/**
 * AF-39: Regression tests for pipeline task-refresh bugs (AF-35, AF-38).
 *
 * Covers:
 *   - AF-35: sharedPhaseLoop must call provider.get() so that task.filePath is
 *     current even when the initial task handle points to a stale path (e.g.
 *     before the runner's provider.move + re-fetch in pipelineRunCommand).
 *   - AF-38: sharedPhaseLoop re-fetches the task via provider.get() at the top
 *     of every phase iteration so that a mid-pipeline file move (e.g. engineer
 *     moves task from in-progress/ → ready-for-qa/) does not cause ENOENT in
 *     the next phase's composeSystemPrompt.
 *
 * Verification strategy (closing the gap):
 *   Both tests pass a task whose filePath points to a path where NO FILE EXISTS.
 *   The file only exists at the path returned by provider.get().  If the
 *   AF-38 refresh (pipeline.ts lines ~462-472) were reverted, composeSystemPrompt
 *   would call readFileSync on the stale path and throw ENOENT — the test would
 *   catch that via the "Failed to compose prompt" assertion.  Similarly, the
 *   AF-35 fix (lines ~299-305) ensures the task passed into sharedPhaseLoop is
 *   already refreshed at the pipelineRunCommand level; the loop-level refresh
 *   then provides a second layer of defence tested here.
 *
 * Run: npx tsx --test src/__tests__/pipeline-task-refresh.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  renameSync,
} from 'fs';
import { join } from 'path';
import chalk from 'chalk';

import {
  sharedPhaseLoop,
  type PhaseLoopArgs,
} from '../commands/pipeline.js';
import {
  initPipelineState,
  writePipelineState,
} from '../lib/pipeline-state.js';
import type { Task, TaskProvider } from '../lib/task-provider.js';
import type { PhaseDefinition, PipelineDefinition } from '../lib/pipeline.js';

// Deterministic output — no ANSI codes in assertions.
chalk.level = 0;

const TMP_ROOT = join(process.cwd(), '.af-test-task-refresh');
const PROJECT_DIR = join(TMP_ROOT, 'project');
const AF_PATH = join(PROJECT_DIR, '.af');

// ============================================================
// Fixture helpers
// ============================================================

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

/** Minimal valid task markdown — required by composeSystemPrompt's readFileSync. */
const TASK_MD = `---
ticket: AF-TEST
title: Test Task
type: task
status: in-progress
priority: medium
complexity: low
created: '2026-04-15'
updated: '2026-04-15'
---

# Test Task
Test body for regression test.
`;

function writeTaskFile(filePath: string): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, TASK_MD, 'utf-8');
}

function mkTask(filePath: string): Task {
  return {
    ticket: 'AF-TEST',
    title: 'Test Task',
    type: 'task',
    status: 'in-progress',
    priority: 'medium',
    complexity: 'low',
    assignee: 'architect',
    created: '2026-04-15',
    updated: '2026-04-15',
    description: '# Test Task',
    filePath,
  };
}

/**
 * Provider stub with a spy.
 *
 * getResponses[0] is returned on the first call, getResponses[1] on the
 * second, etc.  The last entry is repeated if the call count exceeds the
 * array length.  This lets tests simulate a mid-pipeline file move by
 * providing a different Task on subsequent calls.
 */
function mkSpyProvider(getResponses: Task[]): {
  provider: TaskProvider;
  getCalls: () => number;
} {
  let getCalls = 0;

  const provider: TaskProvider = {
    list: async () => [],
    get: async (_ticket: string) => {
      const idx = Math.min(getCalls, getResponses.length - 1);
      getCalls++;
      return getResponses[idx];
    },
    create: async () => {
      throw new Error('stub: create not implemented');
    },
    move: async () => {
      throw new Error('stub: move not implemented');
    },
    update: async () => {
      throw new Error('stub: update not implemented');
    },
    delete: async () => {
      throw new Error('stub: delete not implemented');
    },
  } as unknown as TaskProvider;

  return { provider, getCalls: () => getCalls };
}

function captureIO(): {
  captured: string[];
  restore: () => void;
} {
  const captured: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit;
  const origCwd = process.cwd;

  // Capture console.log (used by sharedPhaseLoop for all pipeline output).
  // Do NOT override process.stdout.write — that would swallow the node:test
  // TAP reporter's output and cause subsequent tests to be silently lost.
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  process.exit = ((code?: number) => {
    throw new Error(`__EXIT__${code ?? 0}`);
  }) as typeof process.exit;
  process.cwd = () => PROJECT_DIR;

  return {
    captured,
    restore: () => {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
      process.cwd = origCwd;
    },
  };
}

function mkPipeline(phases: PhaseDefinition[]): PipelineDefinition {
  return { name: 'test', description: 'regression test pipeline', phases };
}

function buildLoopArgs(
  pipeline: PipelineDefinition,
  task: Task,
  provider: TaskProvider,
  pipelineOutputDir: string,
): PhaseLoopArgs {
  const state = initPipelineState(pipeline.name, task.ticket, pipeline.phases);
  writePipelineState(pipelineOutputDir, state);

  return {
    pipeline,
    phaseOrder: pipeline.phases,
    startIndex: 0,
    state,
    task,
    afPath: AF_PATH,
    projectDir: PROJECT_DIR,
    pipelineOutputDir,
    ctx: {
      ticket: task.ticket,
      afPath: AF_PATH,
      projectDir: PROJECT_DIR,
      phaseAgentMap: new Map(pipeline.phases.map((p) => [p.name, p.agent])),
    },
    allWarnings: [],
    pipelineStart: Date.now(),
    name: pipeline.name,
    provider,
  };
}

// ============================================================
// AF-35 regression: runner-level task refresh after move-to-in-progress
// ============================================================
//
// Scenario: pipelineRunCommand receives a task whose status is NOT
// in-progress.  It calls provider.move(ticket, 'in-progress'), which moves
// the file on disk.  The fix (AF-35, lines ~299-305 of pipeline.ts) calls
// provider.get() immediately after to refresh task.filePath.
//
// This test verifies the defence-in-depth: even if the runner-level refresh
// were absent, sharedPhaseLoop's own provider.get() call (AF-38 fix) would
// catch it.  The stale-path ENOENT scenario is reproduced by:
//   - task.filePath points to tasks/open/AF-TEST.md  (file does NOT exist)
//   - file exists only at tasks/in-progress/AF-TEST.md  (the refreshed path)
//   - provider.get() returns the refreshed task
// If provider.get() were not called, composeSystemPrompt would ENOENT.

describe('AF-35 regression: provider.get() refreshes stale task.filePath at loop entry', () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    setupProject();
    io = captureIO();
  });

  afterEach(() => {
    io.restore();
    teardown();
  });

  it('provider.get() is called and composeSystemPrompt uses the refreshed filePath — not the stale open/ path', async () => {
    // Stale path — file does NOT exist here.
    const stalePath = join(AF_PATH, 'tasks', 'open', 'AF-TEST.md');

    // Refreshed path — file ONLY exists here.
    const refreshedPath = join(AF_PATH, 'tasks', 'in-progress', 'AF-TEST.md');
    writeTaskFile(refreshedPath);

    const pipelineOutputDir = join(AF_PATH, 'output', 'AF-TEST');
    mkdirSync(pipelineOutputDir, { recursive: true });

    const pipeline = mkPipeline([{ name: 'design', agent: 'architect' }]);

    // Task handed to the loop has the stale filePath (open/).
    const staleTask = mkTask(stalePath);

    // provider.get() returns the refreshed task (in-progress/).
    const refreshedTask = mkTask(refreshedPath);
    const { provider, getCalls } = mkSpyProvider([refreshedTask]);

    const loopArgs = buildLoopArgs(pipeline, staleTask, provider, pipelineOutputDir);
    const outcome = await sharedPhaseLoop(loopArgs);

    // Loop should fail — but at spawn level, NOT at composeSystemPrompt.
    assert.equal(outcome, 'failed');

    // Spy assertion: provider.get() must have been called at least once.
    // This is the mechanism that keeps task.filePath current.
    // Reverting lines ~462-472 of pipeline.ts causes getCalls() === 0 and
    // the test fails with ENOENT from composeSystemPrompt.
    assert.ok(getCalls() >= 1, `provider.get() must be called at least once; got ${getCalls()}`);

    const out = io.captured.join('\n');

    // composeSystemPrompt must NOT have thrown ENOENT.
    // If the stale path were used, "Failed to compose prompt" + "ENOENT" appears.
    assert.ok(
      !out.includes('Failed to compose prompt'),
      `composeSystemPrompt should have succeeded; got: ${out}`,
    );
    assert.ok(
      !out.includes('ENOENT'),
      `No ENOENT should appear — stale path was not used; got: ${out}`,
    );
  });
});

// ============================================================
// AF-38 regression: phase-loop-level task refresh between phases
// ============================================================
//
// Scenario: A pipeline runs multiple phases.  After phase N's agent executes,
// it may move the task file to a new status directory (e.g. in-progress/ →
// ready-for-qa/).  Without the AF-38 fix, sharedPhaseLoop would use the old
// task.filePath for phase N+1's composeSystemPrompt — causing ENOENT.
//
// The fix (AF-38, lines ~462-472 of pipeline.ts) re-fetches the task via
// provider.get() at the TOP of every phase iteration, before composeSystemPrompt.
//
// We reproduce the scenario by:
//   - task.filePath starts at tasks/in-progress/AF-TEST.md  (stale, no file there)
//   - file exists only at tasks/ready-for-qa/AF-TEST.md  (simulating the move)
//   - provider.get() returns a task with the new (ready-for-qa) filePath
// If provider.get() were not called, composeSystemPrompt would ENOENT.

describe('AF-38 regression: provider.get() re-fetches task before each phase to survive mid-pipeline file moves', () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    setupProject();
    io = captureIO();
  });

  afterEach(() => {
    io.restore();
    teardown();
  });

  it('provider.get() is called and composeSystemPrompt survives a mid-pipeline file move (stale in-progress/ → actual ready-for-qa/)', async () => {
    // Stale path — simulates what the loop's task handle would hold after an
    // agent moved the file during the previous phase.  File does NOT exist here.
    const stalePath = join(AF_PATH, 'tasks', 'in-progress', 'AF-TEST.md');

    // Refreshed path — where the file actually lives now (agent moved it).
    const refreshedPath = join(AF_PATH, 'tasks', 'ready-for-qa', 'AF-TEST.md');
    writeTaskFile(refreshedPath);

    const pipelineOutputDir = join(AF_PATH, 'output', 'AF-TEST');
    mkdirSync(pipelineOutputDir, { recursive: true });

    const pipeline = mkPipeline([
      { name: 'implement', agent: 'engineer' },
    ]);

    // The task handed to the loop has the stale in-progress/ filePath.
    const staleTask = mkTask(stalePath);

    // provider.get() always returns the refreshed (ready-for-qa/) task.
    const refreshedTask = mkTask(refreshedPath);
    const { provider, getCalls } = mkSpyProvider([refreshedTask]);

    const loopArgs = buildLoopArgs(pipeline, staleTask, provider, pipelineOutputDir);
    const outcome = await sharedPhaseLoop(loopArgs);

    // Outcome is 'failed' — spawn cannot succeed in test environment.
    // The important thing is WHY it failed: spawn_error, not ENOENT.
    assert.equal(outcome, 'failed');

    // Spy assertion: provider.get() must have been called at least once per
    // phase iteration.  Reverting lines ~462-472 of pipeline.ts causes
    // getCalls() === 0 and the test fails with ENOENT from composeSystemPrompt.
    assert.ok(getCalls() >= 1, `provider.get() must be called ≥1 time; got ${getCalls()}`);

    const out = io.captured.join('\n');

    // The phase must have gotten PAST composeSystemPrompt.
    // If the stale in-progress/ path had been used, we would see ENOENT here.
    assert.ok(
      !out.includes('Failed to compose prompt'),
      `composeSystemPrompt should have succeeded (no ENOENT); got: ${out}`,
    );
    assert.ok(
      !out.includes('ENOENT'),
      `No ENOENT expected — refreshed path was used; got: ${out}`,
    );
  });

  it('provider.get() is called once per phase iteration entered (spy call-count matches phases attempted)', async () => {
    // File exists at the path provider.get() will return.
    const taskPath = join(AF_PATH, 'tasks', 'in-progress', 'AF-TEST.md');
    writeTaskFile(taskPath);

    const pipelineOutputDir = join(AF_PATH, 'output', 'AF-TEST');
    mkdirSync(pipelineOutputDir, { recursive: true });

    // Single-phase pipeline: loop enters exactly one iteration before failing
    // at the spawn step.  provider.get() should be called exactly once.
    const pipeline = mkPipeline([{ name: 'design', agent: 'architect' }]);

    const task = mkTask(taskPath);
    const { provider, getCalls } = mkSpyProvider([task]);

    const loopArgs = buildLoopArgs(pipeline, task, provider, pipelineOutputDir);
    await sharedPhaseLoop(loopArgs);

    // Exactly one phase was entered → exactly one provider.get() call.
    assert.equal(
      getCalls(),
      1,
      `Expected provider.get() to be called once (one phase attempted); got ${getCalls()}`,
    );
  });

  it('task object passed to composeSystemPrompt reflects the refreshed filePath returned by provider.get()', async () => {
    // Stale path — does NOT exist on disk.
    const stalePath = join(AF_PATH, 'tasks', 'open', 'AF-TEST.md');

    // Two different refreshed paths — one per provider.get() call.
    // The second would be used for a second phase if the first succeeded.
    const refreshedPath1 = join(AF_PATH, 'tasks', 'in-progress', 'AF-TEST.md');
    writeTaskFile(refreshedPath1);

    const pipelineOutputDir = join(AF_PATH, 'output', 'AF-TEST');
    mkdirSync(pipelineOutputDir, { recursive: true });

    const pipeline = mkPipeline([{ name: 'design', agent: 'architect' }]);

    const staleTask = mkTask(stalePath);
    const refreshedTask = mkTask(refreshedPath1);

    const { provider, getCalls } = mkSpyProvider([refreshedTask]);

    const loopArgs = buildLoopArgs(pipeline, staleTask, provider, pipelineOutputDir);
    const outcome = await sharedPhaseLoop(loopArgs);

    // The loop failed at spawn (expected) but NOT at composeSystemPrompt.
    assert.equal(outcome, 'failed');
    assert.equal(getCalls(), 1);

    const out = io.captured.join('\n');
    // No ENOENT means the refreshed path (which exists) was used.
    assert.ok(!out.includes('ENOENT'), `Got unexpected ENOENT: ${out}`);
    assert.ok(!out.includes('Failed to compose prompt'), `Got unexpected compose error: ${out}`);
  });
});
