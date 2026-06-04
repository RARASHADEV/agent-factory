/**
 * AF-69: Tests for the log-first / log-last audit middleware + GET /audit.
 *
 * Two layers:
 *   - PURE: the strip/serialize, route→{plane,operation} mapping, caller derivation,
 *     and outcome classification — unit-tested without a socket or DB.
 *   - DISPATCH: a temp SQLite DB + the real router/dispatch, asserting:
 *       · log-first writes a request_log row BEFORE the handler runs (and before a
 *         response_at exists), then log-last fills status/outcome/responded_at;
 *       · rejected requests (401 missing auth, 400 unknown project, 429 queue full)
 *         still produce a request_log row;
 *       · payload secret-stripping (bearer + secret-ish fields never persisted);
 *       · GET /audit filters by plane/caller/project/since/op/limit and requires auth;
 *       · execution log links request_log.job_id to the created job.
 *
 * Temp DB under os.tmpdir() (never the real ~/.af/service.db). Socket-free: the
 * router/dispatch is exercised with mock req/res, with one in-flight ordering check
 * via a handler hook. Run: npx tsx --test src/__tests__/service-audit.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  stripSecrets,
  serializePayload,
  resolveAuditMeta,
  matchDynamicAuditMeta,
  deriveCaller,
  classifyOutcome,
  summarize,
  bufferBody,
  takeBufferedBody,
  AUDIT_ROUTES,
} from '../lib/service-audit.js';
import { ServiceDb, openServiceDb } from '../lib/service-db.js';
import { buildRouter, dispatch } from '../commands/serve.js';
import { JobService } from '../lib/service-jobs.js';
import { JobQueue } from '../lib/job-queue.js';
import type { ResolvedServiceConfig } from '../lib/service-config.js';

// ── PURE: secret stripping (§9, design test 14) ──────────────────────────────

describe('stripSecrets', () => {
  it('redacts secret-named fields, preserves the rest', () => {
    const out = stripSecrets({
      project: 'af',
      objective: 'do a thing',
      secret: 'sshh',
      apiKey: 'k-123',
      callback_url: 'https://x',
    }) as Record<string, unknown>;
    assert.equal(out.project, 'af');
    assert.equal(out.objective, 'do a thing');
    assert.equal(out.secret, '[REDACTED]');
    assert.equal(out.apiKey, '[REDACTED]');
    // callback_url is not a credential — keep it.
    assert.equal(out.callback_url, 'https://x');
  });

  it('redacts a variety of credential key spellings (case/separator-insensitive)', () => {
    const out = stripSecrets({
      Authorization: 'Bearer xyz',
      access_token: 't',
      API_KEY: 'k',
      password: 'p',
      privateKey: 'pk',
      bearerToken: 'b',
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) assert.equal(v, '[REDACTED]');
  });

  it('recurses into nested objects and arrays', () => {
    const out = stripSecrets({
      opts: { headers: { authorization: 'Bearer z' }, model: 'opus' },
      list: [{ token: 'a' }, { keep: 'b' }],
    }) as any;
    assert.equal(out.opts.headers.authorization, '[REDACTED]');
    assert.equal(out.opts.model, 'opus');
    assert.equal(out.list[0].token, '[REDACTED]');
    assert.equal(out.list[1].keep, 'b');
  });

  it('does not mutate the input', () => {
    const input = { secret: 'live' };
    stripSecrets(input);
    assert.equal(input.secret, 'live');
  });

  it('survives cyclic graphs', () => {
    const a: any = { name: 'a' };
    a.self = a;
    assert.doesNotThrow(() => stripSecrets(a));
  });
});

describe('serializePayload', () => {
  it('empty/undefined body → null', () => {
    assert.equal(serializePayload({}), null);
    assert.equal(serializePayload(undefined), null);
    assert.equal(serializePayload(null), null);
  });

  it('strips secrets in the serialized JSON', () => {
    const json = serializePayload({ project: 'af', secret: 'live-secret' });
    assert.ok(json);
    assert.ok(!json!.includes('live-secret'));
    assert.ok(json!.includes('[REDACTED]'));
    assert.ok(json!.includes('af'));
  });
});

// ── PURE: route → {plane, operation} mapping (extensibility seam) ─────────────

describe('resolveAuditMeta', () => {
  it('maps the known static routes', () => {
    assert.deepEqual(resolveAuditMeta('POST', '/jobs'), { plane: 'execution', operation: 'agent.spawn' });
    assert.deepEqual(resolveAuditMeta('GET', '/jobs'), { plane: 'query', operation: 'jobs.list' });
    assert.deepEqual(resolveAuditMeta('GET', '/audit'), { plane: 'query', operation: 'audit.list' });
    assert.deepEqual(resolveAuditMeta('GET', '/health'), { plane: 'query', operation: 'health.get' });
  });

  it('maps dynamic /jobs/:id routes', () => {
    assert.deepEqual(matchDynamicAuditMeta('GET', '/jobs/abc'), { plane: 'query', operation: 'jobs.get' });
    assert.deepEqual(matchDynamicAuditMeta('POST', '/jobs/abc/pause'), {
      plane: 'execution',
      operation: 'pipeline.control',
    });
    assert.equal(matchDynamicAuditMeta('GET', '/health'), undefined);
  });

  it('unknown routes still resolve (attempt is logged); plane keyed by method', () => {
    assert.deepEqual(resolveAuditMeta('GET', '/nope'), { plane: 'query', operation: 'unknown' });
    assert.deepEqual(resolveAuditMeta('POST', '/nope'), { plane: 'mutation', operation: 'unknown' });
  });

  it('AUDIT_ROUTES is the registry Stage B routes extend', () => {
    assert.ok(AUDIT_ROUTES.has('POST /jobs'));
    assert.ok(AUDIT_ROUTES.has('GET /audit'));
  });
});

describe('deriveCaller', () => {
  it('reads X-AF-Caller / X-AF-Client, else null', () => {
    assert.equal(deriveCaller({ 'x-af-caller': 'chat-1' } as any), 'chat-1');
    assert.equal(deriveCaller({ 'x-af-client': 'clone-2' } as any), 'clone-2');
    assert.equal(deriveCaller({} as any), null);
    assert.equal(deriveCaller({ 'x-af-caller': '  ' } as any), null);
  });
});

describe('classifyOutcome', () => {
  it('202 accepted · 2xx ok · 4xx rejected · 5xx error', () => {
    assert.equal(classifyOutcome(202), 'accepted');
    assert.equal(classifyOutcome(200), 'ok');
    assert.equal(classifyOutcome(401), 'rejected');
    assert.equal(classifyOutcome(400), 'rejected');
    assert.equal(classifyOutcome(429), 'rejected');
    assert.equal(classifyOutcome(500), 'error');
  });
});

describe('summarize', () => {
  it('extracts error / id:status / status from a JSON body', () => {
    assert.equal(summarize(400, JSON.stringify({ error: 'unknown project' })), 'unknown project');
    assert.equal(summarize(202, JSON.stringify({ id: 'J1', status: 'queued' })), 'J1:queued');
    assert.equal(summarize(401, JSON.stringify({ ok: false })), 'status 401');
    assert.equal(summarize(200, ''), null);
  });
});

// ── bufferBody: read-once semantics shared with the handler ───────────────────

describe('bufferBody', () => {
  function bodyReq(method: string, raw: string) {
    const r = Readable.from([Buffer.from(raw, 'utf-8')]) as any;
    r.method = method;
    r.headers = {};
    return r;
  }

  it('parses a POST body and stashes it for reuse', async () => {
    const req = bodyReq('POST', JSON.stringify({ project: 'af' }));
    const parsed = await bufferBody(req);
    assert.deepEqual(parsed, { project: 'af' });
    assert.deepEqual(takeBufferedBody(req), { project: 'af' });
  });

  it('GET carries no body → {}', async () => {
    const req = bodyReq('GET', '');
    assert.deepEqual(await bufferBody(req), {});
  });

  it('invalid JSON → {} (never throws)', async () => {
    const req = bodyReq('POST', '{not json');
    assert.deepEqual(await bufferBody(req), {});
  });
});

// ── DISPATCH: live router + temp DB ──────────────────────────────────────────

/** Mock ServerResponse capturing status + body, with stream-ish API. */
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

/** Build a mock request whose body streams `raw` (for POST). */
function mockReq(
  method: string,
  url: string,
  headers: Record<string, unknown> = {},
  raw = '',
): any {
  const source = method === 'GET' || method === 'HEAD' ? [] : [Buffer.from(raw, 'utf-8')];
  const r = Readable.from(source) as any;
  r.method = method;
  r.url = url;
  r.headers = headers;
  return r;
}

const SECRET = 'audit-secret';
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

/** A JobService over the given DB with a stub project resolver + manual executor. */
function makeJobs(db: ServiceDb, opts: { resolves?: boolean; maxQueueDepth?: number } = {}) {
  const resolves = opts.resolves ?? true;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const queue = new JobQueue({
    capacity: 20,
    executor: async () => {
      await gate; // hold jobs "running" so we can observe in-flight state
      return { status: 'completed' };
    },
    hooks: {},
  });
  const service = new JobService({
    db,
    queue,
    resolveProjectFn: (p) => (resolves && p === 'af' ? { afPath: join(tmpdir(), 'af') } : null),
  });
  service.configureBackstop(opts.maxQueueDepth ?? 500);
  queue.setHooks(service.registryHooks());
  return { service, release };
}

let dir: string;
let db: ServiceDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-audit-'));
  db = openServiceDb(join(dir, 'service.db'));
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('audit middleware: log-first / log-last', () => {
  it('GET /health: writes one row, log-first BEFORE handler, log-last fills outcome', async () => {
    const routes = buildRouter(undefined, db);
    const res = new MockRes();
    await dispatch(routes, mockReq('GET', '/health', AUTH), res as any, cfg(), undefined, db);
    assert.equal(res.statusCode, 200);

    const rows = db.listRequestLog({});
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.plane, 'query');
    assert.equal(r.operation, 'health.get');
    assert.equal(r.method, 'GET');
    assert.equal(r.path, '/health');
    assert.ok(r.receivedAt > 0);
    // log-last filled:
    assert.equal(r.status, 200);
    assert.equal(r.outcome, 'ok');
    assert.ok(r.respondedAt! >= r.receivedAt);
  });

  it('log-first row exists with no responded_at while the handler is mid-flight', async () => {
    // A handler that inspects the journal at the moment it runs, BEFORE responding.
    type MidFlight = { hasRow: boolean; respondedAt: number | null };
    let midFlight: MidFlight | null = null;
    const routes = new Map<string, any>();
    const { wrapWithAudit } = await import('../lib/service-audit.js');
    routes.set(
      'GET /probe',
      wrapWithAudit(db, (_req: any, res: any) => {
        const rows = db.listRequestLog({});
        midFlight = { hasRow: rows.length === 1, respondedAt: rows[0]?.respondedAt ?? null };
        res.writeHead(200, {});
        res.end('{}');
      }),
    );
    const res = new MockRes();
    await dispatch(routes as any, mockReq('GET', '/probe', AUTH), res as any, cfg(), undefined, db);
    const observed = midFlight as MidFlight | null;
    assert.ok(observed, 'handler ran');
    assert.equal(observed!.hasRow, true); // ① row present before the handler responded
    assert.equal(observed!.respondedAt, null); // ③ not yet written mid-flight
    // After the response, ③ is committed.
    assert.ok(db.listRequestLog({})[0].respondedAt! > 0);
  });
});

describe('audit middleware: rejected attempts are logged', () => {
  it('401 missing auth still writes a request_log row (rejected), no secret stored', async () => {
    const routes = buildRouter(undefined, db);
    const res = new MockRes();
    // No Authorization header; send a body with a secret to prove stripping on a 401.
    await dispatch(
      routes,
      mockReq('GET', '/health', {}),
      res as any,
      cfg(),
      undefined,
      db,
    );
    assert.equal(res.statusCode, 401);
    const rows = db.listRequestLog({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 401);
    assert.equal(rows[0].outcome, 'rejected');
  });

  it('400 unknown project still writes a row', async () => {
    const { service, release } = makeJobs(db, { resolves: false });
    const routes = buildRouter(service as any, db);
    const res = new MockRes();
    await dispatch(
      routes,
      mockReq('POST', '/jobs', AUTH, JSON.stringify({ kind: 'agent', objective: 'x', project: 'ghost' })),
      res as any,
      cfg(),
      service as any,
      db,
    );
    release();
    assert.equal(res.statusCode, 400);
    const rows = db.listRequestLog({ plane: 'execution' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 400);
    assert.equal(rows[0].outcome, 'rejected');
    assert.equal(rows[0].project, 'ghost');
  });

  it('429 queue full still writes a row', async () => {
    const { service, release } = makeJobs(db, { maxQueueDepth: 0 });
    const routes = buildRouter(service as any, db);
    const res = new MockRes();
    await dispatch(
      routes,
      mockReq('POST', '/jobs', AUTH, JSON.stringify({ kind: 'agent', objective: 'x', project: 'af' })),
      res as any,
      cfg(),
      service as any,
      db,
    );
    release();
    assert.equal(res.statusCode, 429);
    const rows = db.listRequestLog({ plane: 'execution' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 429);
    assert.equal(rows[0].outcome, 'rejected');
  });
});

describe('audit middleware: payload secret hygiene (design test 14)', () => {
  it('POST /jobs: bearer + secret-ish body fields never persisted to payload', async () => {
    const { service, release } = makeJobs(db);
    const routes = buildRouter(service as any, db);
    const res = new MockRes();
    const body = JSON.stringify({
      kind: 'agent',
      objective: 'do the thing',
      project: 'af',
      secret: 'super-secret-value',
      apiKey: 'key-leak',
      opts: { authorization: 'Bearer leaked' },
    });
    await dispatch(
      routes,
      mockReq('POST', '/jobs', { ...AUTH, 'x-af-caller': 'chat-9' }, body),
      res as any,
      cfg(),
      service as any,
      db,
    );
    assert.equal(res.statusCode, 202);
    const rows = db.listRequestLog({ plane: 'execution' });
    assert.equal(rows.length, 1);
    const payload = rows[0].payload ?? '';
    assert.ok(!payload.includes('super-secret-value'), 'body secret stripped');
    assert.ok(!payload.includes('key-leak'), 'apiKey stripped');
    assert.ok(!payload.includes('Bearer leaked'), 'nested authorization stripped');
    assert.ok(!payload.includes(SECRET), 'bearer never in payload');
    // Non-secret fields survive.
    assert.ok(payload.includes('do the thing'));
    // caller attributed; job_id backfilled to the created job.
    assert.equal(rows[0].caller, 'chat-9');
    assert.ok(rows[0].jobId, 'request_log.job_id backfilled');
    assert.equal(rows[0].outcome, 'accepted');
    assert.equal(rows[0].status, 202);
    const jobs = db.listJobs({});
    assert.equal(jobs[0].id, rows[0].jobId);
    release();
  });
});

describe('GET /audit', () => {
  beforeEach(() => {
    // Seed a cross-plane journal directly.
    db.insertRequestLog({ id: 'a1', receivedAt: 100, caller: 'c1', plane: 'execution', method: 'POST', path: '/jobs', operation: 'agent.spawn', project: 'af' });
    db.insertRequestLog({ id: 'a2', receivedAt: 200, caller: 'c2', plane: 'query', method: 'GET', path: '/jobs', operation: 'jobs.list', project: 'af' });
    db.insertRequestLog({ id: 'a3', receivedAt: 300, caller: 'c1', plane: 'query', method: 'GET', path: '/health', operation: 'health.get', project: null });
  });

  async function get(url: string, headers: Record<string, unknown> = AUTH) {
    const routes = buildRouter(undefined, db);
    const res = new MockRes();
    await dispatch(routes, mockReq('GET', url, headers), res as any, cfg(), undefined, db);
    return res;
  }

  it('requires auth (401)', async () => {
    const res = await get('/audit', {});
    assert.equal(res.statusCode, 401);
  });

  it('returns the cross-plane journal, newest first', async () => {
    const res = await get('/audit');
    assert.equal(res.statusCode, 200);
    const entries = JSON.parse(res.body).entries;
    // 3 seeded + the GET /audit request itself logged by the middleware.
    assert.ok(entries.length >= 3);
    // newest-first ordering: the just-logged /audit row (now) precedes the seeds.
    assert.equal(entries[0].path, '/audit');
  });

  it('filters by plane', async () => {
    const entries = JSON.parse((await get('/audit?plane=execution')).body).entries;
    assert.ok(entries.every((e: any) => e.plane === 'execution'));
    assert.ok(entries.some((e: any) => e.id === 'a1'));
  });

  it('filters by caller', async () => {
    const entries = JSON.parse((await get('/audit?caller=c1')).body).entries;
    assert.ok(entries.every((e: any) => e.caller === 'c1'));
  });

  it('filters by project', async () => {
    const entries = JSON.parse((await get('/audit?project=af')).body).entries;
    assert.ok(entries.every((e: any) => e.project === 'af'));
  });

  it('filters by since (inclusive lower bound)', async () => {
    const entries = JSON.parse((await get('/audit?since=250')).body).entries;
    // a1 (100) and a2 (200) excluded; a3 (300) + the live /audit row included.
    assert.ok(!entries.some((e: any) => e.id === 'a1'));
    assert.ok(!entries.some((e: any) => e.id === 'a2'));
    assert.ok(entries.some((e: any) => e.id === 'a3'));
  });

  it('filters by op (operation)', async () => {
    const entries = JSON.parse((await get('/audit?op=jobs.list')).body).entries;
    assert.ok(entries.every((e: any) => e.operation === 'jobs.list'));
    assert.ok(entries.some((e: any) => e.id === 'a2'));
  });

  it('respects limit', async () => {
    const entries = JSON.parse((await get('/audit?limit=2')).body).entries;
    assert.equal(entries.length, 2);
  });

  it('is unqueued — returns while a job is held running', async () => {
    const { service, release } = makeJobs(db);
    const routes = buildRouter(service as any, db);
    // Start a job and hold it running.
    const jobRes = new MockRes();
    await dispatch(
      routes,
      mockReq('POST', '/jobs', AUTH, JSON.stringify({ kind: 'agent', objective: 'x', project: 'af' })),
      jobRes as any,
      cfg(),
      service as any,
      db,
    );
    assert.equal(jobRes.statusCode, 202);
    assert.equal(service.queue.runningCount(), 1);
    // /audit returns immediately despite the in-flight job.
    const auditRes = new MockRes();
    await dispatch(
      routes,
      mockReq('GET', '/audit', AUTH),
      auditRes as any,
      cfg(),
      service as any,
      db,
    );
    assert.equal(auditRes.statusCode, 200);
    release();
  });
});
