/**
 * AF-55: Unit tests for the SQLite data-access layer (`src/lib/service-db.ts`).
 *
 * Covers:
 *   - schema: all three §7 tables + their indexes are created; WAL is enabled.
 *   - data-access CRUD round-trips for dispatch_jobs, request_log, job_events.
 *   - reconcile-on-boot: queued stays re-dispatchable; orphaned running → failed.
 *   - retention: 0 = nothing pruned (even old terminal rows); N>0 prunes only old
 *     terminal jobs/events while request_log + recent + non-terminal rows survive.
 *
 * Uses a temp DB file under os.tmpdir() (never the real ~/.af/service.db) and
 * cleans up. Run: npx tsx --test src/__tests__/service-db.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ServiceDb, openServiceDb, TERMINAL_STATUSES, isTerminalStatus } from '../lib/service-db.js';

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let dbPath: string;
let db: ServiceDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-svc-db-'));
  dbPath = join(dir, 'service.db');
  db = openServiceDb(dbPath);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

// ── Schema + WAL ─────────────────────────────────────────────────────────────

describe('service-db schema', () => {
  it('creates the DB file at the given path', () => {
    assert.equal(existsSync(dbPath), true);
  });

  it('enables WAL journal mode', () => {
    assert.equal(db.journalMode(), 'wal');
  });

  it('creates the three §7 tables + indexes (idempotent re-open is safe)', () => {
    // Re-opening the same file must not throw (CREATE ... IF NOT EXISTS).
    const db2 = openServiceDb(dbPath);
    // Round-trip a row through each table to prove the tables exist + shape is right.
    db2.insertJob({ id: 'J1', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o' });
    db2.insertRequestLog({ id: 'R1', plane: 'execution', method: 'POST', path: '/jobs' });
    db2.appendJobEvent({ jobId: 'J1', event: 'queued' });
    assert.equal(db2.getJob('J1')?.id, 'J1');
    assert.equal(db2.getRequestLog('R1')?.id, 'R1');
    assert.equal(db2.listJobEvents('J1').length, 1);
    db2.close();
  });

  it('TERMINAL_STATUSES + isTerminalStatus agree', () => {
    assert.deepEqual([...TERMINAL_STATUSES], ['completed', 'failed', 'crashed', 'timeout']);
    assert.equal(isTerminalStatus('completed'), true);
    assert.equal(isTerminalStatus('queued'), false);
    assert.equal(isTerminalStatus('running'), false);
  });
});

// ── dispatch_jobs CRUD ───────────────────────────────────────────────────────

describe('dispatch_jobs CRUD', () => {
  it('insert + get round-trips all columns; defaults applied', () => {
    const now = Date.now();
    db.insertJob({
      id: 'AF-1', kind: 'agent', project: 'agent-factory', role: 'engineer',
      objective: 'do the thing', outputDir: '/out/AF-1',
      callbackUrl: 'http://x/cb', caller: 'chat-7', queuedAt: now,
    });
    const job = db.getJob('AF-1');
    assert.ok(job);
    assert.equal(job!.kind, 'agent');
    assert.equal(job!.project, 'agent-factory');
    assert.equal(job!.role, 'engineer');
    assert.equal(job!.objective, 'do the thing');
    assert.equal(job!.status, 'queued'); // default
    assert.equal(job!.outputDir, '/out/AF-1');
    assert.equal(job!.callbackUrl, 'http://x/cb');
    assert.equal(job!.caller, 'chat-7');
    assert.equal(job!.queuedAt, now);
    assert.equal(job!.startedAt, null);
    assert.equal(job!.completedAt, null);
    assert.equal(job!.result, null);
  });

  it('getJob returns undefined for unknown id', () => {
    assert.equal(db.getJob('nope'), undefined);
  });

  it('updateJob patches only provided fields, returns true on hit', () => {
    db.insertJob({ id: 'AF-2', kind: 'pipeline', project: 'P', objective: 'o', outputDir: '/o' });
    const t = Date.now();
    assert.equal(db.updateJob('AF-2', { status: 'running', startedAt: t }), true);
    let job = db.getJob('AF-2')!;
    assert.equal(job.status, 'running');
    assert.equal(job.startedAt, t);
    assert.equal(job.completedAt, null);

    assert.equal(db.updateJob('AF-2', { status: 'completed', completedAt: t + 5, result: '{"ok":true}' }), true);
    job = db.getJob('AF-2')!;
    assert.equal(job.status, 'completed');
    assert.equal(job.completedAt, t + 5);
    assert.equal(job.result, '{"ok":true}');
    assert.equal(job.startedAt, t); // untouched
  });

  it('updateJob returns false for unknown id or empty patch', () => {
    db.insertJob({ id: 'AF-3', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o' });
    assert.equal(db.updateJob('missing', { status: 'failed' }), false);
    assert.equal(db.updateJob('AF-3', {}), false);
  });

  it('listJobs filters by project/status and respects limit, newest first', () => {
    db.insertJob({ id: 'A', kind: 'agent', project: 'P1', objective: 'o', outputDir: '/o', status: 'queued', queuedAt: 100 });
    db.insertJob({ id: 'B', kind: 'agent', project: 'P1', objective: 'o', outputDir: '/o', status: 'running', queuedAt: 200 });
    db.insertJob({ id: 'C', kind: 'agent', project: 'P2', objective: 'o', outputDir: '/o', status: 'queued', queuedAt: 300 });

    assert.equal(db.listJobs().length, 3);
    assert.deepEqual(db.listJobs({ project: 'P1' }).map((j) => j.id), ['B', 'A']);
    assert.deepEqual(db.listJobs({ status: 'queued' }).map((j) => j.id), ['C', 'A']);
    assert.deepEqual(db.listJobs({ project: 'P1', status: 'queued' }).map((j) => j.id), ['A']);
    assert.deepEqual(db.listJobs({ limit: 2 }).map((j) => j.id), ['C', 'B']);
  });
});

// ── request_log CRUD ─────────────────────────────────────────────────────────

describe('request_log CRUD', () => {
  it('insert (log-first) then update (log-last) round-trips', () => {
    const recv = Date.now();
    db.insertRequestLog({
      id: 'REQ-1', receivedAt: recv, caller: 'chat-1', plane: 'execution',
      method: 'POST', path: '/jobs', operation: 'agent.spawn', project: 'P',
      payload: '{"objective":"x"}',
    });
    let row = db.getRequestLog('REQ-1')!;
    assert.equal(row.receivedAt, recv);
    assert.equal(row.plane, 'execution');
    assert.equal(row.operation, 'agent.spawn');
    assert.equal(row.status, null);
    assert.equal(row.respondedAt, null);

    const resp = recv + 10;
    assert.equal(db.updateRequestLog('REQ-1', {
      status: 202, outcome: 'accepted', resultSummary: 'queued', respondedAt: resp, jobId: 'AF-9',
    }), true);
    row = db.getRequestLog('REQ-1')!;
    assert.equal(row.status, 202);
    assert.equal(row.outcome, 'accepted');
    assert.equal(row.resultSummary, 'queued');
    assert.equal(row.respondedAt, resp);
    assert.equal(row.jobId, 'AF-9');
  });

  it('updateRequestLog defaults respondedAt to now when omitted', () => {
    db.insertRequestLog({ id: 'REQ-2', plane: 'query', method: 'GET', path: '/projects' });
    const before = Date.now();
    db.updateRequestLog('REQ-2', { status: 200, outcome: 'ok' });
    const row = db.getRequestLog('REQ-2')!;
    assert.ok(row.respondedAt! >= before);
  });

  it('updateRequestLog returns false for unknown id', () => {
    assert.equal(db.updateRequestLog('nope', { status: 500 }), false);
  });

  it('listRequestLog filters (since/caller/project/plane/jobId) + limit, newest first', () => {
    db.insertRequestLog({ id: 'r1', receivedAt: 100, caller: 'a', plane: 'query', method: 'GET', path: '/p', project: 'P1' });
    db.insertRequestLog({ id: 'r2', receivedAt: 200, caller: 'b', plane: 'execution', method: 'POST', path: '/jobs', project: 'P1', jobId: 'J1' });
    db.insertRequestLog({ id: 'r3', receivedAt: 300, caller: 'a', plane: 'mutation', method: 'PATCH', path: '/t', project: 'P2' });

    assert.deepEqual(db.listRequestLog().map((r) => r.id), ['r3', 'r2', 'r1']);
    assert.deepEqual(db.listRequestLog({ since: 200 }).map((r) => r.id), ['r3', 'r2']);
    assert.deepEqual(db.listRequestLog({ caller: 'a' }).map((r) => r.id), ['r3', 'r1']);
    assert.deepEqual(db.listRequestLog({ project: 'P1' }).map((r) => r.id), ['r2', 'r1']);
    assert.deepEqual(db.listRequestLog({ plane: 'execution' }).map((r) => r.id), ['r2']);
    assert.deepEqual(db.listRequestLog({ jobId: 'J1' }).map((r) => r.id), ['r2']);
    assert.deepEqual(db.listRequestLog({ limit: 1 }).map((r) => r.id), ['r3']);
  });
});

// ── job_events ───────────────────────────────────────────────────────────────

describe('job_events', () => {
  it('appends events and lists them chronologically', () => {
    db.appendJobEvent({ jobId: 'J', at: 30, event: 'completed' });
    db.appendJobEvent({ jobId: 'J', at: 10, event: 'queued', detail: '{"queuePosition":3}' });
    db.appendJobEvent({ jobId: 'J', at: 20, event: 'started' });
    db.appendJobEvent({ jobId: 'OTHER', at: 5, event: 'queued' });

    const evts = db.listJobEvents('J');
    assert.deepEqual(evts.map((e) => e.event), ['queued', 'started', 'completed']);
    assert.equal(evts[0].detail, '{"queuePosition":3}');
    assert.equal(db.listJobEvents('OTHER').length, 1);
    assert.equal(db.listJobEvents('absent').length, 0);
  });
});

// ── Reconcile on boot (design §7.1, test 5) ──────────────────────────────────

describe('reconcileOnBoot', () => {
  it('queued rows stay re-dispatchable; orphaned running → failed + event', () => {
    db.insertJob({ id: 'Q1', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o', status: 'queued' });
    db.insertJob({ id: 'Q2', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o', status: 'queued' });
    db.insertJob({ id: 'R1', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o', status: 'running' });
    db.insertJob({ id: 'C1', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o', status: 'completed', completedAt: 1 });

    const now = 999999;
    const res = db.reconcileOnBoot(now);
    assert.equal(res.requeued, 2);
    assert.equal(res.failed, 1);

    // Queued rows untouched and still re-dispatchable.
    assert.equal(db.getJob('Q1')!.status, 'queued');
    assert.equal(db.getJob('Q2')!.status, 'queued');

    // Orphaned running → failed with completed_at set, and a failed event appended.
    const r1 = db.getJob('R1')!;
    assert.equal(r1.status, 'failed');
    assert.equal(r1.completedAt, now);
    const evts = db.listJobEvents('R1');
    assert.equal(evts.length, 1);
    assert.equal(evts[0].event, 'failed');

    // Already-terminal job is left alone.
    assert.equal(db.getJob('C1')!.status, 'completed');
  });

  it('survives a reopen: running written, connection closed, reopened, reconciled', () => {
    db.insertJob({ id: 'X', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o', status: 'running' });
    db.close();
    const db2 = openServiceDb(dbPath);
    const res = db2.reconcileOnBoot();
    assert.equal(res.failed, 1);
    assert.equal(db2.getJob('X')!.status, 'failed');
    db2.close();
    // reassign so afterEach close() is harmless
    db = openServiceDb(dbPath);
  });
});

// ── Retention (Decision 10, test 11) ─────────────────────────────────────────

describe('pruneRetention', () => {
  function seed(now: number) {
    // Old terminal job (well past any retention window).
    db.insertJob({ id: 'OLD-DONE', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o', status: 'completed', queuedAt: now - 40 * DAY, completedAt: now - 40 * DAY });
    db.appendJobEvent({ jobId: 'OLD-DONE', at: now - 40 * DAY, event: 'completed' });
    // Recent terminal job (inside the window).
    db.insertJob({ id: 'NEW-DONE', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o', status: 'failed', queuedAt: now - 1 * DAY, completedAt: now - 1 * DAY });
    db.appendJobEvent({ jobId: 'NEW-DONE', at: now - 1 * DAY, event: 'failed' });
    // Old NON-terminal jobs — must always survive regardless of age.
    db.insertJob({ id: 'OLD-QUEUED', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o', status: 'queued', queuedAt: now - 40 * DAY });
    db.insertJob({ id: 'OLD-RUNNING', kind: 'agent', project: 'P', objective: 'o', outputDir: '/o', status: 'running', queuedAt: now - 40 * DAY });
    // Old request_log row — NEVER auto-pruned.
    db.insertRequestLog({ id: 'OLD-REQ', receivedAt: now - 40 * DAY, plane: 'query', method: 'GET', path: '/p' });
  }

  it('retentionDays = 0 keeps everything, including old terminal rows', () => {
    const now = Date.now();
    seed(now);
    assert.equal(db.pruneRetention(0, now), 0);
    assert.ok(db.getJob('OLD-DONE'));
    assert.equal(db.listJobEvents('OLD-DONE').length, 1);
    assert.equal(db.listJobs().length, 4);
    assert.ok(db.getRequestLog('OLD-REQ'));
  });

  it('negative retentionDays is also a no-op', () => {
    const now = Date.now();
    seed(now);
    assert.equal(db.pruneRetention(-5, now), 0);
    assert.ok(db.getJob('OLD-DONE'));
  });

  it('positive retentionDays prunes only OLD TERMINAL jobs + their events', () => {
    const now = Date.now();
    seed(now);
    const pruned = db.pruneRetention(7, now);
    assert.equal(pruned, 1);

    // Old terminal job + its events gone.
    assert.equal(db.getJob('OLD-DONE'), undefined);
    assert.equal(db.listJobEvents('OLD-DONE').length, 0);

    // Recent terminal survives.
    assert.ok(db.getJob('NEW-DONE'));
    assert.equal(db.listJobEvents('NEW-DONE').length, 1);

    // Non-terminal (even old) survives.
    assert.ok(db.getJob('OLD-QUEUED'));
    assert.ok(db.getJob('OLD-RUNNING'));

    // request_log is NEVER auto-pruned.
    assert.ok(db.getRequestLog('OLD-REQ'));
  });
});
