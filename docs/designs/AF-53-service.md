# AF-53: AF Service — Agent Factory over HTTP — Technical Design

> Exposes the Agent Factory command surface as an authenticated HTTP service on Hanuman so ORA and the remote ORA-clones dispatch and query through one governed door instead of ad-hoc `bash → af` / `ssh … af`. Companion to **ORA-160** — *Deterministic Agent Dispatch* (`oracle-bridge` repo, `docs/designs/ORA-160.md`), the ORA-side dispatch tool that calls this service. Carries over the queue / SQLite registry / callback design from ORA-160 §Phase 2 and extends it to the full command surface.
>
> Status: Design (outline) · Author: Architect (design session with Brahma) · Date: 2026-06-03 · Flag: `ENABLE_AF_53` (default off)

## 1. Overview

Today every AF capability is a CLI invocation. ORA (on Hanuman) and remote clones reach AF by shelling out — `af agent spawn …`, `ssh hanuman … af …`. There is no fleet-wide governance, no shared job registry, and remote clients construct fragile command strings.

AF-53 introduces `af serve`: a long-running HTTP service (systemd, Hanuman) that exposes AF's operations as a small REST API over the **same engine the CLI already uses**. All repos and execution live on Hanuman, so the service is **central, not federated** — one process, one global queue.

The surface splits into two planes by the *nature* of each command:

- **Execution plane** — operations that spawn workers / drive long-running work (`agent spawn`, `orchestrate`, `pipeline run/pause/resume`). These flow through a **global concurrency queue** (`AF_MAX_CONCURRENCY = 20`), a **SQLite job registry**, and **completion callbacks**. Async: dispatch returns a ticket; the result is pushed back.
- **Query / mutation plane** — fast, synchronous operations with no worker spawn (`projects`, `status`, `task *`, `agent list/show/sync`, `pipeline list/status`, `sync`, `init`). Plain request/response; **never queued** (you would not make a `projects list` wait behind 20 running agents).

`webhook serve` is *infrastructure* (it is itself a server) and is **not** exposed as an operation.

## 2. Scope Boundaries

Built in two stages; Stage A is the governance-critical, design-heavy part that ORA-160 depends on.

| Component | Stage A (execution) | Stage B (surface) | Deferred |
|-----------|---------------------|-------------------|----------|
| `POST /jobs` (agent spawn / orchestrate / pipeline run) + global queue | ✅ | — | — |
| SQLite job registry + reconcile-on-boot | ✅ | — | — |
| Completion callbacks (every terminal state) | ✅ | — | — |
| `GET /jobs/:id`, `GET /health` | ✅ | — | — |
| Project-required guardrail (Decision 3) | ✅ | ✅ | — |
| Auth (shared secret, Tailscale bind) | ✅ | ✅ | — |
| Query routes (`/projects`, `/status`, task/agent/pipeline reads) | — | ✅ | — |
| Mutation routes (`task create/move/assign/log`, `sync`, `init`, `agent sync`) | — | ✅ | — |
| Core-function refactor (presentation-free ops) | partial (execution ops) | full | — |
| Cross-server **scheduling**/placement | — | — | ✅ (all work is on Hanuman; moot) |
| `webhook serve` as an endpoint | — | — | ✅ (infra, not an op) |
| Web dashboard changes (`web/`) | — | — | ✅ (separate) |

## 3. Architecture

### 3.1 One engine, thin adapters (the enabling refactor)

The prerequisite for exposing "all commands" without duplicating logic: **each command's logic must live in a presentation-free core function that returns structured data.** The CLI adds console formatting; the HTTP service adds JSON (and, for execution ops, the queue). Some of this exists already (`orchestrateCommand` is "glue + presentation" over a separate engine; AF-26 separated pipeline logic). The rest (`projects`, `status`, `task`) needs lifting.

```
            ┌───────────────── AF core (library) ─────────────────┐
            │  ops return data:  listProjects(), getStatus(p),     │
            │  createTask(...), dispatchAgent(...), runOrchestration│
            └───────▲───────────────────────────▲─────────────────┘
                    │ formats to console          │ formats to JSON / enqueues
            ┌───────┴────────┐           ┌────────┴──────────────────────┐
            │  CLI (dist/cli)│           │  af serve (HTTP, this doc)     │
            └────────────────┘           └────────────────────────────────┘
```

**Invariant:** no business logic in HTTP handlers. A handler validates input, calls a core op, returns its result (or enqueues it). If a handler reimplements logic, the CLI and service will drift.

### 3.2 Service shape

```
ORA (local, Hanuman) ─────────▶┐
clone @ server B  ──Tailscale──▶├─▶  af serve  (systemd, Hanuman, :PORT bound to tailnet)
clone @ server C  ──Tailscale──▶┘        │
                                         ├─ Router → { execution plane | query/mutation plane }
                                         ├─ Execution: global queue (cap 20) → AF core dispatch
                                         ├─ SQLite job registry (durable; reconcile on boot)
                                         ├─ Completion callbacks → caller (ORA-119 callback contract)
                                         └─ Loka sync (AF-12, unchanged) → observability
```

## 4. HTTP API Surface (resource-oriented REST)

Chosen over a generic `POST /exec {command,args}` RPC because the latter is arbitrary remote command execution with no per-op validation and a weaker project guardrail. Resource routes are typed, validated, and let us decide per-route what queues.

All routes require `Authorization: Bearer <shared secret>` and are bound to the Tailscale interface only.

**Execution plane (Stage A — async, queued):**
```
POST /jobs              { kind: "agent"|"orchestration"|"pipeline", project, role?/domain?/name?, objective, opts? }
                        → 202 { id, status: "queued", queuePosition }
GET  /jobs/:id          → { id, kind, project, status, startedAt?, completedAt?, result? }
GET  /jobs              ?project=&status=  → [ … ]              (list/inspect in-flight + history)
POST /jobs/:id/pause    | /resume          (pipeline control)  → { id, status }
GET  /health            → { ok, running, queued, capacity: 20 }
```

**Query plane (Stage B — sync, read-only):**
```
GET /projects                       → af projects
GET /projects/:p/status             → af status -p :p
GET /projects/:p/tasks ?status=     → af task list
GET /tasks/:ticket                  → af task show
GET /agents        | /agents/:slug  → af agent list | show
GET /pipelines     | /pipelines/:ticket  → af pipeline list | status
```

**Mutation plane (Stage B — sync, writes):**
```
POST  /projects                 { prefix, name }        → af init
POST  /projects/:p/tasks        { title, … }            → af task create
PATCH /tasks/:ticket            { status?|assignee?|log? } → af task move/assign/log
POST  /agents/sync                                      → af agent sync
POST  /sync                     { project, mode }       → af sync
```

> Open: whether `init` (creates workspaces) and `sync` are allowed for all authed clients or restricted — see §12. They are powerful; same auth, flagged sensitive.

## 5. Execution Plane Detail (Stage A)

### 5.1 Global concurrency queue
Every execution request from any client enqueues here. At most **`AF_MAX_CONCURRENCY = 20`** workers run concurrently; the rest wait. This is the only place a fleet-wide cap can be enforced, because all execution is on this one box — `bash → af` from N servers physically cannot coordinate it. Responses include `queuePosition`; `/health` reports `running`/`queued`/`capacity`.

### 5.2 Completion callbacks
The service tracks every job. On **every** terminal state — `completed | failed | crashed | timeout` — it POSTs the result to the caller's callback URL. ORA's existing ORA-119 callback server accepts `{ task_id, status, result }`. This removes model-driven `af agent status` polling: the result is pushed, always, exactly once per job. (Carried from ORA-160 §Phase 2; AF-53 is the producer side.)

### 5.3 Workers
Execution still runs through existing machinery (`spawn-runner.js` / `dispatchAgent`) in the **project-local** workspace; the service only owns admission (queue), tracking (registry), and notification (callback). Output stays at `<project>/.af/output/<ticket>/`.

## 6. Project Guardrail (Decision 3)

`project` is **required** on every route that touches a workspace (all execution + most query/mutation). A request with a missing or unresolvable project is rejected **`400 { error: "unknown project '<x>'" }` before anything is enqueued or executed** — never guessed. `project` must resolve against AF's registry (`af projects`). This is what makes "which repo does this run in?" a hard precondition system-wide and determines `outputDir`.

## 7. Data Model — SQLite job registry (Decision 2)

```sql
CREATE TABLE dispatch_jobs (
  id            TEXT PRIMARY KEY,     -- ticket / runId
  kind          TEXT NOT NULL,        -- 'agent' | 'orchestration' | 'pipeline'
  project       TEXT NOT NULL,        -- required (Decision 3)
  role          TEXT,                 -- agent role / domain / pipeline name
  objective     TEXT NOT NULL,
  status        TEXT NOT NULL,        -- 'queued'|'running'|'completed'|'failed'
  output_dir    TEXT NOT NULL,
  callback_url  TEXT,                 -- where to POST the terminal result
  caller        TEXT,                 -- chatId / clone id, for routing
  queued_at     INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,
  result        TEXT
);
```
**Reconcile on boot:** re-queue rows still `queued`; mark any `running` rows (orphaned by the restart) `failed` so they can be re-dispatched. Jobs survive `af serve` restarts; none silently lost. Use `better-sqlite3` (already an AF/Loka dependency).

## 8. Configuration

| Key | Default | Purpose |
|-----|---------|---------|
| `AF_SERVICE_PORT` | TBD (distinct from webhook's 4100) | Listen port |
| `AF_SERVICE_BIND` | Tailscale iface (never `0.0.0.0`) | Bind address |
| `AF_MAX_CONCURRENCY` | `20` | Global worker cap (Decision 1) |
| `AF_SERVICE_DB` | `~/.af/service.db` | SQLite registry path |
| `AF_SERVICE_SECRET` | — (required) | Bearer shared secret |
| `ENABLE_AF_53` | `false` | Feature flag for the whole service |

## 9. Security

- **Auth on every route** — Bearer shared secret; reject unauthenticated. Mirror ORA-119 `checkAuth`.
- **Bind to Tailscale only** — never a public interface.
- **Sensitive ops** — `init`, `sync`, and all mutations are powerful; same auth, logged. Consider a per-client capability split later (§12).
- **No generic exec** — resource routes only; no arbitrary command passthrough.
- **Reduced fleet surface** — replaces remote `ssh hanuman … af …` (shell over SSH) with a narrow authed API.

## 10. Dependencies

- **ORA-160** — the consumer. Its dispatch tool calls `POST /jobs`; its callback server receives results. AF-53 Stage A must land for ORA-160 Phase 2.
- **AF engine** — `dispatchAgent`, orchestrator, `spawn-runner.js` (exist; `ENABLE_AF_48` on).
- **Core-function refactor** (§3.1) — prerequisite for Stage B breadth.
- **Loka sync** (AF-12) — unchanged.
- **Tailscale** mesh (exists).

## 11. Implementation Role & Phasing

- **Stage A — Execution plane**: **ENGINEER**. `af serve` skeleton, auth, `/jobs` + global queue + SQLite registry + reconcile + callbacks + `/health`. Complexity **Medium**. Unblocks ORA-160 Phase 2.
- **Stage B — Full surface**: **ENGINEER**. Core-function refactor + query/mutation routes. Complexity **Medium** (breadth, mostly mechanical once refactor exists). May involve **FRONTEND_ENGINEER** only if the `web/` dashboard is later pointed at the API (out of scope here).

## 12. Open Decisions

- **Port + bind address** for `af serve`.
- **Capability split** — do all authed clients get the full surface (including `init`/`sync`/mutations), or do remote clones get a reduced set vs local ORA? Default: full surface to all authed clients (per "all commands available to ORA and others"); revisit if least-privilege is wanted.
- **Queue overflow** — return `queuePosition` and let callers wait (recommended) vs `429` above a depth bound.
- **Registry retention** — how long to keep terminal `dispatch_jobs` rows (history vs pruning).

## 13. Test Plan (acceptance)

1. **Auth** — unauthenticated request → `401`; wrong secret → `401`.
2. **Project guardrail** — `POST /jobs` with missing/unknown `project` → `400`, nothing enqueued.
3. **Concurrency** — dispatch 25 jobs from two clients; ≤20 run concurrently, rest queue, none dropped, cap respected.
4. **Callback on all terminal states** — kill / timeout / crash a worker → caller still receives exactly one `failed` callback (no hang); success path receives `completed`.
5. **Restart survival** — with `queued` + `running` jobs, restart `af serve` → queued resume; orphaned `running` → `failed` and re-dispatchable.
6. **Query plane is unqueued** — `GET /projects` returns immediately while 20 jobs run.
7. **Parity** — a representative query/mutation route returns the same data the equivalent `af` CLI command produces (proving the shared core function).
8. **Loka agreement** — `/jobs/:id` outcome matches the Loka task comment for that ticket.
