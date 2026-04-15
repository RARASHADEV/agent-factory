/**
 * AF-27: Unit tests for gate-evaluator.ts
 *
 * Covers:
 *   - All 10 operators including `matches` (regex)
 *   - Shorthand (single-condition) gates — backward compat with AF-26
 *   - Compound gates: `all` (AND), `any` (OR)
 *   - Dot-path field access incl. bracket / numeric indexing
 *   - Human-readable messages with expected-vs-actual
 *   - Remediation hints on failures
 *   - Defensive handling (invalid regex, empty gate)
 *
 * Uses Node.js built-in test runner (node:test).
 * Run: npx tsx --test src/__tests__/gate-evaluator.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, evaluateCondition } from '../lib/gate-evaluator.js';
import type { GateDefinition, GateCondition } from '../lib/pipeline.js';
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
// Shorthand — eq / neq
// ============================================================

describe('evaluateGate — shorthand eq', () => {
  it('passes when string equals', () => {
    const gate: GateDefinition = { field: 'status', operator: 'eq', value: 'complete' };
    const r = evaluateGate(gate, makeResult({ status: 'complete' }));
    assert.equal(r.passed, true);
    assert.equal(r.failures.length, 0);
    assert.equal(r.mode, 'single');
  });

  it('fails when string differs — failure carries full context', () => {
    const gate: GateDefinition = { field: 'status', operator: 'eq', value: 'complete' };
    const r = evaluateGate(gate, makeResult({ status: 'failed' }));
    assert.equal(r.passed, false);
    assert.equal(r.failures.length, 1);
    const f = r.failures[0];
    assert.equal(f.condition.field, 'status');
    assert.equal(f.condition.operator, 'eq');
    assert.equal(f.condition.value, 'complete');
    assert.equal(f.actual, 'failed');
    assert.match(f.message, /Gate failed at status/);
    assert.match(f.message, /complete/);
    assert.match(f.message, /failed/);
    assert.ok(f.remediation, 'remediation should be present');
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

describe('evaluateGate — shorthand neq', () => {
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
    assert.match(r.failures[0].message, /expected field to exist/);
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
    assert.match(r.failures[0].message, /expected field to not exist/);
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
// matches (regex)
// ============================================================

describe('evaluateGate — matches', () => {
  it('passes when string matches simple regex', () => {
    const gate: GateDefinition = {
      field: 'metadata.pr_url',
      operator: 'matches',
      value: '^https://github\\.com/',
    };
    const r = evaluateGate(
      gate,
      makeResult({ metadata: { pr_url: 'https://github.com/x/y/pull/1' } }),
    );
    assert.equal(r.passed, true);
  });

  it('fails with clear message when string does not match', () => {
    const gate: GateDefinition = {
      field: 'metadata.pr_url',
      operator: 'matches',
      value: '^https://gitlab\\.com/',
    };
    const r = evaluateGate(
      gate,
      makeResult({ metadata: { pr_url: 'https://github.com/x/y' } }),
    );
    assert.equal(r.passed, false);
    const f = r.failures[0];
    assert.match(f.message, /expected to match/);
    assert.ok(f.remediation);
  });

  it('fails when actual is not a string', () => {
    const gate: GateDefinition = {
      field: 'metadata.count',
      operator: 'matches',
      value: '^\\d+$',
    };
    const r = evaluateGate(gate, makeResult({ metadata: { count: 42 } }));
    assert.equal(r.passed, false);
    assert.match(r.failures[0].message, /expected string for regex match/);
  });

  it('fails gracefully (no throw) when regex is invalid', () => {
    const gate: GateDefinition = {
      field: 'summary',
      operator: 'matches',
      value: '[invalid-regex',
    };
    const r = evaluateGate(gate, makeResult({ summary: 'anything' }));
    assert.equal(r.passed, false);
    assert.match(r.failures[0].message, /not a valid regex/);
  });

  it('matches character classes / repetition', () => {
    const gate: GateDefinition = {
      field: 'summary',
      operator: 'matches',
      value: '^[A-Z][A-Z]-\\d+:',
    };
    const r = evaluateGate(gate, makeResult({ summary: 'AF-27: done' }));
    assert.equal(r.passed, true);
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
    assert.match(r.failures[0].message, /requires numeric operands/);
  });

  it('coerces numeric strings', () => {
    const gate: GateDefinition = { field: 'metadata.n', operator: 'gt', value: 5 };
    const r = evaluateGate(gate, makeResult({ metadata: { n: '10' } }));
    assert.equal(r.passed, true);
  });
});

// ============================================================
// Dot-path field access — incl. bracket / numeric indexing
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
    assert.equal(r.failures[0].actual, undefined);
  });

  it('returns undefined when traversing through missing parent', () => {
    const gate: GateDefinition = { field: 'metadata.missing.nested', operator: 'exists' };
    const r = evaluateGate(gate, makeResult({ metadata: {} }));
    assert.equal(r.passed, false);
  });

  it('supports bracket indexing into arrays (artifacts[0].path)', () => {
    const gate: GateDefinition = {
      field: 'artifacts[0].path',
      operator: 'eq',
      value: 'docs/x.md',
    };
    const r = evaluateGate(
      gate,
      makeResult({
        artifacts: [
          { type: 'design_document', path: 'docs/x.md' },
          { type: 'pr', path: 'https://x' },
        ],
      }),
    );
    assert.equal(r.passed, true);
  });

  it('supports numeric dotted indexing (artifacts.1.path)', () => {
    const gate: GateDefinition = {
      field: 'artifacts.1.path',
      operator: 'eq',
      value: 'https://x',
    };
    const r = evaluateGate(
      gate,
      makeResult({
        artifacts: [
          { type: 'design_document', path: 'docs/x.md' },
          { type: 'pr', path: 'https://x' },
        ],
      }),
    );
    assert.equal(r.passed, true);
  });

  it('returns undefined for out-of-bounds index', () => {
    const gate: GateDefinition = {
      field: 'artifacts[99].path',
      operator: 'exists',
    };
    const r = evaluateGate(gate, makeResult({ artifacts: [] }));
    assert.equal(r.passed, false);
  });
});

// ============================================================
// Compound: all (AND)
// ============================================================

describe('evaluateGate — compound all (AND)', () => {
  it('passes when all conditions pass', () => {
    const gate: GateDefinition = {
      all: [
        { field: 'status', operator: 'eq', value: 'complete' },
        { field: 'metadata.verdict', operator: 'eq', value: 'PASS' },
        { field: 'metadata.pr_url', operator: 'exists' },
      ],
    };
    const r = evaluateGate(
      gate,
      makeResult({
        metadata: { verdict: 'PASS', pr_url: 'https://x' },
      }),
    );
    assert.equal(r.passed, true);
    assert.equal(r.failures.length, 0);
    assert.equal(r.mode, 'all');
  });

  it('fails when any one condition fails — returns only failing conditions', () => {
    const gate: GateDefinition = {
      all: [
        { field: 'status', operator: 'eq', value: 'complete' },
        { field: 'metadata.verdict', operator: 'eq', value: 'PASS' },
        { field: 'metadata.pr_url', operator: 'exists' },
      ],
    };
    const r = evaluateGate(
      gate,
      makeResult({
        metadata: { verdict: 'FAIL' }, // pr_url missing, verdict wrong
      }),
    );
    assert.equal(r.passed, false);
    assert.equal(r.failures.length, 2);
    assert.equal(r.failures[0].condition.field, 'metadata.verdict');
    assert.equal(r.failures[1].condition.field, 'metadata.pr_url');
  });
});

// ============================================================
// Compound: any (OR)
// ============================================================

describe('evaluateGate — compound any (OR)', () => {
  it('passes when at least one condition passes', () => {
    const gate: GateDefinition = {
      any: [
        { field: 'metadata.pr_url', operator: 'exists' },
        { field: 'metadata.skipped', operator: 'eq', value: true },
      ],
    };
    const r = evaluateGate(gate, makeResult({ metadata: { skipped: true } }));
    assert.equal(r.passed, true);
    assert.equal(r.failures.length, 0);
    assert.equal(r.mode, 'any');
  });

  it('fails when all conditions fail — returns every failing branch', () => {
    const gate: GateDefinition = {
      any: [
        { field: 'metadata.pr_url', operator: 'exists' },
        { field: 'metadata.skipped', operator: 'eq', value: true },
        { field: 'status', operator: 'eq', value: 'partial' },
      ],
    };
    const r = evaluateGate(gate, makeResult({ status: 'complete', metadata: {} }));
    assert.equal(r.passed, false);
    assert.equal(r.failures.length, 3);
  });
});

// ============================================================
// Empty gate (defensive — validator rejects at load time)
// ============================================================

describe('evaluateGate — defensive behavior', () => {
  it('returns passed=true for an empty gate (no conditions)', () => {
    const gate: GateDefinition = {};
    const r = evaluateGate(gate, makeResult());
    assert.equal(r.passed, true);
    assert.equal(r.failures.length, 0);
  });

  it('never throws on unusual result shapes', () => {
    const gate: GateDefinition = { field: 'missing.deep.path', operator: 'eq', value: 'x' };
    // Should not throw
    const r = evaluateGate(gate, makeResult());
    assert.equal(r.passed, false);
  });
});

// ============================================================
// evaluateCondition (internal helper exported for completeness)
// ============================================================

describe('evaluateCondition', () => {
  it('returns null on pass', () => {
    const c: GateCondition = { field: 'status', operator: 'eq', value: 'complete' };
    assert.equal(evaluateCondition(c, makeResult()), null);
  });

  it('returns GateFailure with remediation on fail', () => {
    const c: GateCondition = { field: 'status', operator: 'eq', value: 'failed' };
    const f = evaluateCondition(c, makeResult({ status: 'complete' }));
    assert.ok(f);
    assert.equal(f!.condition.field, 'status');
    assert.ok(f!.remediation);
  });
});
