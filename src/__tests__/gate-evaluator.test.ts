/**
 * AF-26: Unit tests for gate-evaluator.ts
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run: npx tsx --test src/__tests__/gate-evaluator.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../lib/gate-evaluator.js';
import type { GateDefinition } from '../lib/pipeline.js';
import type { ResultSchema } from '../lib/result-schema.js';

// ============================================================
// Helpers
// ============================================================

function makeResult(overrides?: Partial<ResultSchema>): ResultSchema {
  return {
    status: 'complete',
    summary: 'ok',
    artifacts: [],
    ...overrides,
  };
}

// ============================================================
// eq / neq
// ============================================================

describe('evaluateGate — eq', () => {
  it('passes when string equals', () => {
    const gate: GateDefinition = { field: 'status', operator: 'eq', value: 'complete' };
    const r = evaluateGate(gate, makeResult({ status: 'complete' }));
    assert.equal(r.passed, true);
  });

  it('fails when string differs', () => {
    const gate: GateDefinition = { field: 'status', operator: 'eq', value: 'complete' };
    const r = evaluateGate(gate, makeResult({ status: 'failed' }));
    assert.equal(r.passed, false);
    if (!r.passed) {
      assert.equal(r.field, 'status');
      assert.equal(r.operator, 'eq');
      assert.equal(r.expected, 'complete');
      assert.equal(r.actual, 'failed');
      assert.match(r.message, /Gate failed at status/);
    }
  });

  it('passes when number equals', () => {
    const gate: GateDefinition = { field: 'metadata.count', operator: 'eq', value: 42 };
    const r = evaluateGate(gate, makeResult({ metadata: { count: 42 } }));
    assert.equal(r.passed, true);
  });

  it('passes when boolean equals', () => {
    const gate: GateDefinition = { field: 'metadata.ok', operator: 'eq', value: true };
    const r = evaluateGate(gate, makeResult({ metadata: { ok: true } }));
    assert.equal(r.passed, true);
  });
});

describe('evaluateGate — neq', () => {
  it('passes when values differ', () => {
    const gate: GateDefinition = { field: 'status', operator: 'neq', value: 'failed' };
    const r = evaluateGate(gate, makeResult({ status: 'complete' }));
    assert.equal(r.passed, true);
  });

  it('fails when values equal', () => {
    const gate: GateDefinition = { field: 'status', operator: 'neq', value: 'complete' };
    const r = evaluateGate(gate, makeResult({ status: 'complete' }));
    assert.equal(r.passed, false);
  });
});

// ============================================================
// exists / not_exists
// ============================================================

describe('evaluateGate — exists', () => {
  it('passes when field has a value', () => {
    const gate: GateDefinition = { field: 'metadata.pr_url', operator: 'exists' };
    const r = evaluateGate(gate, makeResult({ metadata: { pr_url: 'https://x' } }));
    assert.equal(r.passed, true);
  });

  it('fails when field is missing', () => {
    const gate: GateDefinition = { field: 'metadata.pr_url', operator: 'exists' };
    const r = evaluateGate(gate, makeResult({ metadata: {} }));
    assert.equal(r.passed, false);
    if (!r.passed) {
      assert.match(r.message, /expected field to exist/);
    }
  });

  it('fails when field is null', () => {
    const gate: GateDefinition = { field: 'metadata.pr_url', operator: 'exists' };
    const r = evaluateGate(gate, makeResult({ metadata: { pr_url: null as unknown as string } }));
    assert.equal(r.passed, false);
  });

  it('passes for empty string (not null/undefined)', () => {
    const gate: GateDefinition = { field: 'metadata.x', operator: 'exists' };
    const r = evaluateGate(gate, makeResult({ metadata: { x: '' } }));
    assert.equal(r.passed, true);
  });

  it('passes for 0 (not null/undefined)', () => {
    const gate: GateDefinition = { field: 'metadata.x', operator: 'exists' };
    const r = evaluateGate(gate, makeResult({ metadata: { x: 0 } }));
    assert.equal(r.passed, true);
  });

  it('passes for false (not null/undefined)', () => {
    const gate: GateDefinition = { field: 'metadata.x', operator: 'exists' };
    const r = evaluateGate(gate, makeResult({ metadata: { x: false } }));
    assert.equal(r.passed, true);
  });
});

describe('evaluateGate — not_exists', () => {
  it('passes when field missing', () => {
    const gate: GateDefinition = { field: 'metadata.missing', operator: 'not_exists' };
    const r = evaluateGate(gate, makeResult({ metadata: {} }));
    assert.equal(r.passed, true);
  });

  it('fails when field has value', () => {
    const gate: GateDefinition = { field: 'metadata.x', operator: 'not_exists' };
    const r = evaluateGate(gate, makeResult({ metadata: { x: 'y' } }));
    assert.equal(r.passed, false);
    if (!r.passed) {
      assert.match(r.message, /expected field to not exist/);
    }
  });
});

// ============================================================
// contains
// ============================================================

describe('evaluateGate — contains', () => {
  it('passes when string contains substring', () => {
    const gate: GateDefinition = { field: 'summary', operator: 'contains', value: 'ok' };
    const r = evaluateGate(gate, makeResult({ summary: 'all ok here' }));
    assert.equal(r.passed, true);
  });

  it('fails when string does not contain substring', () => {
    const gate: GateDefinition = { field: 'summary', operator: 'contains', value: 'missing' };
    const r = evaluateGate(gate, makeResult({ summary: 'all ok here' }));
    assert.equal(r.passed, false);
  });

  it('passes when array contains value', () => {
    const gate: GateDefinition = { field: 'blockers', operator: 'contains', value: 'api' };
    const r = evaluateGate(gate, makeResult({ blockers: ['auth', 'api'] }));
    assert.equal(r.passed, true);
  });

  it('fails when array does not contain value', () => {
    const gate: GateDefinition = { field: 'blockers', operator: 'contains', value: 'api' };
    const r = evaluateGate(gate, makeResult({ blockers: ['auth'] }));
    assert.equal(r.passed, false);
  });

  it('fails when actual is not string or array', () => {
    const gate: GateDefinition = { field: 'metadata.count', operator: 'contains', value: 1 };
    const r = evaluateGate(gate, makeResult({ metadata: { count: 42 } }));
    assert.equal(r.passed, false);
  });
});

// ============================================================
// Numeric comparisons
// ============================================================

describe('evaluateGate — gt/gte/lt/lte', () => {
  it('gt passes when actual > value', () => {
    const gate: GateDefinition = { field: 'metadata.n', operator: 'gt', value: 5 };
    const r = evaluateGate(gate, makeResult({ metadata: { n: 10 } }));
    assert.equal(r.passed, true);
  });

  it('gt fails when actual === value', () => {
    const gate: GateDefinition = { field: 'metadata.n', operator: 'gt', value: 5 };
    const r = evaluateGate(gate, makeResult({ metadata: { n: 5 } }));
    assert.equal(r.passed, false);
  });

  it('gte passes when actual === value', () => {
    const gate: GateDefinition = { field: 'metadata.n', operator: 'gte', value: 5 };
    const r = evaluateGate(gate, makeResult({ metadata: { n: 5 } }));
    assert.equal(r.passed, true);
  });

  it('lt passes when actual < value', () => {
    const gate: GateDefinition = { field: 'metadata.n', operator: 'lt', value: 5 };
    const r = evaluateGate(gate, makeResult({ metadata: { n: 3 } }));
    assert.equal(r.passed, true);
  });

  it('lte passes when actual === value', () => {
    const gate: GateDefinition = { field: 'metadata.n', operator: 'lte', value: 5 };
    const r = evaluateGate(gate, makeResult({ metadata: { n: 5 } }));
    assert.equal(r.passed, true);
  });

  it('fails with clear message when actual is non-numeric', () => {
    const gate: GateDefinition = { field: 'metadata.n', operator: 'gt', value: 5 };
    const r = evaluateGate(gate, makeResult({ metadata: { n: 'not-a-number' } }));
    assert.equal(r.passed, false);
    if (!r.passed) {
      assert.match(r.message, /requires numeric operands/);
    }
  });

  it('coerces numeric strings', () => {
    const gate: GateDefinition = { field: 'metadata.n', operator: 'gt', value: 5 };
    const r = evaluateGate(gate, makeResult({ metadata: { n: '10' } }));
    assert.equal(r.passed, true);
  });
});

// ============================================================
// Dot-path field access
// ============================================================

describe('evaluateGate — dot-path field access', () => {
  it('accesses nested field', () => {
    const gate: GateDefinition = { field: 'metadata.deep.nested', operator: 'eq', value: 'v' };
    const r = evaluateGate(gate, makeResult({ metadata: { deep: { nested: 'v' } } }));
    assert.equal(r.passed, true);
  });

  it('returns undefined for missing top-level field', () => {
    const gate: GateDefinition = { field: 'missing', operator: 'eq', value: 'x' };
    const r = evaluateGate(gate, makeResult());
    assert.equal(r.passed, false);
    if (!r.passed) {
      assert.equal(r.actual, undefined);
    }
  });

  it('returns undefined when traversing through missing parent', () => {
    const gate: GateDefinition = { field: 'metadata.missing.nested', operator: 'exists' };
    const r = evaluateGate(gate, makeResult({ metadata: {} }));
    assert.equal(r.passed, false);
  });
});

// ============================================================
// Failure message shape
// ============================================================

describe('evaluateGate — failure message contains context', () => {
  it('includes field, operator, expected, and actual', () => {
    const gate: GateDefinition = { field: 'status', operator: 'eq', value: 'complete' };
    const r = evaluateGate(gate, makeResult({ status: 'failed' }));
    assert.equal(r.passed, false);
    if (!r.passed) {
      assert.equal(r.field, 'status');
      assert.equal(r.operator, 'eq');
      assert.equal(r.expected, 'complete');
      assert.equal(r.actual, 'failed');
      assert.match(r.message, /status/);
      assert.match(r.message, /complete/);
      assert.match(r.message, /failed/);
    }
  });
});
