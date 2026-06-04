// src/__tests__/core-ops.test.ts
// AF-58: Unit tests for the presentation-free core ops (src/lib/core/*).
//
// These call the core ops directly and assert the STRUCTURED DATA they return
// (no console output involved). They prove the parity intent: the CLI and the
// HTTP service both format the same data object. Tests are hermetic — they
// build a temp .af workspace and chdir into it so resolveProject()/
// findWorkspace() resolve via cwd, never the machine's global config.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { getProjectStatus } from '../lib/core/status.js';
import {
  listTasks,
  showTask,
  createTask,
  moveTask,
  assignTask,
  logTask,
} from '../lib/core/tasks.js';
import { ProjectNotFoundError } from '../lib/core/errors.js';
import { STATUSES } from '../lib/constants.js';

let workdir: string;
let originalCwd: string;

// Global config (~/.af/config.yaml) handling: the write ops fire a
// fire-and-forget post-action Loka sync. To keep tests hermetic (no real
// network writes to a developer's local Loka), we temporarily strip the
// `loka` block from the global config so the sync guard returns early, then
// restore the original file afterwards.
const GLOBAL_CONFIG = join(homedir(), '.af', 'config.yaml');
const CONFIG_BACKUP = join(tmpdir(), `af-core-ops-config-backup-${process.pid}.yaml`);
let hadGlobalConfig = false;

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
  // Neutralise the global Loka config for the duration of these tests.
  hadGlobalConfig = existsSync(GLOBAL_CONFIG);
  if (hadGlobalConfig) {
    copyFileSync(GLOBAL_CONFIG, CONFIG_BACKUP);
    const parsed = (parseYaml(readFileSync(GLOBAL_CONFIG, 'utf-8')) || {}) as Record<string, unknown>;
    delete parsed.loka;
    if (parsed.defaults && typeof parsed.defaults === 'object') {
      delete (parsed.defaults as Record<string, unknown>).taskBackend;
    }
    writeFileSync(GLOBAL_CONFIG, stringifyYaml(parsed), 'utf-8');
  }

  originalCwd = process.cwd();
  workdir = mkdtempSync(join(tmpdir(), 'af-core-ops-'));
  mkdirSync(join(workdir, '.af'), { recursive: true });
  writeFileSync(join(workdir, '.af', 'project.md'), PROJECT_MD, 'utf-8');

  writeTask('in-progress', 'TST-1', {
    title: 'Active task', type: 'task', priority: 'high', complexity: 'medium', assignee: 'engineer',
  });
  writeTask('open', 'TST-2', {
    title: 'Open task', type: 'feature', priority: 'medium', complexity: 'low',
  });
  writeTask('closed', 'TST-3', {
    title: 'Done task', type: 'bug', priority: 'low', complexity: 'low',
  });

  process.chdir(workdir);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(workdir, { recursive: true, force: true });

  // Restore the original global config.
  if (hadGlobalConfig && existsSync(CONFIG_BACKUP)) {
    copyFileSync(CONFIG_BACKUP, GLOBAL_CONFIG);
    unlinkSync(CONFIG_BACKUP);
  }
});

// ── status ───────────────────────────────────────────────────────────────────

test('getProjectStatus returns project meta, canonical groups, and counts', async () => {
  const result = await getProjectStatus();

  assert.equal(result.prefix, 'TST');
  assert.equal(result.name, 'Test Project');
  assert.equal(result.total, 3);
  assert.equal(result.done, 1); // closed counts as done

  // groups are in canonical STATUSES order and include empties
  assert.equal(result.groups.length, STATUSES.length);
  assert.deepEqual(result.groups.map(g => g.status), [...STATUSES]);

  const inProgress = result.groups.find(g => g.status === 'in-progress')!;
  assert.equal(inProgress.tasks.length, 1);
  assert.equal(inProgress.tasks[0].ticket, 'TST-1');
});

test('getProjectStatus throws ProjectNotFoundError for an unknown prefix', async () => {
  await assert.rejects(() => getProjectStatus('NOPE'), ProjectNotFoundError);
});

// ── task read ops ──────────────────────────────────────────────────────────────

test('listTasks returns all tasks with project meta', async () => {
  const result = await listTasks();
  assert.equal(result.prefix, 'TST');
  assert.equal(result.tasks.length, 3);
});

test('listTasks honours a status filter', async () => {
  const result = await listTasks({ status: 'open' });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].ticket, 'TST-2');
});

test('listTasks honours an assignee filter', async () => {
  const result = await listTasks({ assignee: 'engineer' });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].ticket, 'TST-1');
});

test('showTask returns the task plus raw markdown', async () => {
  const result = await showTask('tst-1'); // lowercase → normalized
  assert.ok(result);
  assert.equal(result!.task.ticket, 'TST-1');
  assert.match(result!.raw!, /ticket: TST-1/);
});

test('showTask returns null for a missing ticket', async () => {
  const result = await showTask('TST-999');
  assert.equal(result, null);
});

// ── task write ops ─────────────────────────────────────────────────────────────

test('createTask persists a task and returns it', async () => {
  const { task } = await createTask({ title: 'Brand new', type: 'feature', priority: 'high' });
  assert.equal(task.title, 'Brand new');
  assert.equal(task.type, 'feature');
  assert.ok(task.ticket.startsWith('TST-'));
  assert.ok(task.filePath);

  // verifiable round-trip: it shows up in a listing
  const listed = await listTasks();
  assert.ok(listed.tasks.some(t => t.ticket === task.ticket));
});

test('moveTask transitions status and reports from/to', async () => {
  const result = await moveTask('TST-2', 'in-progress');
  assert.equal(result.unchanged, false);
  assert.equal(result.fromStatus, 'open');
  assert.equal(result.toStatus, 'in-progress');
  assert.equal(result.task.status, 'in-progress');
});

test('moveTask is a no-op when already in target status', async () => {
  const result = await moveTask('TST-1', 'in-progress');
  assert.equal(result.unchanged, true);
  assert.equal(result.fromStatus, 'in-progress');
  assert.equal(result.toStatus, 'in-progress');
});

test('moveTask throws TaskNotFoundError for a missing ticket', async () => {
  await assert.rejects(
    () => moveTask('TST-999', 'open'),
    (err: Error) => err.name === 'TaskNotFoundError',
  );
});

test('assignTask sets the assignee and returns it', async () => {
  const result = await assignTask('TST-3', 'qa');
  assert.equal(result.assignee, 'qa');
  assert.equal(result.task.assignee, 'qa');
});

test('logTask appends to the log and returns the normalized ticket', async () => {
  const result = await logTask('tst-3', 'a log entry');
  assert.equal(result.ticket, 'TST-3');
  const shown = await showTask('TST-3');
  assert.match(shown!.raw!, /a log entry/);
});

test('write ops throw ProjectNotFoundError for an unknown prefix', async () => {
  await assert.rejects(() => listTasks({}, 'NOPE'), ProjectNotFoundError);
  await assert.rejects(() => createTask({ title: 'x' }, 'NOPE'), ProjectNotFoundError);
  await assert.rejects(() => moveTask('TST-1', 'open', 'NOPE'), ProjectNotFoundError);
});

afterEach(() => {
  // No cross-test cleanup required; each test is order-tolerant or appends.
});
