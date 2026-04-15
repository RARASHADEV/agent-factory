/**
 * AF-26: Pipeline state tracking — the on-disk record of a pipeline run.
 *
 * State lives at `.af/output/<ticket>/pipeline-state.json` and is written
 * continuously as the pipeline progresses. AF-28 reads this format.
 *
 * AF-34 adds `'paused'` to PipelineStatus, `pausedAt`/`resumedAt` fields
 * on PipelineState, and the pause-request sentinel file I/O helpers.
 *
 * This file is pure I/O + typed state transitions. No business logic.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import type { PhaseDefinition } from './pipeline.js';

// --- Status enums ---

export type PipelineStatus = 'running' | 'completed' | 'failed' | 'paused';
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
  /**
   * AF-34: ISO timestamp of the most recent pause transition. Overwritten on
   * each pause cycle — full history lives in audit.log.
   */
  pausedAt?: string;
  /**
   * AF-34: ISO timestamp of the most recent resume transition. Overwritten on
   * each resume — full history lives in audit.log.
   */
  resumedAt?: string;
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

// ============================================================
// AF-34: Pause-request sentinel I/O
// ============================================================

/**
 * AF-34: A pause request sentinel — one is written to
 * `<outputDir>/pause.request` by `af pipeline pause <ticket>` and observed
 * by the runner between phases. Contents are forensic only; the runner
 * cares solely about the file's existence.
 */
export interface PauseRequest {
  /** ISO 8601 timestamp when the pause was requested. */
  requestedAt: string;
  /** Who requested it. 'cli' for now; future: 'webhook', etc. */
  requestedBy: string;
}

const PAUSE_FILENAME = 'pause.request';

/**
 * AF-34: Write a pause-request sentinel to `<outputDir>/pause.request`.
 *
 * Atomic: writes to `<outputDir>/pause.request.tmp` and renames into place.
 * This prevents the runner from observing a half-written file if the pause
 * command's process is killed mid-write.
 *
 * Throws if the output directory does not exist — the caller is expected
 * to have checked for a pipeline run before requesting pause.
 */
export function writePauseRequest(
  outputDir: string,
  req: PauseRequest,
): void {
  if (!existsSync(outputDir)) {
    throw new Error(`Output dir does not exist: ${outputDir}`);
  }
  const tmp = join(outputDir, `${PAUSE_FILENAME}.tmp`);
  const final = join(outputDir, PAUSE_FILENAME);
  writeFileSync(tmp, JSON.stringify(req, null, 2), 'utf-8');
  renameSync(tmp, final);
}

/**
 * AF-34: Return true if a pause request sentinel is present.
 * Hot-path helper for the runner's between-phase check — existence-only,
 * no I/O on the contents.
 */
export function pauseRequestExists(outputDir: string): boolean {
  return existsSync(join(outputDir, PAUSE_FILENAME));
}

/**
 * AF-34: Read the pause-request sentinel. Returns null if absent or malformed.
 * Used for forensics (e.g. when transitioning to paused, the runner records
 * the original `requestedAt`/`requestedBy` in the audit log).
 */
export function readPauseRequest(outputDir: string): PauseRequest | null {
  const filePath = join(outputDir, PAUSE_FILENAME);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as PauseRequest;
  } catch {
    return null;
  }
}

/**
 * AF-34: Remove the pause-request sentinel. Idempotent — no-op if the
 * file does not exist. Called by `af pipeline resume` as the authoritative
 * clearer; the runner never removes it so a crash mid-pause is recoverable.
 */
export function removePauseRequest(outputDir: string): void {
  const filePath = join(outputDir, PAUSE_FILENAME);
  if (!existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    // Best effort — a parallel removal or permissions blip is not fatal.
  }
}

// ============================================================
// AF-34: Resume — find the next phase to run
// ============================================================

/**
 * AF-34: Return the index of the first phase in `phaseOrder` whose recorded
 * status is neither `completed` nor `skipped`. Returns `phaseOrder.length`
 * when every phase is done.
 *
 * Defensive: if a phase has no state record (shouldn't happen with well-
 * formed state files, but could after a manual edit), returns that index
 * so the runner re-runs it.
 *
 * Pure function — no I/O.
 */
export function findNextPendingPhase(
  state: PipelineState,
  phaseOrder: PhaseDefinition[],
): number {
  for (let i = 0; i < phaseOrder.length; i++) {
    const ps = state.phases[phaseOrder[i].name];
    if (!ps) return i;
    if (ps.status === 'completed') continue;
    if (ps.status === 'skipped') continue;
    return i;
  }
  return phaseOrder.length;
}
