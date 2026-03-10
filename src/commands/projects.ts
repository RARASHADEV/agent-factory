import chalk from 'chalk';
import Table from 'cli-table3';
import { listProjects } from '../lib/workspace.js';
import { FileProvider } from '../lib/providers/file-provider.js';
import { heading, dim, formatTaskLine } from '../lib/format.js';
import { existsSync } from 'fs';
import type { Task } from '../lib/task-provider.js';

interface ProjectOptions {
  detail?: boolean;
}

interface ProjectSummary {
  prefix: string;
  name: string;
  path: string;
  counts: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
    total: number;
  };
  blockedTasks: Task[];
}

export async function projectsCommand(options: ProjectOptions = {}): Promise<void> {
  if (options.detail) {
    await projectsDetailCommand();
    return;
  }

  const projects = listProjects();

  if (projects.length === 0) {
    console.log(dim('No projects registered. Run `af init <prefix>` in a project directory.'));
    return;
  }

  console.log(heading('Projects'));
  console.log('');

  for (const project of projects) {
    const provider = new FileProvider(project.afPath, project.meta);
    const tasks = await provider.list();
    const inProgress = tasks.filter(t => t.status === 'in-progress').length;
    const open = tasks.filter(t => t.status === 'open').length;
    const backlog = tasks.filter(t => t.status === 'backlog').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;

    const statusBadge = project.meta.status === 'active'
      ? chalk.green('● active')
      : chalk.dim(`○ ${project.meta.status}`);

    console.log(`  ${chalk.bold(project.meta.prefix)}  ${project.meta.name}  ${statusBadge}`);

    const counts: string[] = [];
    if (inProgress) counts.push(chalk.cyan(`${inProgress} in-progress`));
    if (open) counts.push(chalk.green(`${open} open`));
    if (backlog) counts.push(chalk.dim(`${backlog} backlog`));
    if (blocked) counts.push(chalk.red(`${blocked} blocked`));

    if (counts.length > 0) {
      console.log(`       ${counts.join('  ')}`);
    } else {
      console.log(dim(`       No tasks`));
    }

    console.log(dim(`       ${project.entry.path}`));
    console.log('');
  }
}

async function projectsDetailCommand(): Promise<void> {
  const projects = listProjects();

  if (projects.length === 0) {
    console.log(dim('No projects registered. Run `af init <prefix>` in a project directory.'));
    return;
  }

  const summaries: ProjectSummary[] = [];
  let totalOpen = 0;
  let totalInProgress = 0;
  let totalBlocked = 0;
  let totalDone = 0;
  let totalAll = 0;

  for (const project of projects) {
    const resolvedPath = project.entry.path.replace(/^~/, process.env.HOME || '');
    if (!existsSync(resolvedPath)) {
      console.error(chalk.dim(`⚠ Project ${project.meta.prefix} path not found, skipping`));
      continue;
    }

    let tasks: Task[];
    try {
      const provider = new FileProvider(project.afPath, project.meta);
      tasks = await provider.list();
    } catch {
      console.error(chalk.dim(`⚠ Project ${project.meta.prefix} unreadable, skipping`));
      continue;
    }

    const openCount = tasks.filter(t => t.status === 'open' || t.status === 'backlog').length;
    const inProgressCount = tasks.filter(t =>
      t.status === 'in-progress' ||
      t.status === 'ready-for-qa' ||
      t.status === 'uat' ||
      t.status === 'ready-4-release'
    ).length;
    const blockedCount = tasks.filter(t => t.status === 'blocked').length;
    const doneCount = tasks.filter(t => t.status === 'released' || t.status === 'closed').length;
    const total = tasks.length;

    const blockedTasks = tasks.filter(t => t.status === 'blocked');

    summaries.push({
      prefix: project.meta.prefix,
      name: project.meta.name,
      path: project.entry.path,
      counts: {
        open: openCount,
        inProgress: inProgressCount,
        blocked: blockedCount,
        done: doneCount,
        total,
      },
      blockedTasks,
    });

    totalOpen += openCount;
    totalInProgress += inProgressCount;
    totalBlocked += blockedCount;
    totalDone += doneCount;
    totalAll += total;
  }

  console.log(heading('Cross-project Status'));
  console.log('');

  if (summaries.length === 0 || totalAll === 0) {
    const count = summaries.length || projects.length;
    console.log(dim(`  No tasks found across ${count} registered project${count !== 1 ? 's' : ''}.`));
    return;
  }

  const table = new Table({
    head: [
      chalk.dim('Project'),
      chalk.dim('Open'),
      chalk.dim('In-Progress'),
      chalk.dim('Blocked'),
      chalk.dim('Done'),
      chalk.dim('Total'),
    ],
    style: { head: [], border: ['dim'] },
    chars: {
      'top': '─',
      'top-mid': '─',
      'top-left': '─',
      'top-right': '─',
      'bottom': '─',
      'bottom-mid': '─',
      'bottom-left': '─',
      'bottom-right': '─',
      'left': ' ',
      'left-mid': ' ',
      'mid': '─',
      'mid-mid': '─',
      'right': ' ',
      'right-mid': ' ',
      'middle': '  ',
    },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
  });

  for (const s of summaries) {
    const projectCell = `${chalk.bold(s.prefix)}  ${chalk.dim(s.name)}`;
    const blockedCell = s.counts.blocked > 0
      ? chalk.red(String(s.counts.blocked))
      : String(s.counts.blocked);

    table.push([
      projectCell,
      String(s.counts.open),
      String(s.counts.inProgress),
      blockedCell,
      String(s.counts.done),
      String(s.counts.total),
    ]);
  }

  // Totals row
  const totalBlockedCell = totalBlocked > 0
    ? chalk.red(String(totalBlocked))
    : String(totalBlocked);

  table.push([
    chalk.bold('Totals'),
    chalk.bold(String(totalOpen)),
    chalk.bold(String(totalInProgress)),
    chalk.bold(totalBlockedCell),
    chalk.bold(String(totalDone)),
    chalk.bold(String(totalAll)),
  ]);

  console.log(table.toString());

  // Blocked items section
  const allBlockedTasks = summaries.flatMap(s =>
    s.blockedTasks.map(t => ({ task: t, prefix: s.prefix }))
  );

  if (allBlockedTasks.length > 0) {
    console.log('');
    console.log(chalk.bold('  Blocked Items'));
    for (const { task, prefix } of allBlockedTasks) {
      console.log(`    ${formatTaskLine(task)}  ${chalk.dim(`(${prefix})`)}`);
    }
  }
}
