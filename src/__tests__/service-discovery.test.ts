/**
 * AF-53: Tests for the self-describing GET / service discovery endpoint.
 *
 * GET / returns a JSON catalog of the whole API surface plus the live, resolved
 * service config, so a consumer (human or machine) can hit one URL and learn how
 * to call every service.
 *
 * Coverage:
 *   - 401: auth enforced (no/wrong bearer → handler never runs), like /health.
 *   - 200 + shape: service/version/auth/capacity/notes/endpoints present, with a
 *     non-empty endpoints array that includes GET /jobs and GET /audit.
 *   - capacity reflects the resolved config (maxConcurrency / maxQueueDepth).
 *   - single source of truth: the catalog GET / renders matches the startup
 *     banner lines (both derive from ROUTE_CATALOG).
 *   - audit: GET / is journaled with operation service.index.
 *
 * Socket-free: the real router/dispatch is exercised with mock req/res over a temp
 * SQLite DB (never the real ~/.af/service.db). Run:
 *   npx tsx --test src/__tests__/service-discovery.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ServiceDb, openServiceDb } from '../lib/service-db.js';
import {
  buildRouter,
  dispatch,
  serviceIndex,
  bannerLines,
  ROUTE_CATALOG,
} from '../commands/serve.js';
import type { ResolvedServiceConfig } from '../lib/service-config.js';

// ── Mock req/res (mirrors service-query.test.ts) ─────────────────────────────

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

const SECRET = 'discovery-secret';
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

let dir: string;
let db: ServiceDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-discovery-'));
  db = openServiceDb(join(dir, 'service.db'));
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

/** Dispatch a GET / and return the MockRes, using the given config + headers. */
async function getIndex(
  headers: Record<string, unknown> = AUTH,
  conf: ResolvedServiceConfig = cfg(),
) {
  const routes = buildRouter(undefined, db);
  const res = new MockRes();
  await dispatch(routes, mockReq('GET', '/', headers), res as any, conf, undefined, db);
  return res;
}

// ── AUTH (401) — like /health, never unauthenticated ─────────────────────────

describe('GET / : auth enforced (401)', () => {
  it('GET / without a bearer → 401', async () => {
    const res = await getIndex({});
    assert.equal(res.statusCode, 401);
  });

  it('GET / with a wrong bearer → 401', async () => {
    const res = await getIndex({ authorization: 'Bearer nope' });
    assert.equal(res.statusCode, 401);
  });
});

// ── 200 + JSON shape ─────────────────────────────────────────────────────────

describe('GET / : 200 + discovery document shape', () => {
  it('returns the self-describing catalog with the expected top-level keys', async () => {
    const res = await getIndex();
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.service, 'af-serve');
    assert.equal(typeof body.version, 'string');
    assert.ok(body.version.length > 0, 'version is non-empty');
    assert.match(body.auth, /Bearer/);
    assert.ok(Array.isArray(body.notes) && body.notes.length > 0, 'notes present');
    assert.ok(Array.isArray(body.endpoints), 'endpoints is an array');
    assert.ok(body.endpoints.length > 0, 'endpoints non-empty');
  });

  it('endpoints include GET /jobs and GET /audit', async () => {
    const res = await getIndex();
    const body = JSON.parse(res.body);
    const has = (method: string, path: string) =>
      body.endpoints.some((e: any) => e.method === method && e.path === path);
    assert.ok(has('GET', '/jobs'), 'GET /jobs documented');
    assert.ok(has('GET', '/audit'), 'GET /audit documented');
    assert.ok(has('GET', '/'), 'GET / documents itself');
    // POST /jobs carries its body note (kind/project/objective).
    const postJobs = body.endpoints.find((e: any) => e.method === 'POST' && e.path === '/jobs');
    assert.ok(postJobs, 'POST /jobs documented');
    assert.match(postJobs.body, /kind/);
    assert.match(postJobs.body, /objective/);
  });

  it('capacity reflects the resolved config', async () => {
    const res = await getIndex(AUTH, cfg({ maxConcurrency: 7, maxQueueDepth: 99 }));
    const body = JSON.parse(res.body);
    assert.deepEqual(body.capacity, { maxConcurrency: 7, maxQueueDepth: 99 });
  });
});

// ── Single source of truth — GET / and the banner derive from ROUTE_CATALOG ──

describe('GET / : single source of truth with the startup banner', () => {
  it('serviceIndex endpoints == ROUTE_CATALOG (one source)', () => {
    const doc = serviceIndex(cfg());
    const endpoints = doc.endpoints as Array<{ method: string; path: string }>;
    assert.equal(endpoints.length, ROUTE_CATALOG.length);
    for (let i = 0; i < ROUTE_CATALOG.length; i++) {
      assert.equal(endpoints[i].method, ROUTE_CATALOG[i].method);
      assert.equal(endpoints[i].path, ROUTE_CATALOG[i].path);
    }
  });

  it('the banner renders one line per catalog route (no drift)', () => {
    const lines = bannerLines(cfg());
    // One line per route, plus the Auth + Capacity trailer lines.
    assert.equal(lines.length, ROUTE_CATALOG.length + 2);
    for (const r of ROUTE_CATALOG) {
      const found = lines.some((l) => l.includes(r.method) && l.includes(r.path) && l.includes(r.description));
      assert.ok(found, `banner has a line for ${r.method} ${r.path}`);
    }
    assert.ok(lines.some((l) => /Auth: Authorization: Bearer/.test(l)), 'auth line present');
    assert.ok(lines.some((l) => /Capacity: 20 concurrent/.test(l)), 'capacity line present');
  });
});

// ── audit registration — GET / is journaled ──────────────────────────────────

describe('GET / : audit-journaled as service.index', () => {
  it('writes a request_log row with operation service.index', async () => {
    await getIndex();
    const rows = db.listRequestLog({ plane: 'query' });
    const row = rows.find((r) => r.path === '/');
    assert.ok(row, 'GET / journaled');
    assert.equal(row!.operation, 'service.index');
    assert.equal(row!.status, 200);
    assert.equal(row!.outcome, 'ok');
  });

  it('a rejected (401) GET / is still journaled', async () => {
    await getIndex({});
    const rows = db.listRequestLog({});
    const row = rows.find((r) => r.path === '/');
    assert.ok(row, 'rejected GET / journaled');
    assert.equal(row!.status, 401);
    assert.equal(row!.outcome, 'rejected');
  });
});
