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

/** AF-42: Local execution backend (Ollama/vLLM) routing via the `execution`
 *  frontmatter block. When false, an agent requesting `backend: local` is
 *  rejected and only the Claude SDK path runs — preserving prior behavior. */
export const ENABLE_AF_42 = true;

/**
 * AF-48: `af orchestrate` command. When false, the command prints a friendly
 * "not enabled" message and exits 0. Gates only the user-facing command — the
 * orchestration engine/library code (AF-42/45/46) is already merged and tested
 * and is NOT gated. Enabled: AF-48 is released (verified against a real local
 * model + a supervisor emitting parseable decisions); AF-53 Stage A depends on
 * this being on.
 */
export const ENABLE_AF_48 = true;

/**
 * AF-53: `af serve` HTTP service. When false, the command prints a "disabled"
 * notice, exits 0, and opens no listener. Checked once at command entry, mirroring
 * how `webhook` checks ENABLE_AF_12. Gates the whole service (and, later, every route).
 * Flip to true only after Stage A acceptance tests pass on Hanuman behind the tailnet.
 */
export const ENABLE_AF_53 = true; // AF-61: enabled on Hanuman after acceptance

/**
 * AF-53 (§8): default global worker concurrency cap for the `af serve` queue.
 * The queue itself lands in a later ticket; `/health` reports this as `capacity`.
 * Overridable via the AF_MAX_CONCURRENCY env var / `service.maxConcurrency` config.
 */
export const AF_MAX_CONCURRENCY_DEFAULT = 20;

/**
 * AF-53 (§8, Decision 6): default queue-depth backstop for the `af serve` queue.
 * If the number of WAITING (not running) jobs is at or above this ceiling, the
 * next `POST /jobs` is rejected `429 { error, retryAfter }` and enqueues nothing —
 * an abuse/runaway backstop, not the normal flow. In-flight jobs are unaffected.
 * Overridable via the AF_MAX_QUEUE_DEPTH env var / `service.maxQueueDepth` config.
 */
export const AF_MAX_QUEUE_DEPTH_DEFAULT = 500;

/** AF-53 (§8, Decision 4): default listen port — distinct from webhook's 4100. */
export const AF_SERVICE_PORT_DEFAULT = 4150;

/** AF-53 (§8, Decision 7): default SQLite database path (jobs + audit journal). */
export const AF_SERVICE_DB_DEFAULT = join(GLOBAL_DIR, 'service.db');

/**
 * AF-53 (§8, Decision 10): default retention in days for the SQLite store.
 * `0` = keep everything (audit-first default; nothing is ever pruned). A positive
 * value prunes only terminal `dispatch_jobs` and their `job_events` older than N
 * days on a boot-time + daily sweep; `request_log` is NEVER auto-pruned.
 * Overridable via AF_SERVICE_RETENTION_DAYS env / `service.retentionDays` config.
 */
export const AF_SERVICE_RETENTION_DAYS_DEFAULT = 0;

/**
 * AF-42 (§8 SSRF guard): allow-list of hosts a local `execution.endpoint` may
 * target. Operator-set agent files could otherwise point the dispatcher at an
 * arbitrary internal service. Entries are matched case-insensitively; a leading
 * "*." marks a wildcard suffix (e.g. "*.internal" matches "ollama.internal").
 * Override via the AF_LOCAL_ENDPOINT_ALLOWLIST env var (comma-separated).
 */
export const LOCAL_ENDPOINT_ALLOWLIST: string[] = (
  process.env.AF_LOCAL_ENDPOINT_ALLOWLIST ?? 'localhost,127.0.0.1,::1'
)
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
