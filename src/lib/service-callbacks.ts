// src/lib/service-callbacks.ts
// AF-53 / AF-57: generic completion callbacks for `af serve`.
//
// Design §5.2 + §5.4 ③/④: when a job was submitted WITH a `callback_url`, then on
// EVERY terminal state (completed | failed | crashed | timeout) the service POSTs
// `{ jobId, status, result }` to that URL — exactly once — AFTER the terminal
// `dispatch_jobs` row + `job_event` are persisted (the queue's onTerminal hook does
// that first; this module is invoked from inside/after that hook).
//
// There is NO external/ORA dependency: the contract is AF's own and `callback_url`
// is OPTIONAL. Jobs without one simply remain retrievable via GET /jobs/:id (AF-56).
//
// Reliability invariants (AF-57 acceptance):
//   - exactly once per job: a per-job guard set means a job can never deliver twice,
//     even if onTerminal were ever to fire again;
//   - no hang: a killed/timed-out/crashed worker still resolves to a terminal state
//     in the queue (job-queue.ts normalises every rejection to `crashed`), so this
//     hook always runs; each HTTP attempt is bounded by a request timeout that
//     aborts the socket, so a black-hole receiver cannot hang the dispatcher;
//   - never throws out of the hook: all delivery work runs on a detached promise and
//     every error is caught — a failed callback must not crash the service or the job;
//   - never silently dropped: success appends a `callback_sent` job_event; exhausted
//     retries append a `callback_failed` job_event AND log to stderr.
//
// Uses only Node built-in `http`/`https` — no new dependency.

import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';

import type { ServiceDb } from './service-db.js';

/** The terminal payload POSTed to a job's callback_url (design §5.2). */
export interface CallbackPayload {
  jobId: string;
  status: string;
  result: unknown;
}

/** Tunable delivery policy. Defaults are production-sane; tests shorten them. */
export interface CallbackConfig {
  /** Total attempts per delivery (1 = no retry). Default 4. */
  maxAttempts?: number;
  /** Base backoff in ms between attempts; grows linearly per attempt. Default 500. */
  backoffMs?: number;
  /** Per-attempt socket timeout in ms before the request is aborted. Default 10000. */
  timeoutMs?: number;
}

const DEFAULTS: Required<CallbackConfig> = {
  maxAttempts: 4,
  backoffMs: 500,
  timeoutMs: 10_000,
};

/** Outcome of a single HTTP attempt. */
interface AttemptResult {
  ok: boolean;
  /** HTTP status code when a response was received, else undefined. */
  status?: number;
  /** Failure reason for a transport error / non-2xx. */
  error?: string;
}

/**
 * Delivers terminal job callbacks. One instance per `af serve` process, wired into
 * the queue's onTerminal hook via JobService. Stateless except for the exactly-once
 * guard set.
 */
export class CallbackDispatcher {
  private readonly db: ServiceDb;
  private readonly cfg: Required<CallbackConfig>;
  /** Job ids for which a callback has already been dispatched (exactly-once). */
  private readonly dispatched = new Set<string>();

  constructor(db: ServiceDb, config: CallbackConfig = {}) {
    this.db = db;
    this.cfg = { ...DEFAULTS, ...config };
  }

  /**
   * Fire the completion callback for a terminal job, if it has a `callback_url`.
   *
   * Synchronous, non-blocking, and total: it never throws and returns immediately
   * after kicking off detached delivery, so it is safe to call straight from the
   * queue's onTerminal hook. A job with no `callbackUrl`, or one already dispatched,
   * is a no-op. Returns true when a delivery was started (a callback URL was present
   * and this is the first terminal fire for the job).
   */
  fire(jobId: string, status: string, callbackUrl: string | null, result: unknown): boolean {
    if (!callbackUrl) return false;
    // Exactly-once guard: a job can only ever start one delivery.
    if (this.dispatched.has(jobId)) return false;
    this.dispatched.add(jobId);

    const payload: CallbackPayload = { jobId, status, result };
    // Detached: delivery (with retries/backoff) must not block or throw into the
    // caller (the terminal hook). All errors are handled inside deliver().
    void this.deliver(jobId, callbackUrl, payload);
    return true;
  }

  /**
   * Attempt delivery up to `maxAttempts`, with linear backoff between tries. On the
   * first 2xx → append `callback_sent` and stop. On exhaustion → append
   * `callback_failed` (with the last error) and log to stderr. Never throws.
   */
  private async deliver(jobId: string, url: string, payload: CallbackPayload): Promise<void> {
    const body = JSON.stringify(payload);
    let last: AttemptResult = { ok: false, error: 'no attempt made' };

    for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
      try {
        last = await this.postOnce(url, body);
      } catch (err) {
        // postOnce is written to resolve, never reject; this is a final backstop.
        last = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      if (last.ok) {
        this.safeAppendEvent(jobId, 'callback_sent', {
          url,
          status: last.status ?? null,
          attempt,
        });
        return;
      }

      // Backoff before the next attempt (skip the wait after the final attempt).
      if (attempt < this.cfg.maxAttempts && this.cfg.backoffMs > 0) {
        await delay(this.cfg.backoffMs * attempt);
      }
    }

    // All attempts exhausted — record, never silently drop.
    const detail = {
      url,
      attempts: this.cfg.maxAttempts,
      status: last.status ?? null,
      error: last.error ?? 'delivery failed',
    };
    this.safeAppendEvent(jobId, 'callback_failed', detail);
    process.stderr.write(
      `[serve] callback delivery failed for job ${jobId} → ${url} after ` +
        `${this.cfg.maxAttempts} attempt(s): ${detail.error}\n`,
    );
  }

  /**
   * A single POST attempt. Resolves with an AttemptResult — it never rejects, so the
   * retry loop can treat every transport error / non-2xx uniformly. The socket is
   * aborted after `timeoutMs` so a non-responding receiver cannot hang the process.
   */
  private postOnce(url: string, body: string): Promise<AttemptResult> {
    return new Promise<AttemptResult>((resolve) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        resolve({ ok: false, error: `invalid callback_url '${url}'` });
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        resolve({ ok: false, error: `unsupported callback protocol '${parsed.protocol}'` });
        return;
      }

      const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
      let settled = false;
      const finish = (r: AttemptResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const req = requestFn(
        parsed,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: this.cfg.timeoutMs,
        },
        (res) => {
          const code = res.statusCode ?? 0;
          // Drain the response so the socket can be reused/closed cleanly.
          res.on('data', () => {});
          res.on('end', () => {
            if (code >= 200 && code < 300) finish({ ok: true, status: code });
            else finish({ ok: false, status: code, error: `non-2xx status ${code}` });
          });
          res.on('error', (err) => finish({ ok: false, status: code, error: err.message }));
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error('callback request timed out'));
      });
      req.on('error', (err) => finish({ ok: false, error: err.message }));

      req.write(body);
      req.end();
    });
  }

  /** Append a job_event without ever throwing out of the delivery path. */
  private safeAppendEvent(jobId: string, event: string, detail: unknown): void {
    try {
      this.db.appendJobEvent({ jobId, event, detail: JSON.stringify(detail) });
    } catch (err) {
      process.stderr.write(
        `[serve] failed to record ${event} job_event for ${jobId}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
