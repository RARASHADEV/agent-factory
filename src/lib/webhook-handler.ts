// src/lib/webhook-handler.ts
// WebhookHandler: processes incoming Loka webhook payloads.
// Validates HMAC-SHA256 signatures, resolves projects, and applies task mutations.

import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { FileProvider } from './providers/file-provider.js';
import { resolveProject } from './workspace.js';
import { auditLog } from './audit.js';
import type { LokaConfig } from './config.js';
import type { TaskUpdateInput } from './task-provider.js';

// ── Payload types ──────────────────────────────────────────────────────────

export interface WebhookTaskPayload {
  id: string;
  ticket: string;
  ticketNumber: number;
  title: string;
  description: string | null;
  status: string;
  statusCategory: string;
  priority: string;
  assignee: string | null;
  dueDate: string | null;
  updatedAt: string;
}

export interface WebhookPayload {
  event: 'task.updated' | 'task.created' | 'task.deleted';
  deliveryId: string;
  timestamp: string;
  projectPrefix: string;
  task: WebhookTaskPayload;
  changedFields: string[];
}

// ── Default status/priority maps (mirrors loka-provider.ts) ───────────────

const DEFAULT_STATUS_MAP: Record<string, string> = {
  'backlog':         'Backlog',
  'open':            'Open',
  'in-progress':     'In Progress',
  'ready-for-qa':    'Ready for QA',
  'uat':             'UAT',
  'ready-4-release': 'Ready for Release',
  'released':        'Released',
  'closed':          'Closed',
  'blocked':         'Blocked',
};

const DEFAULT_PRIORITY_MAP: Record<string, string> = {
  'critical': 'Urgent',
  'high':     'High',
  'medium':   'Medium',
  'low':      'Low',
};

/** Map a Loka status display name back to an AF status slug. */
function mapLokaStatus(lokaStatusName: string, lokaConfig: LokaConfig): string {
  const statusSrc = lokaConfig.statusMap ?? DEFAULT_STATUS_MAP;
  for (const [afSlug, lokaName] of Object.entries(statusSrc)) {
    if (lokaName.toLowerCase() === lokaStatusName.toLowerCase()) return afSlug;
  }
  // Fallback: slugify the Loka name
  return lokaStatusName.toLowerCase().replace(/\s+/g, '-');
}

/** Map a Loka priority display name back to an AF priority slug. */
function mapLokaPriority(lokaPriorityName: string, lokaConfig: LokaConfig): string {
  const prioritySrc = lokaConfig.priorityMap ?? DEFAULT_PRIORITY_MAP;
  for (const [afSlug, lokaName] of Object.entries(prioritySrc)) {
    if (lokaName.toLowerCase() === lokaPriorityName.toLowerCase()) return afSlug;
  }
  return lokaPriorityName.toLowerCase();
}

// ── WebhookHandler ─────────────────────────────────────────────────────────

/** Maximum request body size: 1 MB */
const MAX_BODY_BYTES = 1024 * 1024;

/** Validate ticket format to prevent path traversal */
const TICKET_RE = /^[A-Z]+-\d+$/;

export class WebhookHandler {
  /**
   * In-memory idempotency cache.
   * Stores delivery UUIDs seen during this server process lifetime.
   * Capped at MAX_CACHE_SIZE; when full, the oldest half is evicted.
   */
  private deliveryCache: Set<string> = new Set();
  private deliveryCacheOrder: string[] = [];
  private readonly MAX_CACHE_SIZE = 10_000;

  constructor(
    private readonly secret: string,
    private readonly lokaConfig: LokaConfig,
    private readonly verbose: boolean = false,
  ) {}

  // ── Public entry point ────────────────────────────────────────────────────

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // 1. Read raw body (capped at 1 MB)
      const rawBody = await this.readBody(req);
      if (rawBody === null) {
        this.sendJson(res, 413, { ok: false, error: 'Request body too large (max 1 MB)' });
        return;
      }

      // 2. Verify HMAC signature
      const signature = req.headers['x-loka-signature'];
      if (!signature || typeof signature !== 'string') {
        this.sendJson(res, 401, { ok: false, error: 'Missing X-Loka-Signature header' });
        return;
      }

      if (!this.verifySignature(rawBody, signature)) {
        if (this.verbose) {
          process.stderr.write('[webhook] 401 Invalid signature\n');
        }
        this.sendJson(res, 401, { ok: false, error: 'Invalid signature' });
        return;
      }

      // 3. Parse JSON
      let payload: WebhookPayload;
      try {
        payload = JSON.parse(rawBody.toString('utf-8')) as WebhookPayload;
      } catch {
        this.sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
        return;
      }

      // 4. Validate required fields
      const validationError = this.validatePayload(payload);
      if (validationError) {
        this.sendJson(res, 400, { ok: false, error: validationError });
        return;
      }

      // 5. Idempotency check
      const deliveryId = payload.deliveryId
        || (req.headers['x-loka-delivery'] as string | undefined)
        || '';

      if (deliveryId && this.deliveryCache.has(deliveryId)) {
        if (this.verbose) {
          process.stderr.write(`[webhook] Skipping duplicate delivery: ${deliveryId}\n`);
        }
        this.sendJson(res, 200, {
          ok: true,
          ticket: payload.task.ticket,
          action: 'skipped',
          reason: 'duplicate delivery',
        });
        return;
      }

      // 6. Resolve project workspace
      const resolved = resolveProject(payload.projectPrefix);
      if (!resolved) {
        this.sendJson(res, 400, {
          ok: false,
          error: `Project not found: ${payload.projectPrefix}`,
        });
        return;
      }
      const { afPath, meta } = resolved;

      // 7. Create FileProvider
      const fileProvider = new FileProvider(afPath, meta);

      // 8. Dispatch on event type
      let action = 'updated';
      try {
        switch (payload.event) {
          case 'task.updated':
            await this.applyUpdate(fileProvider, payload);
            action = 'updated';
            break;
          case 'task.created':
            await this.applyCreate(fileProvider, payload);
            action = 'created';
            break;
          case 'task.deleted':
            // We don't delete local files — just log and acknowledge
            if (this.verbose) {
              process.stderr.write(`[webhook] task.deleted for ${payload.task.ticket} — local file kept\n`);
            }
            action = 'skipped';
            break;
        }
      } catch (err: any) {
        // If the task wasn't found locally, return graceful skip
        if (err?.constructor?.name === 'TaskNotFoundError' || err?.message?.includes('not found')) {
          process.stderr.write(`[webhook] Warning: ${payload.task.ticket} not found locally, skipping\n`);

          auditLog(afPath, {
            event: 'webhook.receive',
            ticket: payload.task.ticket,
            actor: 'webhook',
            detail: `Webhook ${payload.event} skipped — task not found locally`,
            meta: { deliveryId, event: payload.event },
          });

          this.addToCache(deliveryId);
          this.sendJson(res, 200, {
            ok: true,
            ticket: payload.task.ticket,
            action: 'skipped',
            reason: 'task not found locally',
          });
          return;
        }

        // File provider threw an unexpected error — let Loka retry (5xx)
        process.stderr.write(`[webhook] Error processing ${payload.task.ticket}: ${err?.message}\n`);

        auditLog(afPath, {
          event: 'webhook.error',
          ticket: payload.task.ticket,
          actor: 'webhook',
          detail: `Webhook error: ${err?.message}`,
          meta: { deliveryId, event: payload.event, error: err?.message },
        });

        this.sendJson(res, 500, { ok: false, error: 'Internal error processing webhook' });
        return;
      }

      // 9. Record delivery for idempotency
      this.addToCache(deliveryId);

      // 10. Audit log successful processing
      auditLog(afPath, {
        event: 'webhook.receive',
        ticket: payload.task.ticket,
        actor: 'webhook',
        detail: `Webhook ${payload.event}: ${payload.changedFields.join(', ')}`,
        meta: { deliveryId, event: payload.event, changedFields: payload.changedFields },
      });

      if (this.verbose) {
        process.stderr.write(
          `[webhook] Processed ${payload.event} for ${payload.task.ticket} (delivery: ${deliveryId})\n`,
        );
      }

      this.sendJson(res, 200, {
        ok: true,
        ticket: payload.task.ticket,
        action,
      });

    } catch (err: any) {
      process.stderr.write(`[webhook] Unhandled error: ${err?.message ?? String(err)}\n`);
      this.sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  /**
   * Apply a task.updated webhook to the local file.
   * Updates changed fields and moves the file if status changed.
   */
  private async applyUpdate(fileProvider: FileProvider, payload: WebhookPayload): Promise<void> {
    const { task, changedFields } = payload;

    const update: TaskUpdateInput = {};

    if (changedFields.includes('title')) {
      update.title = task.title;
    }
    if (changedFields.includes('priority')) {
      update.priority = mapLokaPriority(task.priority, this.lokaConfig);
    }
    if (changedFields.includes('assignee')) {
      update.assignee = task.assignee ?? null;
    }
    if (changedFields.includes('dueDate')) {
      update.due = task.dueDate ?? null;
    }
    if (changedFields.includes('description')) {
      update.description = task.description ?? '';
    }

    if (Object.keys(update).length > 0) {
      await fileProvider.update(task.ticket, update);
    }

    // Status change triggers a file move (separate from field update)
    if (changedFields.includes('status')) {
      const existingTask = await fileProvider.get(task.ticket);
      if (!existingTask) return;

      const afStatus = mapLokaStatus(task.status, this.lokaConfig);
      if (afStatus !== existingTask.status) {
        await fileProvider.move(task.ticket, afStatus);
      }
    }
  }

  /**
   * Apply a task.created webhook.
   * If the task already exists locally, treat it as an update instead.
   */
  private async applyCreate(fileProvider: FileProvider, payload: WebhookPayload): Promise<void> {
    const { task } = payload;

    // Check if task already exists
    const existing = await fileProvider.get(task.ticket);
    if (existing) {
      // Treat as a full update
      const allFields = ['title', 'priority', 'assignee', 'dueDate', 'description', 'status'];
      await this.applyUpdate(fileProvider, { ...payload, changedFields: allFields });
      return;
    }

    // Create new task from webhook payload
    const afStatus = mapLokaStatus(task.status, this.lokaConfig);
    const afPriority = mapLokaPriority(task.priority, this.lokaConfig);

    await fileProvider.create({
      ticket: task.ticket,
      title: task.title,
      description: task.description ?? '',
      priority: afPriority as any,
      assignee: task.assignee ?? undefined,
      due: task.dueDate ?? undefined,
    });

    // Move to the correct status folder (create always puts in backlog)
    if (afStatus !== 'backlog') {
      try {
        await fileProvider.move(task.ticket, afStatus);
      } catch {
        // Non-fatal — task was created, status move failed
        process.stderr.write(`[webhook] Warning: created ${task.ticket} but failed to move to ${afStatus}\n`);
      }
    }
  }

  // ── Signature verification ────────────────────────────────────────────────

  /**
   * Verify HMAC-SHA256 signature using timing-safe comparison.
   * Expected signature format: "sha256=<hex-digest>"
   */
  private verifySignature(rawBody: Buffer, signature: string): boolean {
    const expected = 'sha256=' + createHmac('sha256', this.secret)
      .update(rawBody)
      .digest('hex');

    if (expected.length !== signature.length) return false;

    try {
      return timingSafeEqual(Buffer.from(expected, 'utf-8'), Buffer.from(signature, 'utf-8'));
    } catch {
      return false;
    }
  }

  // ── Validation ────────────────────────────────────────────────────────────

  private validatePayload(payload: WebhookPayload): string | null {
    if (!payload.projectPrefix) return 'Missing required field: projectPrefix';
    if (!payload.event) return 'Missing required field: event';
    if (!payload.task) return 'Missing required field: task';
    if (!payload.task.ticket) return 'Missing required field: task.ticket';

    if (!TICKET_RE.test(payload.task.ticket)) {
      return `Invalid ticket format: ${payload.task.ticket}`;
    }

    const validEvents = ['task.updated', 'task.created', 'task.deleted'];
    if (!validEvents.includes(payload.event)) {
      return `Unknown event type: ${payload.event}`;
    }

    return null;
  }

  // ── Idempotency cache ────────────────────────────────────────────────────

  private addToCache(deliveryId: string): void {
    if (!deliveryId) return;

    if (this.deliveryCache.size >= this.MAX_CACHE_SIZE) {
      // Evict oldest half
      const evictCount = Math.floor(this.MAX_CACHE_SIZE / 2);
      const toEvict = this.deliveryCacheOrder.splice(0, evictCount);
      for (const id of toEvict) {
        this.deliveryCache.delete(id);
      }
    }

    this.deliveryCache.add(deliveryId);
    this.deliveryCacheOrder.push(deliveryId);
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }

  /**
   * Read the full request body, respecting MAX_BODY_BYTES limit.
   * Returns null if the body exceeds the limit.
   */
  private readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooLarge = false;

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          tooLarge = true;
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (!tooLarge) {
          resolve(Buffer.concat(chunks));
        }
      });

      req.on('error', reject);
    });
  }
}
