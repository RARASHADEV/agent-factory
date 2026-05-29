# Technical Design: Generic Agent Orchestration Module

**Author:** Architect
**Date:** 2026-05-29
**Status:** Draft — for review
**Related:** `~/projects/agentic-marketing/docs/research-ai-agentic-marketing.md` (landscape research), `~/projects/agentic-marketing/.ora/planning.md`
**Implements in:** `agent-factory` (AF CLI `src/`, `web/`, `agents/*.md`)

---

## 1. Overview

We are building a **domain-agnostic orchestration module** that lets a *supervisor agent* (Campaign Director for marketing, Team Lead for IT, Support Lead for support, …) decompose an objective and delegate to a roster of specialized AF agents — with model execution (Claude SDK vs. local Ollama/vLLM) decided per-agent and configurable from the Agent Factory UI.

The design separates three concerns that today are entangled:

1. **Orchestration** — sequencing/delegation logic. Model- and domain-agnostic.
2. **Execution** — how an individual agent runs (which backend/model).
3. **Agent definition** — the role/goal/prompt/config of each agent.

A new domain = a new config file + (optionally) new agent `.md` definitions. **No engine changes.** This realizes the research doc's core finding: *specialized agent roles + workflow orchestration + a shared layer kept separate from the agents*, and its recommendation to **borrow the supervisor pattern rather than adopt a framework**.

### Non-goals
- Not replacing AF CLI — we build *on top of* it.
- Not a new agent runtime — execution stays in AF CLI.
- Not re-implementing task sync (`af sync` / Loka) — out of scope.
- The Claude Code `Workflow` tool was used to **prototype** this pipeline (see §9); it is **not** the deployment target.

---

## 2. Architecture

### 2.1 Layering

```
┌─────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR                                                  │
│  - reads a Domain Config { supervisor, roster, policy }       │
│  - runs the supervisor; exposes each roster agent as a tool   │
│  - enforces guardrails (max delegations, required finalizers, │
│    token budget); validates inputs before any dispatch        │
│  - model-agnostic, domain-agnostic                            │
└───────────────┬───────────────────────────────────────────────┘
                │  run(agentId, input) -> result
                ▼
┌─────────────────────────────────────────────────────────────┐
│ EXECUTOR (thin adapter)                                       │
│  - single boundary into AF CLI; no model logic                │
│  - af dispatch <agentId> --input <...> (programmatic invoke)  │
└───────────────┬───────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│ AF CLI  (agent-factory)                                       │
│  - resolves the agent .md definition + frontmatter            │
│  - routes to the backend named in the agent's `model` field   │
└──────────────┬───────────────────────────┬────────────────────┘
               ▼                            ▼
        ┌─────────────┐             ┌──────────────────┐
        │ Claude SDK  │             │ Ollama / vLLM    │
        │ (cloud)     │             │ (local backend)  │
        └─────────────┘             └──────────────────┘
```

**Key property:** model routing lives in **one place** — the agent's frontmatter, resolved by AF CLI. Nothing above AF CLI knows or cares which backend ran. Swapping an agent cloud↔local is a one-field config edit.

### 2.2 Shared source of truth (verified in codebase)

Agent definitions live as markdown in `agent-factory/agents/*.md` (frontmatter + prompt). **Both** the AF CLI **and** the Agent Factory Web UI read/write these *same files* directly — there is no replication step:

- UI read: `web/src/lib/agents.ts` → `loadAgents()` / `getAgent()` (parse via `gray-matter`).
- UI write: `saveAgent(slug, content)` writes straight back to `agents/<slug>.md`. (Updates only — it refuses to create new agents.)
- API: `web/src/app/api/agents/route.ts`, `web/src/app/api/agents/[slug]/route.ts`.

Therefore: **configuring an agent in the UI directly edits the definition AF CLI executes.** Our new routing field (§4) plugs into this with no new sync.

### 2.3 Agent types (verified)

- `type: 'sdk'` — file-backed agents in `agents/*.md`. **Editable via UI, orchestratable, routable.** These are our roster agents.
- `type: 'bridge'` — the "main four" (ora, garuda, agni, shakti) are remote long-running processes reached via HTTP endpoint, defined in code (`BRIDGE_AGENTS` in `agents.ts`), not files. **Not file-configurable; out of scope** as roster members for v1.

---

## 3. Orchestration Design

### 3.1 Supervisor mode: constrained-dynamic (hybrid)

Per the discussion, the supervisor **dynamically decides** which agents to call ("as needed"), but within hard constraints:

- Delegation is limited to the configured **roster**.
- A **token/step budget** caps the loop (`policy.max_delegations`).
- **Required finalizers** always run before completion (e.g. a `reviewer`), regardless of the supervisor's plan.
- Agents listed in `policy.parallelizable` may be fanned out concurrently.

This gives adaptivity (the win over a fixed script) without runaway loops or skipped QA.

### 3.2 Control loop (pseudocode — not production code)

```
function orchestrate(domainConfig, objective):
    validateInputs(objective, domainConfig)          # throw on missing/invalid — see §6.1
    supervisor = domainConfig.supervisor
    tools = roster.map(agent => asTool(agent))        # each agent -> a callable tool
    state = { objective, history: [], delegations: 0 }

    loop:
        decision = run(supervisor, state, tools)      # supervisor picks agent(s) or "done"
        if decision == DONE: break
        if state.delegations >= policy.max_delegations: break    # guardrail
        if budgetExceeded(): break                                # guardrail

        results = executeAgents(decision.calls)        # parallel if all in policy.parallelizable
        state.history.append(results)
        state.delegations += decision.calls.length

    for finalizer in policy.required_finalizers:       # always run QA/review
        state.history.append( execute(finalizer, state) )

    return assemble(state)
```

`executeAgents` / `execute` call the **Executor** (§5), never a model directly.

### 3.3 Reference flow (marketing, from the prototype)

`Campaign Director` → parallel `[market-researcher, competitor-analyst, audience-researcher]` → `content-strategist` → `content-writer` → `seo-optimizer` → **required finalizer** `reviewer` (returns structured `{approved, score, issues}`; `approved:false` can loop back to the writer once).

---

## 4. Data Model — Agent Config Contract

### 4.1 Extended agent frontmatter

Agents already carry frontmatter (`slug`, `name`, `role`, `version`, `maxTurns`, `disallowedTools`, `synced`). We **add an execution-routing block**:

```yaml
---
slug: content-writer
name: Content Writer
role: CONTENT_WRITER
version: 3
maxTurns: 60
disallowedTools: []
# --- NEW: execution routing ---
execution:
  backend: local          # one of: claude | local
  model: llama3.1:70b     # backend-specific model id (e.g. claude-sonnet-4-5, or an ollama tag)
  endpoint: http://...    # optional; for local backends if not the AF default
  toolCalling: prompt     # native | prompt  — see §6.2 (local-model tool-calling)
synced: '2026-...'
---
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `execution.backend` | `claude` \| `local` | `claude` | Which family AF CLI dispatches to |
| `execution.model` | string | per-backend default | Model id/tag |
| `execution.endpoint` | string (URL) | AF default | Override for local serving host |
| `execution.toolCalling` | `native` \| `prompt` | `native` for claude, `prompt` for local | How tools are presented |

Backward compatible: absent `execution` block → defaults to `claude` (today's behavior).

### 4.2 Domain Config (new artifact)

Stored as `agent-factory/orchestration/domains/<domain>.yaml` (data only — no engine logic):

```yaml
domain: marketing
supervisor:
  agent: campaign-director        # references an agents/*.md slug
  goal: Turn a campaign objective into reviewed, publish-ready assets
roster:
  - market-researcher
  - competitor-analyst
  - audience-researcher
  - content-strategist
  - content-writer
  - seo-optimizer
  - reviewer
policy:
  max_delegations: 12                       # max total agent calls (length)
  roster_only: true                         # supervisor may only call roster agents (breadth)
  token_budget: 200000                      # hard ceiling on accumulated tokens (cost)
  timeout_seconds: 600                       # wall-clock kill switch
  required_finalizers: [reviewer]            # always run before "done" (quality gate)
  max_revision_loops: 2                      # bound writer<->review retries on approved:false
  abort_on_no_progress: true                 # stop on repeated identical calls / no progress
  parallelizable: [market-researcher, competitor-analyst, audience-researcher]
```

See §6.6 for the full guardrail semantics.

Adding the IT domain = `domains/it.yaml` with `supervisor: team-lead` and an IT roster. **Zero engine changes.**

---

## 5. API / Interface Design

### 5.1 Executor interface (the seam)

```ts
interface Executor {
  // Runs ONE agent by slug; returns its output + usage. No model logic here.
  run(agentId: string, input: AgentInput): Promise<AgentResult>;
}

interface AgentResult {
  output: unknown;
  usage: TokenUsage;          // actual usage reported by the backend (not estimated)
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
```

**Usage is measured, not estimated.** Every backend reports actual token counts, which the Executor normalizes into `TokenUsage`:
- Claude SDK → `usage.input_tokens` / `usage.output_tokens`
- Ollama → `prompt_eval_count` / `eval_count`
- vLLM (OpenAI-compatible) → `usage.prompt_tokens` / `usage.completion_tokens`

The orchestrator keeps a **running total, checked after each step** (see §6.6). It stops on the step *after* the budget is crossed; `max_delegations` bounds the overshoot. A pre-call tokenizer estimate is optional and out of scope for v1.

- **`AfCliExecutor`** (production): shells/binds into `agent-factory` to dispatch the agent. AF CLI resolves frontmatter and routes the backend.
- **`StubExecutor`** (tests): returns canned results — lets the orchestrator be unit-tested with no models.

This single-method seam is what makes orchestration independent of execution.

### 5.2 Orchestrator entry point

```ts
interface Orchestrator {
  run(domain: string, objective: string, opts?: {
    dryRun?: boolean;          // log the plan, dispatch nothing
    maxDelegations?: number;   // override policy
  }): Promise<OrchestrationResult>;
}

interface OrchestrationResult {
  domain: string;
  objective: string;
  steps: Array<{ agent: string; backend: string; output: unknown; usage: TokenUsage }>;
  finalizers: Record<string, unknown>;   // e.g. reviewer verdict
  approved: boolean;
  totalUsage: TokenUsage;                 // accumulated across all steps + supervisor turns
  stopReason: 'done' | 'max_delegations' | 'token_budget' | 'timeout' | 'no_progress' | 'max_revisions';
}
```

**`dryRun` dispatches nothing — including the supervisor (AF-FIX-B3).** The
supervisor "decide which agents to call next" step normally runs the supervisor
agent through the Executor (a live backend). In `dryRun`, **nothing may hit a
live backend**, so the default planner does **not** dispatch the supervisor.
Instead it emits a static plan — the roster, the configured policy, and a
"supervisor `<agent>` would delegate at runtime to roster=[…]" line — then stops
cleanly (`stopReason: 'done'`) with `totalUsage = {0,0}`. Required finalizers
likewise only emit their dry-run plan lines. Net result: a `dryRun` run produces
a fully traceable plan with **zero `Executor.run` calls**.

**Supervisor turns are budgeted (AF-FIX-B4).** The supervisor runs through the
same Executor seam as any worker, so its measured `usage` is accumulated into
`totalUsage` and included in the `token_budget` check (§6.6) — supervisor turns
are not free. The budget is checked after each supervisor turn as well as after
each worker step, so a supervisor that overspends planning is caught.

**No-progress signature is history-aware (AF-FIX-B9).** The `abort_on_no_progress`
guard signs the *effective* input a call will run with (`call.input ?? default
input`, where the default folds in accumulated history), not the raw (often
-undefined) `call.input`. A legitimate same-agent re-call in a later round
(history has grown) gets a different signature and proceeds; only a genuinely
identical repeat trips the guard.

### 5.3 UI surface (Agent Factory)

Extend the existing agent editor — **no new sync**, reuse `saveAgent`:
- `GET /api/agents/[slug]` already returns parsed frontmatter → render an **Execution** panel (backend dropdown `claude|local`, model field, endpoint, toolCalling toggle).
- Save serializes the `execution` block back into frontmatter via the existing `saveAgent(slug, content)` path.
- (Stretch) A read-only **Domains** view listing each domain's supervisor + roster from `orchestration/domains/*.yaml`.

---

## 6. Implementation Notes

### 6.1 Input validation is mandatory (lesson from the prototype)
In prototyping, a missing objective did **not** error — agents *confabulated* a plausible-but-wrong campaign. The orchestrator MUST validate inputs and **throw before any dispatch**: non-empty objective, domain exists, supervisor + all roster slugs resolve to real `agents/*.md` files, finalizers ⊆ roster. Fail loud, never silently.

### 6.2 Local-model tool-calling bottleneck (from research doc)
The research flags tool-calling as *the* weakness of local models. Mitigations, all below the orchestrator (AF CLI's responsibility, invisible upward):
- Route the **supervisor** and tool-heavy agents to `backend: claude` (native tool-calling).
- Give local models **contained text-in/text-out** tasks (drafting, summarizing).
- When `execution.toolCalling: prompt`, AF CLI uses a prompt-based tool protocol / structured-output parsing instead of native function-calling.

### 6.3 Guardrails are not optional
Dynamic delegation (Option B) requires guardrails or the supervisor can loop, overspend, or skip review. See §6.6 for the complete set and semantics.

### 6.4 Reuse, don't rebuild
- **Reuse:** `agents/*.md` store, `gray-matter` parsing, `saveAgent`, the agent editor UI, AF CLI dispatch.
- **Build:** orchestrator engine, Executor adapter, domain-config loader/validator, the frontmatter `execution` block + UI panel, AF CLI backend-routing for `local`.

### 6.5 Known constraints to flag
- UI `AGENTS_DIR` is **hardcoded** to `/home/vanara/projects/agent-factory/agents` — UI editing is single-host today. If remote agent management is desired, this needs parameterizing (separate ticket).
- `af sync`/Loka syncs **tasks, not agents** — do not couple orchestration to it.
- The frontmatter `synced:` timestamp is set by a separate definition-push path, **not** by `saveAgent`; do not rely on it as a UI-edit signal until verified.

### 6.6 Guardrail set (Option B — dynamic supervisor)

Guardrails fall into three groups. Each maps to a `policy` field and a `stopReason`.

**Stopping limits — bound how far the run can go**
| Guardrail | Field | Catches |
|---|---|---|
| Max steps | `max_delegations` | Runaway *length* — too many delegations |
| Roster only | `roster_only` | Supervisor calling agents outside the configured roster (*breadth*) |
| Token budget | `token_budget` | *Cost* runaway — incl. a single agent burning a huge context that a step count misses |
| Wall-clock timeout | `timeout_seconds` | A hung/slow backend (esp. local) stalling the whole run |

**Quality gates — protect output integrity**
| Guardrail | Field | Behavior |
|---|---|---|
| Required finalizer | `required_finalizers` | Listed agents (e.g. `reviewer`) **always** run before completion, even if the supervisor wants to skip. Most important quality guardrail. |
| Max revision loops | `max_revision_loops` | On a finalizer verdict `approved:false`, allow writer→review retry at most N times, then stop and flag for a human. Prevents infinite "fix it / still bad" cycles. |

**Loop / sanity guards — stop spin-in-place**
| Guardrail | Field | Behavior |
|---|---|---|
| No-progress detector | `abort_on_no_progress` | Abort if the supervisor repeats the same agent+input, or a loop produces no new state. Catches spin the step counter would let run to the limit. |
| Input validation | (always on, §6.1) | Reject empty/garbage objectives *before* any dispatch, so the run can't confabulate. |

**Token budget measurement (§5.1):** usage is **reported by each backend, not estimated**, and the orchestrator accumulates a running total checked after each step. It stops on the step *after* the budget is crossed; `max_delegations` and `timeout_seconds` bound the overshoot. Optional pre-call tokenizer estimation is out of scope for v1.

Every guardrail trip is recorded in `OrchestrationResult.stopReason` so callers (and the UI) can distinguish a clean `done` from an enforced stop.

---

## 7. Dependencies

- **agent-factory** (AF CLI) — must add `local` backend routing + programmatic dispatch surface for the Executor.
- **Claude Agent SDK** — existing cloud backend.
- **Ollama / vLLM** — local serving runtime (new integration in AF CLI).
- **agent-factory/web** — UI panel for the `execution` block.
- **Open question for Product Analyst:** confirm supervisor mode = constrained-dynamic (vs. fixed sequence) for v1, and the initial domain set (marketing first; IT/support next?).

---

## 8. Security Considerations

- **Local endpoint trust:** `execution.endpoint` is operator-set; validate it's an allow-listed host/scheme to prevent SSRF via a tampered agent file. UI must not accept arbitrary URLs without validation.
- **Prompt/data isolation:** objectives and intermediate results may contain sensitive campaign/customer data — local backends keep it on-prem (a feature), but ensure cloud-routed agents don't leak data the operator intended to keep local. Make backend per-agent choice explicit and visible in the UI.
- **Write surface:** `saveAgent` writes executable agent prompts; the UI editor is effectively a code editor. Keep it behind the existing auth (`web/src/lib/auth.ts`) and never expose agent-write APIs unauthenticated.
- **Budget/DoS:** the token budget + `max_delegations` also serve as a cost-control / runaway-loop guard.

---

## 9. Prototype Reference

A working prototype of the pipeline shape was run via the Claude Code `Workflow` tool (parallel research → strategy → write → SEO → structured review) on the sample goal *"Launch a GTM campaign for FlowNote."* It validated: parallel+sequential composition, structured hand-offs (JSON verdict), and the `approved:false` branch point. It also surfaced the **input-validation bug** now hardened in §6.1. The production module reimplements this shape on the Executor → AF CLI path so it runs independently of Claude Code.

---

## 10. Implementation Role

**Full-stack — ENGINEER first, then FRONTEND_ENGINEER.**

- **ENGINEER:** orchestrator engine, Executor (`AfCliExecutor` + `StubExecutor`), domain-config loader/validator, AF CLI `local` backend routing + `execution` frontmatter resolution, input validation + guardrails.
- **FRONTEND_ENGINEER (follows):** Execution panel in the agent editor, optional Domains view.

**Complexity:** High (new engine + AF CLI backend integration + UI; local-model tool-calling is the main risk).

---

## Log

- [2026-05-29T00:00:00.000Z] architect: spawn.start | Investigated agent-factory (AF CLI + web UI), confirmed shared-file agent store and task-only sync
- [2026-05-29T00:00:00.000Z] architect: spawn.complete | Created docs/tech-design-orchestration.md — four-layer orchestration design with UI-editable execution routing; role set to ENGINEER (then FRONTEND_ENGINEER)
