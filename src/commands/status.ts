import chalk from 'chalk';
import { getProjectStatus } from '../lib/core/status.js';
import { ProjectNotFoundError } from '../lib/core/errors.js';
import { heading, statusColor, formatTaskLine, error, dim } from '../lib/format.js';

interface StatusOptions {
  project?: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  let result;
  try {
    result = await getProjectStatus(options.project);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      console.log(error(err.message));
      process.exit(1);
    }
    throw err;
  }

  console.log(heading(`${result.prefix} — ${result.name}`));
  console.log('');

  // Print non-empty statuses (in canonical order)
  let hasAny = false;
  for (const group of result.groups) {
    if (group.tasks.length === 0) continue;
    hasAny = true;

    console.log(`  ${statusColor(group.status)} ${chalk.dim(`(${group.tasks.length})`)}`);
    for (const task of group.tasks) {
      console.log(`    ${formatTaskLine(task)}`);
    }
    console.log('');
  }

  if (!hasAny) {
    console.log(dim('  No tasks yet. Create one with `af task create "title"`.'));
  }

  // Summary line
  console.log(dim(`  ${result.total} tasks total, ${result.done} completed`));
}
