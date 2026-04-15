# AF-28 — Pipeline status command — Implementation Result

## Summary

Implemented `af pipeline status [ticket]` per the technical design in `docs/designs/AF-28-pipeline-status.md`. Pure read-only renderer over `pipeline-state.json` — no changes to the runner, no new schema.

## Scope delivered

- **`af pipeline status <ticket>`** — full phase-by-phase breakdown, including gate failure + remediation lines for failed phases and live elapsed duration for the currently-running phase.
- **`af pipeline status`** (no ticket) — one-line summary per run across `.af/output/*/pipeline-state.json`, sorted newest-first.
- **`--json`** — raw `PipelineState` (single) or array (list), sorted in list mode to match pretty output.
- **Exit codes** — 0 on render (any pipeline status); 1 only on infrastructure errors (no project / no state file / malformed state file).

## Files changed

| File | Change |
|---|---|
| `src/lib/constants.ts` | Added `ENABLE_AF_28 = true` feature flag |
| `src/lib/audit.ts` | Added `'pipeline.status_check'` to the `AuditEvent` union |
| `src/commands/pipeline.ts` | Added `pipelineStatusCommand`, `renderPipelineState`, `renderRunList`, `findPipelineRuns`, `livePhaseDurationMs`, `renderPhaseLine`, `renderPhaseFailureDetail`, `formatPhaseStatusColumn`, `formatRelative`. Refactored `printSuccessSummary` + `printFailureSummary` to use the new shared helpers (no output-format change). |
| `src/cli.ts` | Registered `af pipeline status [ticket] [--json] [-p, --project]` subcommand |
| `src/__tests__/pipeline-status.test.ts` | New test file — 17 unit tests covering render helpers and command behavior |

## Tests

- New: 17 tests in `pipeline-status.test.ts` — all pass.
- Full suite: **243/243 pass** (`npx tsx --test src/__tests__/*.test.ts`).
- Type-check: clean (`npx tsc --noEmit`).
- Build: clean (`npm run build`).

## Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| `af pipeline status AF-30` shows phase-by-phase breakdown | ✅ | `renderPipelineState` + smoke test in `/tmp/af-28-smoke` |
| `af pipeline status` (no ticket) lists all runs | ✅ | `renderRunList` + `findPipelineRuns` |
| Phase rows show icon, name, agent, duration, gate result | ✅ | `renderPhaseLine` — shared with `run` success/failure summaries |
| Failed phases show gate failure message + remediation | ✅ | `renderPhaseFailureDetail` reused from `printFailureSummary` |
| `af pipeline list` shows available pipelines with descriptions | ✅ | Already implemented by AF-26 (`pipelineListCommand`); verified still works |
| `--json` flag outputs machine-readable format | ✅ | Raw `PipelineState` / array |
| Works for running, completed, failed pipelines | ✅ | Three-status rendering + live duration test |

## Deviations from design

None. Followed the design as written:

- Reused `formatDuration` / `phaseIcon` in place.
- Extracted the two small per-phase helpers (`renderPhaseLine`, `renderPhaseFailureDetail`) and adopted them in the existing success/failure printers — single source of truth.
- No "paused" status (confirmed in design, split into AF-34).
- No PID liveness detection (out of scope, runner doesn't record PID).
- No `--watch` (out of scope).
- Added the optional `pipeline.status_check` audit event per the design's recommendation (option B).

## Notes for QA

- Run `af pipeline run <pipeline> --task <ticket>` to produce a state file, then call `af pipeline status <ticket>` at any point during execution to see the live phase.
- A completed pipeline will show `Status: completed (<total>)` with all phases ticked; a failed one will show the red `gate: fail` row plus the failure message and remediation.
- `--json` output is exactly what's on disk — not a derived view — so scripts can rely on the `PipelineState` shape in `src/lib/pipeline-state.ts`.
