#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { projectsCommand } from './commands/projects.js';
import { statusCommand } from './commands/status.js';
import {
  taskListCommand,
  taskCreateCommand,
  taskShowCommand,
  taskMoveCommand,
  taskAssignCommand,
  taskLogCommand,
} from './commands/task.js';
import {
  agentListCommand,
  agentShowCommand,
  agentSyncCommand,
  agentSpawnCommand,
  agentStatusCommand,
} from './commands/agent.js';
import { syncCommand } from './commands/sync.js';
import { webhookServeCommand } from './commands/webhook.js';
import {
  pipelineRunCommand,
  pipelineListCommand,
  pipelineStatusCommand,
} from './commands/pipeline.js';

const program = new Command();

program
  .name('af')
  .description('Agent Factory — CLI for managing AI agent workflows')
  .version('0.1.0');

// --- Project commands ---

program
  .command('init <prefix>')
  .description('Initialize .af/ workspace in current directory')
  .option('-n, --name <name>', 'Project name (defaults to directory name)')
  .action(initCommand);

program
  .command('projects')
  .description('List all registered projects')
  .option('-d, --detail', 'Show task counts bucketed by status across all projects')
  .action(projectsCommand);

program
  .command('status')
  .description('Show task breakdown for a project')
  .option('-p, --project <prefix>', 'Project prefix (defaults to cwd)')
  .action(statusCommand);

// --- Task commands ---

const task = program
  .command('task')
  .description('Task management');

task
  .command('list')
  .description('List tasks')
  .option('-s, --status <status>', 'Filter by status')
  .option('-a, --assignee <assignee>', 'Filter by assignee')
  .option('--priority <priority>', 'Filter by priority')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(taskListCommand);

task
  .command('create <title>')
  .description('Create a new task')
  .option('-t, --type <type>', 'Task type (bug|chore|epic|feature|improvement|task)', 'task')
  .option('--priority <priority>', 'Priority (critical|high|medium|low)', 'medium')
  .option('--complexity <complexity>', 'Complexity (low|medium|high)', 'medium')
  .option('-a, --assignee <assignee>', 'Assignee (agent slug)')
  .option('-d, --depends <tickets>', 'Dependencies (comma-separated)')
  .option('--due <date>', 'Due date (YYYY-MM-DD)')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(taskCreateCommand);

task
  .command('show <ticket>')
  .description('Show a task')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(taskShowCommand);

task
  .command('move <ticket> <status>')
  .description('Move a task to a new status')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(taskMoveCommand);

task
  .command('assign <ticket> <assignee>')
  .description('Assign a task to an agent')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(taskAssignCommand);

task
  .command('log <ticket> <entry>')
  .description('Add a log entry to a task')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(taskLogCommand);

// --- Agent commands ---

const agent = program
  .command('agent')
  .description('Agent management');

agent
  .command('list')
  .description('List agents in local registry')
  .action(agentListCommand);

agent
  .command('show <slug>')
  .description('Show an agent profile')
  .action(agentShowCommand);

agent
  .command('sync [slug]')
  .description('Sync agents from agent-platform API')
  .action(agentSyncCommand);

agent
  .command('spawn <slug>')
  .description('Spawn an agent on a task or prompt')
  .option('--task <ticket>', 'Task ticket number (workspace mode)')
  .option('--prompt <text>', 'Direct prompt text or @file path (prompt mode)')
  .option('--output-dir <path>', 'Output directory for prompt mode')
  .option('-p, --project <prefix>', 'Project prefix')
  .option('--dry-run', 'Print composed prompt without spawning')
  .option('-b, --background', 'Run in background using SDK (non-blocking)')
  .action(agentSpawnCommand);

agent
  .command('status [ticket]')
  .description('Check status of background agent spawns')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(agentStatusCommand);

// --- Pipeline commands (AF-26) ---

const pipeline = program
  .command('pipeline')
  .description('Pipeline management');

pipeline
  .command('run <name>')
  .description('Run a pipeline end-to-end on a task')
  .requiredOption('--task <ticket>', 'Task ticket to run the pipeline against')
  .option('-p, --project <prefix>', 'Project prefix')
  .option('--dry-run', 'Print execution plan without spawning agents')
  .option('--from <phase>', 'Resume from a specific phase')
  .action(pipelineRunCommand);

pipeline
  .command('list')
  .description('List available pipeline definitions')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(pipelineListCommand);

pipeline
  .command('status [ticket]')
  .description('Show pipeline run status from pipeline-state.json')
  .option('-p, --project <prefix>', 'Project prefix')
  .option('--json', 'Emit raw JSON')
  .action(pipelineStatusCommand);

// --- Sync command (AF-12) ---

program
  .command('sync')
  .description('Synchronize tasks with Loka')
  .option('-m, --mode <mode>', 'Sync mode: push, pull, bidirectional', 'push')
  .option('--pull', 'Shorthand for --mode pull')
  .option('--bidirectional', 'Shorthand for --mode bidirectional')
  .option('--dry-run', 'Show what would be synced without making changes')
  .option('-v, --verbose', 'Show per-task sync details')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(syncCommand);

// --- Webhook command (AF-18) ---

const webhook = program
  .command('webhook')
  .description('Webhook listener for Loka → AF sync');

webhook
  .command('serve')
  .description('Start webhook listener for Loka → AF sync')
  .option('-p, --port <port>', 'Port to listen on (default: 4100)')
  .option('--project <prefix>', 'Restrict to a single project prefix')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (opts) => {
    await webhookServeCommand({
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      project: opts.project,
      verbose: opts.verbose ?? false,
    });
  });

program.parse();
