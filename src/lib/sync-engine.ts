// src/lib/sync-engine.ts
// SyncEngine: reconciles tasks between FileProvider (local) and LokaProvider (remote).
// Implements push, pull, and bidirectional modes with Last-Write-Wins conflict resolution.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { Task, TaskUpdateInput } from './task-provider.js';
import { FileProvider } from './providers/file-provider.js';
import { LokaProvider } from './providers/loka-provider.js';

export type SyncMode = 'push' | 'pull' | 'bidirectional';

export interface SyncResult {
  pushed: string[];      // tickets pushed AF → Loka
  pulled: string[];      // tickets pulled Loka → AF
  created: string[];     // new tickets created
  conflicts: string[];   // conflict resolutions applied
  errors: SyncError[];   // non-fatal errors
  skipped: string[];     // archived/excluded
}

export interface SyncError {
  ticket: string;
  message: string;
}

export interface SyncOptions {
  mode: SyncMode;
  dryRun?: boolean;      // log what would happen, don't mutate
  verbose?: boolean;
}

export class SyncEngine {
  constructor(
    private fileProvider: FileProvider,
    private lokaProvider: LokaProvider,
    private afPath: string,
  ) {}

  async sync(options: SyncOptions): Promise<SyncResult> {
    const result: SyncResult = {
      pushed: [],
      pulled: [],
      created: [],
      conflicts: [],
      errors: [],
      skipped: [],
    };

    const { mode, dryRun = false, verbose = false } = options;

    if (verbose) process.stdout.write(`[sync] Starting ${mode} sync (dry-run: ${dryRun})\n`);

    // 1. Load tasks from both providers
    const [localTasks, remoteTasks] = await Promise.all([
      this.fileProvider.list().catch(err => {
        result.errors.push({ ticket: '*', message: `Failed to load local tasks: ${err.message}` });
        return [] as Task[];
      }),
      this.lokaProvider.list().catch(err => {
        result.errors.push({ ticket: '*', message: `Failed to load remote tasks: ${err.message}` });
        return [] as Task[];
      }),
    ]);

    if (verbose) {
      process.stdout.write(`[sync] Loaded ${localTasks.length} local, ${remoteTasks.length} remote tasks\n`);
    }

    // 2. Build index maps
    const localByTicket = new Map<string, Task>();
    const localByLokaRef = new Map<string, Task>();

    for (const t of localTasks) {
      localByTicket.set(t.ticket, t);
      if (t.lokaRef) {
        localByLokaRef.set(t.lokaRef, t);
      }
    }

    const remoteByTicket = new Map<string, Task>();
    for (const t of remoteTasks) {
      remoteByTicket.set(t.ticket, t);
    }

    // 3. Process remote tasks
    const matchedLocalTickets = new Set<string>();

    for (const remote of remoteTasks) {
      // Find matching local task: first by loka-ref (externalId), then by ticket
      let local = remote.externalId ? localByLokaRef.get(remote.externalId) : undefined;
      if (!local) {
        local = localByTicket.get(remote.ticket);
      }

      if (!local) {
        // NEW_REMOTE: task exists in Loka but not locally
        if (mode === 'pull' || mode === 'bidirectional') {
          if (verbose) process.stdout.write(`[sync] Creating local task ${remote.ticket} (new remote)\n`);
          if (!dryRun) {
            try {
              const created = await this.createLocalFromRemote(remote);
              result.created.push(created.ticket);
              result.pulled.push(created.ticket);
            } catch (err: any) {
              result.errors.push({ ticket: remote.ticket, message: `Failed to create local: ${err.message}` });
            }
          } else {
            result.created.push(remote.ticket);
            result.pulled.push(remote.ticket);
          }
        } else {
          // push mode: skip new remote tasks
          result.skipped.push(remote.ticket);
        }
        continue;
      }

      matchedLocalTickets.add(local.ticket);

      // EXISTING: task in both systems — reconcile
      const conflictOutcome = resolveConflict(local, remote);

      if (conflictOutcome === 'no-change') {
        if (verbose) process.stdout.write(`[sync] No change: ${local.ticket}\n`);
        // Still ensure loka-ref is set
        if (!local.lokaRef && remote.externalId && !dryRun) {
          await this.fileProvider.update(local.ticket, { lokaRef: remote.externalId }).catch(() => {});
        }
        continue;
      }

      if (mode === 'push') {
        // Push local to remote regardless of who's newer
        if (verbose) process.stdout.write(`[sync] Push ${local.ticket} → Loka\n`);
        if (!dryRun) {
          try {
            await this.pushToLoka(local, remote);
            result.pushed.push(local.ticket);
          } catch (err: any) {
            result.errors.push({ ticket: local.ticket, message: `Push failed: ${err.message}` });
          }
        } else {
          result.pushed.push(local.ticket);
        }
      } else if (mode === 'pull') {
        // Pull remote to local regardless of who's newer
        if (verbose) process.stdout.write(`[sync] Pull ${remote.ticket} → local\n`);
        if (!dryRun) {
          try {
            await this.pullToLocal(local, remote);
            result.pulled.push(local.ticket);
          } catch (err: any) {
            result.errors.push({ ticket: local.ticket, message: `Pull failed: ${err.message}` });
          }
        } else {
          result.pulled.push(local.ticket);
        }
      } else {
        // bidirectional: Last-Write-Wins
        if (conflictOutcome === 'local-wins') {
          if (verbose) process.stdout.write(`[sync] LWW local wins: ${local.ticket} (push)\n`);
          if (!dryRun) {
            try {
              await this.pushToLoka(local, remote);
              result.pushed.push(local.ticket);
              result.conflicts.push(local.ticket);
            } catch (err: any) {
              result.errors.push({ ticket: local.ticket, message: `Push failed: ${err.message}` });
            }
          } else {
            result.pushed.push(local.ticket);
            result.conflicts.push(local.ticket);
          }
        } else {
          // remote-wins
          if (verbose) process.stdout.write(`[sync] LWW remote wins: ${local.ticket} (pull)\n`);
          if (!dryRun) {
            try {
              await this.pullToLocal(local, remote);
              result.pulled.push(local.ticket);
              result.conflicts.push(local.ticket);
            } catch (err: any) {
              result.errors.push({ ticket: local.ticket, message: `Pull failed: ${err.message}` });
            }
          } else {
            result.pulled.push(local.ticket);
            result.conflicts.push(local.ticket);
          }
        }
      }
    }

    // 4. Process local tasks not matched to remote
    for (const local of localTasks) {
      if (matchedLocalTickets.has(local.ticket)) continue;

      // Local-only task
      if (mode === 'push' || mode === 'bidirectional') {
        if (verbose) process.stdout.write(`[sync] Push new local task ${local.ticket} → Loka\n`);
        if (!dryRun) {
          try {
            const remote = await this.lokaProvider.create({
              title: local.title,
              type: local.type,
              priority: local.priority,
              assignee: local.assignee,
              due: local.due,
              description: local.description,
              design: local.design,
            });
            // Store loka-ref
            await this.fileProvider.update(local.ticket, { lokaRef: remote.externalId });
            result.created.push(local.ticket);
            result.pushed.push(local.ticket);
            // Advance local counter if needed
            await this.advanceCounterIfNeeded(local.ticket, remote.ticket);
          } catch (err: any) {
            result.errors.push({ ticket: local.ticket, message: `Create in Loka failed: ${err.message}` });
          }
        } else {
          result.created.push(local.ticket);
          result.pushed.push(local.ticket);
        }
      } else {
        // pull mode: skip local-only tasks
        result.skipped.push(local.ticket);
      }
    }

    return result;
  }

  /**
   * Create a local task file from a remote Loka task.
   */
  private async createLocalFromRemote(remote: Task): Promise<Task> {
    // Parse ticket number to advance local counter if needed
    const match = remote.ticket.match(/^([A-Za-z]+)-(\d+)$/);
    if (match) {
      const lokaNumber = parseInt(match[2], 10);
      await this.advanceCounterIfNeeded(remote.ticket, remote.ticket, lokaNumber);
    }

    // Write file directly to preserve loka-ref and ticket number
    const today = new Date().toISOString().split('T')[0];
    const taskMeta: Record<string, unknown> = {
      ticket: remote.ticket,
      title: remote.title,
      type: remote.type || 'task',
      status: remote.status,
      priority: remote.priority || 'medium',
      complexity: remote.complexity || 'medium',
      created: remote.created || today,
      updated: remote.updated || today,
    };
    if (remote.assignee) taskMeta.assignee = remote.assignee;
    if (remote.due) taskMeta.due = remote.due;
    if (remote.externalId) taskMeta['loka-ref'] = remote.externalId;

    const bodyText = remote.description
      ? `\n${remote.description}\n`
      : `\n# ${remote.title}\n\n## Objective\n\n## Context\n\n## Acceptance\n- [ ] \n\n## Log\n`;

    const taskContent = matter.stringify(bodyText, taskMeta);

    const { mkdirSync } = await import('fs');
    const taskDir = join(this.afPath, 'tasks', remote.status);
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, `${remote.ticket}.md`);
    writeFileSync(filePath, taskContent);

    return {
      ...remote,
      lokaRef: remote.externalId,
      filePath,
    };
  }

  /**
   * Push local task fields to Loka.
   */
  private async pushToLoka(local: Task, remote: Task): Promise<void> {
    const update: TaskUpdateInput = {};
    let hasChanges = false;

    if (local.title !== remote.title) { update.title = local.title; hasChanges = true; }
    if (local.description !== remote.description) { update.description = local.description; hasChanges = true; }
    if (local.priority !== remote.priority) { update.priority = local.priority; hasChanges = true; }
    if (local.assignee !== remote.assignee) { update.assignee = local.assignee ?? null; hasChanges = true; }
    if (local.due !== remote.due) { update.due = local.due ?? null; hasChanges = true; }

    if (hasChanges) {
      await this.lokaProvider.update(remote.ticket, update);
    }

    if (local.status !== remote.status) {
      await this.lokaProvider.move(remote.ticket, local.status);
    }

    // Store loka-ref if not already set
    if (!local.lokaRef && remote.externalId) {
      await this.fileProvider.update(local.ticket, { lokaRef: remote.externalId });
    }
  }

  /**
   * Pull remote task fields to local.
   */
  private async pullToLocal(local: Task, remote: Task): Promise<void> {
    const update: TaskUpdateInput = {};
    let hasChanges = false;

    if (remote.title !== local.title) { update.title = remote.title; hasChanges = true; }
    if (remote.description !== local.description) { update.description = remote.description; hasChanges = true; }
    if (remote.priority !== local.priority) { update.priority = remote.priority; hasChanges = true; }
    if (remote.assignee !== local.assignee) { update.assignee = remote.assignee ?? null; hasChanges = true; }
    if (remote.due !== local.due) { update.due = remote.due ?? null; hasChanges = true; }

    // Always store loka-ref
    if (!local.lokaRef && remote.externalId) {
      update.lokaRef = remote.externalId;
      hasChanges = true;
    }

    if (hasChanges) {
      await this.fileProvider.update(local.ticket, update);
    }

    if (remote.status !== local.status) {
      await this.fileProvider.move(local.ticket, remote.status);
    }
  }

  /**
   * Advance the project.md counter if a Loka ticket number is >= current counter.
   */
  private async advanceCounterIfNeeded(
    _localTicket: string,
    _remoteTicket: string,
    lokaNumber?: number,
  ): Promise<void> {
    if (lokaNumber === undefined) {
      const match = _remoteTicket.match(/^[A-Za-z]+-(\d+)$/);
      if (!match) return;
      lokaNumber = parseInt(match[1], 10);
    }

    const projectFile = join(this.afPath, 'project.md');
    if (!existsSync(projectFile)) return;

    try {
      const raw = readFileSync(projectFile, 'utf-8');
      const parsed = matter(raw);
      const currentCounter = (parsed.data.counter as number) || 1;

      if (lokaNumber >= currentCounter) {
        parsed.data.counter = lokaNumber + 1;
        writeFileSync(projectFile, matter.stringify(parsed.content, parsed.data));
      }
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Last-Write-Wins conflict resolution.
 * Compares updatedAt timestamps lexicographically (ISO 8601 sorts correctly).
 */
export function resolveConflict(
  local: Task,
  remote: Task,
): 'local-wins' | 'remote-wins' | 'no-change' {
  const localTs = local.updated ?? '';
  const remoteTs = remote.updated ?? '';

  if (localTs === remoteTs) return 'no-change';
  return localTs > remoteTs ? 'local-wins' : 'remote-wins';
}
