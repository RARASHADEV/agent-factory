/**
 * AF-60: Tests for the mutation plane (writes · synchronous · NEVER queued).
 *
 * Routes (design §4):
 *   POST  /projects                 { prefix, name? }          → init a workspace
 *   POST  /projects/:p/tasks        { title, … }               → createTask
 *   PATCH /tasks/:ticket            { status?|assignee?|log? }  → move/assign/log
 *   POST  /agents/sync                                         → agent sync
 *   POST  /sync                     { project, mode }          → sync
 *
 * Coverage:
 *   - each route performs the mutation (asserted by re-reading via the core op);
 *   - each writes a request_log row with plane='mutation' + the right operation;
 *   - PATCH field-dispatch: status→move, assignee→assign, log→log; 0/2 fields→400;
 *   - unknown project → 400; unknown ticket → 404; bad/empty body → 400; auth → 401;
 *   - PARITY (design test 7): a representative mutation returns the same result as
 *     the equivalent core op the `af` CLI calls (both go through one engine).
 *
 * Hermetic: a temp `.af` workspace is chdir'd into (so resolveProject() resolves via
 * cwd), the prefix `TST` is registered in a backed-up global config (restored after),
 * and the global `loka` block is stripped so the fire-and-forget post-action sync is
 * a no-op (no network). The agent-sync / sync NETWORK legs are NOT exercised here —
 * those routes are tested on their guardrail/validation paths only (not-configured →
 * 400), which never touch the network.
 *
 *   npx tsx --test src/__tests__/service-mutation.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
  copyFileSync, readFileSync, unlinkSync,
} from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { ServiceDb, openServiceDb } from '../lib/service-db.js';
import { buildRouter, dispatch } from '../commands/serve.js';
import type { ResolvedServiceConfig } from '../lib/service-config.js';
import { listTasks, showTask, moveTask } from '../lib/core/tasks.js';
import { addProject } from '../lib/config.js';

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

/** A mock request whose JSON body streams as one chunk (so bufferBody reads it). */
function mockReq(
  method: string,
  url: string,
  headers: Record<string, unknown> = {},
  body?: unknown,
): any {
  const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const r = Readable.from(chunks) as any;
  r.method = method;
  r.url = url;
  r.headers = headers;
  return r;
}

const SECRET = 'mutation-secret';
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

// ── Hermetic workspace + global config ───────────────────────────────────────

const GLOBAL_CONFIG = join(homedir(), '.af', 'config.yaml');
const CONFIG_BACKUP = join(tmpdir(), `af-mutation-config-backup-${process.pid}.yaml`);
let hadGlobalConfig = false;
let workdir: string;
let originalCwd: string;
let db: ServiceDb;
let dbDir: string;

const PROJECT_MD = `---
id: test-project
name: Test Project
prefix: TST
status: active
owner: tester
created: '2026-01-01'
counter: 4
---

# Test Project
`;

function writeTask(status: string, ticket: string, fields: Record<string, string>): void {
  const dir = join(workdir, '.af', 'tasks', status);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries({ status, ...fields })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(
    join(dir, `${ticket}.md`),
    `---\nticket: ${ticket}\n${fm}\n---\n\n# ${fields.title || ticket}\n\nBody.\n`,
    'utf-8',
  );
}

before(() => {
  // Neutralise the global Loka block so the post-action sync is a no-op (no network).
  hadGlobalConfig = existsSync(GLOBAL_CONFIG);
  if (hadGlobalConfig) {
    copyFileSync(GLOBAL_CONFIG, CONFIG_BACKUP);
    const parsed = (parseYaml(readFileSync(GLOBAL_CONFIG, 'utf-8')) || {}) as Record<string, unknown>;
    delete parsed.loka;
    // Point the agent-platform upstream at a closed local port so POST /agents/sync
    // fails fast (ECONNREFUSED → 502) instead of waiting on the configured host. We
    // assert only the audit metadata for that route; the network leg is not under test.
    parsed.agents = { upstream: { url: 'http://127.0.0.1:1/api' } };
    writeFileSync(GLOBAL_CONFIG, stringifyYaml(parsed), 'utf-8');
  } else {
    // No global config existed — create one with a fast-failing upstream + no loka.
    mkdirSync(join(homedir(), '.af'), { recursive: true });
    writeFileSync(GLOBAL_CONFIG, stringifyYaml({ agents: { upstream: { url: 'http://127.0.0.1:1/api' } } }), 'utf-8');
  }

  originalCwd = process.cwd();
  workdir = mkdtempSync(join(tmpdir(), 'af-mutation-'));
  mkdirSync(join(workdir, '.af'), { recursive: true });
  writeFileSync(join(workdir, '.af', 'project.md'), PROJECT_MD, 'utf-8');

  writeTask('in-progress', 'TST-1', {
    title: 'Active task', type: 'task', priority: 'high', complexity: 'medium', assignee: 'engineer',
  });
  writeTask('open', 'TST-2', {
    title: 'Open task', type: 'feature', priority: 'medium', complexity: 'low',
  });
  writeTask('open', 'TST-3', {
    title: 'Loggable task', type: 'task', priority: 'low', complexity: 'low',
  });

  // Register TST → workdir so the prefix-scoped route (/projects/TST/tasks) resolves.
  addProject('TST', workdir);

  process.chdir(workdir);

  dbDir = mkdtempSync(join(tmpdir(), 'af-mutation-db-'));
  db = openServiceDb(join(dbDir, 'service.db'));
});

after(() => {
  process.chdir(originalCwd);
  try { db.close(); } catch { /* ignore */ }
  rmSync(workdir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });

  if (hadGlobalConfig && existsSync(CONFIG_BACKUP)) {
    copyFileSync(CONFIG_BACKUP, GLOBAL_CONFIG);
    unlinkSync(CONFIG_BACKUP);
  } else if (existsSync(GLOBAL_CONFIG)) {
    // We created a config purely for this test (none existed) — remove it.
    unlinkSync(GLOBAL_CONFIG);
  }
});

/** Dispatch a request through the real router/dispatch and return the MockRes. */
async function call(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, unknown> = AUTH,
): Promise<MockRes> {
  const routes = buildRouter(undefined, db);
  const res = new MockRes();
  await dispatch(routes, mockReq(method, url, headers, body), res as any, cfg(), undefined, db);
  return res;
}

/** Find the most recent request_log row for a path (listRequestLog is newest-first). */
function lastRow(path: string) {
  const rows = db.listRequestLog({ plane: 'mutation' });
  return rows.find((r) => r.path === path);
}

// ── POST /projects/:p/tasks → createTask ─────────────────────────────────────

describe('POST /projects/:p/tasks → createTask', () => {
  it('creates a task and it shows up in a listing (mutation performed)', async () => {
    const res = await call('POST', '/projects/TST/tasks', { title: 'From HTTP', type: 'feature', priority: 'high' });
    assert.equal(res.statusCode, 201);
    const created = JSON.parse(res.body).task;
    assert.equal(created.title, 'From HTTP');
    assert.ok(created.ticket.startsWith('TST-'));

    const listed = await listTasks({}, 'TST');
    assert.ok(listed.tasks.some((t) => t.ticket === created.ticket), 'created task is listed');
  });

  it('writes a request_log row with plane=mutation, operation=tasks.create', async () => {
    await call('POST', '/projects/TST/tasks', { title: 'Audited create' });
    const row = lastRow('/projects/TST/tasks');
    assert.ok(row, 'journaled');
    assert.equal(row!.plane, 'mutation');
    assert.equal(row!.operation, 'tasks.create');
    assert.equal(row!.status, 201);
    assert.equal(row!.outcome, 'ok');
  });

  it('empty body (no title) → 400', async () => {
    const res = await call('POST', '/projects/TST/tasks', {});
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  it('unknown project → 400 (§6 guardrail)', async () => {
    const res = await call('POST', '/projects/NOPE/tasks', { title: 'x' });
    assert.equal(res.statusCode, 400);
  });
});

// ── PATCH /tasks/:ticket → move/assign/log (field dispatch) ──────────────────

describe('PATCH /tasks/:ticket field dispatch', () => {
  it('status → moveTask (status transitions)', async () => {
    const res = await call('PATCH', '/tasks/TST-2', { status: 'in-progress' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.toStatus, 'in-progress');
    assert.equal(body.task.status, 'in-progress');

    const reread = await showTask('TST-2', 'TST');
    assert.equal(reread!.task.status, 'in-progress');

    const row = lastRow('/tasks/TST-2');
    assert.equal(row!.plane, 'mutation');
    assert.equal(row!.operation, 'tasks.update');
  });

  it('assignee → assignTask', async () => {
    const res = await call('PATCH', '/tasks/TST-1', { assignee: 'qa' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).assignee, 'qa');

    const reread = await showTask('TST-1', 'TST');
    assert.equal(reread!.task.assignee, 'qa');
  });

  it('log → logTask', async () => {
    const res = await call('PATCH', '/tasks/TST-3', { log: 'engineer: note | did a thing' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ticket, 'TST-3');

    const reread = await showTask('TST-3', 'TST');
    assert.match(reread!.raw!, /did a thing/);
  });

  it('no field → 400', async () => {
    const res = await call('PATCH', '/tasks/TST-1', {});
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /one of status\|assignee\|log/);
  });

  it('more than one field → 400', async () => {
    const res = await call('PATCH', '/tasks/TST-1', { status: 'open', assignee: 'qa' });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /exactly one/);
  });

  it('unknown ticket → 404', async () => {
    const res = await call('PATCH', '/tasks/TST-999', { status: 'open' });
    assert.equal(res.statusCode, 404);
  });
});

// ── PARITY (design test 7) ───────────────────────────────────────────────────

describe('parity with the af CLI core op (design test 7)', () => {
  it('PATCH status returns the same shape moveTask() produces', async () => {
    // Drive the route, then drive the core op on a sibling ticket and compare shape.
    const res = await call('PATCH', '/tasks/TST-2', { status: 'open' }); // move back
    assert.equal(res.statusCode, 200);
    const viaRoute = JSON.parse(res.body);

    // moveTask on the same ticket again is a no-op but returns the same fields.
    const viaCore = await moveTask('TST-2', 'open', 'TST');
    assert.deepEqual(Object.keys(viaRoute).sort(), Object.keys(JSON.parse(JSON.stringify(viaCore))).sort());
    assert.equal(viaRoute.task.ticket, viaCore.task.ticket);
  });
});

// ── POST /projects → init (validation only; real init writes a new workspace) ─

describe('POST /projects → init', () => {
  it('missing prefix → 400', async () => {
    const res = await call('POST', '/projects', { name: 'No Prefix' });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /prefix is required/);
  });

  it('duplicate workspace (existing .af) → 400', async () => {
    // workdir already has a .af workspace — initialising it again must be rejected.
    const res = await call('POST', '/projects', { prefix: 'DUP', path: workdir });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /already exists/);
  });

  it('initialises a fresh workspace and journals plane=mutation, op=projects.init', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'af-mutation-init-'));
    try {
      const res = await call('POST', '/projects', { prefix: 'NEW', name: 'Fresh', path: fresh });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.prefix, 'NEW');
      assert.ok(existsSync(join(fresh, '.af', 'project.md')), 'workspace created on disk');

      const row = lastRow('/projects');
      assert.equal(row!.plane, 'mutation');
      assert.equal(row!.operation, 'projects.init');
      assert.equal(row!.status, 201);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

// ── POST /sync → guardrail/validation only (no network) ──────────────────────

describe('POST /sync (validation/guardrail — network leg NOT exercised)', () => {
  it('unknown project → 400', async () => {
    const res = await call('POST', '/sync', { project: 'NOPE' });
    assert.equal(res.statusCode, 400);
  });

  it('invalid mode → 400', async () => {
    const res = await call('POST', '/sync', { project: 'TST', mode: 'sideways' });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /invalid mode/);
  });

  it('Loka not configured → 400 (the loka block was stripped for hermeticity)', async () => {
    // project resolves (TST) but the global config has no loka block → not configured.
    const res = await call('POST', '/sync', { project: 'TST', mode: 'push' });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /not configured/i);

    const row = lastRow('/sync');
    assert.equal(row!.plane, 'mutation');
    assert.equal(row!.operation, 'projects.sync');
  });
});

// ── POST /agents/sync → guardrail only (no network) ──────────────────────────

describe('POST /agents/sync (guardrail — network leg NOT exercised)', () => {
  it('journals plane=mutation, operation=agents.sync', async () => {
    // The default config points upstream at a host that is unreachable in CI; we
    // assert the request is journaled on the mutation plane with the right op. The
    // outcome may be 200 (if reachable) or 502 (unreachable) — either way it must
    // be recorded. We only assert the audit metadata, not the network outcome.
    await call('POST', '/agents/sync', {});
    const row = lastRow('/agents/sync');
    assert.ok(row, 'agents.sync journaled');
    assert.equal(row!.plane, 'mutation');
    assert.equal(row!.operation, 'agents.sync');
  });
});

// ── AUTH (401) ────────────────────────────────────────────────────────────────

describe('mutation plane: auth enforced (401)', () => {
  it('POST /projects/:p/tasks without a bearer → 401, no mutation', async () => {
    const before = (await listTasks({}, 'TST')).tasks.length;
    const res = await call('POST', '/projects/TST/tasks', { title: 'unauth' }, {});
    assert.equal(res.statusCode, 401);
    const after = (await listTasks({}, 'TST')).tasks.length;
    assert.equal(after, before, 'no task created when unauthorized');
  });

  it('PATCH /tasks/:ticket with a wrong bearer → 401', async () => {
    const res = await call('PATCH', '/tasks/TST-1', { status: 'open' }, { authorization: 'Bearer nope' });
    assert.equal(res.statusCode, 401);
  });

  it('a 401 attempt is still journaled (an attempt is an attempt)', async () => {
    await call('POST', '/sync', { project: 'TST' }, {});
    const rows = db.listRequestLog({ plane: 'mutation' });
    const unauthorized = rows.find((r) => r.path === '/sync' && r.status === 401);
    assert.ok(unauthorized, '401 attempt journaled');
  });
});
