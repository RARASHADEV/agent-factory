/**
 * AF-40 regression: LokaProvider.get() must return the task matching the
 * ticket number, not whichever task happens to be first in Loka's response.
 *
 * Root cause: Loka's /tasks endpoint silently ignores the `ticketNumber`
 * query param. The old implementation passed it in and then took tasks[0],
 * which always returned AF-24 (the first task in Loka's default sort).
 * Every update/move/assign/log call routed to the wrong task as a result.
 *
 * Run: npx tsx --test src/__tests__/loka-provider-get.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LokaProvider, type LokaFlatTask } from '../lib/providers/loka-provider.js';

function mkFlatTask(prefix: string, num: number, id: string, overrides: Partial<LokaFlatTask> = {}): LokaFlatTask {
  return {
    id,
    title: `${prefix}-${num}`,
    description: '',
    ticketNumber: num,
    status: 'Backlog',
    statusId: 'x',
    statusCategory: 'backlog',
    priority: 3,
    priorityId: 'p',
    priorityName: 'Medium',
    projectId: 'proj',
    projectPrefix: prefix,
    projectName: 'Test',
    assignee: null,
    assigneeId: null,
    tags: [],
    dueDate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    isCompleted: false,
    ...overrides,
  };
}

/**
 * Fake HTTP client that mimics Loka: /tasks ignores the ticketNumber param
 * and returns the whole project list. If the fix is missing, get() will
 * return the first item regardless of which ticket was asked for.
 */
class FakeClient {
  public lastParams: Record<string, string> | undefined;
  constructor(private tasks: LokaFlatTask[]) {}
  async get<T>(_path: string, params?: Record<string, string>): Promise<T> {
    this.lastParams = params;
    // Simulate Loka's behavior: returns full list regardless of ticketNumber
    return { tasks: this.tasks } as unknown as T;
  }
  async post<T>(): Promise<T> { throw new Error('unused'); }
  async patch<T>(): Promise<T> { throw new Error('unused'); }
  async delete(): Promise<void> { throw new Error('unused'); }
}

function mkProvider(tasks: LokaFlatTask[]) {
  const provider = new LokaProvider('http://test', 'key', 'AF', undefined, undefined);
  const client = new FakeClient(tasks);
  // Inject fake client and mark config-ready so ensureConfig() short-circuits.
  (provider as any).client = client;
  (provider as any).projectId = 'proj';
  (provider as any).configLoaded = true;
  (provider as any).statusMap = new Map([['released', 'Released']]);
  (provider as any).reverseStatusMap = new Map([['Released', 'released'], ['Backlog', 'backlog']]);
  (provider as any).priorityMap = new Map();
  (provider as any).reversePriorityMap = new Map([['Medium', 'medium']]);
  return { provider, client };
}

describe('LokaProvider.get() — AF-40 regression', () => {
  it('returns the task matching the requested ticketNumber, not tasks[0]', async () => {
    const tasks = [
      mkFlatTask('AF', 24, 'uuid-24'),
      mkFlatTask('AF', 28, 'uuid-28'),
      mkFlatTask('AF', 39, 'uuid-39'),
    ];
    const { provider } = mkProvider(tasks);

    const r28 = await provider.get('AF-28');
    const r39 = await provider.get('AF-39');
    const r24 = await provider.get('AF-24');

    assert.equal(r28?.ticket, 'AF-28', 'AF-28 must resolve to the AF-28 task (not AF-24)');
    assert.equal(r28?.externalId, 'uuid-28');
    assert.equal(r39?.ticket, 'AF-39');
    assert.equal(r39?.externalId, 'uuid-39');
    assert.equal(r24?.ticket, 'AF-24');
    assert.equal(r24?.externalId, 'uuid-24');
  });

  it('returns null when the ticket is not in Loka', async () => {
    const { provider } = mkProvider([mkFlatTask('AF', 24, 'uuid-24')]);
    const r = await provider.get('AF-999');
    assert.equal(r, null);
  });

  it('returns null for malformed ticket strings', async () => {
    const { provider } = mkProvider([mkFlatTask('AF', 24, 'uuid-24')]);
    assert.equal(await provider.get('not-a-ticket'), null);
    assert.equal(await provider.get(''), null);
  });

  it('does not send ticketNumber as a query param (Loka ignores it — filter client-side)', async () => {
    const { provider, client } = mkProvider([mkFlatTask('AF', 24, 'uuid-24')]);
    await provider.get('AF-24');
    assert.equal(client.lastParams?.projectPrefix, 'AF');
    assert.equal(client.lastParams?.ticketNumber, undefined, 'ticketNumber must not be sent (Loka ignores it)');
  });

  it('does not cross projects — AF-28 does not return MKT-28 with same ticket number', async () => {
    const tasks = [
      mkFlatTask('MKT', 28, 'mkt-28'),
      mkFlatTask('AF', 28, 'af-28'),
    ];
    const { provider } = mkProvider(tasks);
    const r = await provider.get('AF-28');
    assert.equal(r?.externalId, 'af-28', 'must match by projectPrefix as well as ticketNumber');
  });
});
