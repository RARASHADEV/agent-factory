/**
 * AF-54: Unit tests for the `af serve` skeleton.
 *
 * Covers the pure, socket-free seams:
 *   - auth: isAuthorized / parseBearer / constantTimeEqual (401 on missing/wrong, pass on correct)
 *   - bind fail-closed: decideBind (Decision 4 / §14 R2) + isTailscaleIp
 *   - config resolution: env overrides config, defaults (port 4150, capacity 20, db)
 *   - router dispatch: GET /health shape, 401 without auth, 404 unknown route
 *
 * Run: npx tsx --test src/__tests__/service.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

import {
  isAuthorized,
  parseBearer,
  constantTimeEqual,
} from '../lib/service-auth.js';
import {
  resolveServiceConfig,
  decideBind,
  isTailscaleIp,
} from '../lib/service-config.js';
import {
  buildRouter,
  dispatch,
} from '../commands/serve.js';
import type { ResolvedServiceConfig } from '../lib/service-config.js';

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('service auth', () => {
  const secret = 'super-secret-token';

  it('constantTimeEqual: true on equal, false on differing length/content', () => {
    assert.equal(constantTimeEqual('abc', 'abc'), true);
    assert.equal(constantTimeEqual('abc', 'abd'), false);
    assert.equal(constantTimeEqual('abc', 'abcd'), false);
    assert.equal(constantTimeEqual('', ''), true);
  });

  it('parseBearer: extracts token, case-insensitive scheme, undefined otherwise', () => {
    assert.equal(parseBearer('Bearer xyz'), 'xyz');
    assert.equal(parseBearer('bearer xyz'), 'xyz');
    assert.equal(parseBearer('  Bearer   xyz  '), 'xyz');
    assert.equal(parseBearer('Basic xyz'), undefined);
    assert.equal(parseBearer(undefined), undefined);
    assert.equal(parseBearer(['Bearer xyz']), undefined); // array header not accepted
  });

  it('isAuthorized: correct secret passes', () => {
    assert.equal(isAuthorized(`Bearer ${secret}`, secret), true);
  });

  it('isAuthorized: missing header → false (401)', () => {
    assert.equal(isAuthorized(undefined, secret), false);
  });

  it('isAuthorized: wrong secret → false (401)', () => {
    assert.equal(isAuthorized('Bearer nope', secret), false);
  });

  it('isAuthorized: empty configured secret never authorizes', () => {
    assert.equal(isAuthorized('Bearer ', ''), false);
    assert.equal(isAuthorized('Bearer anything', ''), false);
  });
});

// ── Bind fail-closed (Decision 4 / §14 R2) ───────────────────────────────────

describe('service bind safety', () => {
  it('isTailscaleIp: 100.64.0.0/10 only', () => {
    assert.equal(isTailscaleIp('100.64.0.1'), true);
    assert.equal(isTailscaleIp('100.109.246.119'), true);
    assert.equal(isTailscaleIp('100.127.255.255'), true);
    assert.equal(isTailscaleIp('100.63.0.1'), false); // below range
    assert.equal(isTailscaleIp('100.128.0.1'), false); // above range
    assert.equal(isTailscaleIp('10.0.0.1'), false);
  });

  it('decideBind: Tailscale address is allowed', () => {
    const d = decideBind('100.109.246.119', false);
    assert.equal(d.ok, true);
    assert.equal(d.ok && d.address, '100.109.246.119');
  });

  it('decideBind: loopback is allowed', () => {
    assert.equal(decideBind('127.0.0.1', false).ok, true);
    assert.equal(decideBind('::1', false).ok, true);
  });

  it('decideBind: 0.0.0.0 refused unless allowPublic (never falls back)', () => {
    const refused = decideBind('0.0.0.0', false);
    assert.equal(refused.ok, false);
    assert.equal(decideBind('0.0.0.0', true).ok, true);
  });

  it('decideBind: empty (Tailscale unresolvable) refused when public not allowed', () => {
    const d = decideBind('', false);
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && /empty/.test(d.reason), true);
  });

  it('decideBind: public/LAN address refused unless allowPublic', () => {
    assert.equal(decideBind('203.0.113.5', false).ok, false);
    assert.equal(decideBind('192.168.1.10', false).ok, false);
    assert.equal(decideBind('203.0.113.5', true).ok, true);
  });
});

// ── Config resolution (§8: env overrides config) ─────────────────────────────

describe('resolveServiceConfig', () => {
  it('defaults: port 4150, capacity 20, queue depth 500, allowPublic false, default db', () => {
    const r = resolveServiceConfig(undefined, {});
    assert.equal(r.port, 4150);
    assert.equal(r.maxConcurrency, 20);
    assert.equal(r.maxQueueDepth, 500);
    assert.equal(r.allowPublic, false);
    assert.equal(r.secret, '');
    assert.equal(r.bind, undefined);
    assert.equal(r.db.endsWith('service.db'), true);
  });

  it('maxQueueDepth: config + env resolve, env wins (§8, Decision 6)', () => {
    assert.equal(resolveServiceConfig({ maxQueueDepth: 100 }, {}).maxQueueDepth, 100);
    assert.equal(
      resolveServiceConfig({ maxQueueDepth: 100 }, { AF_MAX_QUEUE_DEPTH: '7' }).maxQueueDepth,
      7,
    );
    assert.equal(resolveServiceConfig(undefined, { AF_MAX_QUEUE_DEPTH: 'x' }).maxQueueDepth, 500);
  });

  it('config block is used when env absent', () => {
    const r = resolveServiceConfig(
      { secret: 'cfg-secret', port: 9000, bind: '100.64.0.5', maxConcurrency: 5, allowPublic: true, db: '/tmp/x.db' },
      {},
    );
    assert.equal(r.secret, 'cfg-secret');
    assert.equal(r.port, 9000);
    assert.equal(r.bind, '100.64.0.5');
    assert.equal(r.maxConcurrency, 5);
    assert.equal(r.allowPublic, true);
    assert.equal(r.db, '/tmp/x.db');
  });

  it('env overrides config (§8)', () => {
    const r = resolveServiceConfig(
      { secret: 'cfg-secret', port: 9000 },
      {
        AF_SERVICE_SECRET: 'env-secret',
        AF_SERVICE_PORT: '4150',
        AF_SERVICE_BIND: '100.64.0.9',
        AF_SERVICE_ALLOW_PUBLIC: 'true',
        AF_MAX_CONCURRENCY: '42',
        AF_SERVICE_DB: '/var/af/service.db',
      },
    );
    assert.equal(r.secret, 'env-secret');
    assert.equal(r.port, 4150);
    assert.equal(r.bind, '100.64.0.9');
    assert.equal(r.allowPublic, true);
    assert.equal(r.maxConcurrency, 42);
    assert.equal(r.db, '/var/af/service.db');
  });

  it('invalid numeric env falls back to default', () => {
    const r = resolveServiceConfig(undefined, { AF_SERVICE_PORT: 'abc', AF_MAX_CONCURRENCY: '' });
    assert.equal(r.port, 4150);
    assert.equal(r.maxConcurrency, 20);
  });

  it('retentionDays defaults to 0 (keep everything); env + config resolve (§8, Decision 10)', () => {
    assert.equal(resolveServiceConfig(undefined, {}).retentionDays, 0);
    assert.equal(resolveServiceConfig({ retentionDays: 30 }, {}).retentionDays, 30);
    assert.equal(
      resolveServiceConfig({ retentionDays: 30 }, { AF_SERVICE_RETENTION_DAYS: '7' }).retentionDays,
      7,
    );
  });
});

// ── Router dispatch / GET /health ────────────────────────────────────────────

/** Minimal mock ServerResponse capturing status + JSON body. */
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
}

function mockReq(method: string, url: string, headers: Record<string, unknown> = {}) {
  return { method, url, headers } as any;
}

const CFG: ResolvedServiceConfig = {
  secret: 'health-secret',
  port: 4150,
  allowPublic: false,
  maxConcurrency: 20,
  maxQueueDepth: 500,
  db: '/tmp/service.db',
  retentionDays: 0,
};

describe('router dispatch', () => {
  it('GET /health with auth → 200 { ok, running, queued, capacity: 20 }', async () => {
    const routes = buildRouter();
    const res = new MockRes();
    await dispatch(routes, mockReq('GET', '/health', { authorization: 'Bearer health-secret' }), res as any, CFG);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { ok: true, running: 0, queued: 0, capacity: 20 });
  });

  it('GET /health honors a different capacity from config', async () => {
    const routes = buildRouter();
    const res = new MockRes();
    await dispatch(routes, mockReq('GET', '/health', { authorization: 'Bearer health-secret' }), res as any, { ...CFG, maxConcurrency: 7 });
    assert.equal(JSON.parse(res.body).capacity, 7);
  });

  it('GET /health without auth → 401', async () => {
    const routes = buildRouter();
    const res = new MockRes();
    await dispatch(routes, mockReq('GET', '/health'), res as any, CFG);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  it('GET /health with wrong secret → 401', async () => {
    const routes = buildRouter();
    const res = new MockRes();
    await dispatch(routes, mockReq('GET', '/health', { authorization: 'Bearer wrong' }), res as any, CFG);
    assert.equal(res.statusCode, 401);
  });

  it('health route ignores query string in path', async () => {
    const routes = buildRouter();
    const res = new MockRes();
    await dispatch(routes, mockReq('GET', '/health?x=1', { authorization: 'Bearer health-secret' }), res as any, CFG);
    assert.equal(res.statusCode, 200);
  });

  it('unknown route → 404', async () => {
    const routes = buildRouter();
    const res = new MockRes();
    await dispatch(routes, mockReq('GET', '/nope', { authorization: 'Bearer health-secret' }), res as any, CFG);
    assert.equal(res.statusCode, 404);
  });
});

// ── Flag-off behavior ────────────────────────────────────────────────────────

describe('ENABLE_AF_53 flag', () => {
  it('defaults to false (no listener opened at command entry)', async () => {
    const { ENABLE_AF_53 } = await import('../lib/constants.js');
    assert.equal(ENABLE_AF_53, false);
  });
});
