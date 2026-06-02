/**
 * AF-50: Unit tests for the orchestration-output writer.
 *
 * Spec: docs/designs/AF-50.md §11 (unit test plan).
 *
 * Drives persistOrchestrationResult against a stubbed OrchestrationResult in a
 * temp cwd (mkdtempSync) with an injected `now` for a deterministic run-id, then
 * asserts the on-disk layout and content.
 *
 * Run: npx tsx --test src/__tests__/orchestration-output.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  persistOrchestrationResult,
  stringifyOutput,
  sanitize,
} from '../lib/orchestration-output.js';
import type { OrchestrationResult } from '../lib/orchestrator.js';

// Fixed clock → fixed run-id. 2026-06-02T14:30:00.000Z → "2026-06-02T14-30-00-000Z".
const FIXED_MS = Date.parse('2026-06-02T14:30:00.000Z');
const RUN_ID = '2026-06-02T14-30-00-000Z';
const now = () => FIXED_MS;

function makeResult(overrides: Partial<OrchestrationResult> = {}): OrchestrationResult {
  return {
    domain: 'marketing',
    objective: 'launch the spring campaign',
    steps: [
      {
        agent: 'researcher',
        backend: 'claude',
        output: 'research findings about the market',
        usage: { inputTokens: 100, outputTokens: 200 },
      },
      {
        agent: 'content-writer',
        backend: 'local',
        // Object output → must be pretty-JSON serialized.
        output: { headline: 'Spring is here', body: 'Buy now' },
        usage: { inputTokens: 50, outputTokens: 300 },
      },
    ],
    finalizers: {
      qa: { approved: true, score: 9 },
    },
    approved: true,
    totalUsage: { inputTokens: 150, outputTokens: 500 },
    stopReason: 'done',
    dryRun: false,
    plan: ['[orchestrate] domain=marketing', '[supervisor] decided: done'],
    ...overrides,
  };
}

describe('persistOrchestrationResult', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'af-orch-out-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('creates the run dir and returns its absolute path', () => {
    const result = makeResult();
    const dir = persistOrchestrationResult(result, { cwd, now });

    const expected = join(cwd, '.af', 'output', 'orchestrate', 'marketing', RUN_ID);
    assert.equal(dir, expected);
    assert.ok(existsSync(dir), 'run dir should exist');
  });

  it('writes result.json whose parsed content deep-equals the input', () => {
    const result = makeResult();
    const dir = persistOrchestrationResult(result, { cwd, now });

    const parsed = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.deepEqual(parsed, result);
  });

  it('writes one step-NN-<agent>.md per step with padded numbering and content', () => {
    const result = makeResult();
    const dir = persistOrchestrationResult(result, { cwd, now });

    // String output → verbatim.
    const step1 = readFileSync(join(dir, 'step-01-researcher.md'), 'utf8');
    assert.equal(step1, 'research findings about the market');

    // Object output → pretty JSON.
    const step2 = readFileSync(join(dir, 'step-02-content-writer.md'), 'utf8');
    assert.equal(
      step2,
      JSON.stringify({ headline: 'Spring is here', body: 'Buy now' }, null, 2),
    );

    // Exactly two step files.
    const stepFiles = readdirSync(dir).filter((f) => f.startsWith('step-'));
    assert.equal(stepFiles.length, 2);
  });

  it('writes finalizer-<slug>.md per finalizer', () => {
    const result = makeResult();
    const dir = persistOrchestrationResult(result, { cwd, now });

    const qa = readFileSync(join(dir, 'finalizer-qa.md'), 'utf8');
    assert.equal(qa, JSON.stringify({ approved: true, score: 9 }, null, 2));
  });

  it('writes summary.md containing the stopReason and per-step agents', () => {
    const result = makeResult();
    const dir = persistOrchestrationResult(result, { cwd, now });

    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.match(summary, /stopReason:\*\* done/);
    assert.match(summary, /researcher/);
    assert.match(summary, /content-writer/);
    assert.match(summary, /launch the spring campaign/);
  });

  it('handles null and undefined step output as "(no output)"', () => {
    const result = makeResult({
      steps: [
        { agent: 'a', backend: 'dry-run', output: null, usage: { inputTokens: 0, outputTokens: 0 } },
        { agent: 'b', backend: 'dry-run', output: undefined, usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      finalizers: {},
    });
    const dir = persistOrchestrationResult(result, { cwd, now });

    assert.equal(readFileSync(join(dir, 'step-01-a.md'), 'utf8'), '(no output)');
    assert.equal(readFileSync(join(dir, 'step-02-b.md'), 'utf8'), '(no output)');
  });

  it('sanitizes odd slugs without escaping the run directory', () => {
    const result = makeResult({
      steps: [
        {
          agent: '../../etc/passwd',
          backend: 'claude',
          output: 'x',
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      ],
      finalizers: { '../evil': 'y' },
    });
    const dir = persistOrchestrationResult(result, { cwd, now });

    // No path traversal: every written file is a direct child of the run dir.
    const entries = readdirSync(dir);
    for (const entry of entries) {
      assert.ok(!entry.includes('/'), `entry "${entry}" must not contain a separator`);
      assert.ok(!entry.includes('..'), `entry "${entry}" must not contain ".."`);
    }
    // The sanitized step file lives inside the run dir.
    assert.ok(existsSync(join(dir, 'step-01-etc-passwd.md')));
    assert.ok(existsSync(join(dir, 'finalizer-evil.md')));
  });
});

describe('stringifyOutput', () => {
  it('returns strings verbatim', () => {
    assert.equal(stringifyOutput('hello'), 'hello');
  });
  it('returns "(no output)" for null/undefined', () => {
    assert.equal(stringifyOutput(null), '(no output)');
    assert.equal(stringifyOutput(undefined), '(no output)');
  });
  it('pretty-prints objects as JSON', () => {
    assert.equal(stringifyOutput({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));
  });
});

describe('sanitize', () => {
  it('lowercases and keeps safe chars', () => {
    assert.equal(sanitize('Content-Writer_2'), 'content-writer_2');
  });
  it('collapses unsafe chars and trims dashes', () => {
    assert.equal(sanitize('../../etc/passwd'), 'etc-passwd');
  });
  it('falls back to "agent" for empty results', () => {
    assert.equal(sanitize('///'), 'agent');
    assert.equal(sanitize(''), 'agent');
  });
});
