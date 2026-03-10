// src/lib/post-action-sync.ts
// Unified post-action sync hook for AF CLI task mutations.
// Fire-and-forget — call with `void postActionSync(...)`.
// Never throws. Warns to stderr on failure.

import { readFileSync, writeFileSync } from 'fs';
import matter from 'gray-matter';
import { loadConfig } from './config.js';
import { ENABLE_AF_12 } from './constants.js';
import { LokaProvider } from './providers/loka-provider.js';
import { FileProvider } from './providers/file-provider.js';
import { type ProjectMeta } from './workspace.js';
import { type TaskCreateInput } from './task-provider.js';



/**
 * Unified post-action sync hook.
 * Fire-and-forget — call with `void postActionSync(...)`.
 * Never throws. Warns to stderr on failure.
 */
export async function postActionSync(
  afPath: string,
  meta: ProjectMeta,
  ticket: string,
  action: 'create' | 'move' | 'assign' | 'log' | 'edit',
  context?: {
    createInput?: TaskCreateInput;  // only for action='create'
    targetStatus?: string;               // only for action='move'
    logEntry?: string;                   // only for action='log'
  },
): Promise<void> {
  // Guard: respects ENABLE_AF_12
  if (!ENABLE_AF_12) return;

  try {
    const config = loadConfig();

    // Guard: Loka must be configured
    if (!config.loka?.url || !config.loka?.apiKey) return;

    // Guard: skip if Loka is already the task backend (already synced via provider)
    if (config.defaults?.taskBackend === 'loka') return;

    const lokaProvider = new LokaProvider(
      config.loka.url,
      config.loka.apiKey,
      meta.prefix,
      config.loka.statusMap,
      config.loka.priorityMap,
    );

    switch (action) {
      case 'create':
        if (context?.createInput) {
          await lokaProvider.create({ ...context.createInput, ticket });
        }
        break;

      case 'move':
        if (context?.targetStatus) {
          await lokaProvider.move(ticket, context.targetStatus);
        }
        break;

      case 'assign': {
        const fileProvider = new FileProvider(afPath, meta);
        const task = await fileProvider.get(ticket);
        if (task) {
          await lokaProvider.update(ticket, { assignee: task.assignee });
        }
        break;
      }

      case 'log':
        await syncLogEntries(afPath, meta, ticket, lokaProvider);
        break;

      case 'edit': {
        const fileProvider = new FileProvider(afPath, meta);
        const task = await fileProvider.get(ticket);
        if (task) {
          await lokaProvider.update(ticket, {
            title: task.title,
            priority: task.priority,
            assignee: task.assignee,
            due: task.due,
          });
        }
        break;
      }
    }
  } catch (err: any) {
    process.stderr.write(
      `[post-action-sync] Warning: ${action} sync failed for ${ticket}: ${err?.message ?? String(err)}\n`,
    );
  }
}

/**
 * Parse log entries from task markdown, sync unsynced ones to Loka as comments.
 * Updates synced-log-count in frontmatter after successful sync.
 * Idempotent: uses synced-log-count to track position, skipping already-synced entries.
 */
async function syncLogEntries(
  afPath: string,
  meta: ProjectMeta,
  ticket: string,
  lokaProvider: LokaProvider,
): Promise<void> {
  const fileProvider = new FileProvider(afPath, meta);
  const task = await fileProvider.get(ticket);
  if (!task || !task.filePath) return;

  const raw = readFileSync(task.filePath, 'utf-8');
  const parsed = matter(raw);

  // Parse all log lines from the full raw content (log lines are appended after frontmatter)
  const LOG_LINE_RE = /^- \[([^\]]+)\] (.+)$/gm;
  const allLogLines: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = LOG_LINE_RE.exec(raw)) !== null) {
    allLogLines.push(match[0]); // full line: "- [timestamp] entry text"
  }

  // Read synced-log-count from frontmatter (default: 0)
  const syncedLogCount: number =
    typeof parsed.data['synced-log-count'] === 'number' ? parsed.data['synced-log-count'] : 0;

  const unsyncedEntries = allLogLines.slice(syncedLogCount);
  if (unsyncedEntries.length === 0) return;

  // Sync each unsynced entry sequentially; stop on first failure
  let lastSyncedIndex = syncedLogCount;
  for (let i = 0; i < unsyncedEntries.length; i++) {
    try {
      await lokaProvider.log(ticket, unsyncedEntries[i]);
      lastSyncedIndex = syncedLogCount + i + 1;
    } catch (err: any) {
      process.stderr.write(
        `[post-action-sync] Warning: log entry sync failed at index ${lastSyncedIndex}: ${err?.message ?? String(err)}\n`,
      );
      break;
    }
  }

  // Update synced-log-count in frontmatter if any entries were synced
  if (lastSyncedIndex > syncedLogCount) {
    parsed.data['synced-log-count'] = lastSyncedIndex;
    const updated = matter.stringify(parsed.content, parsed.data);
    writeFileSync(task.filePath, updated);
  }
}
