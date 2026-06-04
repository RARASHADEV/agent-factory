# AF-53: AF Service — Agent Factory over HTTP — Technical Design

> Exposes the Agent Factory command surface as an authenticated HTTP service on Hanuman so any authenticated client dispatches and queries through one governed door instead of ad-hoc `bash → af` / `ssh … af`. **Standalone — no external/ORA dependency** (an earlier draft was coupled to ORA-160; that coupling was removed 2026-06-04 so AF is built as a service for any consumer). Core mechanics: a global concurrency queue, a SQLite system-of-record that logs everything, optional completion callbacks, over the full command surface.
>
> Status: Design (outline) · Author: Architect (design session with Brahma) · Date: 2026-06-03 · Flag: `ENABLE_AF_53` (default off)
>
> **Revision 2026-06-04 (project owner directive).** Storage is a **SQLite database** — the durable system of record for *everything the service does*: every job, inquiry, and instruction is logged on arrival and again on completion, and the database is itself exposed as a read service so the operator can see, at any time, what work is running and everything that has happened. This supersedes the earlier file-backed-JSON resolution (old Decision 7 / R1); see §7, §8, §12, §14.

## 1. Overview

Today every AF capability is a CLI invocation. Clients reach AF by shelling out — `af agent spawn …`, `ssh hanuman … af …`. There is no fleet-wide governance, no shared job registry, and remote clients construct fragile command strings.

AF-53 introduces `af serve`: a long-running HTTP service (systemd, Hanuman) that exposes AF's operations as a small REST API over the **same engine the CLI already uses**. All repos and execution live on Hanuman, so the service is **central, not federated** — one process, one global queue.

The surface splits into two planes by the *nature* of each command:

- **Execution plane** — operations that spawn workers / drive long-running work (`agent spawn`, `orchestrate`, `pipeline run/pause/resume`). These flow through a **global concurrency queue** (`AF_MAX_CONCURRENCY = 20`), a **SQLite job registry**, and **completion callbacks**. Async: dispatch returns a ticket; the result is pushed back.
- **Query / mutation plane** — fast, synchronous operations with no worker spawn (`projects`, `status`, `task *`, `agent list/show/sync`, `pipeline list/status`, `sync`, `init`). Plain request/response; **never queued** (you would not make a `projects list` wait behind 20 running agents).

`webhook serve` is *infrastructure* (it is itself a server) and is **not** exposed as an operation.

### 1.1 Everything is logged — the SQLite system of record

The service keeps a **SQLite database** that is the durable record of *everything it does*. It is not just an execution-job registry: **every inbound request across all three planes** — an execution *job*, a read *inquiry*, or a write *instruction* — is logged the moment it arrives, processed by AF, and its outcome logged again before the response (or async callback) leaves. The canonical flow for every request:

```
  request (job / inquiry / instruction)
        │
        ▼
  ① LOG to SQLite  (received: caller, plane, operation, project, payload — secrets stripped)
        │
        ▼
  ② → AF core  (enqueue+dispatch for jobs; execute synchronously for inquiries/instructions)
        │
        ▼
  ③ LOG to SQLite  (outcome: status, timing, result/error)
        │
        ▼
  ④ → consumer  (sync response, or — for jobs — the completion callback)
```

Because the log is the database and the database is **exposed as a read service** (`GET /jobs`, `GET /audit`, `GET /health`), the operator gets a live overview of what is running and a complete, queryable history of what has happened — at any time, without shelling into the box.

## 2. Scope Boundaries

Built in two stages; Stage A is the governance-critical, design-heavy core (queue + SQLite system-of-record + audit + callbacks).

| Component | Stage A (execution) | Stage B (surface) | Deferred |
|-----------|---------------------|-------------------|----------|
| `POST /jobs` (agent spawn / orchestrate / pipeline run) + global queue | ✅ | — | — |
| **SQLite database** — job registry + reconcile-on-boot | ✅ | — | — |
| **Audit journal** (log-first/log-last) — execution plane | ✅ | extends to query/mutation planes | — |
| Completion callbacks (every terminal state) | ✅ | — | — |
| `GET /jobs/:id`, `GET /jobs`, `GET /audit`, `GET /health` (observability service) | ✅ | — | — |
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
client (local, Hanuman) ──────▶┐
client @ server B ──Tailscale──▶├─▶  af serve  (systemd, Hanuman, :PORT bound to tailnet)
client @ server C ──Tailscale──▶┘        │
                                         ├─ Audit middleware: LOG every request → SQLite (step ①), before routing
                                         ├─ Router → { execution plane | query/mutation plane }
                                         ├─ Execution: global queue (cap 20) → AF core dispatch
                                         ├─ SQLite database (durable; jobs + audit journal; reconcile on boot)
                                         ├─ Outcome LOG → SQLite (step ③) on response / terminal state
                                         ├─ Completion callbacks → caller's optional callback_url
                                         ├─ Read service: GET /jobs, /audit, /health (live overview of all work)
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
GET  /audit             ?since=&caller=&project=&plane=&op=&limit=
                        → [ … ]   append-only request/event journal across ALL planes (the overview)
GET  /health            → { ok, running, queued, capacity: 20 }
```

`GET /audit` is the operator's "what is happening / what has happened" view: it reads the audit journal (every job, inquiry, and instruction, with received/outcome timestamps). `GET /jobs` is the execution-focused subset (the job registry). Both are read-only and unqueued.

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
The service tracks every job. When a `POST /jobs` request supplies a `callback_url`, then on **every** terminal state — `completed | failed | crashed | timeout` — the service POSTs `{ jobId, status, result }` to that URL, exactly once. This removes model-driven `af agent status` polling: the result is pushed. **`callback_url` is optional** — clients that omit it retrieve the result via `GET /jobs/:id` instead, so callbacks are a convenience, not a hard requirement. No external consumer is assumed; the contract is AF's own.

### 5.3 Workers
Execution still runs through existing machinery (`spawn-runner.js` / `dispatchAgent`) in the **project-local** workspace; the service only owns admission (queue), tracking (registry), and notification (callback). Output stays at `<project>/.af/output/<ticket>/`.

### 5.4 Log-first / log-last audit journal (all planes)
A single audit middleware wraps **every** route — execution, query, and mutation — and implements the §1.1 flow:

- **① On arrival (log-first):** before any work, `INSERT` a `request_log` row — `caller`, `plane`, `operation`, `project`, the request `payload` with secrets/bearer stripped, and `received_at`. This write happens even if the request is later rejected (`400`/`401`/`429`), so the journal records attempts, not just successes.
- **② Process:** route to AF core. Execution jobs enqueue and also create a `dispatch_jobs` row (the registry); inquiries/instructions run synchronously.
- **③ On outcome (log-last):** `UPDATE` the `request_log` row with `status`, `responded_at`, and a `result_summary`/`error`. For execution jobs the *terminal* outcome arrives asynchronously (after the 202), so each job-lifecycle transition (`queued → running → completed|failed|crashed|timeout`, plus `callback_sent`) is appended to `job_events`, and the matching `dispatch_jobs` row is updated. This is the "Done → log → consumer" half: the terminal state is persisted **before** the callback fires.
- **④ Deliver:** return the sync response, or POST the completion callback (§5.2).

Ordering guarantee: the log write in ① is committed before AF is invoked, and the log write in ③ is committed before the result leaves the box. The database therefore never trails reality — if a consumer received an answer, it is already in the journal.

## 6. Project Guardrail (Decision 3)

`project` is **required** on every route that touches a workspace (all execution + most query/mutation). A request with a missing or unresolvable project is rejected **`400 { error: "unknown project '<x>'" }` before anything is enqueued or executed** — never guessed. `project` must resolve against AF's registry (`af projects`). This is what makes "which repo does this run in?" a hard precondition system-wide and determines `outputDir`.

## 7. Data Model — SQLite database (Decision 2 + Decision 7)

**Storage is SQLite** (project-owner directive, 2026-06-04). It is the durable system of record for every job, inquiry, and instruction. Three tables: `dispatch_jobs` (execution registry), `request_log` (the cross-plane audit journal), and `job_events` (execution lifecycle transitions).

**Engine — use Node's built-in `node:sqlite` (Node ≥ 22).** It is a real SQLite engine with **no external/native dependency**, so it adds nothing to `package.json` and does not complicate the systemd deploy on Hanuman. **Do *not* add `better-sqlite3`** (native module — fails the deploy-simplicity and dependency constraints). If the deployed Node is < 22, the engineer must flag it; `node:sqlite` is the chosen engine and the target runtime should provide it. Single writer (the service is single-process); enable WAL mode for concurrent reads from the `GET /jobs` · `GET /audit` read service.

### 7.1 `dispatch_jobs` — execution registry
```sql
CREATE TABLE dispatch_jobs (
  id            TEXT PRIMARY KEY,     -- ticket / runId
  kind          TEXT NOT NULL,        -- 'agent' | 'orchestration' | 'pipeline'
  project       TEXT NOT NULL,        -- required (Decision 3)
  role          TEXT,                 -- agent role / domain / pipeline name
  objective     TEXT NOT NULL,
  status        TEXT NOT NULL,        -- 'queued'|'running'|'completed'|'failed'|'crashed'|'timeout'
  output_dir    TEXT NOT NULL,
  callback_url  TEXT,                 -- where to POST the terminal result
  caller        TEXT,                 -- chatId / clone id, for routing
  queued_at     INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,
  result        TEXT
);
CREATE INDEX idx_jobs_status  ON dispatch_jobs(status);
CREATE INDEX idx_jobs_project ON dispatch_jobs(project);
```
**Reconcile on boot:** re-queue rows still `queued`; mark any `running` rows (orphaned by the restart) `failed` so they can be re-dispatched. Jobs survive `af serve` restarts; none silently lost.

### 7.2 `request_log` — cross-plane audit journal (the "log everything" table)
Append-on-arrival, update-on-outcome. One row per inbound request on **every** plane, written per §5.4.
```sql
CREATE TABLE request_log (
  id              TEXT PRIMARY KEY,   -- uuid for this request
  received_at     INTEGER NOT NULL,   -- step ① log-first
  caller          TEXT,               -- chatId / clone id (from auth context)
  plane           TEXT NOT NULL,      -- 'execution' | 'query' | 'mutation'
  method          TEXT NOT NULL,      -- HTTP method
  path            TEXT NOT NULL,      -- route
  operation       TEXT,               -- logical op, e.g. 'agent.spawn', 'task.move', 'projects.list'
  project         TEXT,               -- when applicable (Decision 3)
  payload         TEXT,               -- request body, JSON, SECRETS/BEARER STRIPPED
  job_id          TEXT,               -- FK → dispatch_jobs.id when plane='execution'
  status          INTEGER,            -- HTTP status of the response (set at step ③)
  outcome         TEXT,               -- 'accepted'|'ok'|'rejected'|'error' (set at step ③)
  result_summary  TEXT,               -- short result or error message (set at step ③)
  responded_at    INTEGER             -- step ③ log-last
);
CREATE INDEX idx_req_received ON request_log(received_at);
CREATE INDEX idx_req_caller   ON request_log(caller);
CREATE INDEX idx_req_project  ON request_log(project);
CREATE INDEX idx_req_job      ON request_log(job_id);
```
This table backs `GET /audit`. A rejected request (`400`/`401`/`429`) still has a row — attempts are recorded, not just successes.

### 7.3 `job_events` — execution lifecycle transitions
The asynchronous "Done → log → consumer" trail. Append-only; one row per state change of an execution job.
```sql
CREATE TABLE job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL,           -- FK → dispatch_jobs.id
  at         INTEGER NOT NULL,
  event      TEXT NOT NULL,           -- 'queued'|'started'|'completed'|'failed'|'crashed'|'timeout'|'callback_sent'|'callback_failed'
  detail     TEXT                     -- optional JSON (queuePosition, exit reason, callback http status, …)
);
CREATE INDEX idx_evt_job ON job_events(job_id, at);
```
A job's terminal `event` is written **before** its completion callback fires (§5.4 ③), so the journal is never behind what the consumer has been told.

## 8. Configuration

All keys live under a new `service` block in `GlobalConfig` (mirroring the existing `loka.webhook` block in `src/lib/config.ts`); env vars override config.

| Key | Default | Purpose |
|-----|---------|---------|
| `AF_SERVICE_PORT` | `4150` (Decision 4 — distinct from webhook's 4100) | Listen port |
| `AF_SERVICE_BIND` | Tailscale IPv4 resolved at boot via `tailscale ip -4` (Decision 4) | Bind address — **never** `0.0.0.0` |
| `AF_SERVICE_ALLOW_PUBLIC` | `false` | Escape hatch; if false (default) and bind would resolve to `0.0.0.0`/a public iface, **fail to start** |
| `AF_MAX_CONCURRENCY` | `20` | Global worker cap (Decision 1) |
| `AF_MAX_QUEUE_DEPTH` | `500` (Decision 6) | Backstop ceiling; beyond it `POST /jobs` → `429` |
| `AF_SERVICE_RETENTION_DAYS` | `0` = keep forever (Decision 10) | Audit-first: retain all rows by default. Set a positive value only to opt into pruning terminal `dispatch_jobs`/`job_events` rows older than N days; `request_log` is **never** auto-pruned |
| `AF_SERVICE_DB` | `~/.af/service.db` | **SQLite** database path (Decision 7) — jobs + audit journal + events |
| `AF_SERVICE_SECRET` | — (required) | Bearer shared secret |
| `ENABLE_AF_53` | `false` | Feature flag for the whole service |

## 9. Security

- **Auth on every route** — Bearer shared secret; reject unauthenticated. Compare the secret with `crypto.timingSafeEqual` (the same constant-time pattern `src/lib/webhook-handler.ts` already uses for HMAC) — never `===`.
- **Bind to Tailscale only** — never a public interface.
- **Sensitive ops** — `init`, `sync`, and all mutations are powerful; same auth, logged. Consider a per-client capability split later (§12).
- **Audit journal hygiene** — every request is logged to `request_log` (§7.2), but the stored `payload` **must** have the `Authorization` bearer and any secret-bearing fields stripped before the row is written. The journal records *who did what*, never credentials. The DB file (`AF_SERVICE_DB`) inherits the tailnet-only trust boundary; protect it with normal file permissions (`0600`).
- **No generic exec** — resource routes only; no arbitrary command passthrough.
- **Reduced fleet surface** — replaces remote `ssh hanuman … af …` (shell over SSH) with a narrow authed API.

## 10. Dependencies

- **No external/ORA dependency** — the service is standalone; any authenticated client may consume it. (An earlier draft coupled this to ORA-160; that dependency was removed 2026-06-04. The ORA ticket is left untouched and is free to call this API later as just another client.)
- **Node ≥ 22** on the host — required by the built-in `node:sqlite` engine (Decision 7).
- **AF engine** — `dispatchAgent`, orchestrator, `spawn-runner.js` (exist; `ENABLE_AF_48` on).
- **Core-function refactor** (§3.1) — prerequisite for Stage B breadth.
- **Loka sync** (AF-12) — unchanged.
- **Tailscale** mesh (exists).

## 11. Implementation Role & Phasing

- **Stage A — Execution plane**: **ENGINEER**. `af serve` skeleton, auth, `/jobs` + global queue + **SQLite database (`node:sqlite`): `dispatch_jobs` + `request_log` + `job_events`** + log-first/log-last audit middleware (§5.4) + reconcile + callbacks + `/jobs` · `/audit` · `/health` read service. Complexity **Medium**.
- **Stage B — Full surface**: **ENGINEER**. Core-function refactor + query/mutation routes. Complexity **Medium** (breadth, mostly mechanical once refactor exists). May involve **FRONTEND_ENGINEER** only if the `web/` dashboard is later pointed at the API (out of scope here).

## 12. Resolved Decisions

> Resolved by Architect on 2026-06-03 (review session). All four prior open items are now decided; numbering continues the design's `Decision N` convention.

- **Decision 4 — Port + bind address.** Port **`4150`** (`AF_SERVICE_PORT`), distinct from webhook's 4100, same `41xx` family. Bind to the host's **Tailscale IPv4** resolved at boot (`tailscale ip -4`), configurable via `AF_SERVICE_BIND`. The service **refuses to start** if the bind would resolve to `0.0.0.0` or a public interface unless `AF_SERVICE_ALLOW_PUBLIC=true` is explicitly set (discouraged). This also corrects the precedent in `webhook serve`, which binds `0.0.0.0` — do **not** copy that.
- **Decision 5 — Capability split.** **Full surface to every authenticated client in v1**, single shared secret. Rationale: the trust boundary is the Tailscale mesh + bearer secret, and all consumers are first-party (authenticated over the tailnet). Per-client least-privilege (scoped capability tokens, reduced surface for remote clones) is deferred to a **follow-up ticket**, not v1. Mitigation now: every mutation and every `init`/`sync` call is written to the existing audit bridge (`src/lib/audit.ts` / `audit-bridge.ts`) so sensitive ops are attributable.
- **Decision 6 — Queue overflow.** **Enqueue and return `queuePosition`** (the recommended path) — async dispatch + completion callbacks mean callers never block, so deep queues are acceptable. Add a runaway/abuse backstop: if queue depth exceeds **`AF_MAX_QUEUE_DEPTH` (default 500)**, `POST /jobs` returns **`429 { error, retryAfter }`** and enqueues nothing. The 429 protects the box; it is not the normal flow.
- **Decision 7 — Storage technology** (project-owner directive 2026-06-04; supersedes the earlier file-backed-JSON resolution and §14 R1). **SQLite is the storage engine** — the durable system of record for every job, inquiry, and instruction (§7). Implemented with Node's **built-in `node:sqlite` (Node ≥ 22)** so there is **no external/native dependency** and the systemd deploy stays simple — this is the agreed path through project.md's "no external API deps" rule (a built-in module adds nothing to `package.json`). **`better-sqlite3` remains explicitly forbidden** (native module). The owner has accepted SQLite over the file-backed registry specifically to get full, queryable audit/log history; the prior "no database" guidance in project.md is overridden for this service by owner decision. Rationale: a single JSON blob cannot serve the audit + live-overview requirement (§1.1) at scale; SQLite gives indexed history, concurrent reads (WAL) for the `/audit` read service, and restart-safe durability in one file.
- **Decision 10 — Retention (audit-first).** **Keep everything by default** — `AF_SERVICE_RETENTION_DAYS = 0` means no pruning, because the database *is* the audit log and the operator wants a complete history. The `request_log` journal is **never** auto-pruned. Pruning is opt-in only: setting a positive `AF_SERVICE_RETENTION_DAYS` prunes only terminal `dispatch_jobs` and their `job_events` older than N days (operational tidy-up), on a boot-time + daily sweep. Loka task comments remain a parallel record (§5.2), but the SQLite journal is now the primary, queryable system of record.

## 13. Test Plan (acceptance)

1. **Auth** — unauthenticated request → `401`; wrong secret → `401`.
2. **Project guardrail** — `POST /jobs` with missing/unknown `project` → `400`, nothing enqueued.
3. **Concurrency** — dispatch 25 jobs from two clients; ≤20 run concurrently, rest queue, none dropped, cap respected.
4. **Callback on all terminal states** — kill / timeout / crash a worker → caller still receives exactly one `failed` callback (no hang); success path receives `completed`.
5. **Restart survival** — with `queued` + `running` jobs, restart `af serve` → queued resume; orphaned `running` → `failed` and re-dispatchable.
6. **Query plane is unqueued** — `GET /projects` returns immediately while 20 jobs run.
7. **Parity** — a representative query/mutation route returns the same data the equivalent `af` CLI command produces (proving the shared core function).
8. **Loka agreement** — `/jobs/:id` outcome matches the Loka task comment for that ticket.

Add for the resolved decisions:
9. **Bind safety (Decision 4)** — with no Tailscale iface resolvable and `AF_SERVICE_ALLOW_PUBLIC` unset, `af serve` exits non-zero and binds nothing (never falls back to `0.0.0.0`).
10. **Queue backstop (Decision 6)** — with depth at `AF_MAX_QUEUE_DEPTH`, the next `POST /jobs` → `429`, enqueues nothing, and in-flight jobs are unaffected.
11. **Retention default = keep-everything (Decision 10)** — with `AF_SERVICE_RETENTION_DAYS=0` (default), no rows are ever pruned, including old terminal jobs; `request_log` is retained in full. With a positive value, only terminal `dispatch_jobs`/`job_events` older than N days are pruned while `request_log` and non-terminal rows survive.
12. **Log-first/log-last journal (§5.4)** — for one job, one inquiry, and one instruction: a `request_log` row exists with `received_at` *before* AF is invoked, and is updated with `status`/`responded_at`/`result_summary` *before* the response (or callback) is delivered. A rejected request (`401`/`400`/`429`) still produces a `request_log` row.
13. **Audit overview service** — `GET /audit?since=…&caller=…&project=…` returns the journal across all three planes, filtered correctly, while jobs are running (unqueued). For an execution job, `job_events` contains the ordered transitions and the terminal event is timestamped at or before `callback_sent`.
14. **Audit secret hygiene (§9)** — a request carrying a bearer/secret has those fields stripped from the stored `request_log.payload`; no credential is persisted.
15. **SQLite engine** — the service opens its DB via `node:sqlite` with no entry added to `package.json` dependencies; `better-sqlite3` is absent.

## 14. Design Review (2026-06-03)

Verdict: **the design is sound and approved for implementation** — central-not-federated, two-plane split, one-engine/thin-adapters, and the project-required guardrail are all the right calls and are grounded in code that already exists (`dispatchAgent`, `spawn-runner.ts`, `orchestrator.ts`, `pipeline.ts`, the `http.createServer` + `timingSafeEqual` patterns in `webhook`). No re-architecture needed. Findings below are corrections folded into the sections above, not blockers.

- **R1 — Storage (SUPERSEDED 2026-06-04 by project-owner directive; see Decision 7 & §7).** The original §7 wrongly claimed `better-sqlite3` was an existing dependency; it is not, and the review first resolved this to a file-backed JSON registry to honor project.md's "no database" rule. **The project owner has since chosen SQLite** as the storage engine to obtain a complete, queryable audit/log history and a live work-overview service (§1.1). Final resolution: storage is **SQLite via the built-in `node:sqlite` module (Node ≥ 22)** — a real database with **no external/native dependency**, so the deploy stays simple and `package.json` is untouched. `better-sqlite3` remains forbidden. The §7 SQL is now the actual schema, not merely a "logical record shape." project.md's no-database guidance is explicitly overridden for this service by owner decision.
- **R2 — Bind precedent is unsafe (resolved, Decision 4).** The existing `webhook serve` binds `0.0.0.0` (`src/commands/webhook.ts:82`). The engineer must **not** mirror that; bind to the tailnet IP and fail-closed otherwise.
- **R3 — Branch base mismatch (RESOLVED 2026-06-03, commit `405f28a`).** `project.md` said base branch `main`; corrected to `master` (matches repo default, `CLAUDE.md`, and `--base master` PRs). Base branch is **`master`**.
- **R4 — `ENABLE_AF_48` precondition (RESOLVED 2026-06-03, commit `95b6e12`).** `ENABLE_AF_48 = true` is now committed to `master` (AF-48 is released). Stage A may rely on `dispatchAgent`/`orchestrate` being enabled; no longer a precondition to clear.
- **R5 — Auth comparison (folded into §9).** Use `crypto.timingSafeEqual` for the bearer check, matching the HMAC comparison already in `webhook-handler.ts`.

### Feature Flag Specification
- **Flag:** `ENABLE_AF_53` — add to `src/lib/constants.ts` (follow the existing `ENABLE_AF_XX` pattern/comment style).
- **Default:** `false` (off).
- **Guards:** the entire `af serve` command and every route handler. With the flag off, `af serve` prints a "disabled" notice and exits 0; no listener is opened. The flag is checked once at command entry (mirror how `webhook` checks `ENABLE_AF_12`).
- **Removal:** flip to `true` only after Stage A acceptance tests 1–6 + 9–11 pass on Hanuman behind the tailnet.
