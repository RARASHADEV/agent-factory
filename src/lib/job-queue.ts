// src/lib/job-queue.ts
// AF-53 / AF-56: the global in-process concurrency queue for `af serve`.
//
// Design: §5.1 (one fleet-wide cap, enforced here because all execution lives on
// this one box), §5.3 (the queue only owns ADMISSION + lifecycle notification —
// the actual work runs through the EXISTING dispatchAgent / orchestrator / pipeline
// machinery, injected as an `executor`), Decision 1 (cap = AF_MAX_CONCURRENCY = 20),
// Decision 6 (a 429 backstop at AF_MAX_QUEUE_DEPTH lives in the HTTP layer, not here).
//
// This module is deliberately free of HTTP, SQLite, and process side effects so
// the concurrency behaviour can be unit-tested directly with a fake executor.
// The HTTP layer (service-jobs.ts) injects:
//   - an `executor` that runs a job and resolves/rejects with the terminal outcome;
//   - lifecycle `hooks` that persist the queued → running → terminal transitions to
//     the SQLite registry (dispatch_jobs + job_events).
//
// FIFO: jobs are admitted in submission order as slots free. At most `capacity`
// jobs run concurrently across ALL clients (a single shared queue object).

import type { JobKind, JobStatus } from './service-db.js';

/** The immutable description of a unit of work handed to the queue. */
export interface QueuedJob {
  id: string;
  kind: JobKind;
  project: string;
  role: string | null;
  objective: string;
  outputDir: string;
  /** Free-form options forwarded to the executor (model, opts, …). */
  opts?: Record<string, unknown>;
}

/** Terminal outcome the executor reports back for a job. */
export interface JobOutcome {
  /** Terminal status. Defaults to 'completed' when the executor resolves. */
  status?: Extract<JobStatus, 'completed' | 'failed' | 'crashed' | 'timeout'>;
  /** Result payload (serialised to the registry `result` column). */
  result?: unknown;
}

/**
 * Runs a single job to completion. Injected so production wires the real
 * dispatchAgent / orchestrator / pipeline mechanisms (service-jobs.ts) while
 * tests pass a fake that resolves / rejects / delays under their control.
 *
 * Resolving → the job reached a terminal state (default `completed`; the executor
 * may report `failed`/`timeout` explicitly via the returned JobOutcome).
 * Throwing / rejecting → the queue captures it as a terminal `crashed` so nothing
 * is ever left `running` forever.
 */
export type JobExecutor = (job: QueuedJob) => Promise<JobOutcome | void>;

/** Lifecycle callbacks fired by the queue as a job transitions. All optional. */
export interface QueueHooks {
  /** Fired when a waiting job is admitted and about to run (→ running). */
  onStart?: (job: QueuedJob) => void;
  /** Fired exactly once per job on any terminal state. AF-57 hooks callbacks here. */
  onTerminal?: (job: QueuedJob, status: JobStatus, result: unknown) => void;
}

interface Waiting {
  job: QueuedJob;
  /** Resolves when the job reaches a terminal state (so callers can await it). */
  resolve: (status: JobStatus) => void;
}

export interface JobQueueOptions {
  /** Max jobs running concurrently across all clients (AF_MAX_CONCURRENCY). */
  capacity: number;
  /** Runs a job. Injected; production wires the real dispatch mechanisms. */
  executor: JobExecutor;
  /** Lifecycle hooks (registry persistence, callbacks). */
  hooks?: QueueHooks;
}

/**
 * A process-wide FIFO concurrency queue. One shared instance per `af serve`
 * process governs every client's execution requests against a single cap.
 */
export class JobQueue {
  private readonly capacity: number;
  private readonly executor: JobExecutor;
  private hooks: QueueHooks;

  /** FIFO of admitted-but-not-yet-running jobs. */
  private readonly waiting: Waiting[] = [];
  /** Ids of jobs currently executing. */
  private readonly running = new Set<string>();

  constructor(opts: JobQueueOptions) {
    if (!Number.isInteger(opts.capacity) || opts.capacity < 1) {
      throw new Error(`JobQueue: capacity must be a positive integer (got ${opts.capacity})`);
    }
    this.capacity = opts.capacity;
    this.executor = opts.executor;
    this.hooks = opts.hooks ?? {};
  }

  /**
   * Replace the lifecycle hooks. Used at wiring time so the registry-persistence
   * hooks (which need a reference to the service that owns this queue) can be set
   * after both objects exist. Safe while the queue is idle.
   */
  setHooks(hooks: QueueHooks): void {
    this.hooks = hooks;
  }

  /** Number of jobs currently running (≤ capacity). */
  runningCount(): number {
    return this.running.size;
  }

  /** Number of jobs waiting in the queue (not yet running). */
  queuedCount(): number {
    return this.waiting.length;
  }

  /** The configured concurrency cap. */
  capacityCount(): number {
    return this.capacity;
  }

  /**
   * 1-based position a NEW submission would occupy in the waiting line if it
   * cannot start immediately, or 0 when a slot is free (it will start at once).
   * Used to compute the `queuePosition` returned in the 202 response.
   */
  nextQueuePosition(): number {
    if (this.running.size < this.capacity) return 0;
    return this.waiting.length + 1;
  }

  /**
   * Admit a job. It either starts immediately (a slot is free) or joins the
   * FIFO tail. Returns the `queuePosition` it was admitted at (0 = started now).
   * The returned promise resolves with the terminal status when the job finishes.
   *
   * NOTE: admission is unconditional here — the 429 backstop (Decision 6) is
   * enforced by the caller BEFORE submit, using `queuedCount()` vs maxQueueDepth.
   */
  submit(job: QueuedJob): { queuePosition: number; done: Promise<JobStatus> } {
    const queuePosition = this.nextQueuePosition();
    const done = new Promise<JobStatus>((resolve) => {
      this.waiting.push({ job, resolve });
    });
    this.pump();
    return { queuePosition, done };
  }

  /** Admit a job already known to be `queued` (e.g. re-admitted on boot). */
  readmit(job: QueuedJob): Promise<JobStatus> {
    return this.submit(job).done;
  }

  /** Drain the queue: start as many waiting jobs as free slots allow (FIFO). */
  private pump(): void {
    while (this.running.size < this.capacity && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.run(next);
    }
  }

  private run(entry: Waiting): void {
    const { job, resolve } = entry;
    this.running.add(job.id);
    try {
      this.hooks.onStart?.(job);
    } catch {
      /* hook failures must never break the queue */
    }

    // Run the injected executor. Normalise every resolution/rejection into a
    // single terminal transition so a job can never hang as `running`.
    void Promise.resolve()
      .then(() => this.executor(job))
      .then(
        (outcome) => {
          const status = (outcome && outcome.status) || 'completed';
          this.finish(job, resolve, status, outcome ? outcome.result : undefined);
        },
        (err) => {
          // A thrown/rejected executor → the worker crashed. Capture the reason.
          const reason = err instanceof Error ? err.message : String(err);
          this.finish(job, resolve, 'crashed', { error: reason });
        },
      );
  }

  private finish(
    job: QueuedJob,
    resolve: (status: JobStatus) => void,
    status: JobStatus,
    result: unknown,
  ): void {
    this.running.delete(job.id);
    try {
      this.hooks.onTerminal?.(job, status, result);
    } catch {
      /* hook failures must never break the queue */
    }
    resolve(status);
    // A slot just freed — admit the next waiting job.
    this.pump();
  }
}
