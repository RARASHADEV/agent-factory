import { homedir } from 'os';
import { join } from 'path';

export const AF_DIR = '.af';
export const GLOBAL_DIR = join(homedir(), '.af');
export const GLOBAL_CONFIG = join(GLOBAL_DIR, 'config.yaml');
export const AGENTS_DIR = join(homedir(), 'projects', 'agent-factory', 'agents');

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
