/**
 * AF-26: Unit tests for pipeline-state.ts
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run: npx tsx --test src/__tests__/pipeline-state.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  writePipelineState,
  readPipelineState,
  initPipelineState,
  type PipelineState,
} from '../lib/pipeline-state.js';
import type { PhaseDefinition } from '../lib/pipeline.js';

const TMP_DIR = join(process.cwd(), '.af-test-pipeline-state');

function setup() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}
function teardown() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

function phases(): PhaseDefinition[] {
  return [
    { name: 'design', agent: 'architect' },
    { name: 'implement', agent: 'engineer', requires: ['design'] },
    { name: 'verify', agent: 'qa', requires: ['implement'] },
  ];
}

// ============================================================
// initPipelineState
// ============================================================

describe('initPipelineState', () => {
  it('produces all phases with status pending', () => {
    const state = initPipelineState('sdlc', 'AF-30', phases());
    assert.equal(state.pipeline, 'sdlc');
    assert.equal(state.ticket, 'AF-30');
    assert.equal(state.status, 'running');
    assert.ok(state.startedAt);
    assert.equal(Object.keys(state.phases).length, 3);
    assert.equal(state.phases['design'].status, 'pending');
    assert.equal(state.phases['design'].agent, 'architect');
    assert.equal(state.phases['implement'].status, 'pending');
    assert.equal(state.phases['verify'].status, 'pending');
  });

  it('sets startedAt to a valid ISO timestamp', () => {
    const state = initPipelineState('sdlc', 'AF-30', phases());
    assert.ok(!Number.isNaN(Date.parse(state.startedAt)));
  });
});

// ============================================================
// write / read round trip
// ============================================================

describe('writePipelineState / readPipelineState', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('writes valid JSON to outputDir/pipeline-state.json', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const state = initPipelineState('sdlc', 'AF-30', phases());
    writePipelineState(TMP_DIR, state);
    const filePath = join(TMP_DIR, 'pipeline-state.json');
    assert.ok(existsSync(filePath));
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.equal(parsed.pipeline, 'sdlc');
  });

  it('creates the output directory if missing', () => {
    const nested = join(TMP_DIR, 'nested', 'deep');
    const state = initPipelineState('sdlc', 'AF-30', phases());
    writePipelineState(nested, state);
    assert.ok(existsSync(join(nested, 'pipeline-state.json')));
  });

  it('readPipelineState returns null when file missing', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    assert.equal(readPipelineState(TMP_DIR), null);
  });

  it('round-trip preserves all fields', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const state: PipelineState = {
      pipeline: 'sdlc',
      ticket: 'AF-30',
      status: 'failed',
      startedAt: '2026-04-15T12:00:00.000Z',
      completedAt: '2026-04-15T12:30:00.000Z',
      phases: {
        design: {
          agent: 'architect',
          status: 'completed',
          startedAt: '2026-04-15T12:00:00.000Z',
          completedAt: '2026-04-15T12:10:00.000Z',
          durationMs: 600000,
          gateResult: 'pass',
          outputDir: 'output/AF-30/architect',
        },
        implement: {
          agent: 'engineer',
          status: 'failed',
          startedAt: '2026-04-15T12:10:00.000Z',
          completedAt: '2026-04-15T12:30:00.000Z',
          durationMs: 1200000,
          gateResult: 'fail',
          gateFailure: {
            field: 'metadata.pr_url',
            operator: 'exists',
            actual: undefined,
            message: 'Gate failed at metadata.pr_url: expected field to exist, got undefined',
          },
          failureReason: 'gate_failure',
          outputDir: 'output/AF-30/engineer',
        },
        verify: {
          agent: 'qa',
          status: 'pending',
        },
      },
      warnings: ['inject "design_document" from "design": no files matched'],
    };

    writePipelineState(TMP_DIR, state);
    const reloaded = readPipelineState(TMP_DIR);
    assert.ok(reloaded);
    assert.equal(reloaded!.pipeline, 'sdlc');
    assert.equal(reloaded!.status, 'failed');
    assert.equal(reloaded!.phases.design.status, 'completed');
    assert.equal(reloaded!.phases.implement.gateFailure?.field, 'metadata.pr_url');
    assert.equal(reloaded!.phases.implement.failureReason, 'gate_failure');
    assert.equal(reloaded!.phases.verify.status, 'pending');
    assert.deepEqual(reloaded!.warnings, state.warnings);
  });

  it('returns null for malformed JSON', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(join(TMP_DIR, 'pipeline-state.json'), 'not-json');
    assert.equal(readPipelineState(TMP_DIR), null);
  });
});
