// src/lib/audit-bridge.ts
// AuditBridge: posts AF agent activity events as comments on Loka tasks.
// Fire-and-forget. Never throws. Silently skips if Loka not configured.
// Feature-flagged behind ENABLE_AF_12.

import { loadConfig } from './config.js';
import { ENABLE_AF_12 } from './constants.js';
import { LokaHttpClient } from './providers/loka-http-client.js';
import { LokaProvider } from './providers/loka-provider.js';

/**
 * Post an agent activity entry as a comment on the corresponding Loka task.
 *
 * Usage (fire-and-forget — do NOT await):
 *   void postActivityToLoka(afPath, ticket, `🤖 Agent ${slug} started...`);
 *
 * Silently skips if:
 *   - ENABLE_AF_12 is false
 *   - Loka is not configured in ~/.af/config.yaml
 *   - config.loka.sync.postActivity is false
 *
 * Warns to stderr on failure, never crashes.
 */
export async function postActivityToLoka(
  _afPath: string,
  ticket: string,
  entry: string,
): Promise<void> {
  if (!ENABLE_AF_12) return;

  try {
    const config = loadConfig();
    if (!config.loka?.url || !config.loka?.apiKey) return;

    // Respect postActivity setting (default: true)
    if (config.loka.sync?.postActivity === false) return;

    const client = new LokaHttpClient({
      baseUrl: config.loka.url,
      apiKey: config.loka.apiKey,
    });

    // Parse ticket prefix
    const match = ticket.match(/^([A-Za-z]+)-(\d+)$/);
    if (!match) return;

    const [, prefix, numStr] = match;

    // Find the task by ticket
    const tasks = await client.get<Array<{ id: string }>>('/tasks', {
      projectPrefix: prefix,
      ticketNumber: numStr,
    });

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return;
    const taskId = tasks[0].id;
    if (!taskId) return;

    await client.post(`/tasks/${taskId}/comments`, { content: entry });
  } catch (err: any) {
    // Never crash — warn to stderr
    process.stderr.write(
      `[audit-bridge] Warning: failed to post activity to Loka for ${ticket}: ${err?.message ?? String(err)}\n`
    );
  }
}
