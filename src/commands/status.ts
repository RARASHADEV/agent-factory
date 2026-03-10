import chalk from 'chalk';
import { resolveProject } from '../lib/workspace.js';
import { createProvider } from '../lib/provider-factory.js';
import { STATUSES } from '../lib/constants.js';
import { heading, statusColor, formatTaskLine, error, dim } from '../lib/format.js';

interface StatusOptions {
  project?: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const resolved = resolveProject(options.project);

  if (!resolved) {
    console.log(error('No project found. Run `af init <prefix>` or use --project <prefix>.'));
    process.exit(1);
  }

  const { afPath, meta } = resolved;
  const provider = createProvider(afPath, meta);
  const tasks = await provider.list();

  console.log(heading(`${meta.prefix} — ${meta.name}`));
  console.log('');

  // Group by status
  const byStatus = new Map<string, typeof tasks>();
  for (const status of STATUSES) {
    byStatus.set(status, []);
  }
  for (const task of tasks) {
    const group = byStatus.get(task.status) || [];
    group.push(task);
    byStatus.set(task.status, group);
  }

  // Print non-empty statuses
  let hasAny = false;
  for (const status of STATUSES) {
    const group = byStatus.get(status) || [];
    if (group.length === 0) continue;
    hasAny = true;

    console.log(`  ${statusColor(status)} ${chalk.dim(`(${group.length})`)}`);
    for (const task of group) {
      console.log(`    ${formatTaskLine(task)}`);
    }
    console.log('');
  }

  if (!hasAny) {
    console.log(dim('  No tasks yet. Create one with `af task create "title"`.'));
  }

  // Summary line
  const total = tasks.length;
  const done = tasks.filter(t => ['released', 'closed'].includes(t.status)).length;
  console.log(dim(`  ${total} tasks total, ${done} completed`));
}
