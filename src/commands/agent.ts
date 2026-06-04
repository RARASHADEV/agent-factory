import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import matter from 'gray-matter';
import chalk from 'chalk';
import { AGENTS_DIR } from '../lib/constants.js';
import { loadConfig } from '../lib/config.js';
import { resolveProject } from '../lib/workspace.js';
import { createProvider } from '../lib/provider-factory.js';
import { heading, success, error, dim } from '../lib/format.js';
import { auditLog } from '../lib/audit.js';
import { postActivityToLoka } from '../lib/audit-bridge.js';
import {
  syncAgents,
  AgentSyncNotConfiguredError,
  AgentSyncError,
} from '../lib/core/agent-sync.js';

export interface AgentMeta {
  slug: string;
  name: string;
  role?: string;
  version?: number;
  model?: string;
  maxTurns?: number;
  environment?: string;
  disallowedTools?: string[];
  tools?: string[];
  synced?: string;
  /** AF-42: per-agent execution routing (backend/model/endpoint/toolCalling). */
  execution?: {
    backend?: string;
    model?: string;
    endpoint?: string;
    toolCalling?: string;
  };
  [key: string]: unknown;
}

export interface AgentFile {
  meta: AgentMeta;
  content: string;
  filePath: string;
}

export function loadAgent(slug: string): AgentFile | null {
  const filePath = join(AGENTS_DIR, `${slug}.md`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  return { meta: data as AgentMeta, content, filePath };
}

function listAgentFiles(): AgentFile[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
  return files.map(f => {
    const filePath = join(AGENTS_DIR, f);
    const raw = readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);
    return { meta: data as AgentMeta, content, filePath };
  });
}

export function agentListCommand(): void {
  const agents = listAgentFiles();

  if (agents.length === 0) {
    console.log(dim('No agents in registry. Run `af agent sync` to import from agent-platform.'));
    return;
  }

  console.log(heading('Agent Registry'));
  console.log('');
  for (const agent of agents) {
    const ver = agent.meta.version ? dim(`v${agent.meta.version}`) : '';
    const model = agent.meta.model ? dim(`· ${agent.meta.model}`) : '';
    console.log(`  ${chalk.bold(agent.meta.slug.padEnd(22))} ${agent.meta.name.padEnd(20)} ${ver} ${model}`);
  }
  console.log('');
  console.log(dim(`  ${agents.length} agent${agents.length === 1 ? '' : 's'}`));
}

export function agentShowCommand(slug: string): void {
  const agent = loadAgent(slug);
  if (!agent) {
    console.log(error(`Agent "${slug}" not found in ${AGENTS_DIR}`));
    process.exit(1);
  }

  const raw = readFileSync(agent.filePath, 'utf-8');
  console.log(raw);
}

function slugify(role: string): string {
  return role.toLowerCase().replace(/_/g, '-');
}

export async function agentSyncCommand(slug?: string): Promise<void> {
  try {
    const result = await syncAgents(slug, ({ slug: agentSlug, version, model }) => {
      console.log(success(`${agentSlug}`) + dim(` (v${version}${model ? ` · ${model}` : ''})`));
    });
    console.log('');
    console.log(
      success(`${result.count} agent${result.count === 1 ? '' : 's'} synced`) +
        (result.skipped > 0 ? dim(` (${result.skipped} skipped)`) : ''),
    );
  } catch (err: any) {
    if (err instanceof AgentSyncNotConfiguredError) {
      console.log(error(err.message));
      process.exit(1);
    }
    if (err instanceof AgentSyncError) {
      console.log(error(err.message));
      if (err.unreachable) {
        console.log(dim('Is deva running? Check: curl ' + err.upstreamUrl + '/agents'));
      }
      process.exit(1);
    }
    console.log(error(`Sync failed: ${err?.message ?? String(err)}`));
    process.exit(1);
  }
}

interface SpawnOptions {
  task?: string;
  prompt?: string;
  outputDir?: string;
  project?: string;
  dryRun?: boolean;
  background?: boolean;
}

export async function agentSpawnCommand(slug: string, options: SpawnOptions): Promise<void> {
  // Validate: either --task or --prompt must be provided
  if (!options.task && !options.prompt) {
    console.log(error('Either --task <ticket> or --prompt <text> is required.'));
    process.exit(1);
  }

  const agent = loadAgent(slug);
  if (!agent) {
    console.log(error(`Agent "${slug}" not found. Run \`af agent list\` to see available agents.`));
    process.exit(1);
  }

  const config = loadConfig();

  // ── Prompt mode: no workspace required ──────────────────────────────────
  if (options.prompt) {
    const cwd = process.cwd();
    const ticket = options.task || `PROMPT-${Date.now()}`;
    const outputDir = options.outputDir || join(cwd, '.af', 'output', ticket);

    // Load prompt from file if it starts with @
    let promptText = options.prompt;
    if (promptText.startsWith('@')) {
      const promptFile = promptText.slice(1);
      if (!existsSync(promptFile)) {
        console.log(error(`Prompt file not found: ${promptFile}`));
        process.exit(1);
      }
      promptText = readFileSync(promptFile, 'utf-8');
    }

    const systemPrompt = [
      agent.content.trim(),
      '',
      '---',
      '',
      '## Task',
      promptText.trim(),
    ].join('\n');

    if (options.dryRun) {
      console.log(heading('DRY RUN — Composed prompt:'));
      console.log('');
      console.log(systemPrompt);
      console.log('');
      console.log(dim(`Model: ${agent.meta.model || config.defaults.model}`));
      return;
    }

    console.log(chalk.cyan(`⚡ Spawning ${chalk.bold(slug)} (prompt mode)`));
    console.log(dim(`Model: ${agent.meta.model || config.defaults.model}`));
    console.log('');

    // Prompt mode always runs in background
    mkdirSync(outputDir, { recursive: true });

    const spawnConfig = {
      systemPrompt,
      taskPrompt: 'Execute the task described in the system prompt. Follow all instructions and deliver your output.',
      model: agent.meta.model || config.defaults.model,
      maxTurns: agent.meta.maxTurns || config.defaults.max_turns,
      tools: agent.meta.tools || undefined,
      cwd,
      outputDir,
      ticket,
      agentSlug: slug,
      afPath: join(cwd, '.af'),
      execution: agent.meta.execution,   // AF-42: per-agent backend routing
    };

    const configFile = join(outputDir, 'config.json');
    writeFileSync(configFile, JSON.stringify(spawnConfig, null, 2));

    const runnerPath = join(import.meta.dirname, '..', 'spawn-runner.js');
    const logFile = join(outputDir, 'agent.log');
    const { openSync } = await import('fs');
    const out = openSync(logFile, 'a');

    const child = spawn('node', [runnerPath, configFile], {
      cwd,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    child.unref();

    const statusFile = join(outputDir, 'status.json');
    writeFileSync(statusFile, JSON.stringify({
      pid: child.pid,
      status: 'starting',
      agent: slug,
      ticket,
      startedAt: new Date().toISOString(),
    }, null, 2));

    // Audit: spawn.start (prompt mode, background)
    try {
      const afPath = join(cwd, '.af');
      auditLog(afPath, {
        event: 'spawn.start',
        ticket,
        agent: slug,
        actor: 'cli',
        detail: `Spawned ${slug} on ${ticket} (background)`,
        meta: { mode: 'background', pid: child.pid },
      });
    } catch {}

    // Output JSON for programmatic consumption
    const result = {
      pid: child.pid,
      ticket,
      agent: slug,
      outputDir,
      statusFile,
      logFile,
    };
    console.log(JSON.stringify(result));
    console.log('');
    console.log(success(`Agent ${slug} spawned in background`));
    console.log(dim(`  PID: ${child.pid}`));
    console.log(dim(`  Output: ${outputDir}/`));
    console.log(dim(`  Check: af agent status ${ticket}`));
    return;
  }

  // ── Task mode: requires workspace ───────────────────────────────────────

  const resolved = resolveProject(options.project);
  if (!resolved) {
    console.log(error('No project found. Run from a project dir or use --project <prefix>.'));
    process.exit(1);
  }

  const { afPath, meta: projectMeta } = resolved;
  const provider = createProvider(afPath, projectMeta);
  const task = await provider.get(options.task!.toUpperCase());

  if (!task) {
    console.log(error(`Task ${options.task} not found.`));
    process.exit(1);
  }

  // Block spawning on blocked tasks
  if (task.status === 'blocked') {
    console.log(error(`Task ${options.task} is blocked. Unblock it first with \`af task move ${options.task} open\`.`));
    process.exit(1);
  }

  // Load project.md content
  const projectFile = join(afPath, 'project.md');
  const projectContent = existsSync(projectFile) ? readFileSync(projectFile, 'utf-8') : '';

  // Load context files
  const contextDir = join(afPath, 'context');
  let contextContent = '';
  if (existsSync(contextDir)) {
    const contextFiles = readdirSync(contextDir).filter(f => f.endsWith('.md'));
    for (const f of contextFiles) {
      const content = readFileSync(join(contextDir, f), 'utf-8');
      contextContent += `\n--- ${f} ---\n${content}\n`;
    }
  }

  // Compose the prompt
  const systemPrompt = [
    agent.content.trim(),
    '',
    '---',
    '',
    '## Project',
    projectContent.trim(),
    '',
    '## Task',
    readFileSync(task.filePath!, 'utf-8').trim(),
    contextContent ? `\n## Context\n${contextContent.trim()}` : '',
  ].filter(Boolean).join('\n');

  if (options.dryRun) {
    console.log(heading('DRY RUN — Composed prompt:'));
    console.log('');
    console.log(systemPrompt);
    console.log('');
    console.log(dim(`Model: ${agent.meta.model || config.defaults.model}`));
    console.log(dim(`CLI: ${config.sdk.cli}`));
    return;
  }

  // Resolve project directory from afPath (go up one level from .af/)
  const projectDir = join(afPath, '..');

  console.log(chalk.cyan(`⚡ Spawning ${chalk.bold(slug)} on ${chalk.bold(task.ticket)}: ${task.title}`));
  console.log(dim(`Model: ${agent.meta.model || config.defaults.model}`));
  console.log('');

  if (options.background) {
    // ── Background mode: use SDK via detached subprocess ─────────────
    const outputDir = join(afPath, 'output', task.ticket, slug);
    mkdirSync(outputDir, { recursive: true });

    const spawnConfig = {
      systemPrompt,
      taskPrompt: 'Execute the task described in the system prompt. Follow all instructions, check off acceptance criteria as you complete them, and log your work.',
      model: agent.meta.model || config.defaults.model,
      maxTurns: agent.meta.maxTurns || config.defaults.max_turns,
      tools: agent.meta.tools || undefined,
      cwd: projectDir,
      outputDir,
      ticket: task.ticket,
      agentSlug: slug,
      afPath,
      execution: agent.meta.execution,   // AF-42: per-agent backend routing
    };

    // Write config to temp file
    const configFile = join(outputDir, 'config.json');
    writeFileSync(configFile, JSON.stringify(spawnConfig, null, 2));

    // Spawn runner detached (import.meta.dirname = dist/commands/ → go up to dist/)
    const runnerPath = join(import.meta.dirname, '..', 'spawn-runner.js');
    const logFile = join(outputDir, 'agent.log');
    const { openSync } = await import('fs');
    const out = openSync(logFile, 'a');

    const child = spawn('node', [runnerPath, configFile], {
      cwd: projectDir,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    child.unref();

    // Write PID for tracking
    const statusFile = join(outputDir, 'status.json');
    writeFileSync(statusFile, JSON.stringify({
      pid: child.pid,
      status: 'starting',
      agent: slug,
      ticket: task.ticket,
      startedAt: new Date().toISOString(),
    }, null, 2));

    // Audit: spawn.start (task mode, background)
    try {
      auditLog(afPath, {
        event: 'spawn.start',
        ticket: task.ticket,
        agent: slug,
        actor: 'cli',
        detail: `Spawned ${slug} on ${task.ticket} (background)`,
        meta: { mode: 'background', pid: child.pid },
      });
    } catch {}
    void postActivityToLoka(afPath, task.ticket, `🤖 Agent ${slug} started working on ${task.ticket}`);

    console.log(success(`Agent ${slug} spawned in background`));
    console.log(dim(`  PID: ${child.pid}`));
    console.log(dim(`  Output: ${outputDir}/`));
    console.log(dim(`  Status: ${statusFile}`));
    console.log(dim(`  Log: ${logFile}`));
    console.log('');
    console.log(dim('Check status: af agent status ' + task.ticket));
    return;
  }

  // ── Foreground mode: use claude CLI (original behavior) ──────────
  const cliPath = config.sdk.cli;
  const args = [
    '--print',
    '--system-prompt', systemPrompt,
    '--max-turns', String(config.defaults.max_turns),
    '--model', agent.meta.model || config.defaults.model,
    'Execute the task described in the system prompt. Follow all instructions, check off acceptance criteria as you complete them, and log your work.',
  ];

  // Add --allowedTools if agent has tools defined
  if (agent.meta.tools && agent.meta.tools.length > 0) {
    args.push('--allowedTools', agent.meta.tools.join(','));
  }

  // Audit: spawn.start (foreground)
  try {
    auditLog(afPath, {
      event: 'spawn.start',
      ticket: task.ticket,
      agent: slug,
      actor: 'cli',
      detail: `Spawned ${slug} on ${task.ticket} (foreground)`,
      meta: { mode: 'foreground' },
    });
  } catch {}
  void postActivityToLoka(afPath, task.ticket, `🤖 Agent ${slug} started working on ${task.ticket}`);

  const spawnStart = Date.now();

  const child = spawn(cliPath, args, {
    cwd: projectDir,
    stdio: 'inherit',
    env: { ...process.env, CLAUDECODE: undefined },
  });

  child.on('close', (code) => {
    console.log('');
    const durationMs = Date.now() - spawnStart;
    const durationS = Math.round(durationMs / 1000);

    if (code === 0) {
      console.log(success(`Agent ${slug} completed task ${task.ticket}`));
      // Append log entry via provider
      provider.log(task.ticket, `${slug}: completed | Agent session finished.`).catch(() => {});

      // Audit: spawn.complete
      try {
        auditLog(afPath, {
          event: 'spawn.complete',
          ticket: task.ticket,
          agent: slug,
          actor: slug,
          detail: `Completed in ${durationS}s`,
          meta: { success: true, durationMs },
        });
      } catch {}
      void postActivityToLoka(afPath, task.ticket, `✅ Agent ${slug} completed work on ${task.ticket} (${durationS}s)`);
    } else {
      console.log(error(`Agent ${slug} exited with code ${code}`));

      // Audit: spawn.fail
      try {
        auditLog(afPath, {
          event: 'spawn.fail',
          ticket: task.ticket,
          agent: slug,
          actor: slug,
          detail: `Failed: exited with code ${code}`,
          meta: { error: `exit code ${code}` },
        });
      } catch {}
      void postActivityToLoka(afPath, task.ticket, `❌ Agent ${slug} failed on ${task.ticket}: exit code ${code}`);
    }
  });
}

/**
 * Check status of a background agent spawn.
 */
export function agentStatusCommand(ticket?: string, options?: { project?: string }): void {
  const resolved = resolveProject(options?.project);
  if (!resolved) {
    console.log(error('No project found. Run from a project dir or use --project <prefix>.'));
    process.exit(1);
  }

  const { afPath } = resolved;
  const outputBase = join(afPath, 'output');

  if (!existsSync(outputBase)) {
    console.log(dim('No background agents have been spawned in this project.'));
    return;
  }

  const dirs = ticket
    ? [ticket.toUpperCase()]
    : readdirSync(outputBase).filter(d => {
        const statusPath = join(outputBase, d, 'status.json');
        return existsSync(statusPath);
      });

  if (dirs.length === 0) {
    console.log(dim('No background agents found.'));
    return;
  }

  console.log(heading('Background Agents'));
  console.log('');

  for (const dir of dirs) {
    const statusPath = join(outputBase, dir, 'status.json');
    if (!existsSync(statusPath)) {
      if (ticket) console.log(error(`No status found for ${dir}`));
      continue;
    }

    const status = JSON.parse(readFileSync(statusPath, 'utf-8'));
    const icon = status.status === 'completed' ? '✅' :
                 status.status === 'failed' ? '❌' :
                 status.status === 'running' ? '🔄' : '⏳';

    // Check if PID is still alive (for running status)
    let alive = false;
    if (status.status === 'running' || status.status === 'starting') {
      try {
        process.kill(status.pid, 0);
        alive = true;
      } catch {
        alive = false;
        // PID is dead but status says running — it crashed
        if (status.status === 'running') {
          status.status = 'crashed';
        }
      }
    }

    console.log(`  ${icon}  ${chalk.bold(status.ticket || dir)} — ${status.agent}`);
    console.log(dim(`     Status: ${status.status}${alive ? ` (PID ${status.pid})` : ''}`));
    console.log(dim(`     Started: ${status.startedAt}`));
    if (status.completedAt) console.log(dim(`     Completed: ${status.completedAt}`));
    if (status.error) console.log(chalk.red(`     Error: ${status.error}`));

    // Show result preview if completed
    const resultPath = join(outputBase, dir, 'result.md');
    if (existsSync(resultPath) && status.status === 'completed') {
      const preview = readFileSync(resultPath, 'utf-8').slice(0, 200).trim();
      console.log(dim(`     Result: ${preview}${preview.length >= 200 ? '...' : ''}`));
    }
    console.log('');

    // Audit: spawn.status_check
    try {
      auditLog(afPath, {
        event: 'spawn.status_check',
        ticket: status.ticket || dir,
        agent: status.agent,
        actor: 'cli',
        detail: `Checked status of ${status.ticket || dir}`,
        meta: { status: status.status },
      });
    } catch {}
  }
}
