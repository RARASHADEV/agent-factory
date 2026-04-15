# AF-34 — Pipeline Pause/Resume: Implementation Result

**Branch:** `engineer/AF-34`
**Commits:** 5 atomic commits (see below)
**Status:** ready-for-qa
**Tests:** 274 pass (243 baseline + 31 new), type-check clean, build clean

## What was built

Two new CLI commands — `af pipeline pause <ticket>` and `af pipeline resume <ticket>` —
plus the runner/schema/renderer changes they require. Implementation follows the
technical design in `docs/designs/AF-34-pipeline-pause-resume.md` verbatim.

### Commands

- `af pipeline pause <ticket>` — writes an atomic sentinel file at
  `.af/output/<ticket>/pause.request`. The runner observes it on its next
  between-phase check and exits cleanly.
- `af pipeline resume <ticket>` — clears the sentinel, validates that the
  pipeline YAML's phase set hasn't structurally changed since pause, computes
  the first non-terminal phase via `findNextPendingPhase`, sets `resumedAt`,
  and re-enters `sharedPhaseLoop` — the same engine used by `af pipeline run`.

### Semantics (per §1 of the design)

- **Sentinel-based, not signal-based** — durable across runner process exits.
- **Between-phase only** — a running agent subprocess is never interrupted.
- **Resume = next pending phase** — completed/skipped phases are never re-run.
- **Shared inner loop** — `run` and `resume` share `sharedPhaseLoop`; only the
  outer preamble differs.
- Pause is a no-op with a clear error on completed/failed/already-paused pipelines.
- Resume is a no-op with a clear error on non-paused pipelines (with guidance
  to use `pipeline run --from <phase>` for crash recovery).
- YAML phase-set compatibility check: if the pipeline definition was edited to
  add or remove phases since pause, resume refuses.

## Commits on this branch

| # | Commit | What |
|---|--------|------|
| 1 | `b505beb` | Extract `sharedPhaseLoop` — mechanical refactor of `pipelineRunCommand`, no behavior change. Prepares for shared engine. |
| 2 | `638a87b` | Schema + sentinel I/O + audit events + `ENABLE_AF_34` flag. |
| 3 | `cbb91ca` | `pipelinePauseCommand`, `pipelineResumeCommand`, between-phase pause check in `sharedPhaseLoop`, CLI wiring. |
| 4 | `a745c77` | 28 new unit/integration tests. |
| 5 | `405281c` | 4 renderer branches for `paused` state in `renderPipelineState` and `renderRunList` + 3 renderer tests. |

## Files touched

| File | Change |
|---|---|
| `src/commands/pipeline.ts` | Extracted `sharedPhaseLoop`, added between-phase pause check, two new commands, four `paused` renderer branches |
| `src/lib/pipeline-state.ts` | `'paused'` in `PipelineStatus` union; `pausedAt`/`resumedAt` fields; `PauseRequest` type; atomic `writePauseRequest` (write-temp + rename); `pauseRequestExists`, `readPauseRequest`, `removePauseRequest` (idempotent); pure `findNextPendingPhase` |
| `src/lib/audit.ts` | `pipeline.pause`, `pipeline.resume` audit events |
| `src/lib/constants.ts` | `ENABLE_AF_34 = true` feature flag |
| `src/cli.ts` | Register `pause` and `resume` subcommands |
| `src/__tests__/pipeline-pause-resume.test.ts` | New file: 28 tests / 6 suites |
| `src/__tests__/pipeline-status.test.ts` | Added `pausedState()` fixture + 3 tests |

## Acceptance criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `af pipeline pause <ticket>` marks pipeline as `paused` at next phase boundary (no mid-phase interrupt) | ✅ |
| 2 | `af pipeline resume <ticket>` continues from next unfinished phase, re-using prior artifacts | ✅ |
| 3 | Pause is durable across runner exits | ✅ (sentinel + persisted state; resume reconstructs context from state — no live process required) |
| 4 | `af pipeline status <ticket>` renders `paused` state | ✅ (four renderer branches; 3 tests verify) |
| 5 | Pausing a completed/failed/already-paused pipeline is a no-op with clear message | ✅ |
| 6 | Resuming a non-paused pipeline is a no-op with clear message | ✅ |
| 7 | Audit log records `pipeline.pause` and `pipeline.resume` with timestamps | ✅ |
| 8 | Documentation in `docs/project-summary.md` describing pause semantics | ⚠️ **Deviation — deferred** |

## Deviations from the design

**One deviation: acceptance criterion #8 (documentation update).**

The engineer role's output permissions (per agent instructions) explicitly forbid
creating or modifying any files under `docs/`. The documentation update should be
picked up by a **documentalist** as a follow-up task — the design's §11
"Acceptance Mapping" row for this AC reads simply "Engineer updates
`docs/project-summary.md` with a short 'Pipeline pause/resume' subsection",
which conflicts with the role boundary.

The commands, their semantics, and the design itself are all self-describing
via `--help` and the design doc in `docs/designs/AF-34-*.md`, so the ship risk
of deferring the prose update is low. Suggested follow-up task:
`documentalist: add "Pipeline pause/resume" subsection to docs/project-summary.md`.

No deviations on code, schema, tests, or UX.

## Test summary

```
# tests 274
# suites 58
# pass 274
# fail 0
```

Breakdown of new tests:

- **Sentinel helpers** (6): atomic write, existence/read/remove, idempotency, malformed JSON tolerance, missing-dir guard.
- **`findNextPendingPhase`** (6): fresh state, skips completed, skips skipped, all-done, failed mid-run, defensive on missing records.
- **`pipelinePauseCommand`** (6): refusals on no-state/completed/failed/already-paused; happy-path writes sentinel without mutating state; case-insensitive ticket.
- **`pipelineResumeCommand`** (7): refusals on no-state/completed/failed/running/missing-YAML/structurally-changed-YAML; degenerate all-done auto-completes.
- **`sharedPhaseLoop` pause observation** (2): pre-placed sentinel at startIndex=0 and startIndex>0 → outcome=`'paused'`, state correctly transitions, sentinel preserved for resume.
- **Paused-state round-trip** (1): `pausedAt`/`resumedAt` serialize and re-parse correctly.
- **Paused renderer** (3): status line, list trailing text, pause icon (not ❌).

## Notes for QA

1. **Manual smoke test (optional but illustrative):**
   ```bash
   # Terminal 1: start a pipeline
   af pipeline run sdlc --task AF-X
   # Terminal 2: pause it
   af pipeline pause AF-X
   # Verify status shows paused between phases
   af pipeline status AF-X
   # Resume
   af pipeline resume AF-X
   ```

2. **Audit events** are gated by `ENABLE_AF_8` (currently `false`), so you won't
   see log lines in `audit.log` until that flag is flipped. The code paths are
   exercised — the audit calls are unconditional from this feature's perspective.

3. **Feature flag `ENABLE_AF_34 = true`** by default. Flipping it to `false`
   disables both commands (exit 1 with a clear message) and skips the
   between-phase sentinel check — existing `run` behavior unchanged.

4. **Pipeline YAML compatibility check** — if you want to test the structural
   mismatch refusal: pause a run, edit the YAML to add/remove a phase, then
   `resume` — you'll get the compatibility error.
