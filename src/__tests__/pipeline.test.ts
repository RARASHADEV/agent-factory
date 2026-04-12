/**
 * AF-24: Unit tests for pipeline.ts
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run: npx tsx --test src/__tests__/pipeline.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  validatePipeline,
  loadPipeline,
  listPipelines,
  resolvePhaseOrder,
  GATE_OPERATORS,
  type PipelineDefinition,
  type PipelineValidationResult,
} from '../lib/pipeline.js';

// ============================================================
// Helpers
// ============================================================

/** Minimal valid pipeline definition */
function minimalPipeline(): Record<string, unknown> {
  return {
    name: 'test',
    phases: [
      { name: 'build', agent: 'engineer' },
    ],
  };
}

/** Full SDLC-style pipeline definition */
function fullPipeline(): Record<string, unknown> {
  return {
    name: 'sdlc',
    description: 'Full SDLC — design through verification',
    phases: [
      {
        name: 'design',
        agent: 'architect',
        gate: { field: 'status', operator: 'eq', value: 'complete' },
      },
      {
        name: 'implement',
        agent: 'engineer',
        requires: ['design'],
        inject: [
          { from: 'design', artifact: 'docs/designs/{ticket}*.md', as: 'design_document' },
        ],
        gate: { field: 'metadata.pr_url', operator: 'exists' },
      },
      {
        name: 'verify',
        agent: 'qa',
        requires: ['implement'],
        inject: [
          { from: 'design', artifact: 'docs/designs/{ticket}*.md', as: 'design_document' },
          { from: 'implement', artifact: 'metadata.pr_url', as: 'pr_to_review' },
        ],
        gate: { field: 'metadata.verdict', operator: 'eq', value: 'PASS' },
      },
    ],
  };
}

// ============================================================
// validatePipeline
// ============================================================

describe('validatePipeline', () => {
  it('accepts a minimal valid pipeline (name + one phase, no gate, no requires)', () => {
    const result = validatePipeline(minimalPipeline());
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.name, 'test');
      assert.equal(result.data.phases.length, 1);
      assert.equal(result.data.phases[0].name, 'build');
    }
  });

  it('accepts a full pipeline (sdlc.yaml content)', () => {
    const result = validatePipeline(fullPipeline());
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.name, 'sdlc');
      assert.equal(result.data.phases.length, 3);
      assert.equal(result.data.description, 'Full SDLC — design through verification');
    }
  });

  it('rejects missing name', () => {
    const input = { phases: [{ name: 'a', agent: 'x' }] };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('name')));
    }
  });

  it('rejects empty name', () => {
    const input = { name: '', phases: [{ name: 'a', agent: 'x' }] };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('name')));
    }
  });

  it('rejects missing phases', () => {
    const input = { name: 'test' };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('phases')));
    }
  });

  it('rejects empty phases array', () => {
    const input = { name: 'test', phases: [] };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('must contain at least one phase')));
    }
  });

  it('rejects duplicate phase names', () => {
    const input = {
      name: 'test',
      phases: [
        { name: 'build', agent: 'engineer' },
        { name: 'build', agent: 'qa' },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes("duplicate phase name 'build'")));
    }
  });

  it('rejects dangling requires reference', () => {
    const input = {
      name: 'test',
      phases: [
        { name: 'build', agent: 'engineer', requires: ['nonexistent'] },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes("unknown phase 'nonexistent'")));
    }
  });

  it('rejects dangling inject.from reference', () => {
    const input = {
      name: 'test',
      phases: [
        { name: 'build', agent: 'engineer' },
        {
          name: 'test-phase',
          agent: 'qa',
          requires: ['build'],
          inject: [{ from: 'nonexistent', artifact: 'foo', as: 'bar' }],
        },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes("unknown phase 'nonexistent'")));
    }
  });

  it('rejects circular dependency (A requires B, B requires A)', () => {
    const input = {
      name: 'test',
      phases: [
        { name: 'a', agent: 'x', requires: ['b'] },
        { name: 'b', agent: 'y', requires: ['a'] },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('circular dependency')));
    }
  });

  it('rejects three-way circular dependency', () => {
    const input = {
      name: 'test',
      phases: [
        { name: 'a', agent: 'x', requires: ['c'] },
        { name: 'b', agent: 'y', requires: ['a'] },
        { name: 'c', agent: 'z', requires: ['b'] },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('circular dependency')));
    }
  });

  it('rejects invalid gate operator', () => {
    const input = {
      name: 'test',
      phases: [
        {
          name: 'build',
          agent: 'engineer',
          gate: { field: 'status', operator: 'like', value: 'x' },
        },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes("invalid operator 'like'")));
    }
  });

  it('rejects missing gate value for operator eq', () => {
    const input = {
      name: 'test',
      phases: [
        {
          name: 'build',
          agent: 'engineer',
          gate: { field: 'status', operator: 'eq' },
        },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes("operator 'eq' requires a 'value' field")));
    }
  });

  it('rejects missing gate value for operator neq', () => {
    const input = {
      name: 'test',
      phases: [
        {
          name: 'build',
          agent: 'engineer',
          gate: { field: 'status', operator: 'neq' },
        },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes("operator 'neq' requires a 'value' field")));
    }
  });

  it('accepts exists operator without value', () => {
    const input = {
      name: 'test',
      phases: [
        {
          name: 'build',
          agent: 'engineer',
          gate: { field: 'metadata.url', operator: 'exists' },
        },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, true);
  });

  it('accepts not_exists operator without value', () => {
    const input = {
      name: 'test',
      phases: [
        {
          name: 'build',
          agent: 'engineer',
          gate: { field: 'blockers', operator: 'not_exists' },
        },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, true);
  });

  it('accepts extra unknown fields (forward compatibility)', () => {
    const input = {
      name: 'test',
      version: 2,
      phases: [
        { name: 'build', agent: 'engineer', custom_field: true },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, true);
  });

  it('rejects null input', () => {
    const result = validatePipeline(null);
    assert.equal(result.valid, false);
  });

  it('rejects array input', () => {
    const result = validatePipeline([]);
    assert.equal(result.valid, false);
  });

  it('rejects string input', () => {
    const result = validatePipeline('hello');
    assert.equal(result.valid, false);
  });

  it('rejects phase with missing agent', () => {
    const input = {
      name: 'test',
      phases: [{ name: 'build' }],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('agent')));
    }
  });

  it('rejects phase with empty name', () => {
    const input = {
      name: 'test',
      phases: [{ name: '', agent: 'engineer' }],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('phases[0].name')));
    }
  });

  it('rejects inject with missing artifact', () => {
    const input = {
      name: 'test',
      phases: [
        { name: 'a', agent: 'x' },
        {
          name: 'b',
          agent: 'y',
          requires: ['a'],
          inject: [{ from: 'a', as: 'label' }],
        },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('artifact')));
    }
  });

  it('rejects inject with missing as', () => {
    const input = {
      name: 'test',
      phases: [
        { name: 'a', agent: 'x' },
        {
          name: 'b',
          agent: 'y',
          requires: ['a'],
          inject: [{ from: 'a', artifact: 'foo.md' }],
        },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('as')));
    }
  });

  it('rejects gate with missing field', () => {
    const input = {
      name: 'test',
      phases: [
        {
          name: 'build',
          agent: 'engineer',
          gate: { operator: 'eq', value: 'x' },
        },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('field')));
    }
  });

  it('validates all defined gate operators are accepted', () => {
    for (const op of GATE_OPERATORS) {
      const needsValue = !['exists', 'not_exists'].includes(op);
      const gate: Record<string, unknown> = { field: 'status', operator: op };
      if (needsValue) gate.value = 'x';

      const input = {
        name: 'test',
        phases: [{ name: 'build', agent: 'engineer', gate }],
      };
      const result = validatePipeline(input);
      assert.equal(result.valid, true, `operator '${op}' should be accepted`);
    }
  });

  it('collects multiple errors', () => {
    const input = {
      name: '',
      phases: [
        { name: '', agent: '' },
      ],
    };
    const result = validatePipeline(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.length >= 3, `Expected at least 3 errors, got ${result.errors.length}`);
    }
  });
});

// ============================================================
// loadPipeline / listPipelines
// ============================================================

describe('loadPipeline', () => {
  const TMP_AF = join(process.cwd(), '.af-test-tmp');
  const PIPELINES = join(TMP_AF, 'pipelines');

  beforeEach(() => {
    mkdirSync(PIPELINES, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP_AF)) {
      rmSync(TMP_AF, { recursive: true, force: true });
    }
  });

  it('loads an existing valid YAML file', () => {
    const yaml = `name: test\nphases:\n  - name: build\n    agent: engineer\n`;
    writeFileSync(join(PIPELINES, 'test.yaml'), yaml, 'utf-8');

    const pipeline = loadPipeline(TMP_AF, 'test');
    assert.equal(pipeline.name, 'test');
    assert.equal(pipeline.phases.length, 1);
    assert.equal(pipeline.phases[0].name, 'build');
  });

  it('throws for non-existent file', () => {
    assert.throws(
      () => loadPipeline(TMP_AF, 'nope'),
      (err: Error) => err.message.includes('not found'),
    );
  });

  it('throws for invalid YAML syntax', () => {
    writeFileSync(join(PIPELINES, 'bad.yaml'), ':\n  :\n  - :\n  invalid:: yaml::', 'utf-8');
    assert.throws(
      () => loadPipeline(TMP_AF, 'bad'),
      (err: Error) => err.message.includes('invalid YAML') || err.message.includes('validation failed'),
    );
  });

  it('throws for valid YAML but invalid schema', () => {
    writeFileSync(join(PIPELINES, 'noname.yaml'), 'phases:\n  - name: x\n    agent: y\n', 'utf-8');
    assert.throws(
      () => loadPipeline(TMP_AF, 'noname'),
      (err: Error) => err.message.includes('validation failed'),
    );
  });

  it('rejects path traversal in pipeline name', () => {
    assert.throws(
      () => loadPipeline(TMP_AF, '../etc/passwd'),
      (err: Error) => err.message.includes('must not contain path separators'),
    );
  });

  it('rejects backslash path traversal', () => {
    assert.throws(
      () => loadPipeline(TMP_AF, '..\\etc\\passwd'),
      (err: Error) => err.message.includes('must not contain path separators'),
    );
  });

  it('rejects dot-dot traversal', () => {
    assert.throws(
      () => loadPipeline(TMP_AF, 'foo..bar'),
      (err: Error) => err.message.includes('must not contain path separators'),
    );
  });
});

describe('listPipelines', () => {
  const TMP_AF = join(process.cwd(), '.af-test-tmp-list');
  const PIPELINES = join(TMP_AF, 'pipelines');

  beforeEach(() => {
    mkdirSync(PIPELINES, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP_AF)) {
      rmSync(TMP_AF, { recursive: true, force: true });
    }
  });

  it('returns empty array if pipelines directory does not exist', () => {
    rmSync(TMP_AF, { recursive: true, force: true });
    const result = listPipelines(TMP_AF);
    assert.deepEqual(result, []);
  });

  it('returns empty array for empty pipelines directory', () => {
    const result = listPipelines(TMP_AF);
    assert.deepEqual(result, []);
  });

  it('discovers .yaml files', () => {
    writeFileSync(join(PIPELINES, 'alpha.yaml'), 'name: alpha\nphases: []\n', 'utf-8');
    writeFileSync(join(PIPELINES, 'beta.yaml'), 'name: beta\nphases: []\n', 'utf-8');
    const result = listPipelines(TMP_AF);
    assert.deepEqual(result, ['alpha', 'beta']);
  });

  it('discovers .yml files', () => {
    writeFileSync(join(PIPELINES, 'gamma.yml'), 'name: gamma\nphases: []\n', 'utf-8');
    const result = listPipelines(TMP_AF);
    assert.deepEqual(result, ['gamma']);
  });

  it('ignores non-YAML files', () => {
    writeFileSync(join(PIPELINES, 'readme.md'), '# Readme\n', 'utf-8');
    writeFileSync(join(PIPELINES, 'data.json'), '{}', 'utf-8');
    writeFileSync(join(PIPELINES, 'sdlc.yaml'), 'name: sdlc\nphases: []\n', 'utf-8');
    const result = listPipelines(TMP_AF);
    assert.deepEqual(result, ['sdlc']);
  });

  it('returns names sorted alphabetically', () => {
    writeFileSync(join(PIPELINES, 'zebra.yaml'), '', 'utf-8');
    writeFileSync(join(PIPELINES, 'alpha.yaml'), '', 'utf-8');
    writeFileSync(join(PIPELINES, 'mango.yml'), '', 'utf-8');
    const result = listPipelines(TMP_AF);
    assert.deepEqual(result, ['alpha', 'mango', 'zebra']);
  });
});

// ============================================================
// resolvePhaseOrder
// ============================================================

describe('resolvePhaseOrder', () => {
  it('returns single phase unchanged', () => {
    const pipeline: PipelineDefinition = {
      name: 'test',
      phases: [{ name: 'only', agent: 'x' }],
    };
    const ordered = resolvePhaseOrder(pipeline);
    assert.equal(ordered.length, 1);
    assert.equal(ordered[0].name, 'only');
  });

  it('returns linear chain in dependency order (A → B → C)', () => {
    const pipeline: PipelineDefinition = {
      name: 'test',
      phases: [
        { name: 'a', agent: 'x' },
        { name: 'b', agent: 'y', requires: ['a'] },
        { name: 'c', agent: 'z', requires: ['b'] },
      ],
    };
    const ordered = resolvePhaseOrder(pipeline);
    assert.deepEqual(ordered.map(p => p.name), ['a', 'b', 'c']);
  });

  it('handles diamond dependency (A → B,C → D)', () => {
    const pipeline: PipelineDefinition = {
      name: 'test',
      phases: [
        { name: 'a', agent: 'x' },
        { name: 'b', agent: 'y', requires: ['a'] },
        { name: 'c', agent: 'z', requires: ['a'] },
        { name: 'd', agent: 'w', requires: ['b', 'c'] },
      ],
    };
    const ordered = resolvePhaseOrder(pipeline);
    const names = ordered.map(p => p.name);

    // A must be first, D must be last
    assert.equal(names[0], 'a');
    assert.equal(names[3], 'd');

    // B and C between A and D — authoring order preserved (B before C)
    assert.equal(names.indexOf('b'), 1);
    assert.equal(names.indexOf('c'), 2);
  });

  it('preserves authoring order for multiple independent phases', () => {
    const pipeline: PipelineDefinition = {
      name: 'test',
      phases: [
        { name: 'z', agent: 'a' },
        { name: 'a', agent: 'b' },
        { name: 'm', agent: 'c' },
      ],
    };
    const ordered = resolvePhaseOrder(pipeline);
    // All independent — authoring order preserved
    assert.deepEqual(ordered.map(p => p.name), ['z', 'a', 'm']);
  });

  it('handles reverse-authored linear chain', () => {
    // Phases authored in reverse order but with requires
    const pipeline: PipelineDefinition = {
      name: 'test',
      phases: [
        { name: 'c', agent: 'z', requires: ['b'] },
        { name: 'b', agent: 'y', requires: ['a'] },
        { name: 'a', agent: 'x' },
      ],
    };
    const ordered = resolvePhaseOrder(pipeline);
    assert.deepEqual(ordered.map(p => p.name), ['a', 'b', 'c']);
  });

  it('throws on circular dependency (safety net)', () => {
    // Construct an already-"validated" pipeline with a cycle to test the safety net
    const pipeline: PipelineDefinition = {
      name: 'test',
      phases: [
        { name: 'a', agent: 'x', requires: ['b'] },
        { name: 'b', agent: 'y', requires: ['a'] },
      ],
    };
    assert.throws(
      () => resolvePhaseOrder(pipeline),
      (err: Error) => err.message.includes('Circular dependency'),
    );
  });

  it('orders sdlc pipeline as design → implement → verify', () => {
    const pipeline: PipelineDefinition = {
      name: 'sdlc',
      phases: [
        { name: 'design', agent: 'architect' },
        {
          name: 'implement',
          agent: 'engineer',
          requires: ['design'],
        },
        {
          name: 'verify',
          agent: 'qa',
          requires: ['implement'],
        },
      ],
    };
    const ordered = resolvePhaseOrder(pipeline);
    assert.deepEqual(ordered.map(p => p.name), ['design', 'implement', 'verify']);
  });
});
