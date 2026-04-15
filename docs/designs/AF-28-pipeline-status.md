# AF-28: Pipeline Status Command — Technical Design

> Pipeline Flow 6: Add `af pipeline status [ticket]` — a read-only CLI view over `pipeline-state.json` so users can observe pipeline runs without tailing log files.

## 1. Overview

AF-26 writes `.af/output/<ticket>/pipeline-state.json` continuously as a pipeline runs. AF-27 extended each phase's state with multi-failure records and retry counts. **AF-28 is the renderer** — a pure consumer of that file.

The scope is intentionally narrow:

1. `af pipeline status <ticket>` — render the full phase-by-phase state for one ticket.
2. `af pipeline status` (no ticket) — list all pipeline runs found under `.af/output/*/pipeline-state.json`, one summary line per run, newest first.
3. `--json` flag — emit the raw `PipelineState` object to stdout for tooling/scripts.

No new data structures. No changes to the runner. No background processes. This is a read-only formatter on top of `readPipelineState()`.

`af pipeline list` is **already implemented** by AF-26 (`pipelineListCommand` in `src/commands/pipeline.ts:157`). The ticket's Solution #2 is already satisfied — this design does not re-implement it. The relevant acceptance criterion (`af pipeline list shows available pipeline definitions with descriptions`) already passes today; engineer should verify and leave it alone.

## 2. Scope Boundaries

| Concern | In scope (AF-28) | Out of scope |
|---|---|---|
| Render one run (`status <ticket>`) | ✅ | — |
| Render all runs (`status`) | ✅ | — |
| `--json` output | ✅ | — |
| Gate failure + remediation display | ✅ (reuse AF-27 rendering) | — |
| Current-phase live duration (status=running) | ✅ (computed from `phases[cur].startedAt`) | — |
| Refactor `formatDuration` / `phaseIcon` to shared helpers | ✅ (tiny, needed for reuse) | Broader refactor of `printSuccessSummary` / `printFailureSummary` |
| `af pipeline list` (already exists from AF-26) | Verify passes AC | Re-implement |
| Stale/orphaned run detection (status=running but no process alive) | — | Future ticket; see §6 |
| "Paused" status rendering | — | See §6 — no such state exists in `PipelineState` today |
| Watching / live refresh (`--watch`) | — | Future |
| Truncating long runs (many phases) | — | Full render is fine for current pipeline sizes |

### Note on "paused" in the ticket

The ticket's Solution #1 lists four overall statuses — *running, completed, failed, paused*. The on-disk schema (`PipelineStatus` in `src/lib/pipeline-state.ts:16`) has only three: `'running' | 'completed' | 'failed'`. There is **no pause mechanism** in AF-26/27 — a pipeline either finishes its phase loop, crashes, or is `process.exit(1)`'d on gate failure. The AC block does not require "paused" either. **Engineer: do not invent a paused state.** Render the three real statuses. Pause/resume has been split into its own ticket — **AF-34 (Pipeline Flow 7: Pause and resume)** — which will extend the schema and add the runner-side mechanism; the status command will pick up the new state automatically when AF-34 lands.

### Note on the overall render format

The ticket's example output uses a `⏸️` icon for *pending* phases and a specific column layout. The existing `printSuccessSummary` / `printFailureSummary` functions in `src/commands/pipeline.ts` already do the per-phase line layout — same columns, same icons, same `attempts` tag. **Reuse those column conventions** (extract a shared `renderPhaseLine()`) rather than inventing a third format. Consistency across `run` output and `status` output is explicitly desirable.

## 3. Architecture

### Call graph

```
af pipeline status [ticket]          (cli.ts)
  │
  └── pipelineStatusCommand(ticket?, options)                 [NEW]
        ├── resolveProject()                                    (existing)
        ├── if ticket:
        │     readPipelineState(.af/output/<ticket>/)           (existing, AF-26)
        │     → renderPipelineState(state, { now })             [NEW]
        │
        └── else:
              scan .af/output/*/pipeline-state.json            [NEW helper]
              readPipelineState for each
              → renderRunList(states)                           [NEW]
```

One new command function, two pure rendering helpers, one directory-scan helper. Everything else is already built.

### Module placement

| Symbol | File | Reason |
|---|---|---|
| `pipelineStatusCommand` | `src/commands/pipeline.ts` (append) | Matches `pipelineRunCommand`, `pipelineListCommand` |
| `renderPhaseLine`, `renderPipelineState`, `renderRunList` | `src/commands/pipeline.ts` (private) | Formatting is tightly coupled to this command; no external reuse need |
| `findPipelineRuns(afPath): string[]` | `src/commands/pipeline.ts` (private) | Just a `readdirSync` filter |
| `formatDuration`, `phaseIcon` | Already in `src/commands/pipeline.ts` (lines 90–109) | Reuse in-place — no need to move to `lib/` |

No new files. No new modules in `lib/`.

## 4. CLI Design

### Command

```
af pipeline status [ticket] [--json] [-p, --project <prefix>]
```

**Arguments**

- `[ticket]` — optional. When present, shows one run. When omitted, lists all runs found in the project's `.af/output/`.

**Options**

- `--json` — emit raw JSON (the `PipelineState` object for single-ticket mode; an array of `PipelineState` for list mode). Disables chalk/ANSI formatting. Machine-readable.
- `-p, --project <prefix>` — standard project selector, same semantics as every other `af` command.

### Exit codes

| Condition | Exit |
|---|---|
| Rendered successfully (any pipeline status, including `failed`) | 0 |
| Ticket supplied but no `pipeline-state.json` found | 1 |
| Project cannot be resolved | 1 |
| `pipeline-state.json` exists but is unreadable/malformed | 1 |

**Rationale:** status is a query, not an assertion. `failed` pipelines are valid information — exit 0. Only infrastructure failures (no project, no file, malformed file) exit non-zero, matching `af agent status` conventions.

### Output — single ticket (human)

```
Pipeline: sdlc — AF-30
Status: running (12m 34s)

  ✅  design      architect     3m 12s    gate: pass
  🔄  implement   engineer      9m 22s    running
  ⏸️  verify      qa            —         pending
  ⏸️  release     deploymanager —         pending

  State:  .af/output/AF-30/pipeline-state.json
  Output: .af/output/AF-30/
```

Rules:
- Status line shows `running | completed | failed`. When running, append live elapsed from `state.startedAt`. When completed/failed, show `state.completedAt - state.startedAt`.
- Phase rows reuse the same column widths as `printSuccessSummary`: `icon  name(12)  agent(12)  duration(10)  gate-or-status`.
- The currently-running phase's `durationMs` field is undefined in `pipeline-state.json`; compute live duration as `Date.now() - Date.parse(phases[cur].startedAt)`.
- Failed phase rows append gate failure lines underneath, one per `gateFailures[]` entry, with remediation on a second line — **identical** to `printFailureSummary` (reuse that block).
- Retry: when `attempts > 1`, append `(attempts: N)` — reuse existing `attemptsTag` logic.
- Warnings: if `state.warnings` is non-empty, print a trailing `Warnings:` block with each line dimmed.

### Output — list mode (no ticket)

```
Pipeline runs

  🔄  AF-30   sdlc      running    started 12m ago   phase: implement (9m 22s)
  ✅  AF-29   sdlc      completed  18m 04s           4/4 phases passed
  ❌  AF-28   sdlc      failed     6m 11s            phase: verify — gate failed

  3 runs
```

Rules:
- Sort by `state.startedAt` descending (newest first). Stable sort.
- One line per run. No gate-failure detail (that's what `status <ticket>` is for).
- Running: relative time (`Xm ago`) + current phase + live duration.
- Completed: total duration + `N/M phases passed` (phases with status=completed vs total).
- Failed: total duration + `phase: <name> — <short reason>` (gate failed | spawn error | no result).

### Output — `--json`

Single ticket:
```json
{ "pipeline": "sdlc", "ticket": "AF-30", "status": "running", ... }
```

List mode:
```json
[ { ...state1 }, { ...state2 } ]
```

Emit `JSON.stringify(x, null, 2)` to stdout. No chalk. No trailing prose. Exactly the on-disk `PipelineState` shape — not a derived view. This guarantees the contract is "we show you what's in the file" and leaves post-processing to the caller.

### Empty / error messages

| State | Message |
|---|---|
| Ticket mode, no `.af/output/<TICKET>/pipeline-state.json` | `✗ No pipeline run found for <TICKET>.` exit 1 |
| Ticket mode, file malformed | `✗ Could not parse pipeline-state.json for <TICKET>.` exit 1 |
| List mode, no pipeline-state files anywhere | `No pipeline runs found.` (dim) exit 0 |

## 5. Data Model

**No changes.** AF-28 is a pure reader.

Consumed shapes (all already defined in `src/lib/pipeline-state.ts`):

- `PipelineState` — top-level record. `phases` is `Record<string, PhaseState>` — insertion order matches pipeline execution order (set by `initPipelineState`), so `Object.entries(state.phases)` iterates in render order.
- `PhaseState.durationMs` — `undefined` for pending/running phases.
- `PhaseState.gateFailures` (AF-27) — preferred. Fallback to `gateFailure` (singular, AF-26 back-compat) only if `gateFailures` is absent — mirrors the logic already in `printFailureSummary`.
- `PhaseState.attempts` — render when `> 1`.
- `PhaseState.outputDir` — relative to `.af/`. Not currently rendered by the run printers; AF-28 also need not render it unless `--json` (which dumps the raw state anyway).

## 6. Implementation Notes

### Reuse, don't reinvent

`renderPhaseLine(phase, ps, now)` should produce the exact same line format that `printSuccessSummary` and `printFailureSummary` produce. The minimal refactor:

1. Extract the existing per-phase line code from `printSuccessSummary` (src/commands/pipeline.ts:938–956) into a private helper. Call it from both `printSuccessSummary` and the new `renderPipelineState`.
2. Extract the gate-failure block (src/commands/pipeline.ts:1003–1028) into a second helper. Call it from both `printFailureSummary` and `renderPipelineState`.

**Do not** duplicate the column layout. One source of truth.

### Live duration for the current phase

```ts
function livePhaseDuration(ps: PhaseState, now: number): number | undefined {
  if (ps.durationMs !== undefined) return ps.durationMs;
  if (ps.status === 'running' && ps.startedAt) {
    return now - Date.parse(ps.startedAt);
  }
  return undefined; // pending / unknown
}
```

Pass `now = Date.now()` from the command function, not from the helpers — keeps helpers pure and unit-testable.

### Finding runs (list mode)

```ts
function findPipelineRuns(afPath: string): string[] {
  const base = join(afPath, 'output');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => existsSync(join(base, name, 'pipeline-state.json')));
}
```

`readPipelineState` each one. Filter out nulls (malformed). Sort by `startedAt` desc.

### CLI wiring

Add to `src/cli.ts` after the existing `pipeline list` subcommand (line 161):

```ts
pipeline
  .command('status [ticket]')
  .description('Show pipeline run status from pipeline-state.json')
  .option('-p, --project <prefix>', 'Project prefix')
  .option('--json', 'Emit raw JSON')
  .action(pipelineStatusCommand);
```

Import `pipelineStatusCommand` from `./commands/pipeline.js` alongside the existing two.

### Feature flag

Add `ENABLE_AF_28` to `src/lib/constants.ts`, defaulted to `true`. The pattern is well-established (`ENABLE_AF_26`, `ENABLE_AF_27`). Guard the command entry point:

```ts
export function pipelineStatusCommand(ticket: string | undefined, options: { project?: string; json?: boolean }): void {
  if (!ENABLE_AF_28) {
    console.log(error('Pipeline status is disabled (ENABLE_AF_28=false).'));
    process.exit(1);
  }
  // ...
}
```

This is a low-risk read-only command, but the flag is cheap and consistent with the pipeline series. Disabling it does not impair `run` or `list`.

### Audit event (optional)

`af agent status` emits `spawn.status_check` on every call. The analogous event for pipelines does **not** currently exist in the `AuditEvent` union (`src/lib/audit.ts:7`). Engineer has two options:

- **Skip auditing** — `ENABLE_AF_8` is `false` right now anyway; audit is a no-op. Simplest.
- **Add `pipeline.status_check`** to the `AuditEvent` union and emit it. Future-proof if audit is ever enabled.

Recommend option B (one-line addition, no cost). No other code consumes this event, so adding it is safe.

### Ticket normalization

Match the existing pattern in `pipelineRunCommand` and `agentStatusCommand`: uppercase the ticket (`ticket.toUpperCase()`) before joining paths. Users will type `af-30` and `AF-30` interchangeably.

### Error handling

- Missing/malformed `pipeline-state.json` → `readPipelineState` returns `null`. Single-ticket mode → error + exit 1. List mode → skip that directory silently (likely a half-initialized run).
- Unknown ticket in directory scan → ignore (output dirs exist for agent spawns too; the `pipeline-state.json` check is what distinguishes a pipeline run).
- `startedAt` unparseable → treat duration as unknown, render `—`. Defensive but not paranoid.

### Tests

Unit tests under `src/__tests__/pipeline-status.test.ts`:

1. `renderPipelineState` on a completed state produces expected lines (snapshot-ish).
2. `renderPipelineState` on a failed state includes gate failure + remediation lines.
3. `renderPipelineState` on a running state computes live duration from `now`.
4. `renderRunList` sorts by `startedAt` desc.
5. `--json` output equals `JSON.stringify(readPipelineState(...), null, 2)`.
6. Ticket mode with missing file exits 1.
7. List mode with no output dir prints the empty message and exits 0.

Use fixture `PipelineState` objects — do not write to disk in unit tests. The I/O (`readPipelineState`) already has a simple happy path and is tested-enough via integration.

### Things **not** to do

- Do not add live refresh / `--watch`. Out of scope.
- Do not add a "paused" status. It doesn't exist in the data model.
- Do not add PID liveness detection (à la `agentStatusCommand`'s `process.kill(pid, 0)`). The pipeline runner does not record its PID in `pipeline-state.json`. Adding it here would require a runner change, which belongs in a separate ticket if we ever want "stalled run" detection.
- Do not touch `pipelineListCommand`. It already satisfies its AC.
- Do not delete or move `formatDuration` / `phaseIcon`. Just reuse them.

## 7. Dependencies

- **AF-26** — writes `pipeline-state.json`. Without it, nothing to render. Already merged (commit `3b17da0`).
- **AF-27** — adds `gateFailures[]`, `attempts`, `remediation`. Already merged (commit `9c478b9`).
- **No new npm packages.** Chalk, fs, path — all already imported in this file.

## 8. Implementation Role

**ENGINEER** — backend CLI only, no frontend. Single-file surface area:

- `src/commands/pipeline.ts` — add `pipelineStatusCommand`, `renderPipelineState`, `renderRunList`, `findPipelineRuns`; extract two small helpers from existing success/failure printers.
- `src/cli.ts` — register the subcommand.
- `src/lib/constants.ts` — add `ENABLE_AF_28 = true`.
- `src/lib/audit.ts` — (optional) add `'pipeline.status_check'` to the `AuditEvent` union.
- `src/__tests__/pipeline-status.test.ts` — new test file.

No web/ changes. No agent markdown changes. No schema changes.

## 9. Feature Flag Specification

| Field | Value |
|---|---|
| Flag name | `ENABLE_AF_28` |
| Location | `src/lib/constants.ts` |
| Default | `true` |
| Guards | `pipelineStatusCommand` entry point only |
| When false | Command prints `✗ Pipeline status is disabled (ENABLE_AF_28=false).` and exits 1. `run` and `list` are unaffected. |

## 10. Acceptance Mapping

| AC | Covered by |
|---|---|
| `af pipeline status AF-30` shows phase-by-phase breakdown | §4 single-ticket output; `renderPipelineState` |
| `af pipeline status` (no ticket) shows all active/recent runs | §4 list mode; `findPipelineRuns` + `renderRunList` |
| Each phase shows: icon, name, agent, duration, gate result | §4; reuse of `renderPhaseLine` extracted from existing printers |
| Failed phases show gate failure message | §4; reuse of gate-failure block from `printFailureSummary` |
| `af pipeline list` shows pipeline definitions with descriptions | **Already implemented** by AF-26 — verify, do not reimplement |
| `--json` flag outputs machine-readable format | §4 `--json`; raw `PipelineState` |
| Works for running, completed, failed pipelines | Three-state rendering; live duration for running; no "paused" state (see §2) |

---

**Ambiguity flagged for Product Analyst / Team Leader:** the ticket mentions a "paused" status that doesn't exist in the data model. Not blocking — recommendation is to ignore it for AF-28 and file a separate ticket if pause/resume is ever actually wanted. Confirm this interpretation before release.
