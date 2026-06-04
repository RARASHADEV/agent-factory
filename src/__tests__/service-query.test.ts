/**
 * AF-59: Tests for the query plane (read-only · synchronous · NEVER queued).
 *
 * Routes (design §4): GET /projects, /projects/:p/status, /projects/:p/tasks,
 * /tasks/:ticket, /agents, /agents/:slug, /pipelines, /pipelines/:ticket.
 *
 * Coverage:
 *   - PARITY (design test 7): a representative route returns the SAME data as the
 *     equivalent core op the `af` CLI calls — both go through one engine.
 *   - UNQUEUED (design test 6): GET /projects answers immediately while the queue
 *     is saturated with running jobs — it never touches the JobService.
 *   - 401: auth enforced (no bearer → handler never runs).
 *   - 400: project-scoped routes reject an unknown project (ProjectNotFoundError).
 *   - 404: unknown ticket / agent slug / pipeline run.
 *
 * Socket-free: the real router/dispatch is exercised with mock req/res over a temp
 * SQLite DB (never the real ~/.af/service.db). Run:
 *   npx tsx --test src/__tests__/service-query.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ServiceDb, openServiceDb } from '../lib/service-db.js';
import { buildRouter, dispatch } from '../commands/serve.js';
import { JobService } from '../lib/service-jobs.js';
import { JobQueue } from '../lib/job-queue.js';
import type { ResolvedServiceConfig } from '../lib/service-config.js';

import { listProjectsSummary } from '../lib/core/projects.js';
import { listAgents } from '../lib/core/agents.js';

// ── Mock req/res (mirrors service-audit.test.ts) ─────────────────────────────

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  body = '';
  headersSent = false;
  writeHead(status: number, headers?: Record<string, unknown>) {
    this.statusCode = status;
    if (headers) this.headers = headers;
    this.headersSent = true;
    return this;
  }
  end(chunk?: string | Buffer) {
    if (typeof chunk === 'string') this.body += chunk;
    else if (Buffer.isBuffer(chunk)) this.body += chunk.toString('utf-8');
    return this;
  }
}

function mockReq(
  method: string,
  url: string,
  headers: Record<string, unknown> = {},
): any {
  const r = Readable.from([]) as any;
  r.method = method;
  r.url = url;
  r.headers = headers;
  return r;
}

const SECRET = 'query-secret';
const AUTH = { authorization: `Bearer ${SECRET}` };

function cfg(over: Partial<ResolvedServiceConfig> = {}): ResolvedServiceConfig {
  return {
    secret: SECRET,
    port: 4150,
    allowPublic: false,
    maxConcurrency: 20,
    maxQueueDepth: 500,
    db: ':memory:',
    retentionDays: 0,
    ...over,
  };
}

/**
 * A JobService over `db` whose executor holds every job "running" behind a gate
 * we release manually — so we can saturate the queue and observe in-flight state.
 */
function makeSaturatedJobs(db: ServiceDb) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const queue = new JobQueue({
    capacity: 20,
    executor: async () => {
      await gate;
      return { status: 'completed' };
    },
    hooks: {},
  });
  const service = new JobService({
    db,
    queue,
    resolveProjectFn: (p) => (p === 'af' ? { afPath: join(tmpdir(), 'af') } : null),
  });
  service.configureBackstop(500);
  queue.setHooks(service.registryHooks());
  return { service, release, queue };
}

let dir: string;
let db: ServiceDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-query-'));
  db = openServiceDb(join(dir, 'service.db'));
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

/** Dispatch a GET and return the MockRes. */
async function get(url: string, headers: Record<string, unknown> = AUTH, jobs?: JobService) {
  const routes = buildRouter(jobs as any, db);
  const res = new MockRes();
  await dispatch(routes, mockReq('GET', url, headers), res as any, cfg(), jobs as any, db);
  return res;
}

// ── PARITY (design test 7) — route data === core op data ─────────────────────

describe('query plane: parity with the af CLI core op (design test 7)', () => {
  it('GET /projects returns exactly listProjectsSummary()', async () => {
    // Both the route and the CLI call the SAME core op, so the bytes must match.
    // listProjectsSummary() reads the live workspace (task counts), which other
    // test files in the concurrent suite can mutate. Bracket the request with two
    // core-op snapshots and accept a match to either — this proves byte-parity with
    // the shared engine while absorbing a concurrent workspace write landing mid-request.
    const before = await listProjectsSummary();
    const res = await get('/projects');
    assert.equal(res.statusCode, 200);
    const after = await listProjectsSummary();
    const body = JSON.parse(res.body);
    const matches =
      JSON.stringify(body) === JSON.stringify(before) ||
      JSON.stringify(body) === JSON.stringify(after);
    assert.ok(
      matches,
      `GET /projects body did not match listProjectsSummary() before/after the request.\nbody:   ${res.body}\nbefore: ${JSON.stringify(before)}\nafter:  ${JSON.stringify(after)}`,
    );
  });

  it('GET /agents returns exactly listAgents()', async () => {
    const res = await get('/agents');
    assert.equal(res.statusCode, 200);
    const expected = listAgents();
    assert.deepEqual(JSON.parse(res.body), JSON.parse(JSON.stringify(expected)));
  });
});

// ── UNQUEUED (design test 6) — sync even while the queue is saturated ─────────

describe('query plane: unqueued (design test 6)', () => {
  it('GET /projects answers immediately while 20 jobs are running', async () => {
    const { service, release, queue } = makeSaturatedJobs(db);
    // Saturate: admit 20 jobs that block on the gate (capacity = 20).
    for (let i = 0; i < 20; i++) {
      queue.submit({
        id: `job-${i}`,
        kind: 'agent',
        project: 'af',
        role: null,
        objective: `job-${i}`,
        outputDir: join(dir, `job-${i}`),
      });
    }
    assert.equal(queue.runningCount(), 20, 'queue is saturated with running jobs');

    // The read route must NOT wait behind the queue — it never touches JobService.
    const res = await get('/projects', AUTH, service);
    assert.equal(res.statusCode, 200);
    // Still saturated — the query did not enqueue anything.
    assert.equal(queue.runningCount(), 20);
    assert.equal(queue.queuedCount(), 0);

    release();
  });
});

// ── AUTH (401) ────────────────────────────────────────────────────────────────

describe('query plane: auth enforced (401)', () => {
  it('GET /projects without a bearer → 401', async () => {
    const res = await get('/projects', {});
    assert.equal(res.statusCode, 401);
  });

  it('GET /agents with a wrong bearer → 401', async () => {
    const res = await get('/agents', { authorization: 'Bearer nope' });
    assert.equal(res.statusCode, 401);
  });

  it('a dynamic query route also requires auth', async () => {
    const res = await get('/projects/GHOST/status', {});
    assert.equal(res.statusCode, 401);
  });
});

// ── PROJECT GUARDRAIL (400) ──────────────────────────────────────────────────

describe('query plane: unknown project → 400 (§6 guardrail)', () => {
  it('GET /projects/:p/status with an unknown project → 400', async () => {
    const res = await get('/projects/NOSUCHPROJECT/status');
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  it('GET /projects/:p/tasks with an unknown project → 400', async () => {
    const res = await get('/projects/NOSUCHPROJECT/tasks?status=open');
    assert.equal(res.statusCode, 400);
  });

});

// ── 404 — unknown agent slug ─────────────────────────────────────────────────

describe('query plane: unknown resource → 404', () => {
  it('GET /agents/:slug for a non-existent slug → 404', async () => {
    const res = await get('/agents/definitely-not-an-agent-xyz');
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  it('GET /pipelines/:ticket with no run for the ticket → 404', async () => {
    // The test runner's cwd is itself an AF project, so the project resolves; the
    // ticket simply has no pipeline run on disk → 404 (not a 400 guardrail).
    const res = await get('/pipelines/NO-SUCH-RUN-1');
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).ok, false);
  });
});

// ── audit registration — query routes are journaled ──────────────────────────

describe('query plane: routes are audit-journaled', () => {
  it('GET /projects writes a request_log row on the query plane', async () => {
    await get('/projects');
    const rows = db.listRequestLog({ plane: 'query' });
    const projectsRow = rows.find((r) => r.path === '/projects');
    assert.ok(projectsRow, 'GET /projects journaled');
    assert.equal(projectsRow!.operation, 'projects.list');
    assert.equal(projectsRow!.status, 200);
    assert.equal(projectsRow!.outcome, 'ok');
  });

  it('a dynamic query route resolves its operation in the journal', async () => {
    await get('/agents/definitely-not-an-agent-xyz');
    const rows = db.listRequestLog({ plane: 'query' });
    const row = rows.find((r) => r.path === '/agents/definitely-not-an-agent-xyz');
    assert.ok(row);
    assert.equal(row!.operation, 'agents.show');
    assert.equal(row!.status, 404);
    assert.equal(row!.outcome, 'rejected');
  });
});
