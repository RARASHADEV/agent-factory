/**
 * AF-26: Pipeline run command — end-to-end orchestration across AF-23/24/25.
 *
 * `af pipeline run <name> --task <ticket>`
 *   For each phase in topological order:
 *     1. Resolve artifact injections from prior phases (AF-25)
 *     2. Compose the system prompt (agent + project + task + injections + context)
 *     3. Spawn the agent via spawn-runner.js as a non-detached subprocess
 *     4. Read result.json (AF-23) and evaluate the gate (AF-26 gate-evaluator)
 *     5. Continue or stop based on gate result
 *
 * `af pipeline list` — lists `.af/pipelines/*.yaml` pipeline definitions.
 *
 * State is streamed to `.af/output/<ticket>/pipeline-state.json` so AF-28
 * can observe it and a crashed pipeline leaves a forensic record.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
} from 'fs';
import { join, relative } from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';

import {
  ENABLE_AF_26,
  ENABLE_AF_27,
  ENABLE_AF_28,
  ENABLE_AF_34,
} from '../lib/constants.js';
import { loadConfig } from '../lib/config.js';
import { resolveProject } from '../lib/workspace.js';
import { createProvider } from '../lib/provider-factory.js';
import type { Task } from '../lib/task-provider.js';
import {
  loadPipeline,
  listPipelines,
  resolvePhaseOrder,
  type PhaseDefinition,
  type PipelineDefinition,
  type GateDefinition,
} from '../lib/pipeline.js';
import {
  buildInjectionContext,
  resolvePhaseInjections,
  composeInjectionPrompt,
  isFileGlobArtifact,
  expandTicketPlaceholder,
  type ResolvedInjection,
  type InjectionContext,
} from '../lib/artifact-injector.js';
import {
  evaluateGate,
  type GateEvaluationResult,
  type GateFailure,
} from '../lib/gate-evaluator.js';
import type { ResultSchema } from '../lib/result-schema.js';
import {
  writePipelineState,
  readPipelineState,
  initPipelineState,
  writePauseRequest,
  pauseRequestExists,
  readPauseRequest,
  removePauseRequest,
  findNextPendingPhase,
  type PipelineState,
  type PhaseState,
  type PhaseStatus,
} from '../lib/pipeline-state.js';
import { auditLog } from '../lib/audit.js';
import { heading, success, error, dim, warn } from '../lib/format.js';
import { loadAgent } from './agent.js';

// ============================================================
// Options
// ============================================================

export interface PipelineRunOptions {
  task: string;
  project?: string;
  dryRun?: boolean;
  from?: string;
}

export interface PipelineListOptions {
  project?: string;
}

export interface PipelineStatusOptions {
  project?: string;
  json?: boolean;
}

export interface PipelinePauseOptions {
  project?: string;
}

export interface PipelineResumeOptions {
  project?: string;
}

// ============================================================
// Helpers — formatting
// ============================================================

/**
 * Format a duration in milliseconds as "Xm Ys" (for >=60s) or "Ys".
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Icon for each phase status.
 */
function phaseIcon(status: PhaseStatus): string {
  switch (status) {
    case 'completed': return '✅';
    case 'failed': return '❌';
    case 'pending': return '⏸️';
    case 'skipped': return '⏭️';
    case 'running': return '🔄';
  }
}

/**
 * Format a single gate condition as "field operator value?" — omits value
 * for existence operators.
 */
function formatCondition(cond: {
  field: string;
  operator: string;
  value?: unknown;
}): string {
  if (cond.operator === 'exists' || cond.operator === 'not_exists') {
    return `${cond.field} ${cond.operator}`;
  }
  return `${cond.field} ${cond.operator} ${JSON.stringify(cond.value)}`;
}

/**
 * Format a gate for display in the execution plan.
 * Handles shorthand, `all`, and `any` compound forms.
 */
function formatGate(gate: GateDefinition): string[] {
  const lines: string[] = [];

  // Shorthand (AF-26 compat)
  if (gate.field !== undefined && gate.operator !== undefined) {
    lines.push(
      formatCondition({ field: gate.field, operator: gate.operator, value: gate.value }),
    );
  } else if (Array.isArray(gate.all)) {
    lines.push(`(all)`);
    for (const c of gate.all) lines.push(`  - ${formatCondition(c)}`);
  } else if (Array.isArray(gate.any)) {
    lines.push(`(any)`);
    for (const c of gate.any) lines.push(`  - ${formatCondition(c)}`);
  }

  if (typeof gate.retry === 'number' && gate.retry > 0) {
    lines.push(`retry: ${gate.retry}`);
  }

  return lines;
}

// ============================================================
// pipelineListCommand
// ============================================================

export function pipelineListCommand(options: PipelineListOptions): void {
  const resolved = resolveProject(options.project);
  if (!resolved) {
    console.log(error('No project found. Run from a project dir or use --project <prefix>.'));
    process.exit(1);
  }

  const { afPath } = resolved;
  const names = listPipelines(afPath);

  if (names.length === 0) {
    console.log(dim('No pipelines found. Add a definition at .af/pipelines/<name>.yaml.'));
    return;
  }

  console.log(heading('Pipelines'));
  console.log('');

  for (const name of names) {
    try {
      const p = loadPipeline(afPath, name);
      const desc = p.description ? dim(`— ${p.description}`) : '';
      const phaseCount = p.phases.length;
      console.log(
        `  ${chalk.bold(name.padEnd(20))} ${dim(`${phaseCount} phase${phaseCount === 1 ? '' : 's'}`)} ${desc}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${chalk.bold(name.padEnd(20))} ${chalk.red(`[invalid: ${msg.split('\n')[0]}]`)}`);
    }
  }

  console.log('');
  console.log(dim(`  ${names.length} pipeline${names.length === 1 ? '' : 's'}`));
}

// ============================================================
// pipelineRunCommand
// ============================================================

export async function pipelineRunCommand(
  name: string,
  options: PipelineRunOptions,
): Promise<void> {
  if (!ENABLE_AF_26) {
    console.log(error('Pipeline run is disabled (ENABLE_AF_26=false).'));
    process.exit(1);
  }

  // 1. Resolve workspace + project
  const resolved = resolveProject(options.project);
  if (!resolved) {
    console.log(error('No project found. Run from a project dir or use --project <prefix>.'));
    process.exit(1);
  }
  const { afPath, meta } = resolved;
  const projectDir = join(afPath, '..');

  // 2. Load pipeline
  let pipeline: PipelineDefinition;
  try {
    pipeline = loadPipeline(afPath, name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(error(msg));
    const available = listPipelines(afPath);
    if (available.length > 0) {
      console.log(dim(`Available: ${available.join(', ')}`));
    }
    process.exit(1);
  }

  // 3. Resolve task
  const provider = createProvider(afPath, meta);
  const ticket = options.task.toUpperCase();
  let task = await provider.get(ticket);
  if (!task) {
    console.log(error(`Task ${options.task} not found.`));
    process.exit(1);
  }
  if (task.status === 'blocked') {
    console.log(error(`Task ${task.ticket} is blocked. Unblock it first with \`af task move ${task.ticket} open\`.`));
    process.exit(1);
  }

  // 4. Plan
  const phaseOrder = resolvePhaseOrder(pipeline);
  let startIndex = 0;
  if (options.from) {
    try {
      startIndex = validateFromFlag(options.from, phaseOrder, task.ticket, afPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(error(msg));
      process.exit(1);
    }
  }

  // 5. Dry run?
  if (options.dryRun) {
    printExecutionPlan(pipeline, phaseOrder, startIndex, task.ticket);
    return;
  }

  // 6. Init state + output dir
  const pipelineOutputDir = join(afPath, 'output', task.ticket);
  mkdirSync(pipelineOutputDir, { recursive: true });
  const state = initPipelineState(pipeline.name, task.ticket, phaseOrder);
  for (let i = 0; i < startIndex; i++) {
    state.phases[phaseOrder[i].name].status = 'skipped';
  }
  writePipelineState(pipelineOutputDir, state);

  // 7. Task → in-progress (best effort)
  //    After the move, re-fetch the task so that task.filePath reflects the new
  //    location on disk. Otherwise the prompt composer reads a stale path and
  //    fails with ENOENT. See AF-35.
  try {
    if (task.status !== 'in-progress') {
      await provider.move(task.ticket, 'in-progress');
      const refreshed = await provider.get(task.ticket);
      if (refreshed) {
        task = refreshed;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(warn(`Could not move task to in-progress: ${msg}`));
  }

  // 8. Audit pipeline.start
  const pipelineStart = Date.now();
  auditLog(afPath, {
    event: 'pipeline.start',
    ticket: task.ticket,
    actor: 'cli',
    detail: `Pipeline ${name} started`,
    meta: {
      pipeline: name,
      phaseCount: phaseOrder.length,
      from: options.from,
    },
  });

  console.log(heading(`Pipeline ${name} — ${task.ticket}`));
  console.log(dim(`Phases: ${phaseOrder.length}${startIndex > 0 ? ` (starting at ${phaseOrder[startIndex].name})` : ''}`));
  console.log('');

  // 9. Injection context
  const ctx = buildInjectionContext(pipeline, task.ticket, afPath, projectDir);
  const allWarnings: string[] = [];

  // 10. Phase loop — extracted into sharedPhaseLoop so resume (AF-34) can reuse it.
  const loopOutcome = await sharedPhaseLoop({
    pipeline,
    phaseOrder,
    startIndex,
    state,
    task,
    afPath,
    projectDir,
    pipelineOutputDir,
    ctx,
    allWarnings,
    pipelineStart,
    name,
  });

  if (loopOutcome === 'failed') {
    process.exit(1);
  }
  // 'completed' — fall through to return
}

// ============================================================
// sharedPhaseLoop — the per-phase execution engine
// ============================================================

/**
 * Outcome of the shared phase loop.
 *
 * - 'completed' — all remaining phases from startIndex ran to success; state persisted
 *   as `completed`, success summary printed.
 * - 'failed'    — a phase failed; state persisted as `failed`, failure summary printed.
 *   Caller decides whether to `process.exit(1)`.
 * - 'paused'    — (AF-34) a pause.request sentinel was observed between phases; state
 *   persisted as `paused`, resume message printed. Caller exits 0.
 */
export type PhaseLoopOutcome = 'completed' | 'failed' | 'paused';

export interface PhaseLoopArgs {
  pipeline: PipelineDefinition;
  phaseOrder: PhaseDefinition[];
  startIndex: number;
  /** Live state — mutated + persisted as the loop runs. */
  state: PipelineState;
  task: Task;
  afPath: string;
  projectDir: string;
  pipelineOutputDir: string;
  ctx: InjectionContext;
  /** Accumulated injection warnings — appended to as phases run. */
  allWarnings: string[];
  /** Epoch ms — used for total pipeline duration reporting. */
  pipelineStart: number;
  /** Pipeline name (for logging + audit). */
  name: string;
}

/**
 * The per-phase execution engine shared by `pipeline run` and `pipeline resume`.
 *
 * Mechanical extraction from `pipelineRunCommand` (AF-34 commit 1) — behavior
 * preserved exactly. Returns an outcome tag so callers can decide the exit code
 * rather than calling `process.exit` from inside the loop.
 */
export async function sharedPhaseLoop(
  args: PhaseLoopArgs,
): Promise<PhaseLoopOutcome> {
  const {
    phaseOrder,
    startIndex,
    state,
    task,
    afPath,
    projectDir,
    pipelineOutputDir,
    ctx,
    allWarnings,
    pipelineStart,
    name,
  } = args;

  // Phase loop
  for (let i = startIndex; i < phaseOrder.length; i++) {
    const phase = phaseOrder[i];

    // AF-34: cooperative between-phase pause check.
    // If a pause request sentinel is present, transition to 'paused' before
    // starting phase[i], persist state, audit, and return — caller exits 0.
    // Sentinel is NOT deleted here; only `resume` removes it. This keeps
    // pause durable across crashes.
    if (ENABLE_AF_34 && pauseRequestExists(pipelineOutputDir)) {
      const pauseReq = readPauseRequest(pipelineOutputDir);
      state.status = 'paused';
      state.pausedAt = new Date().toISOString();
      state.currentPhase = undefined;
      if (allWarnings.length > 0) state.warnings = allWarnings;
      writePipelineState(pipelineOutputDir, state);

      auditLog(afPath, {
        event: 'pipeline.pause',
        ticket: task.ticket,
        actor: 'cli',
        detail: `Pipeline ${name} paused before phase ${phase.name}`,
        meta: {
          pipeline: name,
          pausedBeforePhase: phase.name,
          requestedAt: pauseReq?.requestedAt,
          requestedBy: pauseReq?.requestedBy,
        },
      });

      console.log('');
      console.log(warn(`Pause requested — stopping before phase "${phase.name}"`));
      console.log(dim(`    Resume with: af pipeline resume ${task.ticket}`));
      return 'paused';
    }

    const phaseStart = Date.now();

    state.currentPhase = phase.name;
    state.phases[phase.name].status = 'running';
    state.phases[phase.name].startedAt = new Date().toISOString();
    writePipelineState(pipelineOutputDir, state);

    auditLog(afPath, {
      event: 'pipeline.phase_start',
      ticket: task.ticket,
      agent: phase.agent,
      actor: 'cli',
      detail: `Phase ${phase.name} started`,
      meta: { phase: phase.name },
    });

    console.log(chalk.cyan(`▶ Phase ${chalk.bold(phase.name)} — ${phase.agent}`));

    // 10a. Resolve injections
    const injResult = resolvePhaseInjections(phase, ctx);
    allWarnings.push(...injResult.warnings);
    for (const w of injResult.warnings) {
      console.log(dim(`  [inject] ${w}`));
    }

    // 10b. Compose prompt
    let systemPrompt: string;
    try {
      systemPrompt = composeSystemPrompt({
        agentSlug: phase.agent,
        projectDir,
        afPath,
        task,
        injections: injResult.resolved,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(error(`  Failed to compose prompt: ${msg}`));
      finalizePhaseFailure(state, phase, phaseStart, 'spawn_error', msg, pipelineOutputDir, afPath, task.ticket);
      finalizePipelineFailure(state, name, phase.name, pipelineOutputDir, afPath, task.ticket, allWarnings, pipelineStart);
      printFailureSummary(state, phase.name, task.ticket, name, pipelineOutputDir);
      return 'failed';
    }

    // 10c. Spawn + evaluate gate — with optional retry (AF-27)
    const phaseOutputDir = join(pipelineOutputDir, phase.agent);
    mkdirSync(phaseOutputDir, { recursive: true });

    const rawRetry = ENABLE_AF_27 ? (phase.gate?.retry ?? 0) : 0;
    const maxAttempts = 1 + Math.max(0, rawRetry);

    const outcome = await runPhaseWithRetry({
      phase,
      maxAttempts,
      spawn: () =>
        runPhaseSubprocess({
          systemPrompt,
          agentSlug: phase.agent,
          ticket: task.ticket,
          cwd: projectDir,
          outputDir: phaseOutputDir,
          afPath,
        }),
      loadResult: () => {
        const r = loadPhaseResultJson(phase.name, ctx);
        if (r && (r as ResultSchema)._synthetic) {
          console.log(
            warn(
              `  Phase ${phase.name}: result.json is synthetic — agent did not emit a structured result-json block`,
            ),
          );
        }
        return r as ResultSchema | null;
      },
      onRetry: (attempt, mx, failures) => {
        auditLog(afPath, {
          event: 'pipeline.phase_retry',
          ticket: task.ticket,
          agent: phase.agent,
          actor: 'cli',
          detail: `Phase ${phase.name} retrying (attempt ${attempt}/${mx})`,
          meta: { phase: phase.name, attempt, maxAttempts: mx, failures },
        });
        console.log(
          warn(`  Gate failed on attempt ${attempt}/${mx} — retrying`),
        );
        for (const f of failures) {
          console.log(dim(`    ${f.message}`));
        }
      },
    });

    const attempts = outcome.attempts;
    const gateEval = outcome.gateEval;
    const phaseStatus = outcome.phaseStatus;
    const failureReason = outcome.failureReason;

    const phaseDuration = Date.now() - phaseStart;
    const ps = state.phases[phase.name];
    ps.status = phaseStatus;
    ps.completedAt = new Date().toISOString();
    ps.durationMs = phaseDuration;
    ps.outputDir = relative(afPath, phaseOutputDir);
    ps.attempts = attempts;

    if (gateEval) {
      ps.gateResult = gateEval.passed ? 'pass' : 'fail';
      if (!gateEval.passed) {
        ps.gateFailures = gateEval.failures.map((f) => ({
          field: f.condition.field,
          operator: f.condition.operator,
          expected: f.condition.value,
          actual: f.actual,
          message: f.message,
          remediation: f.remediation,
        }));
        // Back-compat: mirror first failure into the singular field
        ps.gateFailure = ps.gateFailures[0];
      } else {
        // Clear any prior stale failure record
        ps.gateFailures = undefined;
        ps.gateFailure = undefined;
      }
    } else if (!phase.gate) {
      ps.gateResult = 'skipped';
    }
    if (failureReason) ps.failureReason = failureReason;

    state.currentPhase = undefined;
    writePipelineState(pipelineOutputDir, state);

    // 10e. Decide to continue or stop
    if (phaseStatus === 'failed') {
      const failMessage =
        ps.gateFailures?.[0]?.message ??
        (failureReason === 'spawn_error'
          ? 'spawn exited non-zero'
          : failureReason === 'no_result_json'
            ? 'result.json not written'
            : `Phase ${phase.name} failed`);

      console.log(error(`  ${failMessage}`));
      // Print remaining gate failures (if any) for visibility
      if (ps.gateFailures && ps.gateFailures.length > 1) {
        for (const f of ps.gateFailures.slice(1)) {
          console.log(error(`  ${f.message}`));
        }
      }

      auditLog(afPath, {
        event: 'pipeline.phase_fail',
        ticket: task.ticket,
        agent: phase.agent,
        actor: 'cli',
        detail: failMessage,
        meta: {
          phase: phase.name,
          reason: failureReason,
          attempts,
          gateFailure: ps.gateFailure,
          gateFailures: ps.gateFailures,
        },
      });

      finalizePipelineFailure(state, name, phase.name, pipelineOutputDir, afPath, task.ticket, allWarnings, pipelineStart);
      printFailureSummary(state, phase.name, task.ticket, name, pipelineOutputDir);
      return 'failed';
    }

    const attemptsSuffix = attempts > 1 ? dim(` (attempts: ${attempts})`) : '';
    console.log(
      success(`  Phase ${phase.name} completed (${formatDuration(phaseDuration)})`) + attemptsSuffix,
    );
    console.log('');

    auditLog(afPath, {
      event: 'pipeline.phase_complete',
      ticket: task.ticket,
      agent: phase.agent,
      actor: 'cli',
      detail: `Phase ${phase.name} completed`,
      meta: {
        phase: phase.name,
        durationMs: phaseDuration,
        gateResult: ps.gateResult,
        attempts,
      },
    });
  }

  // 11. Complete
  state.status = 'completed';
  state.completedAt = new Date().toISOString();
  if (allWarnings.length > 0) state.warnings = allWarnings;
  writePipelineState(pipelineOutputDir, state);

  auditLog(afPath, {
    event: 'pipeline.complete',
    ticket: task.ticket,
    actor: 'cli',
    detail: `Pipeline ${name} completed`,
    meta: {
      pipeline: name,
      totalDurationMs: Date.now() - pipelineStart,
    },
  });

  printSuccessSummary(state, name, pipelineOutputDir, pipelineStart);
  return 'completed';
}

// ============================================================
// AF-34: pipelinePauseCommand
// ============================================================

/**
 * `af pipeline pause <ticket>` — request a pause. The runner observes the
 * sentinel on its next between-phase check and exits cleanly. Mid-phase
 * pause is not supported in v1; the currently-running agent subprocess
 * is never interrupted.
 */
export async function pipelinePauseCommand(
  ticket: string,
  options: PipelinePauseOptions,
): Promise<void> {
  if (!ENABLE_AF_34) {
    console.log(error('Pipeline pause/resume is disabled (ENABLE_AF_34=false).'));
    process.exit(1);
  }

  const resolved = resolveProject(options.project);
  if (!resolved) {
    console.log(error('No project found. Run from a project dir or use --project <prefix>.'));
    process.exit(1);
  }
  const { afPath } = resolved;

  const normalized = ticket.toUpperCase();
  const pipelineOutputDir = join(afPath, 'output', normalized);

  const state = readPipelineState(pipelineOutputDir);
  if (!state) {
    console.log(error(`No pipeline run found for ${normalized}.`));
    process.exit(1);
  }

  // Refuse if the pipeline is already in a terminal or already-paused state.
  if (state.status === 'completed') {
    console.log(error(`Pipeline ${state.pipeline} for ${normalized} is already completed.`));
    process.exit(1);
  }
  if (state.status === 'failed') {
    console.log(error(`Pipeline ${state.pipeline} for ${normalized} has already failed.`));
    process.exit(1);
  }
  if (state.status === 'paused') {
    console.log(error(`Pipeline ${state.pipeline} for ${normalized} is already paused.`));
    process.exit(1);
  }

  // state.status === 'running' — write the sentinel.
  const requestedAt = new Date().toISOString();
  writePauseRequest(pipelineOutputDir, {
    requestedAt,
    requestedBy: 'cli',
  });

  auditLog(afPath, {
    event: 'pipeline.pause',
    ticket: normalized,
    actor: 'cli',
    detail: `Pause requested for pipeline ${state.pipeline}`,
    meta: {
      pipeline: state.pipeline,
      requestedAt,
      requestedBy: 'cli',
    },
  });

  console.log(warn(`Pause requested for ${normalized}. Runner will stop at the next phase boundary.`));
  console.log(dim(`    State: ${join(pipelineOutputDir, 'pipeline-state.json')}`));
}

// ============================================================
// AF-34: pipelineResumeCommand
// ============================================================

/**
 * `af pipeline resume <ticket>` — continue a paused pipeline from the first
 * non-terminal phase. Durable: works even if the original runner process
 * exited after the pause was observed.
 *
 * Refuses to resume if:
 *   - no state file,
 *   - state is not `paused`,
 *   - the pipeline YAML has been edited in a structurally-incompatible way
 *     (phase name set differs from the saved state).
 *
 * Delegates to `sharedPhaseLoop`, the same engine used by `pipeline run`.
 */
export async function pipelineResumeCommand(
  ticket: string,
  options: PipelineResumeOptions,
): Promise<void> {
  if (!ENABLE_AF_34) {
    console.log(error('Pipeline pause/resume is disabled (ENABLE_AF_34=false).'));
    process.exit(1);
  }

  const resolved = resolveProject(options.project);
  if (!resolved) {
    console.log(error('No project found. Run from a project dir or use --project <prefix>.'));
    process.exit(1);
  }
  const { afPath, meta } = resolved;
  const projectDir = join(afPath, '..');

  const normalized = ticket.toUpperCase();
  const pipelineOutputDir = join(afPath, 'output', normalized);

  const state = readPipelineState(pipelineOutputDir);
  if (!state) {
    console.log(error(`No pipeline run found for ${normalized}.`));
    process.exit(1);
  }

  if (state.status === 'completed') {
    console.log(
      error(
        `Pipeline ${state.pipeline} for ${normalized} is already completed — nothing to resume.`,
      ),
    );
    process.exit(1);
  }
  if (state.status === 'failed') {
    console.log(
      error(
        `Pipeline ${state.pipeline} for ${normalized} failed. Use \`af pipeline run ${state.pipeline} --task ${normalized} --from <phase>\` to re-run from a specific phase.`,
      ),
    );
    process.exit(1);
  }
  if (state.status === 'running') {
    console.log(
      error(
        `Pipeline ${state.pipeline} for ${normalized} is marked running. If a previous run crashed, use \`af pipeline run ${state.pipeline} --task ${normalized} --from <phase>\` to recover.`,
      ),
    );
    process.exit(1);
  }
  // state.status === 'paused'

  // Load the pipeline definition. If the YAML is gone or malformed, bail.
  let pipeline: PipelineDefinition;
  try {
    pipeline = loadPipeline(afPath, state.pipeline);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(error(`Could not load pipeline definition "${state.pipeline}": ${msg}`));
    process.exit(1);
  }

  const phaseOrder = resolvePhaseOrder(pipeline);

  // Safety check: refuse if the pipeline definition's phase set has changed
  // since the pause. Order/gate/injection differences within a phase are OK —
  // completed phases' artifacts are already on disk.
  const savedPhaseNames = new Set(Object.keys(state.phases));
  const currentPhaseNames = new Set(phaseOrder.map((p) => p.name));
  if (
    savedPhaseNames.size !== currentPhaseNames.size ||
    [...savedPhaseNames].some((n) => !currentPhaseNames.has(n))
  ) {
    console.log(
      error(
        `Pipeline definition has changed since pause. Cannot resume. ` +
          `Use \`af pipeline run ${state.pipeline} --task ${normalized} --from <phase>\` if you intend to proceed with the new definition.`,
      ),
    );
    process.exit(1);
  }

  const startIndex = findNextPendingPhase(state, phaseOrder);

  // Degenerate case: nothing left to run. Flip the status to completed and exit.
  if (startIndex >= phaseOrder.length) {
    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    writePipelineState(pipelineOutputDir, state);
    removePauseRequest(pipelineOutputDir);
    console.log(
      success(
        `Pipeline ${state.pipeline} already complete for ${normalized} — no phases pending.`,
      ),
    );
    return;
  }

  // Resolve the task — needed for prompt composition.
  const provider = createProvider(afPath, meta);
  const task = await provider.get(normalized);
  if (!task) {
    console.log(error(`Task ${normalized} not found.`));
    process.exit(1);
  }

  // Clear the sentinel, flip state back to running, record resumedAt.
  removePauseRequest(pipelineOutputDir);
  state.status = 'running';
  state.resumedAt = new Date().toISOString();
  writePipelineState(pipelineOutputDir, state);

  auditLog(afPath, {
    event: 'pipeline.resume',
    ticket: normalized,
    actor: 'cli',
    detail: `Pipeline ${state.pipeline} resumed from phase ${phaseOrder[startIndex].name}`,
    meta: {
      pipeline: state.pipeline,
      fromPhase: phaseOrder[startIndex].name,
    },
  });

  console.log(heading(`Resuming pipeline ${state.pipeline} — ${normalized} from phase "${phaseOrder[startIndex].name}"`));
  const priorDone = phaseOrder
    .slice(0, startIndex)
    .filter((p) => {
      const ps = state.phases[p.name];
      return ps && (ps.status === 'completed' || ps.status === 'skipped');
    })
    .map((p) => {
      const ps = state.phases[p.name];
      return `${p.name} (${ps.status === 'completed' ? '✅' : '⏭️'})`;
    });
  if (priorDone.length > 0) {
    console.log(dim(`  Prior phases: ${priorDone.join(', ')}`));
  }
  console.log('');

  // Rebuild runtime context — same as `run`.
  const ctx = buildInjectionContext(pipeline, normalized, afPath, projectDir);
  const allWarnings: string[] = state.warnings ? [...state.warnings] : [];
  const parsedStart = Date.parse(state.startedAt);
  const pipelineStart = Number.isNaN(parsedStart) ? Date.now() : parsedStart;

  const outcome = await sharedPhaseLoop({
    pipeline,
    phaseOrder,
    startIndex,
    state,
    task,
    afPath,
    projectDir,
    pipelineOutputDir,
    ctx,
    allWarnings,
    pipelineStart,
    name: state.pipeline,
  });

  if (outcome === 'failed') {
    process.exit(1);
  }
  // 'completed' or 'paused' → exit 0
}

// ============================================================
// Phase retry loop (AF-27)
// ============================================================

/**
 * Outcome of executing a phase (possibly with retries).
 * Pure — captures the final state of the attempt(s); the caller persists it.
 */
export interface PhaseExecOutcome {
  attempts: number;
  spawnOk: boolean;
  phaseResult: ResultSchema | null;
  gateEval: GateEvaluationResult | null;
  phaseStatus: PhaseStatus;
  failureReason?: 'spawn_error' | 'no_result_json' | 'gate_failure';
}

/**
 * Arguments for runPhaseWithRetry — all side effects are injected so the
 * retry loop itself is deterministic and unit-testable.
 */
export interface RunPhaseWithRetryArgs {
  phase: PhaseDefinition;
  maxAttempts: number;
  /** Spawn the phase's subprocess. Returns true on exit 0, false otherwise. */
  spawn: () => Promise<boolean>;
  /** Load the phase's result.json. Returns null when missing or malformed. */
  loadResult: () => ResultSchema | null;
  /** Called once per retry (i.e. after attempt N fails the gate, with N < maxAttempts). */
  onRetry?: (attempt: number, maxAttempts: number, failures: GateFailure[]) => void;
}

/**
 * Execute a single pipeline phase with optional retry on gate failure.
 *
 * Rules:
 *   - spawn_error (spawn returned false): fail-fast, no retry.
 *   - no_result_json (loadResult returned null): fail-fast, no retry.
 *   - gate failure: retry up to maxAttempts total attempts.
 *   - no gate: first successful spawn + result counts as passing.
 *
 * Pure coordinator — does not write state or audit logs; the caller does.
 */
export async function runPhaseWithRetry(
  args: RunPhaseWithRetryArgs,
): Promise<PhaseExecOutcome> {
  const { phase, maxAttempts, spawn, loadResult, onRetry } = args;

  let attempts = 0;
  let spawnOk = false;
  let phaseResult: ResultSchema | null = null;
  let gateEval: GateEvaluationResult | null = null;
  let phaseStatus: PhaseStatus = 'completed';
  let failureReason: 'spawn_error' | 'no_result_json' | 'gate_failure' | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;

    spawnOk = await spawn();
    if (!spawnOk) {
      phaseStatus = 'failed';
      failureReason = 'spawn_error';
      gateEval = null;
      break;
    }

    phaseResult = loadResult();
    if (!phaseResult) {
      phaseStatus = 'failed';
      failureReason = 'no_result_json';
      gateEval = null;
      break;
    }

    if (!phase.gate) {
      phaseStatus = 'completed';
      gateEval = null;
      break;
    }

    gateEval = evaluateGate(phase.gate, phaseResult);
    if (gateEval.passed) {
      phaseStatus = 'completed';
      break;
    }

    if (attempt < maxAttempts) {
      onRetry?.(attempt, maxAttempts, gateEval.failures);
      continue;
    }

    phaseStatus = 'failed';
    failureReason = 'gate_failure';
  }

  return {
    attempts,
    spawnOk,
    phaseResult,
    gateEval,
    phaseStatus,
    failureReason,
  };
}

// ============================================================
// Subprocess spawning
// ============================================================

interface RunPhaseArgs {
  systemPrompt: string;
  agentSlug: string;
  ticket: string;
  cwd: string;
  outputDir: string;
  afPath: string;
}

/**
 * Spawn a phase's agent via spawn-runner.js as a non-detached subprocess.
 * Returns true if the subprocess exited 0, false otherwise.
 *
 * We reuse spawn-runner.js via subprocess instead of calling runAgent inline
 * because spawn-runner already handles status.json / result.md / result.json,
 * crash safety, timeouts, audit spawn.* events, and Loka activity posting.
 */
async function runPhaseSubprocess(args: RunPhaseArgs): Promise<boolean> {
  const agent = loadAgent(args.agentSlug);
  if (!agent) {
    console.log(error(`  Agent "${args.agentSlug}" not found in registry`));
    return false;
  }

  const config = loadConfig();

  const spawnConfig = {
    systemPrompt: args.systemPrompt,
    taskPrompt:
      'Execute the task described in the system prompt. Follow all instructions, check off acceptance criteria as you complete them, and log your work.',
    model: agent.meta.model || config.defaults.model,
    maxTurns: agent.meta.maxTurns || config.defaults.max_turns,
    tools: agent.meta.tools || undefined,
    cwd: args.cwd,
    outputDir: args.outputDir,
    ticket: args.ticket,
    agentSlug: args.agentSlug,
    afPath: args.afPath,
  };

  const configFile = join(args.outputDir, 'config.json');
  writeFileSync(configFile, JSON.stringify(spawnConfig, null, 2));

  // import.meta.dirname = dist/commands/ → go up to dist/
  const runnerPath = join(import.meta.dirname, '..', 'spawn-runner.js');
  const logFile = join(args.outputDir, 'agent.log');
  const out = openSync(logFile, 'a');

  console.log(dim(`  Log: ${logFile}`));

  return new Promise<boolean>((resolve) => {
    const child = spawn('node', [runnerPath, configFile], {
      cwd: args.cwd,
      stdio: ['ignore', out, out],
      env: { ...process.env, CLAUDECODE: undefined },
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

// ============================================================
// Prompt composition
// ============================================================

interface ComposeArgs {
  agentSlug: string;
  projectDir: string;
  afPath: string;
  task: Task;
  injections: ResolvedInjection[];
}

/**
 * Compose the system prompt for a pipeline phase.
 * Layout: agent body + project + task + (injected artifacts) + (context).
 *
 * Mirrors agentSpawnCommand's composition with an extra section for
 * AF-25 injected artifacts, spliced between Task and Context.
 */
function composeSystemPrompt(args: ComposeArgs): string {
  const agent = loadAgent(args.agentSlug);
  if (!agent) {
    throw new Error(`Agent "${args.agentSlug}" not found in registry`);
  }

  const projectFile = join(args.afPath, 'project.md');
  const projectContent = existsSync(projectFile) ? readFileSync(projectFile, 'utf-8') : '';

  const contextDir = join(args.afPath, 'context');
  let contextContent = '';
  if (existsSync(contextDir)) {
    const contextFiles = readdirSync(contextDir).filter((f) => f.endsWith('.md'));
    for (const f of contextFiles) {
      const content = readFileSync(join(contextDir, f), 'utf-8');
      contextContent += `\n--- ${f} ---\n${content}\n`;
    }
  }

  if (!args.task.filePath) {
    throw new Error(`Task ${args.task.ticket} has no filePath — cannot compose prompt`);
  }
  const taskContent = readFileSync(args.task.filePath, 'utf-8');

  const injectionSection = composeInjectionPrompt(args.injections);

  return [
    agent.content.trim(),
    '',
    '---',
    '',
    '## Project',
    projectContent.trim(),
    '',
    '## Task',
    taskContent.trim(),
    injectionSection ? `\n${injectionSection}` : '',
    contextContent ? `\n## Context\n${contextContent.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ============================================================
// Result loading
// ============================================================

/**
 * Load a phase's result.json. Centralized here so the pipeline command
 * is not coupled to artifact-injector's internal helper choice.
 */
function loadPhaseResultJson(
  phaseName: string,
  ctx: InjectionContext,
) {
  const agentSlug = ctx.phaseAgentMap.get(phaseName);
  if (!agentSlug) return null;
  const resultPath = join(ctx.afPath, 'output', ctx.ticket, agentSlug, 'result.json');
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================
// --from validation
// ============================================================

/**
 * Validate a --from flag:
 *   - phase name must exist in the pipeline
 *   - every earlier phase must have an existing result.json
 * Returns the zero-based start index into phaseOrder.
 * Throws on invalid input.
 */
export function validateFromFlag(
  fromPhase: string,
  phaseOrder: PhaseDefinition[],
  ticket: string,
  afPath: string,
): number {
  const idx = phaseOrder.findIndex((p) => p.name === fromPhase);
  if (idx < 0) {
    const available = phaseOrder.map((p) => p.name).join(', ');
    throw new Error(`--from: unknown phase "${fromPhase}" (available: ${available})`);
  }
  for (let i = 0; i < idx; i++) {
    const phase = phaseOrder[i];
    const rp = join(afPath, 'output', ticket, phase.agent, 'result.json');
    if (!existsSync(rp)) {
      throw new Error(
        `--from ${fromPhase}: prior phase "${phase.name}" has no result.json at ${rp}. ` +
          `Run the earlier phases first, or start the pipeline from an earlier phase.`,
      );
    }
  }
  return idx;
}

// ============================================================
// Finalizers (phase/pipeline failure state transitions)
// ============================================================

function finalizePhaseFailure(
  state: PipelineState,
  phase: PhaseDefinition,
  phaseStart: number,
  reason: 'spawn_error' | 'no_result_json' | 'gate_failure',
  message: string,
  pipelineOutputDir: string,
  afPath: string,
  ticket: string,
): void {
  const ps = state.phases[phase.name];
  ps.status = 'failed';
  ps.completedAt = new Date().toISOString();
  ps.durationMs = Date.now() - phaseStart;
  ps.failureReason = reason;
  state.currentPhase = undefined;
  writePipelineState(pipelineOutputDir, state);

  auditLog(afPath, {
    event: 'pipeline.phase_fail',
    ticket,
    agent: phase.agent,
    actor: 'cli',
    detail: message,
    meta: { phase: phase.name, reason },
  });
}

function finalizePipelineFailure(
  state: PipelineState,
  pipelineName: string,
  failedPhase: string,
  pipelineOutputDir: string,
  afPath: string,
  ticket: string,
  allWarnings: string[],
  pipelineStart: number,
): void {
  state.status = 'failed';
  state.completedAt = new Date().toISOString();
  if (allWarnings.length > 0) state.warnings = allWarnings;
  writePipelineState(pipelineOutputDir, state);

  auditLog(afPath, {
    event: 'pipeline.fail',
    ticket,
    actor: 'cli',
    detail: `Pipeline ${pipelineName} failed at phase ${failedPhase}`,
    meta: {
      pipeline: pipelineName,
      phase: failedPhase,
      totalDurationMs: Date.now() - pipelineStart,
    },
  });
}

// ============================================================
// Printers
// ============================================================

/**
 * Print the execution plan for --dry-run.
 */
export function printExecutionPlan(
  pipeline: PipelineDefinition,
  phaseOrder: PhaseDefinition[],
  startIndex: number,
  ticket: string,
): void {
  console.log(heading(`Pipeline: ${pipeline.name} — ${ticket}`));
  console.log(dim(`Phases: ${phaseOrder.length}  (dry run — no agents will be spawned)`));
  if (startIndex > 0) {
    console.log(dim(`Starting at: ${phaseOrder[startIndex].name}`));
  }
  console.log('');

  for (let i = 0; i < phaseOrder.length; i++) {
    const phase = phaseOrder[i];
    const idx = i + 1;
    const skipped = i < startIndex;
    const prefix = skipped ? '~' : ' ';
    const name = chalk.bold(phase.name);
    const skipTag = skipped ? dim(' (skipped)') : '';
    const requires = phase.requires && phase.requires.length > 0
      ? dim(`requires: ${phase.requires.join(', ')}`)
      : '';

    const line = `  ${prefix}${idx}. ${name.padEnd(20)} ${phase.agent.padEnd(14)}${skipTag}${requires ? '   ' + requires : ''}`;
    console.log(line.trimEnd());

    if (phase.inject && phase.inject.length > 0) {
      console.log(dim('     inject:'));
      for (const inj of phase.inject) {
        const expanded = expandTicketPlaceholder(inj.artifact, ticket);
        const kind = isFileGlobArtifact(inj.artifact) ? 'file glob' : 'dot-path';
        console.log(dim(`       - ${inj.as}  ← ${inj.from} phase  (${kind}: ${expanded})`));
      }
    }

    if (phase.gate) {
      const lines = formatGate(phase.gate);
      if (lines.length === 1) {
        console.log(dim(`     gate: ${lines[0]}`));
      } else if (lines.length > 1) {
        console.log(dim(`     gate: ${lines[0]}`));
        for (const l of lines.slice(1)) {
          console.log(dim(`       ${l}`));
        }
      }
    }

    console.log('');
  }
}

/**
 * Compute the duration to display for a phase, including live elapsed for
 * currently-running phases. Returns `undefined` when not known (pending, or
 * a startedAt that won't parse).
 */
function livePhaseDurationMs(ps: PhaseState, now: number): number | undefined {
  if (ps.durationMs !== undefined) return ps.durationMs;
  if (ps.status === 'running' && ps.startedAt) {
    const t = Date.parse(ps.startedAt);
    if (!Number.isNaN(t)) return now - t;
  }
  return undefined;
}

/**
 * Format the gate/status column for a single phase row.
 * Shared between success summary, failure summary, and status rendering.
 */
function formatPhaseStatusColumn(ps: PhaseState): string {
  if (ps.status === 'skipped') return dim('skipped');
  if (ps.status === 'pending') return dim('pending');
  if (ps.status === 'running') return dim('running');
  if (ps.status === 'failed') return `gate: ${ps.gateResult ?? 'fail'}`;
  // completed
  return ps.gateResult ? `gate: ${ps.gateResult}` : '';
}

/**
 * Render a single phase row — icon, name, agent, duration, gate/status, attempts.
 * Shared between success summary, failure summary, and status rendering.
 *
 * Returns the formatted line (no trailing newline).
 */
function renderPhaseLine(
  phaseName: string,
  ps: PhaseState,
  now: number,
): string {
  const icon = phaseIcon(ps.status);
  const gate = formatPhaseStatusColumn(ps);
  const attemptsTag =
    typeof ps.attempts === 'number' && ps.attempts > 1
      ? dim(`  (attempts: ${ps.attempts})`)
      : '';
  const durMs = livePhaseDurationMs(ps, now);
  const dur =
    ps.status === 'skipped' || ps.status === 'pending'
      ? dim('—')
      : durMs !== undefined
        ? dim(formatDuration(durMs))
        : dim('—');
  return `  ${icon}  ${chalk.bold(phaseName.padEnd(12))} ${dim((ps.agent ?? '').padEnd(12))} ${dur.padEnd(10)} ${gate}${attemptsTag}`;
}

/**
 * Render the gate-failure detail block for a failed phase.
 * Emits one line per failure (plus optional remediation). Returns the lines
 * — caller concatenates / prints. Empty array when there are no failures.
 */
function renderPhaseFailureDetail(ps: PhaseState): string[] {
  if (ps.status !== 'failed') return [];
  const failures =
    ps.gateFailures && ps.gateFailures.length > 0
      ? ps.gateFailures
      : ps.gateFailure
        ? [ps.gateFailure]
        : [];
  const lines: string[] = [];
  if (failures.length > 0) {
    for (const f of failures) {
      lines.push(chalk.red(`       ${f.message}`));
      if (f.remediation) {
        lines.push(dim(`       → ${f.remediation}`));
      }
    }
  } else {
    const reasonMsg =
      ps.failureReason === 'spawn_error'
        ? 'spawn exited non-zero'
        : ps.failureReason === 'no_result_json'
          ? 'result.json not written'
          : 'phase failed';
    lines.push(chalk.red(`       ${reasonMsg}`));
  }
  return lines;
}

/**
 * Print a success summary when the pipeline completes.
 */
function printSuccessSummary(
  state: PipelineState,
  pipelineName: string,
  pipelineOutputDir: string,
  pipelineStart: number,
): void {
  const total = Date.now() - pipelineStart;
  const now = Date.now();
  console.log('');
  console.log(success(`Pipeline ${pipelineName} completed for ${state.ticket} (${formatDuration(total)})`));
  console.log('');

  for (const [phaseName, ps] of Object.entries(state.phases)) {
    console.log(renderPhaseLine(phaseName, ps, now));
  }

  console.log('');
  console.log(dim(`  Output: ${pipelineOutputDir}/`));
}

/**
 * Print a failure summary when a phase fails.
 */
function printFailureSummary(
  state: PipelineState,
  failedPhase: string,
  ticket: string,
  pipelineName: string,
  pipelineOutputDir: string,
): void {
  console.log('');
  console.log(error(`Pipeline ${pipelineName} failed at phase "${failedPhase}" for ${ticket}`));
  console.log('');

  const now = Date.now();
  for (const [phaseName, ps] of Object.entries(state.phases)) {
    console.log(renderPhaseLine(phaseName, ps, now));
    for (const detail of renderPhaseFailureDetail(ps)) {
      console.log(detail);
    }
  }

  console.log('');
  console.log(dim(`  State: ${join(pipelineOutputDir, 'pipeline-state.json')}`));
  const failed = state.phases[failedPhase];
  if (failed?.agent) {
    console.log(dim(`  Log:   ${join(pipelineOutputDir, failed.agent, 'agent.log')}`));
  }
}

// ============================================================
// pipelineStatusCommand (AF-28)
// ============================================================

/**
 * Format a relative duration for "started Xm ago" display.
 * Uses minutes for anything >= 60s, seconds otherwise, hours for >= 1h.
 */
function formatRelative(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s ago`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h ago` : `${hours}h ${remMin}m ago`;
}

/**
 * Scan `<afPath>/output/*` and return the ticket directory names whose
 * subfolder contains a `pipeline-state.json` file.
 */
export function findPipelineRuns(afPath: string): string[] {
  const base = join(afPath, 'output');
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(join(base, name, 'pipeline-state.json')));
  } catch {
    return [];
  }
}

/**
 * Render a full pipeline run to stdout-ready lines.
 * Pure: takes `now` so the helper is deterministic and unit-testable.
 */
export function renderPipelineState(
  state: PipelineState,
  afPath: string,
  now: number = Date.now(),
): string[] {
  const lines: string[] = [];

  // Header
  let statusLine: string;
  let pausedLine: string | undefined;
  if (state.status === 'running') {
    const started = Date.parse(state.startedAt);
    const elapsed = Number.isNaN(started) ? undefined : now - started;
    const el = elapsed !== undefined ? ` (${formatDuration(elapsed)})` : '';
    statusLine = `Status: ${chalk.cyan('running')}${el}`;
  } else if (state.status === 'completed') {
    const started = Date.parse(state.startedAt);
    const completed = state.completedAt ? Date.parse(state.completedAt) : NaN;
    const total =
      !Number.isNaN(started) && !Number.isNaN(completed)
        ? completed - started
        : undefined;
    const el = total !== undefined ? ` (${formatDuration(total)})` : '';
    statusLine = `Status: ${chalk.green('completed')}${el}`;
  } else if (state.status === 'paused') {
    // AF-34: paused state — show elapsed-since-start and a resume hint.
    const started = Date.parse(state.startedAt);
    const elapsed = Number.isNaN(started) ? undefined : now - started;
    const el = elapsed !== undefined ? ` (${formatDuration(elapsed)} elapsed)` : '';
    statusLine = `Status: ${chalk.yellow('paused')}${el}`;
    if (state.pausedAt) {
      pausedLine = dim(
        `Paused at: ${state.pausedAt}  — resume with \`af pipeline resume ${state.ticket}\``,
      );
    }
  } else {
    // failed
    const started = Date.parse(state.startedAt);
    const completed = state.completedAt ? Date.parse(state.completedAt) : NaN;
    const total =
      !Number.isNaN(started) && !Number.isNaN(completed)
        ? completed - started
        : undefined;
    const el = total !== undefined ? ` (${formatDuration(total)})` : '';
    statusLine = `Status: ${chalk.red('failed')}${el}`;
  }

  lines.push(heading(`Pipeline: ${state.pipeline} — ${state.ticket}`));
  lines.push(statusLine);
  if (pausedLine) lines.push(pausedLine);
  lines.push('');

  // Phase rows
  for (const [phaseName, ps] of Object.entries(state.phases)) {
    lines.push(renderPhaseLine(phaseName, ps, now));
    for (const detail of renderPhaseFailureDetail(ps)) {
      lines.push(detail);
    }
  }

  lines.push('');
  const pipelineOutputDir = join(afPath, 'output', state.ticket);
  lines.push(dim(`  State:  ${join(pipelineOutputDir, 'pipeline-state.json')}`));
  lines.push(dim(`  Output: ${pipelineOutputDir}/`));

  if (state.warnings && state.warnings.length > 0) {
    lines.push('');
    lines.push(dim(`  Warnings:`));
    for (const w of state.warnings) {
      lines.push(dim(`    ${w}`));
    }
  }

  return lines;
}

/**
 * Render a one-line summary per pipeline run for list mode.
 * Sorted by startedAt desc (newest first). Pure — caller supplies `now`.
 */
export function renderRunList(
  states: PipelineState[],
  now: number = Date.now(),
): string[] {
  const lines: string[] = [];

  if (states.length === 0) {
    lines.push(dim('No pipeline runs found.'));
    return lines;
  }

  // Sort by startedAt desc (stable). Unparseable timestamps sink to the bottom.
  const sorted = [...states].sort((a, b) => {
    const ta = Date.parse(a.startedAt);
    const tb = Date.parse(b.startedAt);
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    return vb - va;
  });

  lines.push(heading('Pipeline runs'));
  lines.push('');

  for (const state of sorted) {
    const icon =
      state.status === 'running'
        ? '🔄'
        : state.status === 'completed'
          ? '✅'
          : state.status === 'paused'
            ? '⏸️'
            : '❌';

    const started = Date.parse(state.startedAt);
    const startedStr = Number.isNaN(started)
      ? dim('—')
      : dim(`started ${formatRelative(now - started)}`);

    const completedTs =
      state.completedAt !== undefined ? Date.parse(state.completedAt) : NaN;
    const totalMs =
      !Number.isNaN(started) && !Number.isNaN(completedTs)
        ? completedTs - started
        : undefined;

    let trailing: string;
    if (state.status === 'running') {
      // Find current phase (prefer state.currentPhase, fallback: first running)
      let currentPhase: string | undefined = state.currentPhase;
      let currentPS: PhaseState | undefined = currentPhase
        ? state.phases[currentPhase]
        : undefined;
      if (!currentPS || currentPS.status !== 'running') {
        for (const [name, ps] of Object.entries(state.phases)) {
          if (ps.status === 'running') {
            currentPhase = name;
            currentPS = ps;
            break;
          }
        }
      }
      if (currentPhase && currentPS) {
        const liveMs = livePhaseDurationMs(currentPS, now);
        const liveStr = liveMs !== undefined ? formatDuration(liveMs) : '—';
        trailing = `${startedStr}   phase: ${currentPhase} (${liveStr})`;
      } else {
        trailing = startedStr;
      }
    } else if (state.status === 'completed') {
      const total = totalMs !== undefined ? formatDuration(totalMs) : '—';
      const phaseValues = Object.values(state.phases);
      const completedCount = phaseValues.filter(
        (p) => p.status === 'completed',
      ).length;
      const totalCount = phaseValues.length;
      trailing = `${dim(total.padEnd(10))}  ${completedCount}/${totalCount} phases passed`;
    } else if (state.status === 'paused') {
      // AF-34: show elapsed-since-start and the phase we're paused before.
      const elapsed = !Number.isNaN(started)
        ? formatDuration(now - started)
        : '—';
      // First phase with a non-terminal status is the one we'll resume into.
      let nextPending: string | undefined;
      for (const [name, ps] of Object.entries(state.phases)) {
        if (ps.status !== 'completed' && ps.status !== 'skipped') {
          nextPending = name;
          break;
        }
      }
      trailing = `${dim(elapsed.padEnd(10))}  paused before: ${nextPending ?? '—'}`;
    } else {
      // failed
      const total = totalMs !== undefined ? formatDuration(totalMs) : '—';
      // Find the failed phase + short reason
      let failedPhase: string | undefined;
      let failedPS: PhaseState | undefined;
      for (const [name, ps] of Object.entries(state.phases)) {
        if (ps.status === 'failed') {
          failedPhase = name;
          failedPS = ps;
          break;
        }
      }
      let reason = 'failed';
      if (failedPS) {
        if (failedPS.failureReason === 'spawn_error') {
          reason = 'spawn error';
        } else if (failedPS.failureReason === 'no_result_json') {
          reason = 'no result';
        } else if (failedPS.failureReason === 'gate_failure') {
          reason = 'gate failed';
        } else if (failedPS.gateResult === 'fail') {
          reason = 'gate failed';
        }
      }
      const phaseInfo = failedPhase
        ? `phase: ${failedPhase} — ${reason}`
        : reason;
      trailing = `${dim(total.padEnd(10))}  ${phaseInfo}`;
    }

    const statusWord =
      state.status === 'running'
        ? chalk.cyan('running  ')
        : state.status === 'completed'
          ? chalk.green('completed')
          : state.status === 'paused'
            ? chalk.yellow('paused   ')
            : chalk.red('failed   ');

    lines.push(
      `  ${icon}  ${chalk.bold(state.ticket.padEnd(8))} ${dim(state.pipeline.padEnd(10))} ${statusWord}  ${trailing}`,
    );
  }

  lines.push('');
  lines.push(dim(`  ${sorted.length} run${sorted.length === 1 ? '' : 's'}`));

  return lines;
}

/**
 * `af pipeline status [ticket]` — read-only view over pipeline-state.json.
 *
 *   - With `ticket`: render a single run's full phase breakdown.
 *   - Without: list all runs newest-first.
 *   - `--json`: emit the raw PipelineState (object or array) and skip prose.
 */
export function pipelineStatusCommand(
  ticket: string | undefined,
  options: PipelineStatusOptions,
): void {
  if (!ENABLE_AF_28) {
    console.log(error('Pipeline status is disabled (ENABLE_AF_28=false).'));
    process.exit(1);
  }

  const resolved = resolveProject(options.project);
  if (!resolved) {
    console.log(error('No project found. Run from a project dir or use --project <prefix>.'));
    process.exit(1);
  }
  const { afPath } = resolved;

  // Audit (no-op unless ENABLE_AF_8)
  auditLog(afPath, {
    event: 'pipeline.status_check',
    ticket: ticket ? ticket.toUpperCase() : undefined,
    actor: 'cli',
    detail: ticket
      ? `Status check for ${ticket.toUpperCase()}`
      : 'Status check (all runs)',
  });

  // ---- Single-ticket mode ----
  if (ticket) {
    const normalized = ticket.toUpperCase();
    const outputDir = join(afPath, 'output', normalized);
    const stateFile = join(outputDir, 'pipeline-state.json');

    if (!existsSync(stateFile)) {
      console.log(error(`No pipeline run found for ${normalized}.`));
      process.exit(1);
    }

    const state = readPipelineState(outputDir);
    if (!state) {
      console.log(error(`Could not parse pipeline-state.json for ${normalized}.`));
      process.exit(1);
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(state, null, 2) + '\n');
      return;
    }

    for (const line of renderPipelineState(state, afPath, Date.now())) {
      console.log(line);
    }
    return;
  }

  // ---- List mode ----
  const tickets = findPipelineRuns(afPath);
  const states: PipelineState[] = [];
  for (const t of tickets) {
    const s = readPipelineState(join(afPath, 'output', t));
    if (s) states.push(s);
  }

  if (options.json) {
    // Sort to match the pretty output.
    const sorted = [...states].sort((a, b) => {
      const ta = Date.parse(a.startedAt);
      const tb = Date.parse(b.startedAt);
      const va = Number.isNaN(ta) ? -Infinity : ta;
      const vb = Number.isNaN(tb) ? -Infinity : tb;
      return vb - va;
    });
    process.stdout.write(JSON.stringify(sorted, null, 2) + '\n');
    return;
  }

  for (const line of renderRunList(states, Date.now())) {
    console.log(line);
  }
}
