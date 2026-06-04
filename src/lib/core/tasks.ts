// src/lib/core/tasks.ts
// AF-58: Presentation-free core ops for the `task` command family.
//
// Each op resolves the project, runs the business logic (provider call +
// audit + post-action Loka sync), and returns structured data. No console.*,
// no chalk, no process.exit inside the op. The CLI (src/commands/task.ts)
// formats results for the terminal; the HTTP mutation routes (AF-60) call the
// SAME ops and serialize the result as JSON.
//
// When a project cannot be resolved, ops throw ProjectNotFoundError. Provider
// errors (validation, not-found, etc.) propagate unchanged so the adapter can
// map them appropriately.

import { readFileSync } from 'fs';
import { resolveProject } from '../workspace.js';
import { createProvider } from '../provider-factory.js';
import { auditLog } from '../audit.js';
import { postActionSync } from '../post-action-sync.js';
import type { Task, TaskCreateInput, TaskQuery } from '../task-provider.js';
import { ProjectNotFoundError } from './errors.js';

function resolveOrThrow(prefix?: string) {
  const resolved = resolveProject(prefix);
  if (!resolved) {
    throw new ProjectNotFoundError(prefix);
  }
  return resolved;
}

// ── Read ops ─────────────────────────────────────────────────────────────────

/** Result of {@link listTasks}. */
export interface TaskListResult {
  prefix: string;
  name: string;
  tasks: Task[];
}

/**
 * List tasks for a project with optional status/assignee/priority filtering.
 * Mirrors `af task list`.
 *
 * @throws {ProjectNotFoundError} if no project resolves.
 */
export async function listTasks(
  query: TaskQuery = {},
  prefix?: string,
): Promise<TaskListResult> {
  const { afPath, meta } = resolveOrThrow(prefix);
  const provider = createProvider(afPath, meta);
  const tasks = await provider.list(query);
  return { prefix: meta.prefix, name: meta.name, tasks };
}

/** Result of {@link showTask}. */
export interface TaskShowResult {
  task: Task;
  /** Raw markdown file content (file backend only); undefined otherwise. */
  raw?: string;
}

/**
 * Fetch a single task by ticket. Returns the structured task plus the raw
 * markdown file content (when the file backend exposes a filePath).
 * Mirrors `af task show`.
 *
 * @throws {ProjectNotFoundError} if no project resolves.
 * @returns null if the ticket does not exist.
 */
export async function showTask(
  ticket: string,
  prefix?: string,
): Promise<TaskShowResult | null> {
  const { afPath, meta } = resolveOrThrow(prefix);
  const provider = createProvider(afPath, meta);
  const task = await provider.get(ticket.toUpperCase());
  if (!task) return null;

  const raw = task.filePath ? readFileSync(task.filePath, 'utf-8') : undefined;
  return { task, raw };
}

// ── Write ops ────────────────────────────────────────────────────────────────

/** Result of {@link createTask}. */
export interface TaskCreateResult {
  task: Task;
}

/**
 * Create a task: persist via the provider, write an audit entry, and fire the
 * post-action Loka sync (fire-and-forget). Mirrors `af task create`.
 *
 * @throws {ProjectNotFoundError} if no project resolves.
 * @throws provider errors (e.g. ValidationError) unchanged.
 */
export async function createTask(
  input: TaskCreateInput,
  prefix?: string,
): Promise<TaskCreateResult> {
  const { afPath, meta } = resolveOrThrow(prefix);
  const provider = createProvider(afPath, meta);

  const task = await provider.create(input);

  try {
    auditLog(afPath, {
      event: 'task.create',
      ticket: task.ticket,
      actor: 'cli',
      detail: `Created task: ${task.title}`,
      meta: {
        type: task.type,
        priority: task.priority,
        ...(input.assignee ? { assignee: input.assignee } : {}),
      },
    });
  } catch {}

  // Unified post-action sync to Loka (fire-and-forget — local file is source of truth)
  void postActionSync(afPath, meta, task.ticket, 'create', {
    createInput: { ...input, ticket: task.ticket },
  });

  return { task };
}

/** Result of {@link moveTask}. */
export interface TaskMoveResult {
  task: Task;
  fromStatus: string;
  toStatus: string;
  /** True when the task was already in the target status (no-op move). */
  unchanged: boolean;
}

/**
 * Move a task to a new status: audit + Loka sync on a real transition.
 * A no-op (already in target status) returns `unchanged: true` without
 * touching the provider, audit, or sync. Mirrors `af task move`.
 *
 * @throws {ProjectNotFoundError} if no project resolves.
 * @throws {TaskNotFoundError} (provider) if the ticket does not exist.
 */
export async function moveTask(
  ticket: string,
  targetStatus: string,
  prefix?: string,
): Promise<TaskMoveResult> {
  const { afPath, meta } = resolveOrThrow(prefix);
  const provider = createProvider(afPath, meta);
  const upper = ticket.toUpperCase();

  const existing = await provider.get(upper);
  if (!existing) {
    // Mirror the provider's not-found contract used elsewhere.
    const { TaskNotFoundError } = await import('../task-provider.js');
    throw new TaskNotFoundError(upper);
  }

  const oldStatus = existing.status;

  if (oldStatus === targetStatus) {
    return { task: existing, fromStatus: oldStatus, toStatus: targetStatus, unchanged: true };
  }

  const task = await provider.move(upper, targetStatus);

  try {
    auditLog(afPath, {
      event: 'task.move',
      ticket: task.ticket,
      actor: 'cli',
      detail: `${oldStatus} → ${targetStatus}`,
      meta: { from: oldStatus, to: targetStatus },
    });
  } catch {}

  void postActionSync(afPath, meta, task.ticket, 'move', { targetStatus });

  return { task, fromStatus: oldStatus, toStatus: targetStatus, unchanged: false };
}

/** Result of {@link assignTask}. */
export interface TaskAssignResult {
  task: Task;
  assignee: string;
}

/**
 * Assign a task to an agent/user: audit + Loka sync. Mirrors `af task assign`.
 *
 * @throws {ProjectNotFoundError} if no project resolves.
 * @throws provider errors unchanged.
 */
export async function assignTask(
  ticket: string,
  assignee: string,
  prefix?: string,
): Promise<TaskAssignResult> {
  const { afPath, meta } = resolveOrThrow(prefix);
  const provider = createProvider(afPath, meta);
  const upper = ticket.toUpperCase();

  const existing = await provider.get(upper);
  const task = await provider.assign(upper, assignee);

  try {
    auditLog(afPath, {
      event: 'task.assign',
      ticket: task.ticket,
      actor: 'cli',
      detail: `Assigned to ${assignee}`,
      meta: { ...(existing?.assignee ? { previousAssignee: existing.assignee } : {}) },
    });
  } catch {}

  void postActionSync(afPath, meta, task.ticket, 'assign');

  return { task, assignee };
}

/** Result of {@link logTask}. */
export interface TaskLogResult {
  ticket: string;
}

/**
 * Append a log entry to a task's ## Log section, then fire the Loka sync.
 * Mirrors `af task log`.
 *
 * @throws {ProjectNotFoundError} if no project resolves.
 * @throws provider errors unchanged.
 */
export async function logTask(
  ticket: string,
  entry: string,
  prefix?: string,
): Promise<TaskLogResult> {
  const { afPath, meta } = resolveOrThrow(prefix);
  const provider = createProvider(afPath, meta);
  const upper = ticket.toUpperCase();

  await provider.log(upper, entry);

  void postActionSync(afPath, meta, upper, 'log', { logEntry: entry });

  return { ticket: upper };
}
