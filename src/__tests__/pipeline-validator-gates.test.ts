/**
 * AF-27: Validator tests for the extended gate schema.
 *
 * Covers:
 *   - Shorthand gates (AF-26 backward compat)
 *   - Compound `all` / `any` acceptance
 *   - Rejection of invalid combinations (shorthand + all, all + any, empty)
 *   - Retry bounds (≤ MAX_GATE_RETRY, integer, >= 0)
 *   - `matches` operator pre-validation (regex + string requirement)
 *   - Structural rejection (non-object, empty arrays)
 *
 * Run: npx tsx --test src/__tests__/pipeline-validator-gates.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePipeline, MAX_GATE_RETRY } from '../lib/pipeline.js';

function withGate(gate: unknown): Record<string, unknown> {
  return {
    name: 'test',
    phases: [{ name: 'build', agent: 'engineer', gate }],
  };
}

// ============================================================
// Shorthand (backward compat with AF-26)
// ============================================================

describe('validator — shorthand gates (AF-26 compat)', () => {
  it('accepts { field, operator, value } eq', () => {
    const r = validatePipeline(
      withGate({ field: 'status', operator: 'eq', value: 'complete' }),
    );
    assert.equal(r.valid, true);
  });

  it('accepts existence operators without value', () => {
    const r = validatePipeline(
      withGate({ field: 'metadata.pr_url', operator: 'exists' }),
    );
    assert.equal(r.valid, true);
  });

  it('rejects unknown operator', () => {
    const r = validatePipeline(
      withGate({ field: 'status', operator: 'banana', value: 'x' }),
    );
    assert.equal(r.valid, false);
    if (!r.valid) {
      assert.ok(r.errors.some((e) => e.includes('invalid operator')));
    }
  });

  it('rejects operator missing required value', () => {
    const r = validatePipeline(withGate({ field: 'status', operator: 'eq' }));
    assert.equal(r.valid, false);
  });
});

// ============================================================
// Compound all / any
// ============================================================

describe('validator — compound gates', () => {
  it('accepts all[] with multiple conditions', () => {
    const r = validatePipeline(
      withGate({
        all: [
          { field: 'status', operator: 'eq', value: 'complete' },
          { field: 'metadata.pr_url', operator: 'exists' },
        ],
      }),
    );
    assert.equal(r.valid, true);
  });

  it('accepts any[] with multiple conditions', () => {
    const r = validatePipeline(
      withGate({
        any: [
          { field: 'metadata.pr_url', operator: 'exists' },
          { field: 'metadata.skipped', operator: 'eq', value: true },
        ],
      }),
    );
    assert.equal(r.valid, true);
  });

  it('rejects empty all[]', () => {
    const r = validatePipeline(withGate({ all: [] }));
    assert.equal(r.valid, false);
    if (!r.valid) {
      assert.ok(r.errors.some((e) => e.includes('at least one condition')));
    }
  });

  it('rejects empty any[]', () => {
    const r = validatePipeline(withGate({ any: [] }));
    assert.equal(r.valid, false);
  });

  it('rejects shorthand + all in the same gate', () => {
    const r = validatePipeline(
      withGate({
        field: 'status',
        operator: 'eq',
        value: 'complete',
        all: [{ field: 'x', operator: 'exists' }],
      }),
    );
    assert.equal(r.valid, false);
    if (!r.valid) {
      assert.ok(r.errors.some((e) => e.includes('cannot mix shorthand')));
    }
  });

  it('rejects all + any together', () => {
    const r = validatePipeline(
      withGate({
        all: [{ field: 'x', operator: 'exists' }],
        any: [{ field: 'y', operator: 'exists' }],
      }),
    );
    assert.equal(r.valid, false);
    if (!r.valid) {
      assert.ok(r.errors.some((e) => e.includes("cannot specify both 'all' and 'any'")));
    }
  });

  it('rejects a gate object with no conditions at all', () => {
    const r = validatePipeline(withGate({}));
    assert.equal(r.valid, false);
    if (!r.valid) {
      assert.ok(r.errors.some((e) => e.includes('must specify a condition')));
    }
  });

  it('rejects non-object condition inside all[]', () => {
    const r = validatePipeline(withGate({ all: ['not an object'] }));
    assert.equal(r.valid, false);
  });

  it('rejects invalid operator inside any[]', () => {
    const r = validatePipeline(
      withGate({ any: [{ field: 'x', operator: 'frobnicate', value: 1 }] }),
    );
    assert.equal(r.valid, false);
  });
});

// ============================================================
// matches operator pre-validation
// ============================================================

describe('validator — matches operator', () => {
  it('accepts matches with a valid regex pattern', () => {
    const r = validatePipeline(
      withGate({ field: 'metadata.pr_url', operator: 'matches', value: '^https://' }),
    );
    assert.equal(r.valid, true);
  });

  it('rejects matches without a value', () => {
    const r = validatePipeline(
      withGate({ field: 'metadata.pr_url', operator: 'matches' }),
    );
    assert.equal(r.valid, false);
  });

  it('rejects matches with a non-string value', () => {
    const r = validatePipeline(
      withGate({ field: 'metadata.pr_url', operator: 'matches', value: 42 }),
    );
    assert.equal(r.valid, false);
    if (!r.valid) {
      assert.ok(r.errors.some((e) => e.includes('requires a string pattern')));
    }
  });

  it('rejects matches with an invalid regex', () => {
    const r = validatePipeline(
      withGate({
        field: 'metadata.pr_url',
        operator: 'matches',
        value: '[invalid-regex',
      }),
    );
    assert.equal(r.valid, false);
    if (!r.valid) {
      assert.ok(r.errors.some((e) => e.includes('invalid regex')));
    }
  });
});

// ============================================================
// Retry bounds
// ============================================================

describe('validator — retry', () => {
  it('accepts retry = 0', () => {
    const r = validatePipeline(
      withGate({ field: 'status', operator: 'eq', value: 'complete', retry: 0 }),
    );
    assert.equal(r.valid, true);
  });

  it('accepts retry = 3', () => {
    const r = validatePipeline(
      withGate({ field: 'status', operator: 'eq', value: 'complete', retry: 3 }),
    );
    assert.equal(r.valid, true);
  });

  it(`accepts retry = ${MAX_GATE_RETRY} (upper bound inclusive)`, () => {
    const r = validatePipeline(
      withGate({
        field: 'status',
        operator: 'eq',
        value: 'complete',
        retry: MAX_GATE_RETRY,
      }),
    );
    assert.equal(r.valid, true);
  });

  it('rejects retry > MAX_GATE_RETRY', () => {
    const r = validatePipeline(
      withGate({
        field: 'status',
        operator: 'eq',
        value: 'complete',
        retry: MAX_GATE_RETRY + 1,
      }),
    );
    assert.equal(r.valid, false);
    if (!r.valid) {
      assert.ok(r.errors.some((e) => e.includes(`≤ ${MAX_GATE_RETRY}`)));
    }
  });

  it('rejects negative retry', () => {
    const r = validatePipeline(
      withGate({ field: 'status', operator: 'eq', value: 'complete', retry: -1 }),
    );
    assert.equal(r.valid, false);
  });

  it('rejects non-integer retry', () => {
    const r = validatePipeline(
      withGate({ field: 'status', operator: 'eq', value: 'complete', retry: 1.5 }),
    );
    assert.equal(r.valid, false);
  });

  it('rejects non-numeric retry', () => {
    const r = validatePipeline(
      withGate({
        field: 'status',
        operator: 'eq',
        value: 'complete',
        retry: 'many' as unknown as number,
      }),
    );
    assert.equal(r.valid, false);
  });

  it('accepts retry on a compound gate', () => {
    const r = validatePipeline(
      withGate({
        all: [
          { field: 'status', operator: 'eq', value: 'complete' },
          { field: 'metadata.pr_url', operator: 'exists' },
        ],
        retry: 2,
      }),
    );
    assert.equal(r.valid, true);
  });
});

// ============================================================
// Structural rejection
// ============================================================

describe('validator — structural errors', () => {
  it('rejects non-object gate', () => {
    const r = validatePipeline(withGate('not-an-object'));
    assert.equal(r.valid, false);
  });

  it('rejects array gate', () => {
    const r = validatePipeline(withGate([{ field: 'x', operator: 'exists' }]));
    assert.equal(r.valid, false);
  });

  it('rejects null gate', () => {
    const r = validatePipeline(withGate(null));
    assert.equal(r.valid, false);
  });
});
