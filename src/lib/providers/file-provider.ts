// src/lib/providers/file-provider.ts
// FileProvider: filesystem-based TaskProvider implementation.
// Extracts logic from workspace.ts (listTasks, findTask) and commands/task.ts
// (taskCreateCommand, taskMoveCommand, taskAssignCommand).

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import {
  TaskProvider,
  Task,
  TaskQuery,
  TaskCreateInput,
  TaskUpdateInput,
  TaskNotFoundError,
  ValidationError,
} from '../task-provider.js';
import { type ProjectMeta } from '../workspace.js';
import { STATUSES, TYPES, PRIORITIES, COMPLEXITIES, type TaskStatus } from '../constants.js';

export class FileProvider implements TaskProvider {
  constructor(
    private afPath: string,
    private projectMeta: ProjectMeta,
  ) {}

  // ── list ──────────────────────────────────────────────────────────────────

  async list(query?: TaskQuery): Promise<Task[]> {
    const tasksDir = join(this.afPath, 'tasks');
    if (!existsSync(tasksDir)) return [];

    const tasks: Task[] = [];
    const statusDirs = query?.status ? [query.status as TaskStatus] : [...STATUSES];

    for (const status of statusDirs) {
      const statusDir = join(tasksDir, status);
      if (!existsSync(statusDir)) continue;

      const files = readdirSync(statusDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = join(statusDir, file);
        const raw = readFileSync(filePath, 'utf-8');
        const { data, content } = matter(raw);

        // Apply filters
        if (query?.assignee && data.assignee !== query.assignee) continue;
        if (query?.priority && data.priority !== query.priority) continue;

        tasks.push(this.toTask(data, content, filePath));
      }
    }

    return tasks;
  }

  // ── get ───────────────────────────────────────────────────────────────────

  async get(ticket: string): Promise<Task | null> {
    const tasksDir = join(this.afPath, 'tasks');
    if (!existsSync(tasksDir)) return null;

    const filename = `${ticket}.md`;

    for (const status of STATUSES) {
      const filePath = join(tasksDir, status, filename);
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8');
        const { data, content } = matter(raw);
        return this.toTask(data, content, filePath);
      }
    }

    return null;
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(input: TaskCreateInput): Promise<Task> {
    // Read current counter from project.md
    const projectFile = join(this.afPath, 'project.md');
    const projectRaw = readFileSync(projectFile, 'utf-8');
    const projectParsed = matter(projectRaw);
    const counter = projectParsed.data.counter || 1;

    const ticket = `${this.projectMeta.prefix}-${counter}`;
    const today = new Date().toISOString().split('T')[0];

    // Validate options
    const type = input.type || 'task';
    if (!TYPES.includes(type as any)) {
      throw new ValidationError(`Invalid type: ${type}. Valid: ${TYPES.join(', ')}`);
    }

    const priority = input.priority || 'medium';
    if (!PRIORITIES.includes(priority as any)) {
      throw new ValidationError(`Invalid priority: ${priority}. Valid: ${PRIORITIES.join(', ')}`);
    }

    const complexity = input.complexity || 'medium';
    if (!COMPLEXITIES.includes(complexity as any)) {
      throw new ValidationError(`Invalid complexity: ${complexity}. Valid: ${COMPLEXITIES.join(', ')}`);
    }

    // Build frontmatter
    const taskMeta: Record<string, unknown> = {
      ticket,
      title: input.title,
      type,
      status: 'backlog',
      priority,
      complexity,
      created: today,
      updated: today,
    };

    if (input.assignee) taskMeta.assignee = input.assignee;
    if (input.depends && input.depends.length > 0) taskMeta.depends = input.depends;
    if (input.due) taskMeta.due = input.due;
    if (input.design) taskMeta.design = input.design;

    const bodyText = input.description
      ? `\n# ${input.title}\n\n${input.description}\n`
      : `\n# ${input.title}\n\n## Objective\n\n## Context\n\n## Acceptance\n- [ ] \n\n## Log\n`;

    const taskContent = matter.stringify(bodyText, taskMeta);

    // Write task file
    const taskDir = join(this.afPath, 'tasks', 'backlog');
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, `${ticket}.md`);
    writeFileSync(filePath, taskContent);

    // Increment counter in project.md
    projectParsed.data.counter = counter + 1;
    const updatedProject = matter.stringify(projectParsed.content, projectParsed.data);
    writeFileSync(projectFile, updatedProject);

    return this.toTask(taskMeta, bodyText, filePath);
  }

  // ── update ────────────────────────────────────────────────────────────────

  async update(ticket: string, input: TaskUpdateInput): Promise<Task> {
    const task = await this.get(ticket);
    if (!task || !task.filePath) throw new TaskNotFoundError(ticket);

    const raw = readFileSync(task.filePath, 'utf-8');
    const parsed = matter(raw);
    const today = new Date().toISOString().split('T')[0];

    if (input.title !== undefined) parsed.data.title = input.title;
    if (input.priority !== undefined) parsed.data.priority = input.priority;
    if (input.complexity !== undefined) parsed.data.complexity = input.complexity;
    if (input.design !== undefined) parsed.data.design = input.design;

    if (input.assignee === null) {
      delete parsed.data.assignee;
    } else if (input.assignee !== undefined) {
      parsed.data.assignee = input.assignee;
    }

    if (input.due === null) {
      delete parsed.data.due;
    } else if (input.due !== undefined) {
      parsed.data.due = input.due;
    }

    parsed.data.updated = today;

    let content = parsed.content;
    if (input.description !== undefined) {
      content = `\n${input.description}\n`;
    }

    const updated = matter.stringify(content, parsed.data);
    writeFileSync(task.filePath, updated);

    return this.toTask(parsed.data, content, task.filePath);
  }

  // ── move ──────────────────────────────────────────────────────────────────

  async move(ticket: string, targetStatus: string): Promise<Task> {
    // Validate status
    if (!STATUSES.includes(targetStatus as TaskStatus)) {
      throw new ValidationError(
        `Invalid status: ${targetStatus}. Valid: ${STATUSES.join(', ')}`,
      );
    }

    const task = await this.get(ticket);
    if (!task || !task.filePath) throw new TaskNotFoundError(ticket);

    // If moving to released/closed, check acceptance criteria
    if (['released', 'closed'].includes(targetStatus)) {
      const unchecked = (task.description.match(/- \[ \]/g) || []).length;
      if (unchecked > 0) {
        throw new ValidationError(
          `Cannot move to ${targetStatus}: ${unchecked} unchecked acceptance criteria.`,
        );
      }
    }

    if (task.status === targetStatus) {
      // Return task unchanged
      return task;
    }

    // Update frontmatter
    const raw = readFileSync(task.filePath, 'utf-8');
    const parsed = matter(raw);
    parsed.data.status = targetStatus;
    parsed.data.updated = new Date().toISOString().split('T')[0];
    const updated = matter.stringify(parsed.content, parsed.data);

    // Move file
    const targetDir = join(this.afPath, 'tasks', targetStatus);
    mkdirSync(targetDir, { recursive: true });
    const targetFile = join(targetDir, `${ticket.toUpperCase()}.md`);
    writeFileSync(targetFile, updated);

    // Remove old file
    unlinkSync(task.filePath);

    return this.toTask(parsed.data, parsed.content, targetFile);
  }

  // ── assign ────────────────────────────────────────────────────────────────

  async assign(ticket: string, assignee: string | null): Promise<Task> {
    const task = await this.get(ticket);
    if (!task || !task.filePath) throw new TaskNotFoundError(ticket);

    const raw = readFileSync(task.filePath, 'utf-8');
    const parsed = matter(raw);

    if (assignee === null) {
      delete parsed.data.assignee;
    } else {
      parsed.data.assignee = assignee;
    }

    parsed.data.updated = new Date().toISOString().split('T')[0];
    const updated = matter.stringify(parsed.content, parsed.data);
    writeFileSync(task.filePath, updated);

    return this.toTask(parsed.data, parsed.content, task.filePath);
  }

  // ── log ───────────────────────────────────────────────────────────────────

  async log(ticket: string, entry: string): Promise<void> {
    const task = await this.get(ticket);
    if (!task || !task.filePath) throw new TaskNotFoundError(ticket);

    const raw = readFileSync(task.filePath, 'utf-8');
    const timestamp = new Date().toISOString();
    const logLine = `- [${timestamp}] ${entry}\n`;
    writeFileSync(task.filePath, raw + logLine);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private toTask(data: Record<string, unknown>, content: string, filePath: string): Task {
    return {
      ticket: data.ticket as string,
      title: data.title as string,
      type: (data.type as string) || 'task',
      status: data.status as string,
      priority: (data.priority as string) || 'medium',
      complexity: (data.complexity as string) || 'medium',
      assignee: data.assignee as string | undefined,
      depends: data.depends as string[] | undefined,
      due: data.due as string | undefined,
      created: data.created as string,
      updated: data.updated as string,
      description: content.trim(),
      design: data.design as string | undefined,
      filePath,
    };
  }
}
