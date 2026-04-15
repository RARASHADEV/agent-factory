# AF-34: Pipeline Pause and Resume — Technical Design

> Pipeline Flow 7: Let users pause a running pipeline between phases and resume it later without losing prior phase output. Scope-split from AF-28.

## 1. Overview

AF-26's runner iterates over phases in a single long-lived process (`af pipeline run`), spawning one subprocess per phase. AF-34 adds a cooperative pause mechanism that lets a user halt the run **at the next phase boundary** and pick it up later.

The design rests on four decisions:

| Decision | Choice | Why |
|---|---|---|
| Signal vs sentinel file | **Sentinel file** (`.af/output/<ticket>/pause.request`) | Durable across process exits. Works even if the runner crashed. No OS signal coupling. Inspectable. |
| Mid-phase pause | **No** — pause takes effect between phases only | Kill-and-resume a running agent subprocess requires result reconciliation we don't have. Out of scope for v1. |
| Resume semantics | **Next pending phase** — prior completed/failed phases are not re-run | Matches user intent ("pick up where you left off"). Re-running a completed phase would waste tokens and overwrite result.json. |
| Relationship with `--from` | **Shared inner loop**, different UX | `--from` initializes a fresh state and marks earlier phases `skipped`. `resume` loads existing state and keeps prior statuses. |

Two new commands:

- `af pipeline pause <ticket>` — writes the sentinel. Between-phase check in the runner observes it on the next iteration, marks the pipeline `paused`, and exits cleanly.
- `af pipeline resume <ticket>` — removes the sentinel, loads existing state, finds the next non-terminal phase, and re-enters the phase loop with the existing state record.

Schema grows by one `PipelineStatus` variant (`'paused'`) and two optional timestamps (`pausedAt`, `resumedAt`). The AF-28 status renderer (already merged — commit `ef7a39a`) needs small additions at four sites to handle the new state cleanly — see §6 for the exact locations.

## 2. Scope Boundaries

| Concern | In scope (AF-34) | Deferred |
|---|---|---|
| `af pipeline pause <ticket>` command | ✅ | — |
| `af pipeline resume <ticket>` command | ✅ | — |
| Between-phase sentinel check in runner | ✅ | — |
| `PipelineStatus: 'paused'` + `pausedAt`/`resumedAt` fields | ✅ | — |
| `pipeline.pause` / `pipeline.resume` audit events | ✅ | — |
| AF-28 renderer branches for `paused` | ✅ (four small additions in `renderPipelineState` + `renderRunList`; see §6) | — |
| Feature flag `ENABLE_AF_34` | ✅ | — |
| Tests: unit for sentinel helpers, unit for runner pause check, integration for pause→resume | ✅ | — |
| Mid-phase pause (interrupt a running agent) | — | Requires kill + subprocess cleanup + partial-result reconciliation — separate ticket if ever wanted |
| `af pipeline stop <ticket>` (hard cancel) | — | Different semantics — pause is cooperative; stop is destructive |
| Recovering a stalled/crashed run (state=running, no process alive) | — | Separate problem; solved by `--from` today and better by a future "stalled run detector" |
| Multiple pause cycles tracked as history | — | Single `pausedAt`/`resumedAt` fields hold the latest values; full history in audit.log |
| Pause targeting a specific future phase (`pause --before verify`) | — | v1 pauses at the *next* boundary only — adequate for the common case |
| Per-pause reason/note (`pause --reason "waiting for review"`) | — | Simple yes/no for v1; reason would just be string storage |

## 3. Architecture

### Sentinel file

Path: `.af/output/<TICKET>/pause.request`

Contents: a single JSON line written by the pause command:

```json
{"requestedAt":"2026-04-15T13:14:15.678Z","requestedBy":"cli"}
```

The runner only cares about the file's existence. Contents are for forensics. `requestedBy` is "cli" for now; a future webhook-triggered pause could set it to something else.

### Call graph

```
af pipeline pause <ticket>
  └── pipelinePauseCommand                                    [NEW]
        ├── readPipelineState(outputDir)                        (existing)
        ├── reject if state is terminal (completed | failed)
        ├── writePauseRequest(outputDir, {requestedAt, requestedBy})
        └── print "Pause requested for <ticket>. Runner will stop at next phase boundary."

af pipeline resume <ticket>
  └── pipelineResumeCommand                                   [NEW]
        ├── readPipelineState(outputDir)
        ├── require state.status === 'paused'
        ├── removePauseRequest(outputDir)
        ├── mark state.status = 'running', state.resumedAt = now, persist
        ├── compute startIndex = findNextPending(state, phaseOrder)
        ├── invoke sharedPhaseLoop(state, pipeline, startIndex, ...)     [NEW extraction]
        └── run as normal — reuses runner's existing logic

af pipeline run <name> --task <ticket>                        (unchanged wiring)
  └── pipelineRunCommand
        ├── initPipelineState(...) → fresh state
        ├── (existing) preamble: load pipeline, ctx, audit start, etc.
        └── sharedPhaseLoop(state, pipeline, startIndex, ...)    ← extracted

sharedPhaseLoop(state, ...)                                   [NEW, extracted]
  for i = startIndex; i < phaseOrder.length; i++:
    ├── if pauseRequestExists(outputDir):                         [NEW check]
    │     ├── transitionToPaused(state, outputDir)
    │     ├── audit pipeline.pause
    │     ├── print "Pipeline paused — resume with af pipeline resume <ticket>"
    │     └── return { outcome: 'paused' }                         ← exits cleanly, 0
    ├── (existing) resolve injections
    ├── (existing) compose prompt
    ├── (existing) run phase with retry
    └── (existing) finalize + continue-or-fail
```

### Module placement

| Symbol | File | Notes |
|---|---|---|
| `pipelinePauseCommand` | `src/commands/pipeline.ts` | Small, next to existing pipeline commands |
| `pipelineResumeCommand` | `src/commands/pipeline.ts` | Same |
| `sharedPhaseLoop` (private async helper) | `src/commands/pipeline.ts` | Extracted from existing `pipelineRunCommand` |
| `writePauseRequest`, `removePauseRequest`, `pauseRequestExists`, `readPauseRequest` | `src/lib/pipeline-state.ts` | Live next to `readPipelineState` / `writePipelineState` — same concern (pipeline on-disk state) |
| `findNextPendingPhase` | `src/lib/pipeline-state.ts` (or `src/lib/pipeline.ts`) | Pure function over `PipelineState` + `PhaseDefinition[]` |
| `PipelineStatus` extension | `src/lib/pipeline-state.ts` | Add `'paused'` to the union |
| `pausedAt?`, `resumedAt?` fields on `PipelineState` | `src/lib/pipeline-state.ts` | Optional, back-compat with AF-26 / AF-27 files |
| `'pipeline.pause'`, `'pipeline.resume'` | `src/lib/audit.ts` | Append to `AuditEvent` union |
| `ENABLE_AF_34 = true` | `src/lib/constants.ts` | Gates both commands |

One new helper file avoided — everything extends existing modules, matching the AF-26/27/28 pattern.

## 4. CLI Design

### `af pipeline pause <ticket>`

```
af pipeline pause <ticket> [-p, --project <prefix>]
```

**Behavior:**

1. Resolve project. Exit 1 if not found.
2. Read `pipeline-state.json` from `.af/output/<TICKET>/`.
3. Refuse (exit 1) if:
   - No state file exists (`✗ No pipeline run found for <TICKET>.`)
   - `state.status === 'completed'` (`✗ Pipeline already completed.`)
   - `state.status === 'failed'` (`✗ Pipeline already failed.`)
   - `state.status === 'paused'` (`✗ Pipeline is already paused.`)
4. Write `.af/output/<TICKET>/pause.request` atomically (write-temp + rename).
5. Print `⏸️ Pause requested for <TICKET>. Runner will stop at the next phase boundary.`
6. Emit audit event `pipeline.pause` with `{ ticket, requestedBy: 'cli' }`.
7. Exit 0.

**Idempotency:** Writing the sentinel twice is safe (same content, same file). The fourth rejection above is a UX nicety, not a correctness requirement.

**Exit code:** 0 on successful pause request, 1 on any rejection.

### `af pipeline resume <ticket>`

```
af pipeline resume <ticket> [-p, --project <prefix>]
```

**Behavior:**

1. Resolve project. Exit 1 if not found.
2. Read `pipeline-state.json`.
3. Refuse (exit 1) if:
   - No state file.
   - `state.status !== 'paused'`. Specifically:
     - `completed` / `failed` → `✗ Pipeline is not paused (status: <s>). Use af pipeline run --from <phase> to re-run from a specific phase.`
     - `running` → `✗ Pipeline is marked running. If a previous run crashed, use af pipeline run --from <phase> to recover.` (Do not auto-recover — that's a different feature.)
4. Load the pipeline definition (from `state.pipeline` name). Abort if the YAML has since been deleted or is malformed — print a clear error.
5. Find the first phase whose status is not `completed` and not `skipped`. That's the resume point.
6. Remove `pause.request`.
7. Set `state.status = 'running'`, `state.resumedAt = now`, persist.
8. Emit audit event `pipeline.resume` with `{ ticket, fromPhase }`.
9. Invoke `sharedPhaseLoop(state, pipeline, startIndex, ...)` — the same loop the `run` command uses.
10. Exit with the loop's outcome code (0 on completion or another pause; 1 on failure).

**Note on re-entering the phase loop:** Resume must rebuild the same runtime context (`InjectionContext`, `phaseOrder`, audit binding) that `run` builds. Engineer will extract a `prepareRunContext()` helper that both paths call.

### Output examples

**Pause:**
```
⏸️  Pause requested for AF-30. Runner will stop at the next phase boundary.
    State: .af/output/AF-30/pipeline-state.json
```

**Runner observing pause:**
```
▶ Phase implement — engineer
  ✓ Phase implement completed (9m 22s)

⏸️  Pause requested — stopping before phase "verify"
    Resume with: af pipeline resume AF-30
```

**Resume:**
```
▶ Resuming pipeline sdlc — AF-30 from phase "verify"
  Prior phases: design (✅), implement (✅)

▶ Phase verify — qa
  ...
```

## 5. Data Model

### Type changes in `src/lib/pipeline-state.ts`

```ts
export type PipelineStatus = 'running' | 'completed' | 'failed' | 'paused';
// ADDED: 'paused'

export interface PipelineState {
  pipeline: string;
  ticket: string;
  status: PipelineStatus;
  startedAt: string;
  completedAt?: string;
  pausedAt?: string;      // ADDED — timestamp of most recent pause
  resumedAt?: string;     // ADDED — timestamp of most recent resume
  currentPhase?: string;
  phases: Record<string, PhaseState>;
  warnings?: string[];
}
```

**Semantics:**
- `pausedAt` is set when the runner observes the sentinel and transitions to `paused`. Overwritten on each pause if multiple cycles occur.
- `resumedAt` is set by `pipelineResumeCommand` immediately before re-entering the loop. Overwritten on each resume.
- Full pause/resume history lives in audit.log (one `pipeline.pause` + one `pipeline.resume` per cycle). The state file keeps only the latest pair for compactness.
- Existing AF-26/AF-27 `pipeline-state.json` files without these fields remain valid — all new fields are optional.

### No `PhaseState` changes

Phases don't individually pause. The run as a whole pauses between phases, and the last-completed phase's state is already accurate from AF-26. No per-phase pause bookkeeping needed.

### Sentinel JSON

```ts
interface PauseRequest {
  requestedAt: string;   // ISO 8601
  requestedBy: string;   // 'cli' for now; future: webhook, agent, etc.
}
```

Written by `writePauseRequest(outputDir, req)` as pretty-printed JSON. Read by `readPauseRequest(outputDir): PauseRequest | null`. Existence-check helper `pauseRequestExists(outputDir): boolean` for the hot path in the runner loop.

## 6. Implementation Notes

### Extracting `sharedPhaseLoop`

The current `pipelineRunCommand` is ~300 lines with the phase loop occupying roughly lines 303–493. The extraction is mechanical:

1. Keep **preamble** in `pipelineRunCommand`: project resolution, pipeline load, task load, dry-run, `--from` validation, init state, audit start, print heading, build injection context.
2. Move **the phase loop** (line 303 onward) and **the completion/finalization blocks** into a new private async function:

```ts
interface PhaseLoopArgs {
  pipeline: PipelineDefinition;
  phaseOrder: PhaseDefinition[];
  startIndex: number;
  state: PipelineState;             // live — mutated + persisted as the loop runs
  task: Task;
  afPath: string;
  projectDir: string;
  pipelineOutputDir: string;
  ctx: InjectionContext;
  allWarnings: string[];
  pipelineStart: number;
  name: string;                     // pipeline name for logging
}

type PhaseLoopOutcome = 'completed' | 'paused' | 'failed';

async function sharedPhaseLoop(args: PhaseLoopArgs): Promise<PhaseLoopOutcome>;
```

3. `pipelineRunCommand` and `pipelineResumeCommand` both call `sharedPhaseLoop`. Run initializes fresh state; resume loads existing state; otherwise identical.

4. The function returns an outcome tag instead of calling `process.exit` directly — the caller decides the exit code. This keeps the function testable and lets resume and run share the same logic without mutual recursion.

**Risk:** this is a ~200-line refactor of a critical path. Engineer should do it as a **separate preparatory commit** inside the AF-34 branch, verified with existing pipeline-run tests before adding pause/resume logic on top. Keep the diff mechanical — no behavior changes in the first commit.

### The between-phase pause check

Inserted at the **top** of each iteration (before resolving injections for phase[i]):

```ts
for (let i = startIndex; i < phaseOrder.length; i++) {
  // Cooperative pause check — sentinel observed → stop before starting phase[i]
  if (pauseRequestExists(pipelineOutputDir)) {
    const pauseReq = readPauseRequest(pipelineOutputDir);
    state.status = 'paused';
    state.pausedAt = new Date().toISOString();
    state.currentPhase = undefined;
    writePipelineState(pipelineOutputDir, state);

    auditLog(afPath, {
      event: 'pipeline.pause',
      ticket: task.ticket,
      actor: 'cli',
      detail: `Pipeline ${name} paused before phase ${phaseOrder[i].name}`,
      meta: {
        pipeline: name,
        pausedBeforePhase: phaseOrder[i].name,
        requestedAt: pauseReq?.requestedAt,
        requestedBy: pauseReq?.requestedBy,
      },
    });

    console.log('');
    console.log(warn(`Pause requested — stopping before phase "${phaseOrder[i].name}"`));
    console.log(dim(`    Resume with: af pipeline resume ${task.ticket}`));
    return 'paused';
  }

  // ... existing phase handling below ...
}
```

Important: the sentinel is **not** deleted on pause observation. It's only deleted by `resume`. This is intentional — the runner's responsibility ends at "I saw the request and stopped"; the resume command is the authoritative clearer. If the runner deleted it, a user running pause followed by an immediate crash would lose the intent.

### Resume's re-entry, concretely

```ts
export async function pipelineResumeCommand(
  ticket: string,
  options: { project?: string },
): Promise<void> {
  if (!ENABLE_AF_34) { /* error + exit 1 */ }

  const resolved = resolveProject(options.project);
  // ... resolve, validate state is 'paused', load pipeline ...

  const phaseOrder = resolvePhaseOrder(pipeline);
  const startIndex = findNextPendingPhase(state, phaseOrder);
  if (startIndex >= phaseOrder.length) {
    // All phases done — degenerate case. Mark complete + exit 0.
    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    writePipelineState(pipelineOutputDir, state);
    console.log(success(`Pipeline ${state.pipeline} already complete for ${ticket}`));
    return;
  }

  removePauseRequest(pipelineOutputDir);
  state.status = 'running';
  state.resumedAt = new Date().toISOString();
  writePipelineState(pipelineOutputDir, state);

  auditLog(afPath, {
    event: 'pipeline.resume',
    ticket,
    actor: 'cli',
    detail: `Pipeline ${state.pipeline} resumed from phase ${phaseOrder[startIndex].name}`,
    meta: { pipeline: state.pipeline, fromPhase: phaseOrder[startIndex].name },
  });

  // Rebuild runtime context — same as run
  const ctx = buildInjectionContext(pipeline, ticket, afPath, projectDir);
  const allWarnings: string[] = state.warnings ?? [];
  const pipelineStart = Date.parse(state.startedAt); // for total-duration reporting

  const outcome = await sharedPhaseLoop({
    pipeline, phaseOrder, startIndex, state, task,
    afPath, projectDir, pipelineOutputDir, ctx, allWarnings, pipelineStart,
    name: state.pipeline,
  });

  process.exit(outcome === 'failed' ? 1 : 0);
}
```

### `findNextPendingPhase`

```ts
export function findNextPendingPhase(
  state: PipelineState,
  phaseOrder: PhaseDefinition[],
): number {
  for (let i = 0; i < phaseOrder.length; i++) {
    const ps = state.phases[phaseOrder[i].name];
    if (!ps) return i;                              // defensive
    if (ps.status === 'completed') continue;
    if (ps.status === 'skipped') continue;
    return i;
  }
  return phaseOrder.length;
}
```

Pure function — unit-testable without filesystem.

### Pipeline YAML changes mid-run

Edge case: user pauses, edits `.af/pipelines/<name>.yaml` (adds/removes/reorders a phase), then resumes. The saved state was built against the old phase set; the new pipeline definition may disagree.

**Recommended behavior:** on resume, if the set of phase names in the loaded pipeline doesn't match the set in `state.phases`, **refuse**: `✗ Pipeline definition has changed since pause. Cannot resume. Use af pipeline run --from <phase> if you intend to proceed with the new definition.` Safer than silently mis-running.

Check = set equality of phase names. Order or injection changes within a phase are trickier but acceptable — the pre-completed phases' artifacts are what matters for injection downstream, and those are on disk.

### Sentinel I/O — atomic write

Sentinel write should be atomic (write-temp then rename) so a pause command can't produce a half-written file that the runner reads between bytes:

```ts
export function writePauseRequest(outputDir: string, req: PauseRequest): void {
  if (!existsSync(outputDir)) throw new Error(`Output dir does not exist: ${outputDir}`);
  const tmp = join(outputDir, 'pause.request.tmp');
  const final = join(outputDir, 'pause.request');
  writeFileSync(tmp, JSON.stringify(req, null, 2), 'utf-8');
  renameSync(tmp, final);
}
```

For existence check, `existsSync(join(outputDir, 'pause.request'))` is sufficient — we never care about reading content in the hot path.

### Feature flag

```ts
/** AF-34: Pause/resume for pipelines. When false, both commands refuse and the runner's between-phase check is skipped. */
export const ENABLE_AF_34 = true;
```

Guard three call sites: `pipelinePauseCommand` entry, `pipelineResumeCommand` entry, and the between-phase check inside `sharedPhaseLoop` (wrapped in `if (ENABLE_AF_34)`). Disabling the flag must not break existing run behavior — just skip the check.

### Audit events

Add two to `src/lib/audit.ts`:

```ts
export type AuditEvent =
  | ...existing...
  | 'pipeline.pause'
  | 'pipeline.resume';
```

No special `AuditEntry` shape — the standard `meta` field carries pipeline name, ticket, and phase info.

### CLI wiring in `src/cli.ts`

Append to the existing `pipeline` command group:

```ts
pipeline
  .command('pause <ticket>')
  .description('Pause a running pipeline at the next phase boundary')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(pipelinePauseCommand);

pipeline
  .command('resume <ticket>')
  .description('Resume a paused pipeline from the next pending phase')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(pipelineResumeCommand);
```

Import both from `./commands/pipeline.js` alongside the existing three.

### AF-28 renderer — four branches to add

AF-28 shipped (`ef7a39a`). The status renderer does **not** have a central `pipelineStatusIcon` helper — it uses inline `if/else` and ternaries at four sites in `src/commands/pipeline.ts`. AF-34 engineer must add a `'paused'` branch at each site, or the renderer will fall through and display paused runs as `failed` (red ❌).

The four sites, with current line numbers (as of `ef7a39a`):

**1. `renderPipelineState` status-line branches (~L1119–1143).** Currently `if running / else if completed / else (failed)`. Add `else if (state.status === 'paused')`:
```ts
} else if (state.status === 'paused') {
  const started = Date.parse(state.startedAt);
  const elapsed = Number.isNaN(started) ? undefined : now - started;
  const el = elapsed !== undefined ? ` (${formatDuration(elapsed)} elapsed)` : '';
  statusLine = `Status: ${chalk.yellow('paused')}${el}`;
}
```
Consider appending a `pausedAt` note on the next line: `Paused at: <pausedAt>  — resume with af pipeline resume <ticket>`.

**2. `renderRunList` icon ternary (~L1201–1206).** Currently `running ? 🔄 : completed ? ✅ : ❌`. Refactor to cover paused:
```ts
const icon =
  state.status === 'running'  ? '🔄' :
  state.status === 'completed' ? '✅' :
  state.status === 'paused'    ? '⏸️' :
                                 '❌';
```

**3. `renderRunList` trailing-text branches (~L1220–1280).** Currently `if running / else if completed / else (failed)`. Add a `paused` branch showing elapsed time + the next pending phase name:
```ts
} else if (state.status === 'paused') {
  const elapsed = !Number.isNaN(started) ? formatDuration(now - started) : '—';
  const nextPending = firstPendingPhaseName(state); // phases with status !== completed/skipped
  trailing = `${dim(elapsed.padEnd(10))}  paused before: ${nextPending ?? '—'}`;
}
```

**4. `renderRunList` statusWord ternary (~L1282–1287).** Currently `running : completed : failed`. Add paused:
```ts
const statusWord =
  state.status === 'running'   ? chalk.cyan('running  ') :
  state.status === 'completed' ? chalk.green('completed') :
  state.status === 'paused'    ? chalk.yellow('paused   ') :
                                 chalk.red('failed   ');
```

**Tests to add** to `src/__tests__/pipeline-status.test.ts`: fixtures for a paused state exercising both `renderPipelineState` and `renderRunList`, mirroring the existing `completedState()` / `failedState()` pattern.

No refactor is needed — don't extract a `pipelineStatusIcon` helper just for this. The inline pattern matches AF-28's style; stay consistent.

### Tests

`src/__tests__/pipeline-pause-resume.test.ts`:

1. **Sentinel helpers** — `writePauseRequest` is atomic (tmp file doesn't remain), `pauseRequestExists` reflects presence, `removePauseRequest` is idempotent (no-op if absent).
2. **`findNextPendingPhase`** — returns 0 for a fresh state; skips completed; skips skipped; returns `phaseOrder.length` when all done.
3. **Pause command** — refuses on terminal state; refuses when no state; writes sentinel on running state.
4. **Resume command** — refuses on non-paused state; clears sentinel; sets `resumedAt`; invokes loop with correct start index.
5. **Runner pause observation** — fake phase loop with a pre-placed sentinel → state transitions to `paused` before phase[i], no phase spawned, loop returns `'paused'`.
6. **YAML-changed-on-resume** — state has phases {a, b, c}; pipeline now has {a, b, d} → resume refuses.
7. **Feature flag off** — pause command errors out; runner check is skipped (a sentinel in place is ignored).

Use fixture `PipelineState` objects + a temp dir for sentinel tests. Do not spawn actual agent subprocesses — `sharedPhaseLoop` takes injectable `spawn` and `loadResult` callbacks already (AF-27 made that change), so an integration test can mock the agent side and exercise the real loop + pause plumbing.

### Things **not** to do

- Do not send signals to the runner process. Sentinel only.
- Do not implement mid-phase pause. If the AC test suggests you should, it's wrong — re-read §2.
- Do not delete the sentinel inside the runner's pause-observation code. Only `resume` deletes it.
- Do not introduce a PID-tracking file. The sentinel is process-agnostic.
- Do not silently auto-resume on process restart. Resume is explicit.
- Do not bump `state.startedAt` on resume — total wall-clock duration intentionally spans pause time. Use `resumedAt` / `pausedAt` for pause-window calculations if needed.
- Do not add a `--reason` flag to pause. v1 is boolean.

## 7. Resolutions to the Ticket's Open Questions

Direct answers to the four questions in `.af/tasks/open/AF-34.md`:

1. **Signal vs sentinel:** sentinel file. Reasons in §1 and §3.
2. **Mid-phase pause:** no for v1. Reason: killing a running agent subprocess requires result reconciliation we don't have. Not blocking — users can wait at most one phase for pause to take effect.
3. **Resume semantics:** start from the first non-terminal phase (not completed, not skipped). Re-running completed phases would waste compute and overwrite `result.json`. §6 `findNextPendingPhase` is the concrete rule.
4. **Interaction with `--from`:** shared inner loop (`sharedPhaseLoop`), distinct outer UX. `--from` is for explicit manual re-entry with a re-initialized state; `resume` is for continuing a paused run with the existing state preserved. Different callers, same engine.

## 8. Dependencies

- **AF-26** — runner with phase loop (extraction target). Already merged.
- **AF-27** — retry helper is already injectable (engineer will find `runPhaseWithRetry` friendly to the refactor). Already merged.
- **AF-28** — status command. Merged and released (commit `ef7a39a`). AF-34 engineer adds the four `paused` branches to the renderer (§6) as part of the AF-34 commit series — no coordination needed.
- **No new npm packages.**

## 9. Implementation Role

**ENGINEER** — backend CLI only, no frontend. Touches:

- `src/commands/pipeline.ts` — two new command functions, one extracted `sharedPhaseLoop`, between-phase pause check
- `src/lib/pipeline-state.ts` — type extensions, sentinel I/O helpers, `findNextPendingPhase`
- `src/lib/audit.ts` — two new event strings
- `src/lib/constants.ts` — `ENABLE_AF_34` flag
- `src/cli.ts` — register two new subcommands
- `src/__tests__/pipeline-pause-resume.test.ts` — new test file

No web/, no agent markdown, no pipeline YAML schema changes.

**Suggested commit structure within the AF-34 branch:**

1. *Mechanical extraction:* move phase loop into `sharedPhaseLoop`, no behavior change. Verify existing tests pass.
2. *Schema + helpers:* add `PipelineStatus: 'paused'`, `pausedAt`/`resumedAt`, sentinel I/O, `findNextPendingPhase`. Add audit events.
3. *Commands:* `pause` and `resume` commands, CLI wiring, feature flag, runner between-phase check.
4. *Tests:* unit + integration.
5. *AF-28 renderer updates:* add the four `paused` branches in `renderPipelineState` and `renderRunList` (see §6 for exact line targets and snippets) + test fixtures.

Splitting like this keeps each commit reviewable and makes the risky refactor (step 1) its own reverting-unit.

## 10. Feature Flag Specification

| Field | Value |
|---|---|
| Flag name | `ENABLE_AF_34` |
| Location | `src/lib/constants.ts` |
| Default | `true` |
| Guards | `pipelinePauseCommand` entry, `pipelineResumeCommand` entry, between-phase sentinel check inside `sharedPhaseLoop` |
| When false | Pause/resume commands print `✗ Pipeline pause/resume is disabled (ENABLE_AF_34=false).` and exit 1. Runner ignores any pause.request sentinel. `run` and `status` otherwise unaffected. |

## 11. Acceptance Mapping

| AC | Covered by |
|---|---|
| `af pipeline pause <ticket>` marks a running pipeline paused at next phase boundary (no mid-phase interrupt) | §4 pause command + §6 between-phase check |
| `af pipeline resume <ticket>` continues from next unfinished phase, re-using prior artifacts | §4 resume command + §6 `findNextPendingPhase` + shared loop |
| Durable across runner exits | Sentinel + persisted state; resume reconstructs runtime context from state — no live process required |
| `af pipeline status <ticket>` renders paused state | §6 "AF-28 renderer — four branches to add" |
| Pause a completed/failed pipeline is a no-op with clear message | §4 pause command refusal paths |
| Resume a non-paused pipeline is a no-op with clear message | §4 resume command refusal paths |
| Audit log records pause/resume with timestamps | §6 audit hooks + §3 `pausedAt`/`resumedAt` on state |
| Documentation of pause semantics | Engineer updates `docs/project-summary.md` with a short "Pipeline pause/resume" subsection referring to this design |

---

**Ambiguities resolved; nothing outstanding for Product Analyst.** If pause-at-a-specific-phase (`pause --before <phase>`) or pause-with-reason (`pause --reason "..."`) is wanted later, file separately.
