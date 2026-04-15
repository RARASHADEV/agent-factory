/**
 * AF-26: Pipeline state tracking — the on-disk record of a pipeline run.
 *
 * State lives at `.af/output/<ticket>/pipeline-state.json` and is written
 * continuously as the pipeline progresses. AF-28 reads this format.
 *
 * This file is pure I/O + typed state transitions. No business logic.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { PhaseDefinition } from './pipeline.js';

// --- Status enums ---

export type PipelineStatus = 'running' | 'completed' | 'failed';
export type PhaseStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';
export type GateResult = 'pass' | 'fail' | 'skipped';

// --- Failure record ---

/**
 * Flat record for a single gate failure as persisted in pipeline-state.json.
 * AF-27 adds `remediation`. `gateFailure` (singular) is retained for backward
 * compatibility with AF-26 readers; `gateFailures` (plural) is the canonical
 * multi-failure record introduced in AF-27.
 */
export interface GateFailureRecord {
  field: string;
  operator: string;
  expected?: unknown;
  actual: unknown;
  message: string;
  /** AF-27: one-line suggestion for how to fix this failure. */
  remediation?: string;
}

// --- Phase state ---

export interface PhaseState {
  agent: string;
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  gateResult?: GateResult;
  /**
   * AF-27: all failing conditions from the gate evaluation (multi-failure support).
   * Populated with the final attempt's failures when a gate fails.
   */
  gateFailures?: GateFailureRecord[];
  /**
   * Mirrors `gateFailures[0]` when present, for backward compatibility with
   * AF-26 consumers (e.g. AF-28 status renderer reading the singular field).
   */
  gateFailure?: GateFailureRecord;
  /**
   * AF-27: number of subprocess attempts for this phase.
   * 1 = single-shot (AF-26 behavior); 2+ = retried at least once.
   * Omitted when the phase was skipped or never spawned.
   */
  attempts?: number;
  /**
   * Reason for failure, when status === 'failed'.
   * One of: 'spawn_error', 'no_result_json', 'gate_failure'.
   */
  failureReason?: 'spawn_error' | 'no_result_json' | 'gate_failure';
  /** Path to this phase's output dir, relative to .af/ — AF-28 convenience */
  outputDir?: string;
}

// --- Pipeline state ---

export interface PipelineState {
  pipeline: string;
  ticket: string;
  status: PipelineStatus;
  startedAt: string;
  completedAt?: string;
  /** Only set while status === 'running' */
  currentPhase?: string;
  /** Phase name → phase state */
  phases: Record<string, PhaseState>;
  /** Warnings collected across all phases (injection, etc.) */
  warnings?: string[];
}

// --- I/O ---

const STATE_FILENAME = 'pipeline-state.json';

/**
 * Write pipeline state to `<outputDir>/pipeline-state.json`.
 * Creates the parent directory if it doesn't exist.
 * Pretty-prints with 2-space indent.
 */
export function writePipelineState(
  outputDir: string,
  state: PipelineState,
): void {
  const filePath = join(outputDir, STATE_FILENAME);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Read pipeline state from `<outputDir>/pipeline-state.json`.
 * Returns null when the file doesn't exist or is unreadable/malformed.
 */
export function readPipelineState(outputDir: string): PipelineState | null {
  const filePath = join(outputDir, STATE_FILENAME);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as PipelineState;
  } catch {
    return null;
  }
}

// --- Factory ---

/**
 * Build an initial `PipelineState` with all phases in `pending` status.
 * Sets `status = 'running'` and `startedAt = now`.
 */
export function initPipelineState(
  pipeline: string,
  ticket: string,
  phases: PhaseDefinition[],
): PipelineState {
  const phaseMap: Record<string, PhaseState> = {};
  for (const p of phases) {
    phaseMap[p.name] = {
      agent: p.agent,
      status: 'pending',
    };
  }
  return {
    pipeline,
    ticket,
    status: 'running',
    startedAt: new Date().toISOString(),
    phases: phaseMap,
  };
}
