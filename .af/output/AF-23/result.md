# AF-23: Structured Agent Output — Implementation Result

## Summary

Implemented structured `result.json` output for the agent pipeline system. After an agent completes, `spawn-runner.ts` now extracts a machine-readable result from the agent's output (via a `result-json` fenced block) or synthesizes a minimal fallback result.

## Files Changed

### New
- `src/lib/result-schema.ts` — `ResultSchema` interface, `validateResult()`, `extractResultJson()`, `synthesizeResult()`
- `src/__tests__/result-schema.test.ts` — 32 unit tests covering all three exported functions

### Modified
- `src/lib/constants.ts` — Added `ENABLE_AF_23 = true` feature flag
- `src/spawn-runner.ts` — Extract/synthesize result.json in success and failure paths; enhanced audit meta
- `agents/architect.md` — Added "Structured Result Output" section to "When Finished"
- `agents/engineer.md` — Added "Structured Result Output" section to "When Finished"
- `agents/qa.md` — Added "Structured Result Output" section to "When Finished"

## Acceptance Criteria

- [x] `ResultSchema` interface exists in `src/lib/result-schema.ts`
- [x] `spawn-runner.ts` extracts or synthesizes `result.json` after agent completion
- [x] Architect agent prompt instructs it to emit a result JSON block with `artifacts` listing the design doc path
- [x] Engineer agent prompt instructs it to emit a result JSON block with `pr_url` in metadata
- [x] QA agent prompt instructs it to emit a result JSON block with `verdict` in metadata
- [x] Existing `result.md` and `status.json` behavior is unchanged (backward compatible)
- [x] Unit tests verify `result.json` extraction and validation (32 tests, all passing)

## Deviations

None. Implementation follows the design document precisely.
