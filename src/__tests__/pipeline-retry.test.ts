/**
 * AF-27: Unit tests for the phase retry loop (runPhaseWithRetry).
 *
 * Covers:
 *   - Gate passes first time → attempts=1, no onRetry callbacks
 *   - Gate fails twice then passes → attempts=3, 2 onRetry callbacks
 *   - Gate fails all attempts → status=failed, failureReason=gate_failure, all failures recorded
 *   - spawn_error: no retry regardless of retry config
 *   - no_result_json: no retry regardless of retry config
 *   - maxAttempts=1 effectively disables retry (AF-26 behavior / ENABLE_AF_27=false path)
 *   - Phase without a gate → first success wins, attempts=1
 *   - Compound `all` gate: final failures contain all failing conditions
 *
 * Run: npx tsx --test src/__tests__/pipeline-retry.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPhaseWithRetry } from '../commands/pipeline.js';
import type { PhaseDefinition } from '../lib/pipeline.js';
import type { ResultSchema } from '../lib/result-schema.js';
import type { GateFailure } from '../lib/gate-evaluator.js';

// ============================================================
// Helpers
// ============================================================

function phase(overrides?: Partial<PhaseDefinition>): PhaseDefinition {
  return {
    name: 'verify',
    agent: 'qa',
    ...overrides,
  };
}

function result(overrides?: Partial<ResultSchema>): ResultSchema {
  return {
    status: 'complete',
    summary: 'ok',
    artifacts: [],
    ...overrides,
  };
}

/** Build a queued spawn fn that returns the given sequence, then throws. */
function queuedSpawn(queue: boolean[]): () => Promise<boolean> {
  let i = 0;
  return async () => {
    if (i >= queue.length) throw new Error('queuedSpawn: out of values');
    return queue[i++];
  };
}

/** Build a queued loadResult fn that returns a sequence of results. */
function queuedResults(
  queue: (ResultSchema | null)[],
): () => ResultSchema | null {
  let i = 0;
  return () => {
    if (i >= queue.length) throw new Error('queuedResults: out of values');
    return queue[i++];
  };
}

// ============================================================
// Gate passes first time
// ============================================================

describe('runPhaseWithRetry — gate passes first time', () => {
  it('returns attempts=1 and no retry callbacks', async () => {
    let retryCalls = 0;
    const out = await runPhaseWithRetry({
      phase: phase({
        gate: { field: 'status', operator: 'eq', value: 'complete', retry: 2 },
      }),
      maxAttempts: 3,
      spawn: queuedSpawn([true]),
      loadResult: queuedResults([result({ status: 'complete' })]),
      onRetry: () => {
        retryCalls += 1;
      },
    });
    assert.equal(out.phaseStatus, 'completed');
    assert.equal(out.attempts, 1);
    assert.equal(out.gateEval?.passed, true);
    assert.equal(retryCalls, 0);
    assert.equal(out.failureReason, undefined);
  });
});

// ============================================================
// Gate fails twice then passes
// ============================================================

describe('runPhaseWithRetry — gate fails then passes', () => {
  it('retries until gate passes and reports attempts correctly', async () => {
    const retryCalls: number[] = [];
    const out = await runPhaseWithRetry({
      phase: phase({
        gate: { field: 'metadata.verdict', operator: 'eq', value: 'PASS', retry: 2 },
      }),
      maxAttempts: 3,
      spawn: queuedSpawn([true, true, true]),
      loadResult: queuedResults([
        result({ metadata: { verdict: 'FAIL' } }),
        result({ metadata: { verdict: 'FAIL' } }),
        result({ metadata: { verdict: 'PASS' } }),
      ]),
      onRetry: (attempt) => {
        retryCalls.push(attempt);
      },
    });
    assert.equal(out.phaseStatus, 'completed');
    assert.equal(out.attempts, 3);
    assert.equal(out.gateEval?.passed, true);
    assert.deepEqual(retryCalls, [1, 2]);
  });
});

// ============================================================
// Gate fails all attempts
// ============================================================

describe('runPhaseWithRetry — gate fails all attempts', () => {
  it('marks phase failed with failureReason=gate_failure, attempts=maxAttempts', async () => {
    const out = await runPhaseWithRetry({
      phase: phase({
        gate: { field: 'metadata.verdict', operator: 'eq', value: 'PASS', retry: 2 },
      }),
      maxAttempts: 3,
      spawn: queuedSpawn([true, true, true]),
      loadResult: queuedResults([
        result({ metadata: { verdict: 'FAIL' } }),
        result({ metadata: { verdict: 'FAIL' } }),
        result({ metadata: { verdict: 'FAIL' } }),
      ]),
    });
    assert.equal(out.phaseStatus, 'failed');
    assert.equal(out.failureReason, 'gate_failure');
    assert.equal(out.attempts, 3);
    assert.equal(out.gateEval?.passed, false);
    assert.equal(out.gateEval?.failures.length, 1);
  });
});

// ============================================================
// spawn_error — no retry
// ============================================================

describe('runPhaseWithRetry — spawn_error fail-fast', () => {
  it('does not retry regardless of configured retry', async () => {
    let spawnCalls = 0;
    const out = await runPhaseWithRetry({
      phase: phase({
        gate: { field: 'status', operator: 'eq', value: 'complete', retry: 3 },
      }),
      maxAttempts: 4,
      spawn: async () => {
        spawnCalls += 1;
        return false;
      },
      loadResult: () => {
        throw new Error('loadResult must not be called on spawn_error');
      },
    });
    assert.equal(out.phaseStatus, 'failed');
    assert.equal(out.failureReason, 'spawn_error');
    assert.equal(out.attempts, 1);
    assert.equal(spawnCalls, 1);
    assert.equal(out.gateEval, null);
  });
});

// ============================================================
// no_result_json — no retry
// ============================================================

describe('runPhaseWithRetry — no_result_json fail-fast', () => {
  it('does not retry when result.json is missing', async () => {
    const out = await runPhaseWithRetry({
      phase: phase({
        gate: { field: 'status', operator: 'eq', value: 'complete', retry: 3 },
      }),
      maxAttempts: 4,
      spawn: queuedSpawn([true]),
      loadResult: queuedResults([null]),
    });
    assert.equal(out.phaseStatus, 'failed');
    assert.equal(out.failureReason, 'no_result_json');
    assert.equal(out.attempts, 1);
  });
});

// ============================================================
// maxAttempts=1 (retry disabled — AF-26 / ENABLE_AF_27=false path)
// ============================================================

describe('runPhaseWithRetry — maxAttempts=1', () => {
  it('behaves like AF-26 single-shot: no retry on gate failure', async () => {
    const out = await runPhaseWithRetry({
      phase: phase({
        gate: { field: 'status', operator: 'eq', value: 'complete' },
      }),
      maxAttempts: 1,
      spawn: queuedSpawn([true]),
      loadResult: queuedResults([result({ status: 'failed' })]),
    });
    assert.equal(out.phaseStatus, 'failed');
    assert.equal(out.failureReason, 'gate_failure');
    assert.equal(out.attempts, 1);
  });
});

// ============================================================
// Phase without gate
// ============================================================

describe('runPhaseWithRetry — phase without a gate', () => {
  it('passes on first successful spawn + result', async () => {
    const out = await runPhaseWithRetry({
      phase: phase(),
      maxAttempts: 1,
      spawn: queuedSpawn([true]),
      loadResult: queuedResults([result()]),
    });
    assert.equal(out.phaseStatus, 'completed');
    assert.equal(out.attempts, 1);
    assert.equal(out.gateEval, null);
  });
});

// ============================================================
// Compound gate — captures all failing conditions on final attempt
// ============================================================

describe('runPhaseWithRetry — compound all gate failure', () => {
  it('returns every failing condition from the final attempt', async () => {
    const out = await runPhaseWithRetry({
      phase: phase({
        gate: {
          all: [
            { field: 'status', operator: 'eq', value: 'complete' },
            { field: 'metadata.verdict', operator: 'eq', value: 'PASS' },
            { field: 'metadata.pr_url', operator: 'exists' },
          ],
        },
      }),
      maxAttempts: 1,
      spawn: queuedSpawn([true]),
      loadResult: queuedResults([
        result({ status: 'partial', metadata: { verdict: 'FAIL' } }),
      ]),
    });
    assert.equal(out.phaseStatus, 'failed');
    assert.equal(out.failureReason, 'gate_failure');
    assert.equal(out.gateEval?.failures.length, 3);
    const fields = out.gateEval!.failures.map((f: GateFailure) => f.condition.field);
    assert.deepEqual(fields, ['status', 'metadata.verdict', 'metadata.pr_url']);
  });
});

// ============================================================
// onRetry receives failures context
// ============================================================

describe('runPhaseWithRetry — onRetry callback', () => {
  it('receives attempt, maxAttempts, and the failing conditions', async () => {
    interface Captured {
      a: number;
      mx: number;
      f: GateFailure[];
    }
    const captures: Captured[] = [];
    await runPhaseWithRetry({
      phase: phase({
        gate: { field: 'status', operator: 'eq', value: 'complete', retry: 1 },
      }),
      maxAttempts: 2,
      spawn: queuedSpawn([true, true]),
      loadResult: queuedResults([
        result({ status: 'failed' }),
        result({ status: 'complete' }),
      ]),
      onRetry: (a, mx, f) => {
        captures.push({ a, mx, f });
      },
    });
    assert.equal(captures.length, 1);
    assert.equal(captures[0].a, 1);
    assert.equal(captures[0].mx, 2);
    assert.equal(captures[0].f.length, 1);
    assert.equal(captures[0].f[0].condition.field, 'status');
  });
});
