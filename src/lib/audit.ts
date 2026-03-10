import { appendFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ENABLE_AF_8 } from './constants.js';

// --- Types ---

export type AuditEvent =
  | 'project.init'
  | 'task.create'
  | 'task.move'
  | 'task.assign'
  | 'spawn.start'
  | 'spawn.complete'
  | 'spawn.fail'
  | 'spawn.status_check'
  | 'agent.sync';

export interface AuditEntry {
  timestamp: string;        // ISO 8601
  event: AuditEvent;
  ticket?: string;          // Task ticket (e.g. "AF-8"), optional for non-task events
  agent?: string;           // Agent slug, if applicable
  actor: string;            // "cli" | agent slug | "system"
  detail: string;           // Human-readable description
  meta?: Record<string, unknown>; // Optional structured data
}

/**
 * Append a single audit entry to .af/audit.log.
 * Creates file if it doesn't exist. Synchronous (appendFileSync).
 * Never throws — catches all errors and warns to stderr.
 */
export function auditLog(afPath: string, entry: Omit<AuditEntry, 'timestamp'>): void {
  if (!ENABLE_AF_8) return;
  try {
    const logFile = join(afPath, 'audit.log');
    const fullEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(logFile, JSON.stringify(fullEntry) + '\n', 'utf-8');
  } catch (err: any) {
    process.stderr.write(`[audit] Warning: failed to write audit log: ${err?.message ?? String(err)}\n`);
  }
}

/**
 * Read and optionally filter audit entries.
 * Returns entries in chronological order.
 * Returns [] if file doesn't exist. Skips malformed lines with a stderr warning.
 */
export function readAuditLog(
  afPath: string,
  filters?: {
    ticket?: string;
    event?: AuditEvent;
    since?: string;       // ISO date, entries >= this timestamp
    limit?: number;       // Max entries to return (from tail)
  }
): AuditEntry[] {
  const logFile = join(afPath, 'audit.log');
  if (!existsSync(logFile)) return [];

  const raw = readFileSync(logFile, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim() !== '');

  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      process.stderr.write(`[audit] Warning: skipping malformed audit log line\n`);
    }
  }

  let result = entries;

  if (filters?.ticket) {
    result = result.filter(e => e.ticket === filters.ticket);
  }
  if (filters?.event) {
    result = result.filter(e => e.event === filters.event);
  }
  if (filters?.since) {
    const since = filters.since;
    result = result.filter(e => e.timestamp >= since);
  }
  if (filters?.limit && filters.limit > 0) {
    result = result.slice(-filters.limit);
  }

  return result;
}
