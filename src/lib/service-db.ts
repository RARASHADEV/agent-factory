// src/lib/service-db.ts
// AF-53 / AF-55: SQLite data-access layer for the `af serve` HTTP service.
//
// Storage is the durable system of record for every job, inquiry, and instruction
// (design §1.1, §7, Decision 7). It is implemented with Node's BUILT-IN
// `node:sqlite` (Node ≥ 22) — a real SQLite engine with NO external/native
// dependency, so nothing is added to package.json (`better-sqlite3` is forbidden).
//
// Scope of AF-55 (this module): open/create the DB, enable WAL, create the three
// §7 tables + indexes (idempotent), expose a small typed data-access API, and
// implement reconcile-on-boot + opt-in retention pruning. The actual WRITES from
// request flow belong to later tickets:
//   - AF-56 (queue) writes/updates `dispatch_jobs`.
//   - AF-69 (audit middleware) writes/updates `request_log` and appends `job_events`.
// This module gives them small, typed methods to call without implementing their logic.
//
// Single-writer: the service is single-process and owns the only connection.
// WAL mode is enabled so the GET /jobs · GET /audit read service can read concurrently.

import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

// ── Domain types ─────────────────────────────────────────────────────────────

/** Job kinds that flow through the execution plane (design §7.1). */
export type JobKind = 'agent' | 'orchestration' | 'pipeline';

/** Lifecycle states of a dispatch job (design §7.1). */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'crashed'
  | 'timeout';

/** Terminal states — a job in one of these is done and will not transition further. */
export const TERMINAL_STATUSES: readonly JobStatus[] = [
  'completed',
  'failed',
  'crashed',
  'timeout',
] as const;

export function isTerminalStatus(status: string): status is JobStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** A row in `dispatch_jobs` — the execution registry (design §7.1). */
export interface DispatchJob {
  id: string;
  kind: JobKind;
  project: string;
  role: string | null;
  objective: string;
  status: JobStatus;
  outputDir: string;
  callbackUrl: string | null;
  caller: string | null;
  queuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  result: string | null;
}

/** Fields required to insert a new `dispatch_jobs` row (AF-56 calls this). */
export interface NewDispatchJob {
  id: string;
  kind: JobKind;
  project: string;
  role?: string | null;
  objective: string;
  status?: JobStatus; // defaults to 'queued'
  outputDir: string;
  callbackUrl?: string | null;
  caller?: string | null;
  queuedAt?: number; // defaults to Date.now()
  startedAt?: number | null;
  completedAt?: number | null;
  result?: string | null;
}

/** Mutable fields of a `dispatch_jobs` row (AF-56 transitions jobs through these). */
export interface DispatchJobUpdate {
  status?: JobStatus;
  startedAt?: number | null;
  completedAt?: number | null;
  result?: string | null;
}

/** A row in `request_log` — the cross-plane audit journal (design §7.2). */
export interface RequestLog {
  id: string;
  receivedAt: number;
  caller: string | null;
  plane: string;
  method: string;
  path: string;
  operation: string | null;
  project: string | null;
  payload: string | null;
  jobId: string | null;
  status: number | null;
  outcome: string | null;
  resultSummary: string | null;
  respondedAt: number | null;
}

/** Fields written on arrival (step ① log-first; AF-69 calls this). */
export interface NewRequestLog {
  id: string;
  receivedAt?: number; // defaults to Date.now()
  caller?: string | null;
  plane: string;
  method: string;
  path: string;
  operation?: string | null;
  project?: string | null;
  payload?: string | null;
  jobId?: string | null;
}

/** Fields written on outcome (step ③ log-last; AF-69 calls this). */
export interface RequestLogOutcome {
  status?: number | null;
  outcome?: string | null;
  resultSummary?: string | null;
  respondedAt?: number | null; // defaults to Date.now()
  jobId?: string | null; // may only be known once the job row exists
}

/** A row in `job_events` — execution lifecycle transitions (design §7.3). */
export interface JobEvent {
  id: number;
  jobId: string;
  at: number;
  event: string;
  detail: string | null;
}

/** Fields to append a `job_events` row (AF-69 calls this). */
export interface NewJobEvent {
  jobId: string;
  at?: number; // defaults to Date.now()
  event: string;
  detail?: string | null;
}

/** Filters for listing the registry (backs GET /jobs). */
export interface JobListFilter {
  project?: string;
  status?: JobStatus;
  limit?: number;
}

/** Filters for listing the audit journal (backs GET /audit). */
export interface RequestLogFilter {
  since?: number;
  caller?: string;
  project?: string;
  plane?: string;
  jobId?: string;
  limit?: number;
}

/** Result of reconcile-on-boot (design §7.1, test 5). */
export interface ReconcileResult {
  /** Count of `queued` rows confirmed still re-dispatchable. */
  requeued: number;
  /** Count of orphaned `running` rows marked `failed`. */
  failed: number;
}

// ── Row → domain mappers ─────────────────────────────────────────────────────

function rowToJob(r: any): DispatchJob {
  return {
    id: r.id,
    kind: r.kind,
    project: r.project,
    role: r.role ?? null,
    objective: r.objective,
    status: r.status,
    outputDir: r.output_dir,
    callbackUrl: r.callback_url ?? null,
    caller: r.caller ?? null,
    queuedAt: r.queued_at,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    result: r.result ?? null,
  };
}

function rowToRequestLog(r: any): RequestLog {
  return {
    id: r.id,
    receivedAt: r.received_at,
    caller: r.caller ?? null,
    plane: r.plane,
    method: r.method,
    path: r.path,
    operation: r.operation ?? null,
    project: r.project ?? null,
    payload: r.payload ?? null,
    jobId: r.job_id ?? null,
    status: r.status ?? null,
    outcome: r.outcome ?? null,
    resultSummary: r.result_summary ?? null,
    respondedAt: r.responded_at ?? null,
  };
}

function rowToJobEvent(r: any): JobEvent {
  return {
    id: r.id,
    jobId: r.job_id,
    at: r.at,
    event: r.event,
    detail: r.detail ?? null,
  };
}

// ── Schema (design §7 — EXACT) ───────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dispatch_jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  project       TEXT NOT NULL,
  role          TEXT,
  objective     TEXT NOT NULL,
  status        TEXT NOT NULL,
  output_dir    TEXT NOT NULL,
  callback_url  TEXT,
  caller        TEXT,
  queued_at     INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,
  result        TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON dispatch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON dispatch_jobs(project);

CREATE TABLE IF NOT EXISTS request_log (
  id              TEXT PRIMARY KEY,
  received_at     INTEGER NOT NULL,
  caller          TEXT,
  plane           TEXT NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  operation       TEXT,
  project         TEXT,
  payload         TEXT,
  job_id          TEXT,
  status          INTEGER,
  outcome         TEXT,
  result_summary  TEXT,
  responded_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_req_received ON request_log(received_at);
CREATE INDEX IF NOT EXISTS idx_req_caller   ON request_log(caller);
CREATE INDEX IF NOT EXISTS idx_req_project  ON request_log(project);
CREATE INDEX IF NOT EXISTS idx_req_job      ON request_log(job_id);

CREATE TABLE IF NOT EXISTS job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_evt_job ON job_events(job_id, at);
`;

// ── Data-access class ────────────────────────────────────────────────────────

/**
 * Single-connection SQLite data-access for the AF service.
 *
 * Construct with a DB file path (`cfg.db`). The directory is created if missing,
 * WAL mode is enabled, and the §7 schema is applied idempotently. The service
 * owns the only connection (single writer); WAL allows concurrent reads.
 */
export class ServiceDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    // Ensure the parent directory exists (mirrors saveConfig's mkdir behavior).
    // ':memory:' and other special paths have no real directory — skip those.
    if (path !== ':memory:' && !path.startsWith('file:')) {
      const dir = dirname(path);
      if (dir && dir !== '.' && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(path);
    // WAL mode for concurrent reads from the /jobs · /audit read service (§7).
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
  }

  /** Close the underlying connection. */
  close(): void {
    this.db.close();
  }

  /** Current `PRAGMA journal_mode` — used by tests to assert WAL is on. */
  journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode;').get() as any;
    return String(row?.journal_mode ?? '').toLowerCase();
  }

  // ── dispatch_jobs (registry — written by AF-56) ────────────────────────────

  /** Insert a new job row. Defaults: status 'queued', queuedAt now. */
  insertJob(job: NewDispatchJob): void {
    const stmt = this.db.prepare(`
      INSERT INTO dispatch_jobs
        (id, kind, project, role, objective, status, output_dir,
         callback_url, caller, queued_at, started_at, completed_at, result)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      job.id,
      job.kind,
      job.project,
      job.role ?? null,
      job.objective,
      job.status ?? 'queued',
      job.outputDir,
      job.callbackUrl ?? null,
      job.caller ?? null,
      job.queuedAt ?? Date.now(),
      job.startedAt ?? null,
      job.completedAt ?? null,
      job.result ?? null,
    );
  }

  /** Fetch a single job by id, or undefined if absent. */
  getJob(id: string): DispatchJob | undefined {
    const row = this.db.prepare('SELECT * FROM dispatch_jobs WHERE id = ?').get(id);
    return row ? rowToJob(row) : undefined;
  }

  /**
   * List jobs, newest-queued first, optionally filtered by project/status.
   * Backs GET /jobs (AF-56). `limit` caps the result set.
   */
  listJobs(filter: JobListFilter = {}): DispatchJob[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.project !== undefined) {
      clauses.push('project = ?');
      params.push(filter.project);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM dispatch_jobs ${where} ORDER BY queued_at DESC, id DESC`;
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...(params as any[]));
    return rows.map(rowToJob);
  }

  /**
   * Update mutable fields of a job (status / timestamps / result). Only the
   * provided fields are written. Returns true if a row was updated.
   */
  updateJob(id: string, patch: DispatchJobUpdate): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.startedAt !== undefined) {
      sets.push('started_at = ?');
      params.push(patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      sets.push('completed_at = ?');
      params.push(patch.completedAt);
    }
    if (patch.result !== undefined) {
      sets.push('result = ?');
      params.push(patch.result);
    }
    if (sets.length === 0) return false;
    params.push(id);
    const info = this.db
      .prepare(`UPDATE dispatch_jobs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as any[]));
    return Number(info.changes) > 0;
  }

  // ── request_log (audit journal — written by AF-69) ─────────────────────────

  /** Insert the log-first row on arrival (step ①). */
  insertRequestLog(entry: NewRequestLog): void {
    const stmt = this.db.prepare(`
      INSERT INTO request_log
        (id, received_at, caller, plane, method, path, operation,
         project, payload, job_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.id,
      entry.receivedAt ?? Date.now(),
      entry.caller ?? null,
      entry.plane,
      entry.method,
      entry.path,
      entry.operation ?? null,
      entry.project ?? null,
      entry.payload ?? null,
      entry.jobId ?? null,
    );
  }

  /**
   * Apply the log-last outcome to an existing request row (step ③). Only the
   * provided fields are written. Returns true if a row was updated.
   */
  updateRequestLog(id: string, outcome: RequestLogOutcome): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (outcome.status !== undefined) {
      sets.push('status = ?');
      params.push(outcome.status);
    }
    if (outcome.outcome !== undefined) {
      sets.push('outcome = ?');
      params.push(outcome.outcome);
    }
    if (outcome.resultSummary !== undefined) {
      sets.push('result_summary = ?');
      params.push(outcome.resultSummary);
    }
    if (outcome.jobId !== undefined) {
      sets.push('job_id = ?');
      params.push(outcome.jobId);
    }
    // responded_at always advances to the outcome moment unless explicitly given.
    sets.push('responded_at = ?');
    params.push(outcome.respondedAt ?? Date.now());

    params.push(id);
    const info = this.db
      .prepare(`UPDATE request_log SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as any[]));
    return Number(info.changes) > 0;
  }

  /** Fetch a single request-log row by id, or undefined. */
  getRequestLog(id: string): RequestLog | undefined {
    const row = this.db.prepare('SELECT * FROM request_log WHERE id = ?').get(id);
    return row ? rowToRequestLog(row) : undefined;
  }

  /**
   * List the audit journal, newest-received first, with optional filters.
   * Backs GET /audit (AF-69). `since` is an inclusive received_at lower bound.
   */
  listRequestLog(filter: RequestLogFilter = {}): RequestLog[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.since !== undefined) {
      clauses.push('received_at >= ?');
      params.push(filter.since);
    }
    if (filter.caller !== undefined) {
      clauses.push('caller = ?');
      params.push(filter.caller);
    }
    if (filter.project !== undefined) {
      clauses.push('project = ?');
      params.push(filter.project);
    }
    if (filter.plane !== undefined) {
      clauses.push('plane = ?');
      params.push(filter.plane);
    }
    if (filter.jobId !== undefined) {
      clauses.push('job_id = ?');
      params.push(filter.jobId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM request_log ${where} ORDER BY received_at DESC, id DESC`;
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...(params as any[]));
    return rows.map(rowToRequestLog);
  }

  // ── job_events (lifecycle trail — written by AF-69) ────────────────────────

  /** Append a lifecycle transition for a job (step ③). */
  appendJobEvent(event: NewJobEvent): void {
    this.db
      .prepare('INSERT INTO job_events (job_id, at, event, detail) VALUES (?, ?, ?, ?)')
      .run(event.jobId, event.at ?? Date.now(), event.event, event.detail ?? null);
  }

  /** List a job's events in chronological order (uses idx_evt_job). */
  listJobEvents(jobId: string): JobEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY at ASC, id ASC')
      .all(jobId);
    return rows.map(rowToJobEvent);
  }

  // ── Reconcile on boot (design §7.1, test 5) ────────────────────────────────

  /**
   * Reconcile the registry after a restart so no in-flight job is silently lost:
   *  - rows still `queued` are left queued (re-dispatchable) — counted as requeued;
   *  - rows still `running` were orphaned by the restart (the worker is gone), so
   *    they are marked `failed` with a `completed_at`, making them re-dispatchable
   *    and never leaving a phantom "running" job. A `reconcile-failed` job_event is
   *    appended for each so the audit trail records the transition.
   *
   * Returns the counts. AF-56 (queue) re-dispatches the still-`queued` rows; this
   * function does not itself enqueue (no queue exists at this layer).
   */
  reconcileOnBoot(now: number = Date.now()): ReconcileResult {
    const orphaned = this.db
      .prepare("SELECT id FROM dispatch_jobs WHERE status = 'running'")
      .all() as Array<{ id: string }>;

    const markFailed = this.db.prepare(
      "UPDATE dispatch_jobs SET status = 'failed', completed_at = ? WHERE id = ?",
    );
    const addEvent = this.db.prepare(
      'INSERT INTO job_events (job_id, at, event, detail) VALUES (?, ?, ?, ?)',
    );

    const detail = JSON.stringify({ reason: 'orphaned by af serve restart' });
    this.db.exec('BEGIN');
    try {
      for (const { id } of orphaned) {
        markFailed.run(now, id);
        addEvent.run(id, now, 'failed', detail);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const requeuedRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM dispatch_jobs WHERE status = 'queued'")
      .get() as any;

    return {
      requeued: Number(requeuedRow?.n ?? 0),
      failed: orphaned.length,
    };
  }

  // ── Retention (design Decision 10, test 11) ────────────────────────────────

  /**
   * Prune terminal `dispatch_jobs` (and their `job_events`) whose terminal
   * timestamp is older than `retentionDays`. Audit-first semantics:
   *  - `retentionDays <= 0` → keep everything; nothing is pruned (the default).
   *  - `request_log` is NEVER auto-pruned, regardless of retention.
   *  - Only TERMINAL jobs are eligible (queued/running rows always survive).
   *
   * A job's age is measured by `completed_at` (falling back to `queued_at` if a
   * terminal row somehow lacks one). Returns the number of job rows pruned.
   */
  pruneRetention(retentionDays: number, now: number = Date.now()): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');

    const victims = this.db
      .prepare(
        `SELECT id FROM dispatch_jobs
         WHERE status IN (${placeholders})
           AND COALESCE(completed_at, queued_at) < ?`,
      )
      .all(...TERMINAL_STATUSES, cutoff) as Array<{ id: string }>;

    if (victims.length === 0) return 0;

    const delJob = this.db.prepare('DELETE FROM dispatch_jobs WHERE id = ?');
    const delEvents = this.db.prepare('DELETE FROM job_events WHERE job_id = ?');

    this.db.exec('BEGIN');
    try {
      for (const { id } of victims) {
        delEvents.run(id);
        delJob.run(id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return victims.length;
  }
}

/**
 * Open (or create) the service DB at `path`, enabling WAL and applying the §7
 * schema. Thin convenience wrapper so callers read as `openServiceDb(cfg.db)`.
 */
export function openServiceDb(path: string): ServiceDb {
  return new ServiceDb(path);
}
