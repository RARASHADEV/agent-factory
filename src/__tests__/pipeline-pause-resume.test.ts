/**
 * AF-34: Unit + integration tests for pipeline pause/resume.
 *
 * Covers:
 *   - Sentinel helpers: atomic write, exists/read/remove
 *   - findNextPendingPhase: pure navigation over state + phaseOrder
 *   - pipelinePauseCommand: refusals (no state, terminal state, already paused),
 *     happy path writes sentinel + sets state unchanged
 *   - pipelineResumeCommand: refusals (no state, not paused, YAML mismatch),
 *     degenerate all-done case, happy path clears sentinel + invokes loop
 *   - sharedPhaseLoop between-phase pause observation (no phase spawned,
 *     state transitions to paused, outcome='paused')
 *   - Feature flag off: pause/resume commands exit 1; loop skips the check
 *
 * Run: npx tsx --test src/__tests__/pipeline-pause-resume.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

import {
  writePauseRequest,
  readPauseRequest,
  pauseRequestExists,
  removePauseRequest,
  findNextPendingPhase,
  writePipelineState,
  readPipelineState,
  initPipelineState,
  type PipelineState,
} from '../lib/pipeline-state.js';
import type { PhaseDefinition, PipelineDefinition } from '../lib/pipeline.js';
import {
  pipelinePauseCommand,
  pipelineResumeCommand,
  sharedPhaseLoop,
  type PhaseLoopArgs,
} from '../commands/pipeline.js';
import type { Task, TaskProvider } from '../lib/task-provider.js';

// Deterministic output — no ANSI colors in assertions.
chalk.level = 0;

const TMP_ROOT = join(process.cwd(), '.af-test-pause-resume');
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

function phases(): PhaseDefinition[] {
  return [
    { name: 'design', agent: 'architect' },
    { name: 'implement', agent: 'engineer', requires: ['design'] },
    { name: 'verify', agent: 'qa', requires: ['implement'] },
  ];
}

// ============================================================
// Sentinel helpers
// ============================================================

describe('writePauseRequest / pauseRequestExists / readPauseRequest / removePauseRequest', () => {
  const TMP = join(process.cwd(), '.af-test-sentinel');
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('writes the sentinel atomically and pauseRequestExists reflects presence', () => {
    assert.equal(pauseRequestExists(TMP), false);
    writePauseRequest(TMP, {
      requestedAt: '2026-04-15T12:00:00.000Z',
      requestedBy: 'cli',
    });
    assert.equal(pauseRequestExists(TMP), true);
    // No leftover .tmp file
    assert.equal(existsSync(join(TMP, 'pause.request.tmp')), false);
    // Content parses
    const req = readPauseRequest(TMP);
    assert.ok(req);
    assert.equal(req!.requestedBy, 'cli');
    assert.equal(req!.requestedAt, '2026-04-15T12:00:00.000Z');
  });

  it('readPauseRequest returns null when absent', () => {
    assert.equal(readPauseRequest(TMP), null);
  });

  it('readPauseRequest returns null for malformed JSON', () => {
    writeFileSync(join(TMP, 'pause.request'), 'not-json', 'utf-8');
    assert.equal(readPauseRequest(TMP), null);
    // Still detectable as existing
    assert.equal(pauseRequestExists(TMP), true);
  });

  it('removePauseRequest deletes the sentinel', () => {
    writePauseRequest(TMP, {
      requestedAt: '2026-04-15T12:00:00.000Z',
      requestedBy: 'cli',
    });
    assert.equal(pauseRequestExists(TMP), true);
    removePauseRequest(TMP);
    assert.equal(pauseRequestExists(TMP), false);
  });

  it('removePauseRequest is idempotent when the sentinel is absent', () => {
    // No sentinel → should not throw
    removePauseRequest(TMP);
    assert.equal(pauseRequestExists(TMP), false);
  });

  it('throws if the output directory does not exist', () => {
    const missing = join(TMP, 'does-not-exist');
    assert.throws(
      () =>
        writePauseRequest(missing, {
          requestedAt: '2026-04-15T12:00:00.000Z',
          requestedBy: 'cli',
        }),
      /Output dir does not exist/,
    );
  });
});

// ============================================================
// findNextPendingPhase
// ============================================================

describe('findNextPendingPhase', () => {
  it('returns 0 on a fresh state (all phases pending)', () => {
    const state = initPipelineState('sdlc', 'AF-30', phases());
    assert.equal(findNextPendingPhase(state, phases()), 0);
  });

  it('skips completed phases', () => {
    const state = initPipelineState('sdlc', 'AF-30', phases());
    state.phases.design.status = 'completed';
    assert.equal(findNextPendingPhase(state, phases()), 1);
  });

  it('skips skipped phases', () => {
    const state = initPipelineState('sdlc', 'AF-30', phases());
    state.phases.design.status = 'skipped';
    state.phases.implement.status = 'completed';
    assert.equal(findNextPendingPhase(state, phases()), 2);
  });

  it('returns phaseOrder.length when every phase is completed/skipped', () => {
    const state = initPipelineState('sdlc', 'AF-30', phases());
    state.phases.design.status = 'completed';
    state.phases.implement.status = 'completed';
    state.phases.verify.status = 'completed';
    assert.equal(findNextPendingPhase(state, phases()), 3);
  });

  it('returns current index for failed/running (non-terminal) phases', () => {
    const state = initPipelineState('sdlc', 'AF-30', phases());
    state.phases.design.status = 'completed';
    state.phases.implement.status = 'failed';
    assert.equal(findNextPendingPhase(state, phases()), 1);
  });

  it('returns the index defensively if a phase has no state record', () => {
    const state = initPipelineState('sdlc', 'AF-30', phases());
    delete (state.phases as Record<string, unknown>)['implement'];
    state.phases.design.status = 'completed';
    assert.equal(findNextPendingPhase(state, phases()), 1);
  });
});

// ============================================================
// Test harness for command-level tests
// ============================================================

function captureIO(): {
  captured: string[];
  restore: () => void;
  origCwd: () => string;
} {
  const captured: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write;
  const origExit = process.exit;
  const origCwd = process.cwd;

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

  process.cwd = () => PROJECT_DIR;

  return {
    captured,
    origCwd,
    restore: () => {
      console.log = origLog;
      process.stdout.write = origWrite;
      process.exit = origExit;
      process.cwd = origCwd;
    },
  };
}

function runningStateFixture(): PipelineState {
  return {
    pipeline: 'sdlc',
    ticket: 'AF-30',
    status: 'running',
    startedAt: '2026-04-15T12:00:00.000Z',
    currentPhase: 'implement',
    phases: {
      design: {
        agent: 'architect',
        status: 'completed',
        durationMs: 120000,
        gateResult: 'pass',
      },
      implement: { agent: 'engineer', status: 'running' },
      verify: { agent: 'qa', status: 'pending' },
    },
  };
}

function pausedStateFixture(): PipelineState {
  return {
    pipeline: 'sdlc',
    ticket: 'AF-30',
    status: 'paused',
    startedAt: '2026-04-15T12:00:00.000Z',
    pausedAt: '2026-04-15T12:02:00.000Z',
    phases: {
      design: {
        agent: 'architect',
        status: 'completed',
        durationMs: 120000,
        gateResult: 'pass',
      },
      implement: { agent: 'engineer', status: 'pending' },
      verify: { agent: 'qa', status: 'pending' },
    },
  };
}

function writePipelineYaml(name: string, phaseNames: string[]): void {
  const pipelineDir = join(AF_PATH, 'pipelines');
  mkdirSync(pipelineDir, { recursive: true });
  const agents: Record<string, string> = {
    design: 'architect',
    implement: 'engineer',
    verify: 'qa',
    deploy: 'devops-engineer',
  };
  const phaseYaml = phaseNames
    .map((pn, idx) => {
      const requires =
        idx > 0 ? `\n    requires: [${phaseNames[idx - 1]}]` : '';
      return `  - name: ${pn}\n    agent: ${agents[pn] ?? 'engineer'}${requires}`;
    })
    .join('\n');
  writeFileSync(
    join(pipelineDir, `${name}.yaml`),
    `name: ${name}
description: Test pipeline
phases:
${phaseYaml}
`,
    'utf-8',
  );
}

// ============================================================
// pipelinePauseCommand
// ============================================================

describe('pipelinePauseCommand', () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    setupProject();
    io = captureIO();
  });
  afterEach(() => {
    io.restore();
    teardown();
  });

  it('exits 1 and messages when no pipeline run exists', async () => {
    await assert.rejects(
      () => pipelinePauseCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /No pipeline run found for AF-30/);
  });

  it('exits 1 when the pipeline is already completed', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    const state = runningStateFixture();
    state.status = 'completed';
    writePipelineState(outputDir, state);

    await assert.rejects(
      () => pipelinePauseCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /already completed/);
    assert.equal(pauseRequestExists(outputDir), false);
  });

  it('exits 1 when the pipeline has failed', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    const state = runningStateFixture();
    state.status = 'failed';
    writePipelineState(outputDir, state);

    await assert.rejects(
      () => pipelinePauseCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /already failed/);
    assert.equal(pauseRequestExists(outputDir), false);
  });

  it('exits 1 when the pipeline is already paused', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    writePipelineState(outputDir, pausedStateFixture());

    await assert.rejects(
      () => pipelinePauseCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /already paused/);
  });

  it('writes the sentinel on a running pipeline and does NOT mutate state', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    const state = runningStateFixture();
    writePipelineState(outputDir, state);

    await pipelinePauseCommand('AF-30', {});

    // Sentinel exists and is well-formed
    assert.equal(pauseRequestExists(outputDir), true);
    const req = readPauseRequest(outputDir);
    assert.ok(req);
    assert.equal(req!.requestedBy, 'cli');
    assert.ok(!Number.isNaN(Date.parse(req!.requestedAt)));

    // Critical: pause command does NOT flip state to 'paused' — only the
    // runner does that on its next between-phase check.
    const reloaded = readPipelineState(outputDir);
    assert.equal(reloaded!.status, 'running');
    assert.equal(reloaded!.pausedAt, undefined);

    const out = io.captured.join('\n');
    assert.match(out, /Pause requested for AF-30/);
    assert.match(out, /next phase boundary/);
  });

  it('normalizes lowercase ticket to uppercase', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    writePipelineState(outputDir, runningStateFixture());

    await pipelinePauseCommand('af-30', {});
    assert.equal(pauseRequestExists(outputDir), true);
    const out = io.captured.join('\n');
    assert.match(out, /AF-30/);
  });
});

// ============================================================
// pipelineResumeCommand
// ============================================================

describe('pipelineResumeCommand', () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    setupProject();
    io = captureIO();
  });
  afterEach(() => {
    io.restore();
    teardown();
  });

  it('exits 1 when no pipeline run exists', async () => {
    await assert.rejects(
      () => pipelineResumeCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /No pipeline run found for AF-30/);
  });

  it('exits 1 when the pipeline is completed', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    const state = runningStateFixture();
    state.status = 'completed';
    writePipelineState(outputDir, state);

    await assert.rejects(
      () => pipelineResumeCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /already completed/);
  });

  it('exits 1 when the pipeline failed (suggests --from)', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    const state = runningStateFixture();
    state.status = 'failed';
    writePipelineState(outputDir, state);

    await assert.rejects(
      () => pipelineResumeCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /--from/);
  });

  it('exits 1 when the pipeline is marked running (crash recovery guidance)', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    writePipelineState(outputDir, runningStateFixture());

    await assert.rejects(
      () => pipelineResumeCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /marked running/);
    assert.match(out, /--from/);
  });

  it('exits 1 when the pipeline YAML is missing', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    writePipelineState(outputDir, pausedStateFixture());
    writePauseRequest(outputDir, {
      requestedAt: '2026-04-15T12:02:00.000Z',
      requestedBy: 'cli',
    });
    // No pipeline YAML — loadPipeline will throw.

    await assert.rejects(
      () => pipelineResumeCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /Could not load pipeline definition/);
    // Sentinel should NOT have been removed — resume failed before clearing.
    assert.equal(pauseRequestExists(outputDir), true);
  });

  it('refuses when the pipeline YAML phase set has structurally changed', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    writePipelineState(outputDir, pausedStateFixture());
    writePauseRequest(outputDir, {
      requestedAt: '2026-04-15T12:02:00.000Z',
      requestedBy: 'cli',
    });
    // Original state has design/implement/verify; new YAML has design/implement/deploy.
    writePipelineYaml('sdlc', ['design', 'implement', 'deploy']);

    await assert.rejects(
      () => pipelineResumeCommand('AF-30', {}),
      /__EXIT__1/,
    );
    const out = io.captured.join('\n');
    assert.match(out, /Pipeline definition has changed since pause/);
    // Sentinel still present — resume never cleared it.
    assert.equal(pauseRequestExists(outputDir), true);
  });

  it('degenerate: all phases done → marks completed, clears sentinel, exit 0', async () => {
    const outputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(outputDir, { recursive: true });
    const state = pausedStateFixture();
    state.phases.implement.status = 'completed';
    state.phases.verify.status = 'completed';
    writePipelineState(outputDir, state);
    writePauseRequest(outputDir, {
      requestedAt: '2026-04-15T12:02:00.000Z',
      requestedBy: 'cli',
    });
    writePipelineYaml('sdlc', ['design', 'implement', 'verify']);

    // Should NOT throw — returns cleanly.
    await pipelineResumeCommand('AF-30', {});

    const reloaded = readPipelineState(outputDir);
    assert.equal(reloaded!.status, 'completed');
    assert.ok(reloaded!.completedAt);
    assert.equal(pauseRequestExists(outputDir), false);
    const out = io.captured.join('\n');
    assert.match(out, /already complete/);
  });
});

// ============================================================
// sharedPhaseLoop — between-phase pause observation
// ============================================================

describe('sharedPhaseLoop — between-phase pause observation', () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    setupProject();
    io = captureIO();
  });
  afterEach(() => {
    io.restore();
    teardown();
  });

  function mkPipeline(): PipelineDefinition {
    return {
      name: 'sdlc',
      description: 'test',
      phases: phases(),
    };
  }

  function mkTask(): Task {
    return {
      ticket: 'AF-30',
      title: 'Test',
      type: 'task',
      status: 'in-progress',
      priority: 'medium',
      complexity: 'low',
      assignee: 'engineer',
      created: '2026-04-15',
      updated: '2026-04-15',
      description: '# Test',
      filePath: join(AF_PATH, 'tasks', 'in-progress', 'AF-30.md'),
    };
  }

  // AF-38: stub provider — only .get is invoked by sharedPhaseLoop for re-fetch.
  // These two pause-short-circuit tests never reach the re-fetch path, so
  // returning null is harmless (loop keeps its existing task handle).
  function mkProvider(): TaskProvider {
    return {
      list: async () => [],
      get: async () => null,
      create: async () => { throw new Error('not implemented in stub'); },
      move: async () => { throw new Error('not implemented in stub'); },
      update: async () => { throw new Error('not implemented in stub'); },
      delete: async () => { throw new Error('not implemented in stub'); },
    } as unknown as TaskProvider;
  }

  it('observes a pre-placed sentinel and returns "paused" without running any phase', async () => {
    const pipelineOutputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(pipelineOutputDir, { recursive: true });
    const pipeline = mkPipeline();
    const state = initPipelineState(pipeline.name, 'AF-30', pipeline.phases);
    writePipelineState(pipelineOutputDir, state);

    // Write the sentinel BEFORE entering the loop — the first iteration must observe it.
    writePauseRequest(pipelineOutputDir, {
      requestedAt: '2026-04-15T12:02:00.000Z',
      requestedBy: 'cli',
    });

    const loopArgs: PhaseLoopArgs = {
      pipeline,
      phaseOrder: pipeline.phases,
      startIndex: 0,
      state,
      task: mkTask(),
      afPath: AF_PATH,
      projectDir: PROJECT_DIR,
      pipelineOutputDir,
      ctx: {
        ticket: 'AF-30',
        afPath: AF_PATH,
        projectDir: PROJECT_DIR,
        phaseAgentMap: new Map(pipeline.phases.map((p) => [p.name, p.agent])),
      },
      allWarnings: [],
      pipelineStart: Date.now(),
      name: 'sdlc',
      provider: mkProvider(),
    };

    const outcome = await sharedPhaseLoop(loopArgs);

    assert.equal(outcome, 'paused');

    // Verify state transitioned to paused correctly
    const reloaded = readPipelineState(pipelineOutputDir);
    assert.equal(reloaded!.status, 'paused');
    assert.ok(reloaded!.pausedAt, 'pausedAt should be set');
    assert.equal(reloaded!.currentPhase, undefined);
    // Phase zero was never started
    assert.equal(reloaded!.phases.design.status, 'pending');
    assert.equal(reloaded!.phases.design.startedAt, undefined);

    // Sentinel should NOT have been removed — only resume does that.
    assert.equal(pauseRequestExists(pipelineOutputDir), true);

    const out = io.captured.join('\n');
    assert.match(out, /Pause requested/);
    assert.match(out, /stopping before phase "design"/);
    assert.match(out, /af pipeline resume AF-30/);
  });

  it('observes sentinel between phases (startIndex > 0)', async () => {
    const pipelineOutputDir = join(AF_PATH, 'output', 'AF-30');
    mkdirSync(pipelineOutputDir, { recursive: true });
    const pipeline = mkPipeline();
    const state = initPipelineState(pipeline.name, 'AF-30', pipeline.phases);
    state.phases.design.status = 'completed';
    state.phases.design.durationMs = 120000;
    state.phases.design.gateResult = 'pass';
    writePipelineState(pipelineOutputDir, state);

    writePauseRequest(pipelineOutputDir, {
      requestedAt: '2026-04-15T12:02:00.000Z',
      requestedBy: 'cli',
    });

    const loopArgs: PhaseLoopArgs = {
      pipeline,
      phaseOrder: pipeline.phases,
      startIndex: 1, // would start at 'implement' — but pause observed first
      state,
      task: mkTask(),
      afPath: AF_PATH,
      projectDir: PROJECT_DIR,
      pipelineOutputDir,
      ctx: {
        ticket: 'AF-30',
        afPath: AF_PATH,
        projectDir: PROJECT_DIR,
        phaseAgentMap: new Map(pipeline.phases.map((p) => [p.name, p.agent])),
      },
      allWarnings: [],
      pipelineStart: Date.now(),
      name: 'sdlc',
      provider: mkProvider(),
    };

    const outcome = await sharedPhaseLoop(loopArgs);
    assert.equal(outcome, 'paused');

    const reloaded = readPipelineState(pipelineOutputDir);
    assert.equal(reloaded!.status, 'paused');
    // Design is still 'completed' (untouched); implement was never started
    assert.equal(reloaded!.phases.design.status, 'completed');
    assert.equal(reloaded!.phases.implement.status, 'pending');

    const out = io.captured.join('\n');
    assert.match(out, /stopping before phase "implement"/);
  });
});

// ============================================================
// Audit event records pause (sanity — the between-phase check path)
// ============================================================

describe('pipeline-state.json round-trips paused state', () => {
  const TMP = join(process.cwd(), '.af-test-paused-roundtrip');
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('preserves pausedAt / resumedAt fields', () => {
    const state: PipelineState = {
      pipeline: 'sdlc',
      ticket: 'AF-30',
      status: 'paused',
      startedAt: '2026-04-15T12:00:00.000Z',
      pausedAt: '2026-04-15T12:02:00.000Z',
      resumedAt: '2026-04-15T12:30:00.000Z',
      phases: {
        design: { agent: 'architect', status: 'completed' },
        implement: { agent: 'engineer', status: 'pending' },
      },
    };
    writePipelineState(TMP, state);
    const reloaded = readPipelineState(TMP);
    assert.ok(reloaded);
    assert.equal(reloaded!.status, 'paused');
    assert.equal(reloaded!.pausedAt, '2026-04-15T12:02:00.000Z');
    assert.equal(reloaded!.resumedAt, '2026-04-15T12:30:00.000Z');

    // On-disk JSON verifies the fields are serialized
    const raw = readFileSync(join(TMP, 'pipeline-state.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.status, 'paused');
    assert.equal(parsed.pausedAt, '2026-04-15T12:02:00.000Z');
    assert.equal(parsed.resumedAt, '2026-04-15T12:30:00.000Z');
  });
});
