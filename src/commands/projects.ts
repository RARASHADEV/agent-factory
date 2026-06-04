import chalk from 'chalk';
import Table from 'cli-table3';
import { heading, dim, formatTaskLine } from '../lib/format.js';
import { listProjectsSummary, listProjectsDetail } from '../lib/core/projects.js';

interface ProjectOptions {
  detail?: boolean;
}

export async function projectsCommand(options: ProjectOptions = {}): Promise<void> {
  if (options.detail) {
    await projectsDetailCommand();
    return;
  }

  const { projects } = await listProjectsSummary();

  if (projects.length === 0) {
    console.log(dim('No projects registered. Run `af init <prefix>` in a project directory.'));
    return;
  }

  console.log(heading('Projects'));
  console.log('');

  for (const project of projects) {
    const { inProgress, open, backlog, blocked } = project.counts;

    const statusBadge = project.status === 'active'
      ? chalk.green('● active')
      : chalk.dim(`○ ${project.status}`);

    console.log(`  ${chalk.bold(project.prefix)}  ${project.name}  ${statusBadge}`);

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

    console.log(dim(`       ${project.path}`));
    console.log('');
  }
}

async function projectsDetailCommand(): Promise<void> {
  const result = await listProjectsDetail();

  if (result.registeredCount === 0) {
    console.log(dim('No projects registered. Run `af init <prefix>` in a project directory.'));
    return;
  }

  // Surface skipped projects (warnings on stderr), matching prior behaviour.
  for (const prefix of result.missingPaths) {
    console.error(chalk.dim(`⚠ Project ${prefix} path not found, skipping`));
  }
  for (const prefix of result.unreadable) {
    console.error(chalk.dim(`⚠ Project ${prefix} unreadable, skipping`));
  }

  const summaries = result.projects;

  console.log(heading('Cross-project Status'));
  console.log('');

  if (summaries.length === 0 || result.totals.total === 0) {
    const count = summaries.length || result.registeredCount;
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
  const totals = result.totals;
  const totalBlockedCell = totals.blocked > 0
    ? chalk.red(String(totals.blocked))
    : String(totals.blocked);

  table.push([
    chalk.bold('Totals'),
    chalk.bold(String(totals.open)),
    chalk.bold(String(totals.inProgress)),
    chalk.bold(totalBlockedCell),
    chalk.bold(String(totals.done)),
    chalk.bold(String(totals.total)),
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
