// src/lib/service-jobs.ts
// AF-53 / AF-56: the execution-plane HTTP handlers for `af serve`.
//
// This module is the seam between the HTTP router (serve.ts) and the two things
// the service owns for execution (design §4, §5.1, §5.3, §6, Decisions 1/3/6):
//   - the global concurrency queue (job-queue.ts) — admission + lifecycle;
//   - the SQLite registry (service-db.ts) — durable system of record.
//
// Routes implemented here:
//   POST /jobs            — validate project (§6) + queue-depth backstop (Decision 6),
//                           insert a `queued` dispatch_jobs row, admit to the queue,
//                           return 202 { id, status:"queued", queuePosition }.
//   GET  /jobs/:id        — the registry row (404 if unknown).
//   GET  /jobs            — list (?project=&status=).
//   POST /jobs/:id/pause  — pipeline control (409/400 for non-pipeline kinds).
//   POST /jobs/:id/resume — pipeline control (409/400 for non-pipeline kinds).
//
// Business logic invariant (design §3.1): handlers validate + delegate; the queue
// runs the work through the EXISTING dispatch mechanisms (service-executor.ts).
// Registry writes for the queued → running → terminal transitions are wired here
// via the queue's hooks so the terminal state + job_events are persisted BEFORE
// any callback fires — AF-57 (callbacks) and AF-69 (audit) build on that ordering.

import { randomUUID } from 'crypto';
import { join } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';

import { JobQueue, type QueuedJob, type QueueHooks } from './job-queue.js';
import {
  type ServiceDb,
  type JobKind,
  type JobStatus,
  isTerminalStatus,
} from './service-db.js';
import { resolveProject } from './workspace.js';
import { createServiceExecutor } from './service-executor.js';
import { CallbackDispatcher, type CallbackConfig } from './service-callbacks.js';
import { takeBufferedBody, auditContext } from './service-audit.js';

// ── HTTP helper (kept local so the module has no serve.ts import cycle) ───────

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** Read and JSON-parse a request body (bounded). Returns {} for an empty body. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // AF-69: the audit middleware buffers the body up front (to log its stripped
  // payload). A stream can only be read once, so reuse that buffered body if present.
  const buffered = takeBufferedBody(req);
  if (buffered !== undefined) return buffered;
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX = 1024 * 1024; // 1 MiB guard
  return await new Promise((resolve, reject) => {
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const VALID_KINDS: readonly JobKind[] = ['agent', 'orchestration', 'pipeline'];

// ── Project resolution seam (design §6, injectable for tests) ─────────────────

/** Resolves a project prefix to its workspace, or null if unknown. */
export type ProjectResolver = (prefix: string) => { afPath: string } | null;

/** Default resolver: the same registry `af projects` uses (resolveProject). */
const defaultProjectResolver: ProjectResolver = (prefix) => {
  const r = resolveProject(prefix);
  return r ? { afPath: r.afPath } : null;
};

// ── Pipeline control seam (design §4, injectable) ─────────────────────────────

/**
 * Wire to the existing pipeline pause/resume mechanism. Returns the new status.
 * Injected so tests can stub it; production passes the real pipeline control.
 * A non-pipeline job never reaches here (the route rejects first).
 */
export type PipelineControl = (
  action: 'pause' | 'resume',
  job: { id: string; project: string; afPath: string },
) => Promise<JobStatus> | JobStatus;

// ── The job service ───────────────────────────────────────────────────────────

export interface JobServiceOptions {
  db: ServiceDb;
  queue: JobQueue;
  /** Project-local workspace afPath per project, captured at submit time. */
  resolveProjectFn?: ProjectResolver;
  /** Pipeline pause/resume wiring; omit to reject control with 501. */
  pipelineControl?: PipelineControl;
  /** Completion-callback delivery policy (AF-57). Omit for production defaults. */
  callbackConfig?: CallbackConfig;
}

/**
 * Bundles the queue + DB and produces the execution-plane route handlers and the
 * boot re-admit. One instance per `af serve` process; the queue inside it is the
 * single fleet-wide concurrency gate.
 */
export class JobService {
  readonly db: ServiceDb;
  readonly queue: JobQueue;
  private readonly resolveProjectFn: ProjectResolver;
  private readonly pipelineControl?: PipelineControl;
  /** afPath per job id, so pause/resume can locate the workspace post-submit. */
  private readonly afPaths = new Map<string, string>();
  /** AF-57: delivers terminal completion callbacks (exactly-once, non-blocking). */
  private readonly callbacks: CallbackDispatcher;

  constructor(opts: JobServiceOptions) {
    this.db = opts.db;
    this.queue = opts.queue;
    this.resolveProjectFn = opts.resolveProjectFn ?? defaultProjectResolver;
    this.pipelineControl = opts.pipelineControl;
    this.callbacks = new CallbackDispatcher(opts.db, opts.callbackConfig);
  }

  /**
   * The queue hooks that persist lifecycle transitions to the registry. Wire these
   * into the JobQueue at construction so running/terminal states + job_events land
   * in SQLite. The terminal write happens BEFORE the queue resolves (AF-57 hooks a
   * callback after this; AF-69 reads these events).
   */
  registryHooks(): QueueHooks {
    return {
      onStart: (job) => {
        const now = Date.now();
        this.db.updateJob(job.id, { status: 'running', startedAt: now });
        this.db.appendJobEvent({ jobId: job.id, at: now, event: 'started' });
      },
      onTerminal: (job, status, result) => {
        const now = Date.now();
        const resultStr =
          result === undefined ? null : typeof result === 'string' ? result : JSON.stringify(result);
        // Persist the terminal transition FIRST (design §5.4 ③): the dispatch_jobs
        // row + the terminal job_event are durable BEFORE any callback fires.
        this.db.updateJob(job.id, { status, completedAt: now, result: resultStr });
        this.db.appendJobEvent({
          jobId: job.id,
          at: now,
          event: status,
          detail: resultStr,
        });
        this.afPaths.delete(job.id);

        // AF-57 (§5.2 / §5.4 ④): now that the terminal state is persisted, POST the
        // completion callback if this job was submitted with a `callback_url`. The
        // url is read from the just-updated row (so it survives a boot re-admit, when
        // the in-memory QueuedJob is reconstructed without it). fire() is total: it
        // never throws and never blocks, so a callback can never crash the hook, the
        // queue, or the job. Jobs without a callback_url are a no-op.
        const row = this.db.getJob(job.id);
        this.callbacks.fire(job.id, status, row?.callbackUrl ?? null, result);
      },
    };
  }

  // ── POST /jobs ──────────────────────────────────────────────────────────────

  async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid body' });
      return;
    }

    const kind = body.kind;
    if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as JobKind)) {
      sendJson(res, 400, { error: `invalid kind '${String(kind)}' (expected agent|orchestration|pipeline)` });
      return;
    }
    const objective = body.objective;
    if (typeof objective !== 'string' || objective.trim() === '') {
      sendJson(res, 400, { error: 'objective is required' });
      return;
    }

    // §6 — project required AND must resolve against the registry. Reject BEFORE
    // enqueueing anything; never guess. role/domain/name collapse to `role`.
    const project = body.project;
    if (typeof project !== 'string' || project.trim() === '') {
      sendJson(res, 400, { error: `unknown project '${String(project ?? '')}'` });
      return;
    }
    const resolved = this.resolveProjectFn(project);
    if (!resolved) {
      sendJson(res, 400, { error: `unknown project '${project}'` });
      return;
    }

    // Decision 6 — queue-depth backstop. Waiting (not running) ≥ ceiling → 429,
    // enqueue nothing; in-flight jobs are unaffected. maxQueueDepth comes via
    // the closure (see makeHandlers). Checked here against the live queue.
    if (this.queue.queuedCount() >= this.maxQueueDepth) {
      sendJson(res, 429, {
        error: 'queue is full; retry later',
        retryAfter: this.retryAfterSeconds,
      });
      return;
    }

    const role =
      pickString(body.role) ?? pickString(body.domain) ?? pickString(body.name) ?? null;
    const callbackUrl = pickString(body.callback_url) ?? null;
    const opts =
      body.opts && typeof body.opts === 'object' ? (body.opts as Record<string, unknown>) : undefined;

    const id = randomUUID();
    const ticketDir = role ? join(role, id) : id;
    const outputDir = join(resolved.afPath, 'output', ticketDir);

    // Insert the queued row + the `queued` job_event (the system of record) BEFORE
    // admitting to the in-process queue, so a crash right after admission still has
    // a durable record to reconcile.
    const now = Date.now();
    this.db.insertJob({
      id,
      kind: kind as JobKind,
      project,
      role,
      objective,
      status: 'queued',
      outputDir,
      callbackUrl,
      caller: null,
      queuedAt: now,
    });

    const queuedJob: QueuedJob = {
      id,
      kind: kind as JobKind,
      project,
      role,
      objective,
      outputDir,
      opts,
    };
    this.afPaths.set(id, resolved.afPath);

    // Record the `queued` lifecycle event BEFORE admitting to the queue, so the
    // ordered job_events trail reads queued → started → terminal even when a free
    // slot admits the job synchronously inside submit() (cap not yet reached).
    const queuePosition = this.queue.nextQueuePosition();
    this.db.appendJobEvent({
      jobId: id,
      at: now,
      event: 'queued',
      detail: JSON.stringify({ queuePosition }),
    });

    this.queue.submit(queuedJob);

    // AF-69 (§5.4 ③): surface the new job id to the audit middleware so log-last
    // backfills request_log.job_id, linking the execution row to its journal entry.
    auditContext(req).jobId = id;

    sendJson(res, 202, { id, status: 'queued', queuePosition });
  }

  // ── GET /jobs/:id and GET /jobs ───────────────────────────────────────────────

  handleGetOne(res: ServerResponse, id: string): void {
    const job = this.db.getJob(id);
    if (!job) {
      sendJson(res, 404, { error: `unknown job '${id}'` });
      return;
    }
    sendJson(res, 200, jobToJson(job));
  }

  handleList(res: ServerResponse, query: URLSearchParams): void {
    const project = query.get('project') ?? undefined;
    const statusParam = query.get('status') ?? undefined;
    const status = statusParam && isJobStatus(statusParam) ? (statusParam as JobStatus) : undefined;
    const limitParam = query.get('limit');
    const limit = limitParam && Number.isFinite(Number(limitParam)) ? Number(limitParam) : undefined;
    const jobs = this.db.listJobs({ project, status, limit });
    sendJson(res, 200, { jobs: jobs.map(jobToJson) });
  }

  // ── POST /jobs/:id/pause | /resume ───────────────────────────────────────────

  async handleControl(res: ServerResponse, id: string, action: 'pause' | 'resume'): Promise<void> {
    const job = this.db.getJob(id);
    if (!job) {
      sendJson(res, 404, { error: `unknown job '${id}'` });
      return;
    }
    if (job.kind !== 'pipeline') {
      // §4 — pause/resume only apply to pipelines. 409: the job exists but its
      // kind does not support the control.
      sendJson(res, 409, { error: `cannot ${action} a ${job.kind} job (pipeline-only control)` });
      return;
    }
    if (!this.pipelineControl) {
      sendJson(res, 501, { error: 'pipeline pause/resume is not wired in this build' });
      return;
    }
    const afPath = this.afPaths.get(id) ?? '';
    try {
      const status = await this.pipelineControl(action, { id, project: job.project, afPath });
      sendJson(res, 200, { id, status });
    } catch (err) {
      sendJson(res, 409, { error: err instanceof Error ? err.message : `cannot ${action}` });
    }
  }

  // ── Boot re-admit (design test 5) ────────────────────────────────────────────

  /**
   * Re-admit rows left `queued` (e.g. by a restart, after reconcileOnBoot has
   * already failed orphaned `running` rows) into the in-process queue so dispatch
   * survives a restart. Returns the count re-admitted.
   */
  readmitQueued(): number {
    const queued = this.db.listJobs({ status: 'queued' });
    for (const job of queued) {
      const resolved = this.resolveProjectFn(job.project);
      if (resolved) this.afPaths.set(job.id, resolved.afPath);
      this.queue.submit({
        id: job.id,
        kind: job.kind,
        project: job.project,
        role: job.role,
        objective: job.objective,
        outputDir: job.outputDir,
      });
    }
    return queued.length;
  }

  // Backstop config, set by makeHandlers (closure carries the resolved values).
  private maxQueueDepth = Infinity;
  private retryAfterSeconds = 30;

  /** Apply the resolved backstop settings (called once at wiring time). */
  configureBackstop(maxQueueDepth: number, retryAfterSeconds = 30): void {
    this.maxQueueDepth = maxQueueDepth;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function isJobStatus(s: string): boolean {
  return (
    s === 'queued' ||
    s === 'running' ||
    isTerminalStatus(s)
  );
}

/** Registry row → the JSON shape GET /jobs returns (design §4). */
function jobToJson(job: {
  id: string;
  kind: string;
  project: string;
  role: string | null;
  objective: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  result: string | null;
}): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    project: job.project,
    role: job.role,
    objective: job.objective,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result,
  };
}

/**
 * Build the production JobService for the running service: a queue wired to the
 * real per-project executor + registry hooks, with the backstop configured.
 */
export function createJobService(deps: {
  db: ServiceDb;
  capacity: number;
  maxQueueDepth: number;
  resolveProjectFn?: ProjectResolver;
  pipelineControl?: PipelineControl;
  /** AF-57: completion-callback delivery policy. Omit for production defaults. */
  callbackConfig?: CallbackConfig;
}): JobService {
  const resolveProjectFn = deps.resolveProjectFn ?? defaultProjectResolver;

  // The production executor resolves each job's project-local workspace and runs
  // the work through the existing dispatch mechanisms (service-executor.ts).
  const queue = new JobQueue({
    capacity: deps.capacity,
    executor: async (job) => {
      const resolved = resolveProjectFn(job.project);
      const cwd = resolved?.afPath ? join(resolved.afPath, '..') : process.cwd();
      const exec = createServiceExecutor({ cwd });
      return exec(job);
    },
    hooks: { /* replaced below once the service exists */ },
  });

  const service = new JobService({
    db: deps.db,
    queue,
    resolveProjectFn,
    pipelineControl: deps.pipelineControl,
    callbackConfig: deps.callbackConfig,
  });
  service.configureBackstop(deps.maxQueueDepth);

  // Wire the service's registry-persistence hooks now that it exists (the queue
  // is still idle, so setting hooks here is safe).
  queue.setHooks(service.registryHooks());

  return service;
}
