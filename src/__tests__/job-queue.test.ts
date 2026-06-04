/**
 * AF-56: Unit tests for the global concurrency queue + execution-plane handlers.
 *
 * Covers (design §5.1, §5.3, §6, Decisions 1/3/6; ticket acceptance + Tests):
 *   - concurrency cap: submit N with cap=k, assert ≤k run simultaneously, all complete;
 *   - FIFO admission + queuePosition;
 *   - project guardrail → 400, nothing enqueued (§6);
 *   - 429 backstop at maxQueueDepth, nothing enqueued, in-flight unaffected (Decision 6);
 *   - 202 { id, status:"queued", queuePosition };
 *   - GET /jobs/:id + GET /jobs?project=&status= list filtering;
 *   - terminal-state persistence (success + failure/crash), no stuck `running`;
 *   - re-admit-queued-on-boot.
 *
 * No real agents are spawned: a fake executor controls timing, and an in-memory
 * SQLite DB (':memory:') backs the registry. Run:
 *   npx tsx --test src/__tests__/job-queue.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

import { JobQueue, type QueuedJob, type JobOutcome } from '../lib/job-queue.js';
import { JobService } from '../lib/service-jobs.js';
import { ServiceDb } from '../lib/service-db.js';

// ── HTTP mocks ────────────────────────────────────────────────────────────────

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  body = '';
  headersSent = false;
  writeHead(status: number, headers: Record<string, unknown>) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  end(chunk?: string) {
    if (chunk) this.body += chunk;
    return this;
  }
  json(): any {
    return JSON.parse(this.body);
  }
}

/** A mock IncomingMessage that streams a JSON body. */
class MockReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, unknown> = {};
  private payload: string;
  constructor(method: string, url: string, body?: unknown) {
    super();
    this.method = method;
    this.url = url;
    this.payload = body === undefined ? '' : JSON.stringify(body);
  }
  // The handler attaches data/end listeners synchronously, then we emit.
  fire() {
    if (this.payload) this.emit('data', Buffer.from(this.payload, 'utf-8'));
    this.emit('end');
  }
}

function postJobs(service: JobService, body: unknown): Promise<MockRes> {
  const req = new MockReq('POST', '/jobs', body);
  const res = new MockRes();
  const p = service.handlePost(req as any, res as any);
  req.fire();
  return p.then(() => res);
}

const okResolver = (prefix: string) => ({ afPath: `/tmp/projects/${prefix}/.af` });

function newDb(): ServiceDb {
  return new ServiceDb(':memory:');
}

const deferred = () => {
  let resolve!: (v?: unknown) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res as any;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// ── Queue: concurrency cap (Decision 1, acceptance: ≤cap run, all complete) ────

describe('JobQueue concurrency', () => {
  it('never runs more than `capacity` at once; all jobs complete (FIFO)', async () => {
    const cap = 3;
    const total = 12;
    let running = 0;
    let maxRunning = 0;
    const gates = Array.from({ length: total }, () => deferred());

    const queue = new JobQueue({
      capacity: cap,
      executor: async (job): Promise<JobOutcome> => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        const idx = Number(job.id);
        await gates[idx].promise;
        running--;
        return { status: 'completed' };
      },
    });

    const dones: Promise<unknown>[] = [];
    const positions: number[] = [];
    for (let i = 0; i < total; i++) {
      const { queuePosition, done } = queue.submit(mkJob(String(i)));
      positions.push(queuePosition);
      dones.push(done);
    }

    // Exactly `cap` should be running now; the rest waiting.
    assert.equal(queue.runningCount(), cap);
    assert.equal(queue.queuedCount(), total - cap);

    // First `cap` admitted immediately (position 0); rest get 1..n FIFO.
    assert.deepEqual(positions.slice(0, cap), [0, 0, 0]);
    assert.deepEqual(positions.slice(cap), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Release gates one at a time; cap is never exceeded.
    for (let i = 0; i < total; i++) {
      gates[i].resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.ok(maxRunning <= cap, `maxRunning ${maxRunning} exceeded cap ${cap}`);
    }

    await Promise.all(dones);
    assert.equal(queue.runningCount(), 0);
    assert.equal(queue.queuedCount(), 0);
    assert.ok(maxRunning <= cap);
    assert.ok(maxRunning >= 1);
  });

  it('a thrown executor becomes terminal `crashed`, never stuck running', async () => {
    const queue = new JobQueue({
      capacity: 1,
      executor: async () => {
        throw new Error('boom');
      },
    });
    const status = await queue.readmit(mkJob('x'));
    assert.equal(status, 'crashed');
    assert.equal(queue.runningCount(), 0);
  });

  it('executor may report an explicit terminal status', async () => {
    const queue = new JobQueue({
      capacity: 1,
      executor: async () => ({ status: 'failed', result: { why: 'soft fail' } }),
    });
    const status = await queue.readmit(mkJob('y'));
    assert.equal(status, 'failed');
  });
});

function mkJob(id: string): QueuedJob {
  return {
    id,
    kind: 'agent',
    project: 'AF',
    role: 'engineer',
    objective: 'do a thing',
    outputDir: `/tmp/${id}`,
  };
}

// ── JobService: POST /jobs validation + 202 + persistence ─────────────────────

describe('JobService POST /jobs', () => {
  function buildService(opts?: {
    capacity?: number;
    maxQueueDepth?: number;
    executor?: (job: QueuedJob) => Promise<JobOutcome | void>;
    resolver?: (p: string) => { afPath: string } | null;
  }) {
    const db = newDb();
    const queue = new JobQueue({
      capacity: opts?.capacity ?? 2,
      executor: opts?.executor ?? (async () => ({ status: 'completed' })),
    });
    const service = new JobService({
      db,
      queue,
      resolveProjectFn: opts?.resolver ?? okResolver,
    });
    queue.setHooks(service.registryHooks());
    service.configureBackstop(opts?.maxQueueDepth ?? 500);
    return { db, queue, service };
  }

  it('valid request → 202 { id, status:"queued", queuePosition } and a queued row', async () => {
    // Block the executor so the row is observable mid-flight.
    const gate = deferred();
    const { db, service } = buildService({ capacity: 1, executor: async () => gate.promise as any });
    const res = await postJobs(service, {
      kind: 'agent',
      project: 'AF',
      role: 'engineer',
      objective: 'build it',
    });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.status, 'queued');
    assert.equal(typeof body.id, 'string');
    assert.equal(body.queuePosition, 0); // slot was free
    // A registry row exists (running, since the single slot admitted it).
    const row = db.getJob(body.id);
    assert.ok(row);
    assert.equal(row!.kind, 'agent');
    assert.equal(row!.project, 'AF');
    gate.resolve();
  });

  it('second submission past capacity gets queuePosition 1', async () => {
    const gate = deferred();
    const { service } = buildService({ capacity: 1, executor: async () => gate.promise as any });
    const r1 = await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: 'a' });
    const r2 = await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: 'b' });
    assert.equal(r1.json().queuePosition, 0);
    assert.equal(r2.json().queuePosition, 1);
    gate.resolve();
  });

  it('missing project → 400 "unknown project", nothing enqueued (§6)', async () => {
    const { queue, db, service } = buildService();
    const res = await postJobs(service, { kind: 'agent', objective: 'x', role: 'r' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /unknown project/);
    assert.equal(queue.queuedCount(), 0);
    assert.equal(queue.runningCount(), 0);
    assert.equal(db.listJobs().length, 0);
  });

  it('unknown project (resolver returns null) → 400, nothing enqueued (§6)', async () => {
    const { db, service } = buildService({ resolver: () => null });
    const res = await postJobs(service, { kind: 'agent', project: 'NOPE', objective: 'x', role: 'r' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /unknown project 'NOPE'/);
    assert.equal(db.listJobs().length, 0);
  });

  it('invalid kind → 400', async () => {
    const { service } = buildService();
    const res = await postJobs(service, { kind: 'wat', project: 'AF', objective: 'x' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /invalid kind/);
  });

  it('missing objective → 400', async () => {
    const { service } = buildService();
    const res = await postJobs(service, { kind: 'agent', project: 'AF', role: 'r' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /objective/);
  });

  it('429 backstop when waiting depth ≥ maxQueueDepth; nothing enqueued; in-flight unaffected', async () => {
    // cap=1, depth ceiling=2. One runs, two wait → next POST is rejected.
    const gate = deferred();
    const { queue, db, service } = buildService({
      capacity: 1,
      maxQueueDepth: 2,
      executor: async () => gate.promise as any,
    });
    // 1 admitted (running), then 2 queued → waiting count = 2 = ceiling.
    await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: '1' });
    await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: '2' });
    await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: '3' });
    assert.equal(queue.runningCount(), 1);
    assert.equal(queue.queuedCount(), 2);
    const totalBefore = db.listJobs().length;

    const res = await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: '4' });
    assert.equal(res.statusCode, 429);
    assert.equal(typeof res.json().retryAfter, 'number');
    assert.match(res.json().error, /full/);
    // Nothing enqueued by the rejected request; in-flight unaffected.
    assert.equal(queue.queuedCount(), 2);
    assert.equal(queue.runningCount(), 1);
    assert.equal(db.listJobs().length, totalBefore);
    gate.resolve();
  });
});

// ── JobService: terminal-state persistence ────────────────────────────────────

describe('JobService terminal persistence', () => {
  it('success path → status completed, started/completed timestamps, job_events', async () => {
    const db = newDb();
    const queue = new JobQueue({
      capacity: 1,
      executor: async () => ({ status: 'completed', result: { ok: true } }),
    });
    const service = new JobService({ db, queue, resolveProjectFn: okResolver });
    queue.setHooks(service.registryHooks());

    const res = await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: 'a' });
    const id = res.json().id;
    // Let the queue drain.
    await new Promise((r) => setTimeout(r, 10));

    const row = db.getJob(id)!;
    assert.equal(row.status, 'completed');
    assert.ok(row.startedAt && row.completedAt);
    assert.match(row.result ?? '', /ok/);

    const events = db.listJobEvents(id).map((e) => e.event);
    assert.deepEqual(events, ['queued', 'started', 'completed']);
  });

  it('crash path (executor throws) → status crashed, never stuck running', async () => {
    const db = newDb();
    const queue = new JobQueue({
      capacity: 1,
      executor: async () => {
        throw new Error('worker died');
      },
    });
    const service = new JobService({ db, queue, resolveProjectFn: okResolver });
    queue.setHooks(service.registryHooks());

    const res = await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: 'a' });
    const id = res.json().id;
    await new Promise((r) => setTimeout(r, 10));

    const row = db.getJob(id)!;
    assert.equal(row.status, 'crashed');
    assert.ok(row.completedAt);
    assert.equal(queue.runningCount(), 0);
    assert.match(row.result ?? '', /worker died/);
    const events = db.listJobEvents(id).map((e) => e.event);
    assert.deepEqual(events, ['queued', 'started', 'crashed']);
  });
});

// ── JobService: GET /jobs/:id + list filtering ────────────────────────────────

describe('JobService GET /jobs', () => {
  function build() {
    const db = newDb();
    const queue = new JobQueue({ capacity: 5, executor: async () => ({ status: 'completed' }) });
    const service = new JobService({ db, queue, resolveProjectFn: okResolver });
    queue.setHooks(service.registryHooks());
    return { db, queue, service };
  }

  it('GET /jobs/:id returns the row, 404 for unknown', async () => {
    const { service } = build();
    const res = await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: 'a' });
    const id = res.json().id;
    await new Promise((r) => setTimeout(r, 10));

    const one = new MockRes();
    service.handleGetOne(one as any, id);
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().id, id);

    const miss = new MockRes();
    service.handleGetOne(miss as any, 'does-not-exist');
    assert.equal(miss.statusCode, 404);
  });

  it('GET /jobs?project=&status= filters', async () => {
    const { service } = build();
    await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: 'a' });
    await postJobs(service, { kind: 'orchestration', project: 'RR', role: 'd', objective: 'b' });
    await new Promise((r) => setTimeout(r, 10));

    const byProject = new MockRes();
    service.handleList(byProject as any, new URLSearchParams('project=AF'));
    const afJobs = byProject.json().jobs;
    assert.equal(afJobs.length, 1);
    assert.equal(afJobs[0].project, 'AF');

    const byStatus = new MockRes();
    service.handleList(byStatus as any, new URLSearchParams('status=completed'));
    assert.equal(byStatus.json().jobs.length, 2);

    const none = new MockRes();
    service.handleList(none as any, new URLSearchParams('status=running'));
    assert.equal(none.json().jobs.length, 0);
  });
});

// ── JobService: pause/resume control ──────────────────────────────────────────

describe('JobService pipeline control', () => {
  function build(pipelineControl?: any) {
    const db = newDb();
    const queue = new JobQueue({ capacity: 5, executor: async () => new Promise(() => {}) });
    const service = new JobService({ db, queue, resolveProjectFn: okResolver, pipelineControl });
    queue.setHooks(service.registryHooks());
    return { db, queue, service };
  }

  it('pause/resume on a non-pipeline kind → 409', async () => {
    const { service } = build(async () => 'queued');
    const res = await postJobs(service, { kind: 'agent', project: 'AF', role: 'r', objective: 'a' });
    const id = res.json().id;
    const ctl = new MockRes();
    await service.handleControl(ctl as any, id, 'pause');
    assert.equal(ctl.statusCode, 409);
  });

  it('pause on a pipeline → calls the wired control and returns its status', async () => {
    let called: string | undefined;
    const { service } = build(async (action: 'pause' | 'resume') => {
      called = action;
      return 'queued';
    });
    const res = await postJobs(service, { kind: 'pipeline', project: 'AF', name: 'release', objective: 'a' });
    const id = res.json().id;
    const ctl = new MockRes();
    await service.handleControl(ctl as any, id, 'pause');
    assert.equal(called, 'pause');
    assert.equal(ctl.statusCode, 200);
    assert.equal(ctl.json().status, 'queued');
  });

  it('control on unknown id → 404', async () => {
    const { service } = build(async () => 'queued');
    const ctl = new MockRes();
    await service.handleControl(ctl as any, 'nope', 'resume');
    assert.equal(ctl.statusCode, 404);
  });

  it('pipeline control absent → 501', async () => {
    const { service } = build(undefined);
    const res = await postJobs(service, { kind: 'pipeline', project: 'AF', name: 'p', objective: 'a' });
    const id = res.json().id;
    const ctl = new MockRes();
    await service.handleControl(ctl as any, id, 'pause');
    assert.equal(ctl.statusCode, 501);
  });
});

// ── Re-admit queued on boot (design test 5) ───────────────────────────────────

describe('JobService re-admit on boot', () => {
  it('rows left `queued` are re-admitted into the in-process queue and run', async () => {
    // Seed a DB with two `queued` rows (as a prior process / reconcile would leave).
    const db = newDb();
    for (const id of ['j1', 'j2']) {
      db.insertJob({
        id,
        kind: 'agent',
        project: 'AF',
        role: 'engineer',
        objective: 'resume me',
        status: 'queued',
        outputDir: `/tmp/${id}`,
      });
    }

    const ran: string[] = [];
    const queue = new JobQueue({
      capacity: 5,
      executor: async (job) => {
        ran.push(job.id);
        return { status: 'completed' };
      },
    });
    const service = new JobService({ db, queue, resolveProjectFn: okResolver });
    queue.setHooks(service.registryHooks());

    const n = service.readmitQueued();
    assert.equal(n, 2);
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(ran.sort(), ['j1', 'j2']);
    assert.equal(db.getJob('j1')!.status, 'completed');
    assert.equal(db.getJob('j2')!.status, 'completed');
  });
});
