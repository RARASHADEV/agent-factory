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

import { ENABLE_AF_26 } from '../lib/constants.js';
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
} from '../lib/gate-evaluator.js';
import {
  writePipelineState,
  initPipelineState,
  type PipelineState,
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
 * Format a gate condition as "field operator value?" — omits value for
 * existence operators.
 */
function formatGate(gate: GateDefinition): string {
  if (gate.operator === 'exists' || gate.operator === 'not_exists') {
    return `${gate.field} ${gate.operator}`;
  }
  return `${gate.field} ${gate.operator} ${JSON.stringify(gate.value)}`;
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
  const task = await provider.get(ticket);
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
  try {
    if (task.status !== 'in-progress') {
      await provider.move(task.ticket, 'in-progress');
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

  // 10. Phase loop
  for (let i = startIndex; i < phaseOrder.length; i++) {
    const phase = phaseOrder[i];
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
      process.exit(1);
    }

    // 10c. Spawn (synchronous, not detached)
    const phaseOutputDir = join(pipelineOutputDir, phase.agent);
    mkdirSync(phaseOutputDir, { recursive: true });
    const spawnOk = await runPhaseSubprocess({
      systemPrompt,
      agentSlug: phase.agent,
      ticket: task.ticket,
      cwd: projectDir,
      outputDir: phaseOutputDir,
      afPath,
    });

    // 10d. Load result, evaluate gate
    const phaseResult = loadPhaseResultJson(phase.name, ctx);
    let gateEval: GateEvaluationResult | null = null;
    let phaseStatus: PhaseStatus = 'completed';
    let failureReason: 'spawn_error' | 'no_result_json' | 'gate_failure' | undefined;

    if (!spawnOk) {
      phaseStatus = 'failed';
      failureReason = 'spawn_error';
    } else if (!phaseResult) {
      phaseStatus = 'failed';
      failureReason = 'no_result_json';
    } else {
      if (phaseResult._synthetic) {
        console.log(warn(`  Phase ${phase.name}: result.json is synthetic — agent did not emit a structured result-json block`));
      }
      if (phase.gate) {
        gateEval = evaluateGate(phase.gate, phaseResult);
        if (!gateEval.passed) {
          phaseStatus = 'failed';
          failureReason = 'gate_failure';
        }
      }
    }

    const phaseDuration = Date.now() - phaseStart;
    const ps = state.phases[phase.name];
    ps.status = phaseStatus;
    ps.completedAt = new Date().toISOString();
    ps.durationMs = phaseDuration;
    ps.outputDir = relative(afPath, phaseOutputDir);

    if (gateEval) {
      ps.gateResult = gateEval.passed ? 'pass' : 'fail';
      if (!gateEval.passed) {
        ps.gateFailure = {
          field: gateEval.field,
          operator: gateEval.operator,
          expected: gateEval.expected,
          actual: gateEval.actual,
          message: gateEval.message,
        };
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
        ps.gateFailure?.message ??
        (failureReason === 'spawn_error'
          ? 'spawn exited non-zero'
          : failureReason === 'no_result_json'
            ? 'result.json not written'
            : `Phase ${phase.name} failed`);

      console.log(error(`  ${failMessage}`));

      auditLog(afPath, {
        event: 'pipeline.phase_fail',
        ticket: task.ticket,
        agent: phase.agent,
        actor: 'cli',
        detail: failMessage,
        meta: {
          phase: phase.name,
          reason: failureReason,
          gateFailure: ps.gateFailure,
        },
      });

      finalizePipelineFailure(state, name, phase.name, pipelineOutputDir, afPath, task.ticket, allWarnings, pipelineStart);
      printFailureSummary(state, phase.name, task.ticket, name, pipelineOutputDir);
      process.exit(1);
    }

    console.log(success(`  Phase ${phase.name} completed (${formatDuration(phaseDuration)})`));
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
      console.log(dim(`     gate: ${formatGate(phase.gate)}`));
    }

    console.log('');
  }
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
  console.log('');
  console.log(success(`Pipeline ${pipelineName} completed for ${state.ticket} (${formatDuration(total)})`));
  console.log('');

  for (const [phaseName, ps] of Object.entries(state.phases)) {
    const icon = phaseIcon(ps.status);
    const gate = ps.status === 'skipped'
      ? dim('skipped')
      : ps.gateResult
        ? `gate: ${ps.gateResult}`
        : '';
    const dur = ps.status === 'skipped'
      ? dim('—')
      : ps.durationMs !== undefined
        ? dim(formatDuration(ps.durationMs))
        : '';
    console.log(
      `  ${icon}  ${chalk.bold(phaseName.padEnd(12))} ${dim((ps.agent ?? '').padEnd(12))} ${dur.padEnd(10)} ${gate}`,
    );
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

  for (const [phaseName, ps] of Object.entries(state.phases)) {
    const icon = phaseIcon(ps.status);
    let gate = '';
    if (ps.status === 'failed') {
      gate = `gate: ${ps.gateResult ?? 'fail'}`;
    } else if (ps.status === 'skipped') {
      gate = dim('skipped');
    } else if (ps.status === 'pending') {
      gate = dim('pending');
    } else if (ps.gateResult) {
      gate = `gate: ${ps.gateResult}`;
    }
    const dur =
      ps.status === 'skipped' || ps.status === 'pending'
        ? dim('—')
        : ps.durationMs !== undefined
          ? dim(formatDuration(ps.durationMs))
          : '';
    console.log(
      `  ${icon}  ${chalk.bold(phaseName.padEnd(12))} ${dim((ps.agent ?? '').padEnd(12))} ${dur.padEnd(10)} ${gate}`,
    );

    if (ps.status === 'failed') {
      const reasonMsg =
        ps.gateFailure?.message ??
        (ps.failureReason === 'spawn_error'
          ? 'spawn exited non-zero'
          : ps.failureReason === 'no_result_json'
            ? 'result.json not written'
            : 'phase failed');
      console.log(chalk.red(`       ${reasonMsg}`));
    }
  }

  console.log('');
  console.log(dim(`  State: ${join(pipelineOutputDir, 'pipeline-state.json')}`));
  const failed = state.phases[failedPhase];
  if (failed?.agent) {
    console.log(dim(`  Log:   ${join(pipelineOutputDir, failed.agent, 'agent.log')}`));
  }
}
