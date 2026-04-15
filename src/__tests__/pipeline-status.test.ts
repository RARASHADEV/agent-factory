/**
 * AF-28: Unit tests for the `af pipeline status` command.
 *
 * Tests the three rendering helpers (renderPipelineState, renderRunList,
 * findPipelineRuns) and the command's exit-code behavior for missing /
 * malformed state files.
 *
 * Run: npx tsx --test src/__tests__/pipeline-status.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

import {
  renderPipelineState,
  renderRunList,
  findPipelineRuns,
  pipelineStatusCommand,
} from '../commands/pipeline.js';
import type { PipelineState } from '../lib/pipeline-state.js';

// Turn off chalk color for deterministic matching.
chalk.level = 0;

const TMP_ROOT = join(process.cwd(), '.af-test-pipeline-status');
const PROJECT_DIR = join(TMP_ROOT, 'project');
const AF_PATH = join(PROJECT_DIR, '.af');

function setupProject(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(AF_PATH, { recursive: true });

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
}

function teardown(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

// ============================================================
// Fixtures
// ============================================================

function completedState(): PipelineState {
  return {
    pipeline: 'sdlc',
    ticket: 'AF-30',
    status: 'completed',
    startedAt: '2026-04-15T12:00:00.000Z',
    completedAt: '2026-04-15T12:18:04.000Z',
    phases: {
      design: {
        agent: 'architect',
        status: 'completed',
        startedAt: '2026-04-15T12:00:00.000Z',
        completedAt: '2026-04-15T12:03:12.000Z',
        durationMs: 192000,
        gateResult: 'pass',
      },
      implement: {
        agent: 'engineer',
        status: 'completed',
        startedAt: '2026-04-15T12:03:12.000Z',
        completedAt: '2026-04-15T12:12:34.000Z',
        durationMs: 562000,
        gateResult: 'pass',
        attempts: 1,
      },
      verify: {
        agent: 'qa',
        status: 'completed',
        startedAt: '2026-04-15T12:12:34.000Z',
        completedAt: '2026-04-15T12:18:04.000Z',
        durationMs: 330000,
        gateResult: 'pass',
        attempts: 2,
      },
    },
  };
}

function failedState(): PipelineState {
  return {
    pipeline: 'sdlc',
    ticket: 'AF-31',
    status: 'failed',
    startedAt: '2026-04-15T12:00:00.000Z',
    completedAt: '2026-04-15T12:06:11.000Z',
    phases: {
      design: {
        agent: 'architect',
        status: 'completed',
        durationMs: 120000,
        gateResult: 'pass',
      },
      implement: {
        agent: 'engineer',
        status: 'failed',
        durationMs: 251000,
        gateResult: 'fail',
        failureReason: 'gate_failure',
        gateFailures: [
          {
            field: 'metadata.pr_url',
            operator: 'exists',
            actual: undefined,
            message: 'Gate failed at metadata.pr_url: expected field to exist, got undefined',
            remediation: 'Create a pull request and populate metadata.pr_url',
          },
        ],
      },
      verify: { agent: 'qa', status: 'pending' },
    },
  };
}

function runningState(startedAt: string, nowPhaseStart: string): PipelineState {
  return {
    pipeline: 'sdlc',
    ticket: 'AF-32',
    status: 'running',
    startedAt,
    currentPhase: 'implement',
    phases: {
      design: {
        agent: 'architect',
        status: 'completed',
        durationMs: 192000,
        gateResult: 'pass',
      },
      implement: {
        agent: 'engineer',
        status: 'running',
        startedAt: nowPhaseStart,
      },
      verify: { agent: 'qa', status: 'pending' },
    },
  };
}

// ============================================================
// renderPipelineState
// ============================================================

describe('renderPipelineState', () => {
  it('renders completed state with all phases and durations', () => {
    const out = renderPipelineState(completedState(), AF_PATH, Date.parse('2026-04-15T12:18:04.000Z')).join('\n');
    assert.match(out, /Pipeline: sdlc — AF-30/);
    assert.match(out, /Status: completed/);
    assert.match(out, /design/);
    assert.match(out, /implement/);
    assert.match(out, /verify/);
    assert.match(out, /gate: pass/);
    // duration formatting
    assert.match(out, /3m 12s/); // design
    assert.match(out, /9m 22s/); // implement
    assert.match(out, /5m 30s/); // verify
    // attempts tag on verify (attempts=2)
    assert.match(out, /attempts: 2/);
    // total pipeline duration in status line
    assert.match(out, /18m 4s/);
  });

  it('renders failed state with gate-failure messages and remediation', () => {
    const out = renderPipelineState(failedState(), AF_PATH, Date.parse('2026-04-15T12:06:11.000Z')).join('\n');
    assert.match(out, /Status: failed/);
    assert.match(out, /gate: fail/);
    assert.match(out, /metadata\.pr_url/);
    assert.match(out, /expected field to exist/);
    assert.match(out, /Create a pull request/);
    // pending phase shows em-dash and pending status
    assert.match(out, /verify/);
    assert.match(out, /pending/);
  });

  it('computes live duration for the current running phase', () => {
    // now = 9m 22s after the running phase started
    const phaseStart = '2026-04-15T12:03:12.000Z';
    const now = Date.parse('2026-04-15T12:12:34.000Z');
    const out = renderPipelineState(
      runningState('2026-04-15T12:00:00.000Z', phaseStart),
      AF_PATH,
      now,
    ).join('\n');
    assert.match(out, /Status: running/);
    assert.match(out, /9m 22s/); // live duration for the implement phase
    // elapsed since pipeline start is 12m 34s
    assert.match(out, /12m 34s/);
  });

  it('includes warnings block when present', () => {
    const s = completedState();
    s.warnings = ['inject "design_document" from "design": no files matched'];
    const out = renderPipelineState(s, AF_PATH, Date.parse('2026-04-15T12:18:04.000Z')).join('\n');
    assert.match(out, /Warnings:/);
    assert.match(out, /no files matched/);
  });
});

// ============================================================
// renderRunList
// ============================================================

describe('renderRunList', () => {
  it('prints empty message when no runs', () => {
    const out = renderRunList([], Date.now()).join('\n');
    assert.match(out, /No pipeline runs found/);
  });

  it('sorts by startedAt desc (newest first)', () => {
    const older: PipelineState = { ...completedState(), ticket: 'AF-10', startedAt: '2026-04-10T12:00:00.000Z' };
    const newer: PipelineState = { ...completedState(), ticket: 'AF-20', startedAt: '2026-04-14T12:00:00.000Z' };
    const mid: PipelineState = { ...completedState(), ticket: 'AF-15', startedAt: '2026-04-12T12:00:00.000Z' };
    const out = renderRunList([older, newer, mid], Date.parse('2026-04-15T12:00:00.000Z')).join('\n');
    const posNewer = out.indexOf('AF-20');
    const posMid = out.indexOf('AF-15');
    const posOlder = out.indexOf('AF-10');
    assert.ok(posNewer > 0 && posMid > 0 && posOlder > 0);
    assert.ok(posNewer < posMid, 'newer should come before mid');
    assert.ok(posMid < posOlder, 'mid should come before older');
  });

  it('shows phase + live duration for running runs', () => {
    const running = runningState('2026-04-15T12:00:00.000Z', '2026-04-15T12:03:12.000Z');
    const now = Date.parse('2026-04-15T12:12:34.000Z');
    const out = renderRunList([running], now).join('\n');
    assert.match(out, /AF-32/);
    assert.match(out, /running/);
    assert.match(out, /phase: implement/);
    assert.match(out, /9m 22s/);
  });

  it('shows phases-passed count for completed runs', () => {
    const out = renderRunList([completedState()], Date.parse('2026-04-15T12:18:04.000Z')).join('\n');
    assert.match(out, /3\/3 phases passed/);
    assert.match(out, /18m 4s/);
  });

  it('shows failed phase and reason for failed runs', () => {
    const out = renderRunList([failedState()], Date.parse('2026-04-15T12:06:11.000Z')).join('\n');
    assert.match(out, /AF-31/);
    assert.match(out, /failed/);
    assert.match(out, /phase: implement/);
    assert.match(out, /gate failed/);
  });
});

// ============================================================
// findPipelineRuns
// ============================================================

describe('findPipelineRuns', () => {
  beforeEach(setupProject);
  afterEach(teardown);

  it('returns empty array when output/ does not exist', () => {
    assert.deepEqual(findPipelineRuns(AF_PATH), []);
  });

  it('returns only directories containing pipeline-state.json', () => {
    const outDir = join(AF_PATH, 'output');
    mkdirSync(join(outDir, 'AF-30'), { recursive: true });
    mkdirSync(join(outDir, 'AF-31'), { recursive: true });
    mkdirSync(join(outDir, 'AF-99-agent-only'), { recursive: true });
    writeFileSync(join(outDir, 'AF-30', 'pipeline-state.json'), '{}');
    writeFileSync(join(outDir, 'AF-31', 'pipeline-state.json'), '{}');
    // AF-99-agent-only has no pipeline-state.json → should be excluded

    const tickets = findPipelineRuns(AF_PATH).sort();
    assert.deepEqual(tickets, ['AF-30', 'AF-31']);
  });
});

// ============================================================
// pipelineStatusCommand — exit-code / messaging behavior
// ============================================================

describe('pipelineStatusCommand', () => {
  let captured: string[] = [];
  let origLog: typeof console.log;
  let origWrite: typeof process.stdout.write;
  let origExit: typeof process.exit;
  let origCwd: () => string;

  beforeEach(() => {
    setupProject();
    captured = [];
    origLog = console.log;
    origWrite = process.stdout.write;
    origExit = process.exit;
    origCwd = process.cwd;

    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    process.stdout.write = ((s: string | Uint8Array) => {
      captured.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    process.exit = ((code?: number) => {
      throw new Error(`__EXIT__${code ?? 0}`);
    }) as typeof process.exit;

    // Run from the tmp project dir so resolveProject() works without --project.
    process.cwd = () => PROJECT_DIR;
  });

  afterEach(() => {
    console.log = origLog;
    process.stdout.write = origWrite;
    process.exit = origExit;
    process.cwd = origCwd;
    teardown();
  });

  it('exits 1 when ticket has no pipeline-state.json', () => {
    assert.throws(
      () => pipelineStatusCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = captured.join('\n');
    assert.match(out, /No pipeline run found for AF-30/);
  });

  it('exits 1 when pipeline-state.json is malformed', () => {
    const dir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pipeline-state.json'), 'not-json');
    assert.throws(
      () => pipelineStatusCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = captured.join('\n');
    assert.match(out, /Could not parse pipeline-state.json for AF-30/);
  });

  it('normalizes ticket to uppercase', () => {
    const dir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pipeline-state.json'), JSON.stringify(completedState()));
    // Lowercase input should resolve to the uppercase directory.
    pipelineStatusCommand('af-30', {});
    const out = captured.join('\n');
    assert.match(out, /Pipeline: sdlc — AF-30/);
  });

  it('list mode with no output dir prints empty message (exit 0)', () => {
    // Should not throw __EXIT__.
    pipelineStatusCommand(undefined, {});
    const out = captured.join('\n');
    assert.match(out, /No pipeline runs found/);
  });

  it('--json single ticket emits raw JSON equal to on-disk state', () => {
    const dir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(dir, { recursive: true });
    const state = completedState();
    writeFileSync(join(dir, 'pipeline-state.json'), JSON.stringify(state, null, 2));
    pipelineStatusCommand('AF-30', { json: true });
    const out = captured.join('');
    // Should be valid JSON equal to the state.
    const parsed = JSON.parse(out);
    assert.equal(parsed.pipeline, 'sdlc');
    assert.equal(parsed.ticket, 'AF-30');
    assert.equal(parsed.status, 'completed');
    assert.equal(Object.keys(parsed.phases).length, 3);
  });

  it('--json list mode emits a sorted array', () => {
    const outDir = join(AF_PATH, 'output');
    mkdirSync(join(outDir, 'AF-10'), { recursive: true });
    mkdirSync(join(outDir, 'AF-20'), { recursive: true });
    writeFileSync(
      join(outDir, 'AF-10', 'pipeline-state.json'),
      JSON.stringify({ ...completedState(), ticket: 'AF-10', startedAt: '2026-04-10T12:00:00.000Z' }),
    );
    writeFileSync(
      join(outDir, 'AF-20', 'pipeline-state.json'),
      JSON.stringify({ ...completedState(), ticket: 'AF-20', startedAt: '2026-04-14T12:00:00.000Z' }),
    );
    pipelineStatusCommand(undefined, { json: true });
    const out = captured.join('');
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    // Newest first: AF-20 (2026-04-14) before AF-10 (2026-04-10).
    assert.equal(parsed[0].ticket, 'AF-20');
    assert.equal(parsed[1].ticket, 'AF-10');
  });
});
