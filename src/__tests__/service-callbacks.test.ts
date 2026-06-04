/**
 * AF-57: Completion callbacks on every terminal state.
 *
 * Covers (design §5.2 / §5.4 ③④; ticket acceptance):
 *   - callback fires on all four terminal states (completed|failed|crashed|timeout);
 *   - payload shape { jobId, status, result }; success delivers `completed` + result;
 *   - exactly-once per job (no double POST);
 *   - killed/crashed/timed-out worker still produces exactly one terminal callback,
 *     with no hang (the queue normalises a rejected executor to `crashed`);
 *   - jobs WITHOUT a callback_url produce no POST and no `callback_sent` event;
 *   - delivery failure (receiver 500 / unreachable) → bounded retries → a
 *     `callback_failed` job_event, never silently dropped;
 *   - a callback receiver error never propagates to crash the job / hook.
 *
 * A tiny local http.createServer on 127.0.0.1:0 (ephemeral port) is the receiver.
 * Retry/backoff are shortened so the suite stays deterministic and fast. Servers
 * and the in-memory DB are cleaned up per test.
 *
 *   npx tsx --test src/__tests__/service-callbacks.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

import { JobQueue, type QueuedJob, type JobOutcome } from '../lib/job-queue.js';
import { JobService } from '../lib/service-jobs.js';
import { ServiceDb } from '../lib/service-db.js';

// ── Receiver: a controllable callback sink ──────────────────────────────────────

interface ReceivedPost {
  body: any;
  url: string;
}

class Receiver {
  readonly received: ReceivedPost[] = [];
  private server: Server;
  /** Per-request status to return; defaults to 200. Mutable per test. */
  respondWith = 200;
  /** If set, the handler throws before responding (simulates receiver error). */
  throwInHandler = false;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<Receiver> {
    const r = new Receiver(undefined as unknown as Server);
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        let body: any = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          /* leave null */
        }
        r.received.push({ body, url: req.url ?? '' });
        if (r.throwInHandler) {
          // Abort the socket without a clean response — exercises the dispatcher's
          // transport-error path. Must never crash the job under test.
          res.destroy();
          return;
        }
        res.writeHead(r.respondWith, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    (r as any).server = server;
    return r;
  }

  url(): string {
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}/cb`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ── Harness: a JobService whose executor we control per job ──────────────────────

const okResolver = (prefix: string) => ({ afPath: `/tmp/projects/${prefix}/.af` });

interface Harness {
  service: JobService;
  db: ServiceDb;
  queue: JobQueue;
  /** Resolves/rejects the running job to drive its terminal outcome. */
  outcomes: Map<string, { resolve: (o: JobOutcome) => void; reject: (e: unknown) => void }>;
}

function makeHarness(callbackConfig = { maxAttempts: 3, backoffMs: 5, timeoutMs: 300 }): Harness {
  const db = new ServiceDb(':memory:');
  const outcomes = new Map<string, any>();
  const queue = new JobQueue({
    capacity: 10,
    executor: (job: QueuedJob) =>
      new Promise<JobOutcome>((resolve, reject) => {
        outcomes.set(job.id, { resolve, reject });
      }),
  });
  const service = new JobService({ db, queue, resolveProjectFn: okResolver, callbackConfig });
  service.configureBackstop(500);
  queue.setHooks(service.registryHooks());
  return { service, db, queue, outcomes };
}

/** Submit a job directly through the service's POST handler with an optional callback_url. */
async function submit(h: Harness, callbackUrl?: string): Promise<string> {
  const body: Record<string, unknown> = {
    kind: 'agent',
    objective: 'do the thing',
    project: 'demo',
  };
  if (callbackUrl) body.callback_url = callbackUrl;

  const req: any = mkReq(body);
  const res: any = mkRes();
  const p = h.service.handlePost(req, res);
  req.fire();
  await p;
  return res.json().id as string;
}

// Minimal req/res mocks (mirrors job-queue.test.ts).
function mkReq(body: unknown) {
  const listeners: Record<string, Function[]> = {};
  const payload = JSON.stringify(body);
  return {
    method: 'POST',
    url: '/jobs',
    headers: {},
    on(ev: string, cb: Function) {
      (listeners[ev] ??= []).push(cb);
      return this;
    },
    fire() {
      (listeners['data'] ?? []).forEach((cb) => cb(Buffer.from(payload, 'utf-8')));
      (listeners['end'] ?? []).forEach((cb) => cb());
    },
  };
}
function mkRes() {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(s: number) {
      this.statusCode = s;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      return this;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

/** Spin the event loop until `pred()` is true or a deadline elapses. */
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function eventsOf(db: ServiceDb, jobId: string): string[] {
  return db.listJobEvents(jobId).map((e) => e.event);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AF-57 completion callbacks', () => {
  let receiver: Receiver;
  let harness: Harness;

  beforeEach(async () => {
    receiver = await Receiver.start();
    harness = makeHarness();
  });

  afterEach(async () => {
    await receiver.stop();
    harness.db.close();
  });

  it('fires on `completed` with payload { jobId, status, result } and records callback_sent', async () => {
    const id = await submit(harness, receiver.url());
    harness.outcomes.get(id)!.resolve({ status: 'completed', result: { answer: 42 } });

    await until(() => receiver.received.length === 1);
    const post = receiver.received[0];
    assert.equal(post.url, '/cb');
    assert.deepEqual(post.body, { jobId: id, status: 'completed', result: { answer: 42 } });

    await until(() => eventsOf(harness.db, id).includes('callback_sent'));
    // The terminal job_event is persisted BEFORE the callback (design §5.4 ③).
    const events = eventsOf(harness.db, id);
    assert.ok(events.indexOf('completed') < events.indexOf('callback_sent'));
  });

  for (const status of ['failed', 'timeout'] as const) {
    it(`fires on \`${status}\` (executor-reported terminal state)`, async () => {
      const id = await submit(harness, receiver.url());
      harness.outcomes.get(id)!.resolve({ status, result: { note: status } });

      await until(() => receiver.received.length === 1);
      assert.deepEqual(receiver.received[0].body, {
        jobId: id,
        status,
        result: { note: status },
      });
      await until(() => eventsOf(harness.db, id).includes('callback_sent'));
    });
  }

  it('fires exactly one `crashed` callback when the worker rejects — no hang', async () => {
    const id = await submit(harness, receiver.url());
    // Simulate a killed/crashed worker: the executor promise rejects. The queue
    // normalises this to a terminal `crashed`, so the callback must still fire once.
    harness.outcomes.get(id)!.reject(new Error('worker killed'));

    await until(() => receiver.received.length === 1);
    assert.equal(receiver.received[0].body.status, 'crashed');
    assert.equal(receiver.received[0].body.jobId, id);

    // Give the loop room to (incorrectly) double-fire, then assert it did not.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(receiver.received.length, 1, 'callback must fire exactly once');
    assert.equal(harness.db.getJob(id)!.status, 'crashed');
  });

  it('does NOT fire when the job has no callback_url (result still retrievable)', async () => {
    const id = await submit(harness); // no callback_url
    harness.outcomes.get(id)!.resolve({ status: 'completed', result: { x: 1 } });

    await until(() => harness.db.getJob(id)!.status === 'completed');
    // No POST and no callback_* events.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(receiver.received.length, 0);
    const events = eventsOf(harness.db, id);
    assert.ok(!events.includes('callback_sent'));
    assert.ok(!events.includes('callback_failed'));
    // Result is still retrievable via the registry (GET /jobs/:id).
    assert.equal(harness.db.getJob(id)!.result, JSON.stringify({ x: 1 }));
  });

  it('retries on receiver 500 then records callback_failed (never silently dropped)', async () => {
    receiver.respondWith = 500;
    const id = await submit(harness, receiver.url());
    harness.outcomes.get(id)!.resolve({ status: 'completed', result: 'r' });

    await until(() => eventsOf(harness.db, id).includes('callback_failed'), 3000);
    // maxAttempts = 3 → the receiver saw three POSTs before giving up.
    assert.equal(receiver.received.length, 3);
    const failed = harness.db.listJobEvents(id).find((e) => e.event === 'callback_failed')!;
    const detail = JSON.parse(failed.detail!);
    assert.equal(detail.attempts, 3);
    assert.equal(detail.status, 500);
    assert.ok(!eventsOf(harness.db, id).includes('callback_sent'));
  });

  it('records callback_failed when the receiver is unreachable (no hang, job unaffected)', async () => {
    // Point at a closed port: connection refused on every attempt.
    const closed = await Receiver.start();
    const deadUrl = closed.url();
    await closed.stop();

    const id = await submit(harness, deadUrl);
    harness.outcomes.get(id)!.resolve({ status: 'completed', result: 'r' });

    await until(() => eventsOf(harness.db, id).includes('callback_failed'), 3000);
    // The job itself reached its terminal state regardless of delivery failure.
    assert.equal(harness.db.getJob(id)!.status, 'completed');
  });

  it('a receiver error never propagates to crash the job or the hook', async () => {
    receiver.throwInHandler = true;
    const id = await submit(harness, receiver.url());
    // The terminal hook fires the callback; the receiver aborts the socket. The job
    // must still be recorded terminal and the dispatcher must record callback_failed.
    harness.outcomes.get(id)!.resolve({ status: 'completed', result: 'r' });

    await until(() => harness.db.getJob(id)!.status === 'completed');
    await until(() => eventsOf(harness.db, id).includes('callback_failed'), 3000);
    assert.equal(harness.db.getJob(id)!.status, 'completed');
  });
});
