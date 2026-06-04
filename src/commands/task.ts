import { type TaskStatus } from '../lib/constants.js';
import { formatTaskLine, success, error, dim, heading } from '../lib/format.js';
import { type TaskCreateInput } from '../lib/task-provider.js';
import {
  listTasks,
  showTask,
  createTask,
  moveTask,
  assignTask,
  logTask,
} from '../lib/core/tasks.js';
import { ProjectNotFoundError } from '../lib/core/errors.js';

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

interface TaskLogOptions {
  project?: string;
}

/** Print the standard "no project" message and exit, mirroring prior behaviour. */
function exitNoProject(): never {
  console.log(error('No project found. Run `af init <prefix>` or use --project <prefix>.'));
  process.exit(1);
}

export async function taskListCommand(options: TaskListOptions): Promise<void> {
  let result;
  try {
    result = await listTasks(
      {
        status: options.status,
        assignee: options.assignee,
        priority: options.priority,
      },
      options.project,
    );
  } catch (err) {
    if (err instanceof ProjectNotFoundError) exitNoProject();
    throw err;
  }

  const { tasks } = result;

  if (tasks.length === 0) {
    console.log(dim('No tasks found.'));
    return;
  }

  console.log(heading(`${result.prefix} — Tasks`));
  console.log('');
  for (const task of tasks) {
    console.log(`  ${formatTaskLine(task)}`);
  }
  console.log('');
  console.log(dim(`  ${tasks.length} task${tasks.length === 1 ? '' : 's'}`));
}

export async function taskCreateCommand(title: string, options: TaskCreateOptions): Promise<void> {
  const input: TaskCreateInput = {
    title,
    type: options.type,
    priority: options.priority,
    complexity: options.complexity,
    assignee: options.assignee,
    depends: options.depends?.split(',').map(s => s.trim()),
    due: options.due,
  };

  try {
    const { task } = await createTask(input, options.project);

    console.log(success(`Created ${task.ticket}: ${task.title}`));
    console.log(dim(`  Type: ${task.type}  Priority: ${task.priority}  Complexity: ${task.complexity}`));
    console.log(dim(`  File: ${task.filePath}`));
  } catch (err: any) {
    if (err instanceof ProjectNotFoundError) exitNoProject();
    console.log(error(err.message));
    process.exit(1);
  }
}

export async function taskShowCommand(ticket: string, options: TaskShowOptions): Promise<void> {
  let result;
  try {
    result = await showTask(ticket, options.project);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) exitNoProject();
    throw err;
  }

  if (!result) {
    console.log(error(`Task ${ticket} not found.`));
    process.exit(1);
  }

  // Print raw file content (readable markdown)
  console.log(result.raw);
}

export async function taskMoveCommand(ticket: string, targetStatus: string, options: TaskMoveOptions): Promise<void> {
  try {
    const result = await moveTask(ticket, targetStatus, options.project);

    if (result.unchanged) {
      console.log(dim(`Task ${ticket} is already in ${targetStatus}.`));
      return;
    }

    console.log(success(`${result.task.ticket}: ${result.fromStatus} → ${result.toStatus}`));
  } catch (err: any) {
    if (err instanceof ProjectNotFoundError) exitNoProject();
    if (err?.name === 'TaskNotFoundError') {
      console.log(error(`Task ${ticket} not found.`));
      process.exit(1);
    }
    console.log(error(err.message));
    process.exit(1);
  }
}

export async function taskAssignCommand(ticket: string, assignee: string, options: TaskAssignOptions): Promise<void> {
  try {
    const { task } = await assignTask(ticket, assignee, options.project);
    console.log(success(`${task.ticket} assigned to ${assignee}`));
  } catch (err: any) {
    if (err instanceof ProjectNotFoundError) exitNoProject();
    console.log(error(err.message));
    process.exit(1);
  }
}

export async function taskLogCommand(ticket: string, entry: string, options: TaskLogOptions): Promise<void> {
  try {
    const { ticket: logged } = await logTask(ticket, entry, options.project);
    console.log(success(`Logged to ${logged}`));
  } catch (err: any) {
    if (err instanceof ProjectNotFoundError) exitNoProject();
    console.log(error(err.message));
    process.exit(1);
  }
}
