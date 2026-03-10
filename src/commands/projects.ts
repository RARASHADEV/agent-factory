import chalk from 'chalk';
import Table from 'cli-table3';
import { listProjects } from '../lib/workspace.js';
import { listTasks } from '../lib/workspace.js';
import type { TaskFile } from '../lib/workspace.js';
import { heading, dim, warn, formatTaskLine } from '../lib/format.js';
import { existsSync } from 'fs';

interface ProjectOptions {
  detail?: boolean;
}

interface ProjectSummary {
  prefix: string;
  name: string;
  path: string;
  counts: {
    open: number;       // open + backlog
    inProgress: number; // in-progress + ready-for-qa + uat + ready-4-release
    blocked: number;    // blocked
    done: number;       // released + closed
    total: number;
  };
  blockedTasks: TaskFile[];
}

export function projectsCommand(options: ProjectOptions = {}): void {
  if (options.detail) {
    projectsDetailCommand();
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
    const tasks = listTasks(project.afPath);
    const inProgress = tasks.filter(t => t.meta.status === 'in-progress').length;
    const open = tasks.filter(t => t.meta.status === 'open').length;
    const backlog = tasks.filter(t => t.meta.status === 'backlog').length;
    const blocked = tasks.filter(t => t.meta.status === 'blocked').length;

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

function projectsDetailCommand(): void {
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

    let tasks: TaskFile[];
    try {
      tasks = listTasks(project.afPath);
    } catch {
      console.error(chalk.dim(`⚠ Project ${project.meta.prefix} unreadable, skipping`));
      continue;
    }

    const openCount = tasks.filter(t => t.meta.status === 'open' || t.meta.status === 'backlog').length;
    const inProgressCount = tasks.filter(t =>
      t.meta.status === 'in-progress' ||
      t.meta.status === 'ready-for-qa' ||
      t.meta.status === 'uat' ||
      t.meta.status === 'ready-4-release'
    ).length;
    const blockedCount = tasks.filter(t => t.meta.status === 'blocked').length;
    const doneCount = tasks.filter(t => t.meta.status === 'released' || t.meta.status === 'closed').length;
    const total = tasks.length;

    const blockedTasks = tasks.filter(t => t.meta.status === 'blocked');

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
      console.log(`    ${formatTaskLine(task.meta)}  ${chalk.dim(`(${prefix})`)}`);
    }
  }
}
