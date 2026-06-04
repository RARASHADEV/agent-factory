// src/lib/core/pipelines.ts
// AF-59: Presentation-free core read ops for the `pipeline` command family.
//
// Returns structured data only — no console.*, no chalk, no process.exit. The CLI
// (src/commands/pipeline.ts) formats the result for the terminal; the HTTP query
// plane (AF-59) serializes the SAME data as JSON.
//
//   listPipelineRuns  → mirrors `af pipeline status` (no ticket) — every run's
//                       pipeline-state.json under <afPath>/output/*.
//   getPipelineRun    → mirrors `af pipeline status <ticket>` — one run's state.
//
// Both resolve the project first; an unresolvable project throws
// ProjectNotFoundError (the adapter maps it to 400). A missing run returns null.

import { join } from 'path';
import { resolveProject } from '../workspace.js';
import {
  findPipelineRuns,
} from '../../commands/pipeline.js';
import { readPipelineState, type PipelineState } from '../pipeline-state.js';
import { ProjectNotFoundError } from './errors.js';

function resolveOrThrow(prefix?: string) {
  const resolved = resolveProject(prefix);
  if (!resolved) {
    throw new ProjectNotFoundError(prefix);
  }
  return resolved;
}

/** Result of {@link listPipelineRuns}. */
export interface PipelineRunListResult {
  prefix: string;
  name: string;
  runs: PipelineState[];
}

/**
 * List every pipeline run in a project (each run's pipeline-state.json).
 * Mirrors `af pipeline status` with no ticket. Sorted newest-first by startedAt.
 *
 * @throws {ProjectNotFoundError} if no project resolves.
 */
export function listPipelineRuns(prefix?: string): PipelineRunListResult {
  const { afPath, meta } = resolveOrThrow(prefix);
  const tickets = findPipelineRuns(afPath);
  const runs: PipelineState[] = [];
  for (const t of tickets) {
    const s = readPipelineState(join(afPath, 'output', t));
    if (s) runs.push(s);
  }
  runs.sort((a, b) => {
    const ta = Date.parse(a.startedAt);
    const tb = Date.parse(b.startedAt);
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    return vb - va;
  });
  return { prefix: meta.prefix, name: meta.name, runs };
}

/** Result of {@link getPipelineRun}. */
export interface PipelineRunResult {
  run: PipelineState;
}

/**
 * Fetch a single pipeline run by ticket. Mirrors `af pipeline status <ticket>`.
 *
 * @throws {ProjectNotFoundError} if no project resolves.
 * @returns null if no run exists for the ticket.
 */
export function getPipelineRun(
  ticket: string,
  prefix?: string,
): PipelineRunResult | null {
  const { afPath } = resolveOrThrow(prefix);
  const normalized = ticket.toUpperCase();
  const state = readPipelineState(join(afPath, 'output', normalized));
  if (!state) return null;
  return { run: state };
}
