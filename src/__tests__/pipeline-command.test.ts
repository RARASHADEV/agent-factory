/**
 * AF-26: Integration tests for the pipeline run command.
 *
 * Approach: build a minimal fake workspace in a tmp directory, stub the
 * subprocess that spawns the agent (by replacing spawn-runner.js with a tiny
 * script that writes a canned result.json), and exercise the code paths
 * via the exported command functions.
 *
 * Run: npx tsx --test src/__tests__/pipeline-command.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'fs';
import { join } from 'path';

import { validateFromFlag, printExecutionPlan } from '../commands/pipeline.js';
import { resolvePhaseOrder, loadPipeline, type PhaseDefinition } from '../lib/pipeline.js';
import { evaluateGate } from '../lib/gate-evaluator.js';
import {
  initPipelineState,
  writePipelineState,
  readPipelineState,
} from '../lib/pipeline-state.js';

// ============================================================
// Tmp fixtures
// ============================================================

const TMP_ROOT = join(process.cwd(), '.af-test-pipeline-cmd');
const PROJECT_DIR = join(TMP_ROOT, 'project');
const AF_PATH = join(PROJECT_DIR, '.af');

function setupProject(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(AF_PATH, { recursive: true });
  mkdirSync(join(AF_PATH, 'pipelines'), { recursive: true });
  mkdirSync(join(AF_PATH, 'tasks', 'in-progress'), { recursive: true });

  // project.md
  writeFileSync(
    join(AF_PATH, 'project.md'),
    `---
id: test
name: Test
prefix: TEST
status: active
owner: test
created: '2026-04-15'
counter: 1
---

# Test project
`,
    'utf-8',
  );

  // sdlc pipeline
  writeFileSync(
    join(AF_PATH, 'pipelines', 'sdlc.yaml'),
    `name: sdlc
description: Test SDLC
phases:
  - name: design
    agent: architect
    gate:
      field: status
      operator: eq
      value: complete
  - name: implement
    agent: engineer
    requires: [design]
    gate:
      field: metadata.pr_url
      operator: exists
`,
    'utf-8',
  );
}

function teardown(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

// ============================================================
// validateFromFlag
// ============================================================

describe('validateFromFlag', () => {
  before(setupProject);
  after(teardown);

  it('returns 0 for the first phase', () => {
    const order: PhaseDefinition[] = [
      { name: 'design', agent: 'architect' },
      { name: 'implement', agent: 'engineer' },
    ];
    const idx = validateFromFlag('design', order, 'TEST-1', AF_PATH);
    assert.equal(idx, 0);
  });

  it('throws when phase is unknown', () => {
    const order: PhaseDefinition[] = [
      { name: 'design', agent: 'architect' },
      { name: 'implement', agent: 'engineer' },
    ];
    assert.throws(
      () => validateFromFlag('nonexistent', order, 'TEST-1', AF_PATH),
      /unknown phase "nonexistent"/,
    );
  });

  it('throws when prior phase result.json is missing', () => {
    const order: PhaseDefinition[] = [
      { name: 'design', agent: 'architect' },
      { name: 'implement', agent: 'engineer' },
    ];
    assert.throws(
      () => validateFromFlag('implement', order, 'TEST-1', AF_PATH),
      /prior phase "design" has no result.json/,
    );
  });

  it('succeeds when prior phase result.json exists', () => {
    const order: PhaseDefinition[] = [
      { name: 'design', agent: 'architect' },
      { name: 'implement', agent: 'engineer' },
    ];
    const resultDir = join(AF_PATH, 'output', 'TEST-1', 'architect');
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(
      join(resultDir, 'result.json'),
      JSON.stringify({ status: 'complete', summary: 'ok', artifacts: [] }),
      'utf-8',
    );
    const idx = validateFromFlag('implement', order, 'TEST-1', AF_PATH);
    assert.equal(idx, 1);
  });
});

// ============================================================
// printExecutionPlan — smoke test (captures stdout)
// ============================================================

describe('printExecutionPlan', () => {
  before(setupProject);
  after(teardown);

  let captured: string[] = [];
  let origLog: typeof console.log;

  beforeEach(() => {
    captured = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = origLog;
  });

  it('prints every phase and marks skipped phases', () => {
    const pipeline = loadPipeline(AF_PATH, 'sdlc');
    const order = resolvePhaseOrder(pipeline);
    printExecutionPlan(pipeline, order, 1, 'TEST-1');
    const output = captured.join('\n');
    assert.match(output, /Pipeline: sdlc/);
    assert.match(output, /TEST-1/);
    assert.match(output, /design/);
    assert.match(output, /implement/);
    assert.match(output, /skipped/);
  });

  it('renders gate lines', () => {
    const pipeline = loadPipeline(AF_PATH, 'sdlc');
    const order = resolvePhaseOrder(pipeline);
    printExecutionPlan(pipeline, order, 0, 'TEST-1');
    const output = captured.join('\n');
    assert.match(output, /gate:.*status.*eq/);
    assert.match(output, /metadata\.pr_url.*exists/);
  });
});

// ============================================================
// Pipeline state file shape after a simulated run
// ============================================================

describe('pipeline state integration — simulated phase outcomes', () => {
  before(setupProject);
  after(teardown);

  it('gate failure produces structured gateFailure record', () => {
    const failedResult = {
      status: 'complete' as const,
      summary: 'ok',
      artifacts: [],
      metadata: {}, // pr_url intentionally missing
    };

    const outcome = evaluateGate(
      { field: 'metadata.pr_url', operator: 'exists' },
      failedResult,
    );

    assert.equal(outcome.passed, false);
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].condition.field, 'metadata.pr_url');
    assert.equal(outcome.failures[0].condition.operator, 'exists');
    assert.match(outcome.failures[0].message, /expected field to exist/);
  });

  it('writing state + marking phases skipped works end-to-end', () => {
    const pipeline = loadPipeline(AF_PATH, 'sdlc');
    const order = resolvePhaseOrder(pipeline);
    const state = initPipelineState('sdlc', 'TEST-2', order);
    state.phases['design'].status = 'skipped';

    const outputDir = join(AF_PATH, 'output', 'TEST-2');
    writePipelineState(outputDir, state);

    const reloaded = readPipelineState(outputDir);
    assert.ok(reloaded);
    assert.equal(reloaded!.phases.design.status, 'skipped');
    assert.equal(reloaded!.phases.implement.status, 'pending');
  });
});
