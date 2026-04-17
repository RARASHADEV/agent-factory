import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const AF_DIR = '.af';
export const GLOBAL_DIR = join(homedir(), '.af');
export const GLOBAL_CONFIG = join(GLOBAL_DIR, 'config.yaml');

// Resolve AGENTS_DIR relative to the package root so the CLI works regardless
// of where it's installed or which user is running it. At runtime this file
// lives at <pkg>/dist/lib/constants.js, so the agents dir is two levels up.
// Environment override: AF_AGENTS_DIR for users who want to point at a custom
// agents directory (e.g. a clone or a global overlay).
const HERE = dirname(fileURLToPath(import.meta.url));
export const AGENTS_DIR =
  process.env.AF_AGENTS_DIR ?? join(HERE, '..', '..', 'agents');

export const STATUSES = [
  'backlog',
  'open',
  'in-progress',
  'ready-for-qa',
  'uat',
  'ready-4-release',
  'released',
  'closed',
  'blocked',
] as const;

export type TaskStatus = (typeof STATUSES)[number];

export const TYPES = ['bug', 'chore', 'epic', 'feature', 'improvement', 'task'] as const;
export type TaskType = (typeof TYPES)[number];

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const COMPLEXITIES = ['low', 'medium', 'high'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const PROJECT_STATUSES = ['inception', 'active', 'paused', 'archived'] as const;

// --- Feature Flags ---

/** AF-8: Audit logging. When false, auditLog() is a no-op. */
export const ENABLE_AF_8 = false;

/** AF-12: Bidirectional Loka sync. When false, sync command and Loka activity posting are disabled. */
export const ENABLE_AF_12 = true;

/** AF-13: Auto-create Loka project + inline sync on task mutations. When false, preserves original throw behavior. */
export const ENABLE_AF_13 = true;

/** AF-23: Structured result.json output. When false, spawn-runner skips result.json extraction/writing. */
export const ENABLE_AF_23 = true;

/** AF-25: Artifact injection. When false, pipeline runner skips inject resolution. */
export const ENABLE_AF_25 = true;

/** AF-26: Pipeline run command. When false, `af pipeline run` refuses to execute. */
export const ENABLE_AF_26 = true;

/** AF-27: Compound gates, matches operator, retry. When false, the validator rejects
 *  compound/retry/matches forms and the pipeline runner ignores `retry`. Single-condition
 *  gates from AF-26 keep working. */
export const ENABLE_AF_27 = true;

/** AF-28: Pipeline status command. When false, `af pipeline status` refuses to execute. */
export const ENABLE_AF_28 = true;

/** AF-34: Pause/resume for pipelines. When false, both commands refuse and
 *  the runner's between-phase sentinel check is skipped — existing run behavior
 *  is unaffected. */
export const ENABLE_AF_34 = true;
