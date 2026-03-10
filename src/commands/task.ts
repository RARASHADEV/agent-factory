import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import matter from 'gray-matter';
import chalk from 'chalk';
import { resolveProject, listTasks, findTask, type TaskMeta } from '../lib/workspace.js';
import { STATUSES, TYPES, PRIORITIES, COMPLEXITIES, type TaskStatus } from '../lib/constants.js';
import { formatTaskLine, success, error, dim, heading } from '../lib/format.js';

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

export function taskListCommand(options: TaskListOptions): void {
  const { afPath, meta } = resolveOrExit(options.project);
  const tasks = listTasks(afPath, {
    status: options.status as TaskStatus | undefined,
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
    console.log(`  ${formatTaskLine(task.meta)}`);
  }
  console.log('');
  console.log(dim(`  ${tasks.length} task${tasks.length === 1 ? '' : 's'}`));
}

export function taskCreateCommand(title: string, options: TaskCreateOptions): void {
  const { afPath, meta } = resolveOrExit(options.project);

  // Read current counter from project.md
  const projectFile = join(afPath, 'project.md');
  const projectRaw = readFileSync(projectFile, 'utf-8');
  const projectParsed = matter(projectRaw);
  const counter = projectParsed.data.counter || 1;

  const ticket = `${meta.prefix}-${counter}`;
  const today = new Date().toISOString().split('T')[0];

  // Validate options
  const type = options.type || 'task';
  if (!TYPES.includes(type as any)) {
    console.log(error(`Invalid type: ${type}. Valid: ${TYPES.join(', ')}`));
    process.exit(1);
  }

  const priority = options.priority || 'medium';
  if (!PRIORITIES.includes(priority as any)) {
    console.log(error(`Invalid priority: ${priority}. Valid: ${PRIORITIES.join(', ')}`));
    process.exit(1);
  }

  const complexity = options.complexity || 'medium';
  if (!COMPLEXITIES.includes(complexity as any)) {
    console.log(error(`Invalid complexity: ${complexity}. Valid: ${COMPLEXITIES.join(', ')}`));
    process.exit(1);
  }

  // Build frontmatter
  const taskMeta: Record<string, unknown> = {
    ticket,
    title,
    type,
    status: 'backlog',
    priority,
    complexity,
    created: today,
    updated: today,
  };

  if (options.assignee) taskMeta.assignee = options.assignee;
  if (options.depends) taskMeta.depends = options.depends.split(',').map(s => s.trim());
  if (options.due) taskMeta.due = options.due;

  const taskContent = matter.stringify(
    `\n# ${title}\n\n## Objective\n\n## Context\n\n## Acceptance\n- [ ] \n\n## Log\n`,
    taskMeta
  );

  // Write task file
  const taskDir = join(afPath, 'tasks', 'backlog');
  mkdirSync(taskDir, { recursive: true });
  const taskFile = join(taskDir, `${ticket}.md`);
  writeFileSync(taskFile, taskContent);

  // Increment counter
  projectParsed.data.counter = counter + 1;
  const updatedProject = matter.stringify(projectParsed.content, projectParsed.data);
  writeFileSync(projectFile, updatedProject);

  console.log(success(`Created ${ticket}: ${title}`));
  console.log(dim(`  Type: ${type}  Priority: ${priority}  Complexity: ${complexity}`));
  console.log(dim(`  File: ${taskFile}`));
}

export function taskShowCommand(ticket: string, options: TaskShowOptions): void {
  const { afPath } = resolveOrExit(options.project);
  const task = findTask(afPath, ticket.toUpperCase());

  if (!task) {
    console.log(error(`Task ${ticket} not found.`));
    process.exit(1);
  }

  // Print raw file content (readable markdown)
  const raw = readFileSync(task.filePath, 'utf-8');
  console.log(raw);
}

export function taskMoveCommand(ticket: string, targetStatus: string, options: TaskMoveOptions): void {
  const { afPath } = resolveOrExit(options.project);

  // Validate status
  if (!STATUSES.includes(targetStatus as TaskStatus)) {
    console.log(error(`Invalid status: ${targetStatus}`));
    console.log(dim(`Valid: ${STATUSES.join(', ')}`));
    process.exit(1);
  }

  const task = findTask(afPath, ticket.toUpperCase());
  if (!task) {
    console.log(error(`Task ${ticket} not found.`));
    process.exit(1);
  }

  // If moving to released/closed, check acceptance criteria
  if (['released', 'closed'].includes(targetStatus)) {
    const unchecked = (task.content.match(/- \[ \]/g) || []).length;
    if (unchecked > 0) {
      console.log(error(`Cannot move to ${targetStatus}: ${unchecked} unchecked acceptance criteria.`));
      process.exit(1);
    }
  }

  const oldStatus = task.meta.status;
  if (oldStatus === targetStatus) {
    console.log(dim(`Task ${ticket} is already in ${targetStatus}.`));
    return;
  }

  // Update frontmatter
  const raw = readFileSync(task.filePath, 'utf-8');
  const parsed = matter(raw);
  parsed.data.status = targetStatus;
  parsed.data.updated = new Date().toISOString().split('T')[0];
  const updated = matter.stringify(parsed.content, parsed.data);

  // Move file
  const targetDir = join(afPath, 'tasks', targetStatus);
  mkdirSync(targetDir, { recursive: true });
  const targetFile = join(targetDir, `${ticket.toUpperCase()}.md`);
  writeFileSync(targetFile, updated);

  // Remove old file
  unlinkSync(task.filePath);

  console.log(success(`${ticket}: ${oldStatus} → ${targetStatus}`));
}

export function taskAssignCommand(ticket: string, assignee: string, options: TaskAssignOptions): void {
  const { afPath } = resolveOrExit(options.project);
  const task = findTask(afPath, ticket.toUpperCase());

  if (!task) {
    console.log(error(`Task ${ticket} not found.`));
    process.exit(1);
  }

  // Update frontmatter
  const raw = readFileSync(task.filePath, 'utf-8');
  const parsed = matter(raw);
  parsed.data.assignee = assignee;
  parsed.data.updated = new Date().toISOString().split('T')[0];
  const updated = matter.stringify(parsed.content, parsed.data);
  writeFileSync(task.filePath, updated);

  console.log(success(`${ticket} assigned to ${assignee}`));
}
