import { readFileSync } from 'fs';
import { resolveProject } from '../lib/workspace.js';
import { type TaskStatus } from '../lib/constants.js';
import { formatTaskLine, success, error, dim, heading } from '../lib/format.js';
import { createProvider } from '../lib/provider-factory.js';

interface TaskListOptions {
  status?: TaskStatus;
  assignee?: string;
  priority?: string;
  project?: string;
}

interface TaskCreateOptions {
  type?: string;
  priority?: string;
  complexity?: string;
  assignee?: string;
  depends?: string;
  due?: string;
  project?: string;
}

interface TaskShowOptions {
  project?: string;
}

interface TaskMoveOptions {
  project?: string;
}

interface TaskAssignOptions {
  project?: string;
}

function resolveOrExit(prefix?: string) {
  const resolved = resolveProject(prefix);
  if (!resolved) {
    console.log(error('No project found. Run `af init <prefix>` or use --project <prefix>.'));
    process.exit(1);
  }
  return resolved;
}

export async function taskListCommand(options: TaskListOptions): Promise<void> {
  const { afPath, meta } = resolveOrExit(options.project);
  const provider = createProvider(afPath, meta);

  const tasks = await provider.list({
    status: options.status,
    assignee: options.assignee,
    priority: options.priority,
  });

  if (tasks.length === 0) {
    console.log(dim('No tasks found.'));
    return;
  }

  console.log(heading(`${meta.prefix} — Tasks`));
  console.log('');
  for (const task of tasks) {
    console.log(`  ${formatTaskLine(task)}`);
  }
  console.log('');
  console.log(dim(`  ${tasks.length} task${tasks.length === 1 ? '' : 's'}`));
}

export async function taskCreateCommand(title: string, options: TaskCreateOptions): Promise<void> {
  const { afPath, meta } = resolveOrExit(options.project);
  const provider = createProvider(afPath, meta);

  try {
    const task = await provider.create({
      title,
      type: options.type,
      priority: options.priority,
      complexity: options.complexity,
      assignee: options.assignee,
      depends: options.depends?.split(',').map(s => s.trim()),
      due: options.due,
    });

    console.log(success(`Created ${task.ticket}: ${task.title}`));
    console.log(dim(`  Type: ${task.type}  Priority: ${task.priority}  Complexity: ${task.complexity}`));
    console.log(dim(`  File: ${task.filePath}`));
  } catch (err: any) {
    console.log(error(err.message));
    process.exit(1);
  }
}

export async function taskShowCommand(ticket: string, options: TaskShowOptions): Promise<void> {
  const { afPath, meta } = resolveOrExit(options.project);
  const provider = createProvider(afPath, meta);

  const task = await provider.get(ticket.toUpperCase());

  if (!task) {
    console.log(error(`Task ${ticket} not found.`));
    process.exit(1);
  }

  // Print raw file content (readable markdown)
  const raw = readFileSync(task.filePath!, 'utf-8');
  console.log(raw);
}

export async function taskMoveCommand(ticket: string, targetStatus: string, options: TaskMoveOptions): Promise<void> {
  const { afPath, meta } = resolveOrExit(options.project);
  const provider = createProvider(afPath, meta);

  try {
    const existing = await provider.get(ticket.toUpperCase());
    if (!existing) {
      console.log(error(`Task ${ticket} not found.`));
      process.exit(1);
    }

    const oldStatus = existing.status;

    if (oldStatus === targetStatus) {
      console.log(dim(`Task ${ticket} is already in ${targetStatus}.`));
      return;
    }

    const task = await provider.move(ticket.toUpperCase(), targetStatus);
    console.log(success(`${task.ticket}: ${oldStatus} → ${targetStatus}`));
  } catch (err: any) {
    console.log(error(err.message));
    process.exit(1);
  }
}

export async function taskAssignCommand(ticket: string, assignee: string, options: TaskAssignOptions): Promise<void> {
  const { afPath, meta } = resolveOrExit(options.project);
  const provider = createProvider(afPath, meta);

  try {
    const task = await provider.assign(ticket.toUpperCase(), assignee);
    console.log(success(`${task.ticket} assigned to ${assignee}`));
  } catch (err: any) {
    console.log(error(err.message));
    process.exit(1);
  }
}
