// src/lib/core/status.ts
// AF-58: Presentation-free core op for the `status` command.
//
// Returns structured data only — no console.*, no chalk, no process.exit.
// The CLI (src/commands/status.ts) formats the result; the HTTP service
// (AF-59) serializes it as JSON. Both call the SAME core op.

import { resolveProject } from '../workspace.js';
import { createProvider } from '../provider-factory.js';
import { STATUSES } from '../constants.js';
import type { Task } from '../task-provider.js';
import { ProjectNotFoundError } from './errors.js';

/** One status group (e.g. "in-progress") with its tasks. */
export interface StatusGroup {
  status: string;
  tasks: Task[];
}

/** Result of {@link getProjectStatus}. */
export interface ProjectStatusResult {
  prefix: string;
  name: string;
  /** Status groups in canonical STATUSES order, including empty groups. */
  groups: StatusGroup[];
  total: number;
  done: number;
}

/**
 * Status overview for a single project: tasks grouped by status in canonical
 * order, plus total / completed counts. Mirrors `af status [-p prefix]`.
 *
 * @throws {ProjectNotFoundError} if no project resolves from `prefix`/cwd.
 */
export async function getProjectStatus(prefix?: string): Promise<ProjectStatusResult> {
  const resolved = resolveProject(prefix);
  if (!resolved) {
    throw new ProjectNotFoundError(prefix);
  }

  const { afPath, meta } = resolved;
  const provider = createProvider(afPath, meta);
  const tasks = await provider.list();

  // Group by status, preserving canonical STATUSES order and keeping
  // empty groups (the CLI filters empties; the data carries them all).
  const byStatus = new Map<string, Task[]>();
  for (const status of STATUSES) {
    byStatus.set(status, []);
  }
  for (const task of tasks) {
    const group = byStatus.get(task.status) || [];
    group.push(task);
    byStatus.set(task.status, group);
  }

  const groups: StatusGroup[] = STATUSES.map(status => ({
    status,
    tasks: byStatus.get(status) || [],
  }));

  return {
    prefix: meta.prefix,
    name: meta.name,
    groups,
    total: tasks.length,
    done: tasks.filter(t => ['released', 'closed'].includes(t.status)).length,
  };
}
