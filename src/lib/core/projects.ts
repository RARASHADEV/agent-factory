// src/lib/core/projects.ts
// AF-58: Presentation-free core ops for the `projects` command.
//
// These functions return structured data only — no console.*, no chalk,
// no process.exit. The CLI (src/commands/projects.ts) formats the result
// for the terminal; the HTTP service (AF-59) serializes the same result
// as JSON. Both call the SAME core op so behaviour can never drift.

import { existsSync } from 'fs';
import { listProjects } from '../workspace.js';
import { FileProvider } from '../providers/file-provider.js';
import type { Task } from '../task-provider.js';

/** Status counts for a single project in the summary listing. */
export interface ProjectListCounts {
  inProgress: number;
  open: number;
  backlog: number;
  blocked: number;
}

/** One project in the `projects` summary listing. */
export interface ProjectListItem {
  prefix: string;
  name: string;
  status: string;
  path: string;
  counts: ProjectListCounts;
}

/** Result of {@link listProjectsSummary}. */
export interface ProjectListResult {
  projects: ProjectListItem[];
}

/** Aggregated status counts for a project in the detailed cross-project view. */
export interface ProjectDetailCounts {
  open: number;
  inProgress: number;
  blocked: number;
  done: number;
  total: number;
}

/** One project row in the detailed cross-project view. */
export interface ProjectDetail {
  prefix: string;
  name: string;
  path: string;
  counts: ProjectDetailCounts;
  blockedTasks: Task[];
}

/** Result of {@link listProjectsDetail}. */
export interface ProjectDetailResult {
  projects: ProjectDetail[];
  totals: ProjectDetailCounts;
  /** Projects that were skipped because their path was missing. */
  missingPaths: string[];
  /** Projects that were skipped because they could not be read. */
  unreadable: string[];
  /** Number of registered projects (before any skipping). */
  registeredCount: number;
}

/**
 * Summary listing of all registered projects with per-project status counts.
 * Mirrors `af projects` (the default, non-detail view).
 */
export async function listProjectsSummary(): Promise<ProjectListResult> {
  const projects = listProjects();
  const items: ProjectListItem[] = [];

  for (const project of projects) {
    const provider = new FileProvider(project.afPath, project.meta);
    const tasks = await provider.list();

    items.push({
      prefix: project.meta.prefix,
      name: project.meta.name,
      status: project.meta.status,
      path: project.entry.path,
      counts: {
        inProgress: tasks.filter(t => t.status === 'in-progress').length,
        open: tasks.filter(t => t.status === 'open').length,
        backlog: tasks.filter(t => t.status === 'backlog').length,
        blocked: tasks.filter(t => t.status === 'blocked').length,
      },
    });
  }

  return { projects: items };
}

/**
 * Detailed cross-project status view with aggregated counts and totals.
 * Mirrors `af projects --detail`.
 *
 * Projects whose path is missing or unreadable are skipped and reported in
 * `missingPaths` / `unreadable` so the caller can surface a warning.
 */
export async function listProjectsDetail(): Promise<ProjectDetailResult> {
  const projects = listProjects();

  const details: ProjectDetail[] = [];
  const missingPaths: string[] = [];
  const unreadable: string[] = [];
  const totals: ProjectDetailCounts = {
    open: 0,
    inProgress: 0,
    blocked: 0,
    done: 0,
    total: 0,
  };

  for (const project of projects) {
    const resolvedPath = project.entry.path.replace(/^~/, process.env.HOME || '');
    if (!existsSync(resolvedPath)) {
      missingPaths.push(project.meta.prefix);
      continue;
    }

    let tasks: Task[];
    try {
      const provider = new FileProvider(project.afPath, project.meta);
      tasks = await provider.list();
    } catch {
      unreadable.push(project.meta.prefix);
      continue;
    }

    const openCount = tasks.filter(t => t.status === 'open' || t.status === 'backlog').length;
    const inProgressCount = tasks.filter(t =>
      t.status === 'in-progress' ||
      t.status === 'ready-for-qa' ||
      t.status === 'uat' ||
      t.status === 'ready-4-release'
    ).length;
    const blockedCount = tasks.filter(t => t.status === 'blocked').length;
    const doneCount = tasks.filter(t => t.status === 'released' || t.status === 'closed').length;
    const total = tasks.length;

    details.push({
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
      blockedTasks: tasks.filter(t => t.status === 'blocked'),
    });

    totals.open += openCount;
    totals.inProgress += inProgressCount;
    totals.blocked += blockedCount;
    totals.done += doneCount;
    totals.total += total;
  }

  return {
    projects: details,
    totals,
    missingPaths,
    unreadable,
    registeredCount: projects.length,
  };
}
