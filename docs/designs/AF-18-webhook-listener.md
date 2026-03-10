# AF-18: Webhook Listener for Loka -> AF Sync

## Overview

Build a lightweight HTTP webhook server (`af webhook serve`) that receives task mutation events from Loka and applies them to local `.af/tasks/` files in real-time. This closes the sync loop: AF-16 handles AF->Loka push; this ticket handles Loka->AF pull via webhooks instead of manual `af sync --pull`.

The server uses Node's built-in `http` module (no Express), authenticates requests via HMAC-SHA256 signatures, and reuses the existing `SyncEngine.pullToLocal()` / `FileProvider` logic for idempotent local file updates.

## Architecture

```
Loka UI (status change, assignment, etc.)
  |
  v
Loka Backend --- POST /webhook ---> AF Webhook Server (af webhook serve)
  (HMAC-signed)                       |
                                      v
                                  Validate signature
                                      |
                                      v
                                  Parse payload, resolve project
                                      |
                                      v
                                  FileProvider.get(ticket)
                                      |
                                      v
                                  FileProvider.update() / .move()
                                      |
                                      v
                                  auditLog() -> .af/audit.log
                                      |
                                      v
                                  HTTP 200 { ok: true }
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| CLI command | `src/commands/webhook.ts` | `af webhook serve` — starts HTTP server |
| Webhook handler | `src/lib/webhook-handler.ts` | Request parsing, signature verification, event dispatch |
| CLI registration | `src/cli.ts` | Register `webhook` subcommand |
| Config extension | `src/lib/config.ts` | Add `webhook` section to `GlobalConfig` |
| Audit events | `src/lib/audit.ts` | Add `webhook.receive` and `webhook.error` event types |
| Constants | `src/lib/constants.ts` | No new flag needed — reuse `ENABLE_AF_12` |

### Key Design Decisions

1. **No new feature flag** — reuse `ENABLE_AF_12`. The webhook is part of the Loka sync subsystem. When `ENABLE_AF_12` is false, `af webhook serve` exits with an error message (same pattern as `af sync`).

2. **HMAC-SHA256 over Bearer token** — HMAC signatures prove the payload wasn't tampered with in transit. Bearer tokens only prove identity but don't protect payload integrity. The shared secret is stored in `~/.af/config.yaml` under `loka.webhook.secret`.

3. **Node `http` module** — no Express dependency. The server handles exactly one route: `POST /webhook`. Everything else returns 404.

4. **Reuse FileProvider directly** — rather than going through `SyncEngine.pullToLocal()` (which requires a `LokaProvider` and full task listing), the webhook handler calls `FileProvider.get()`, `FileProvider.update()`, and `FileProvider.move()` directly. This is simpler and avoids unnecessary Loka API calls (the webhook *is* the Loka data).

5. **Multi-project support** — the webhook payload includes `projectPrefix`, which is used to resolve the correct `.af/` workspace from the global config's `projects` list.

## API Design

### Webhook Endpoint (AF side)

```
POST /webhook
Content-Type: application/json
X-Loka-Signature: sha256=<hex-hmac>
X-Loka-Delivery: <uuid>
X-Loka-Event: task.updated
```

#### Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | Must be `application/json` |
| `X-Loka-Signature` | Yes | `sha256=<HMAC-SHA256 hex digest of raw body using shared secret>` |
| `X-Loka-Delivery` | Yes | Unique delivery UUID for idempotency tracking |
| `X-Loka-Event` | Yes | Event type: `task.updated`, `task.created`, `task.deleted` |

#### Webhook Payload Schema

```typescript
interface WebhookPayload {
  event: 'task.updated' | 'task.created' | 'task.deleted';
  deliveryId: string;          // UUID — same as X-Loka-Delivery header
  timestamp: string;           // ISO 8601
  projectPrefix: string;       // e.g. "AF"
  task: {
    id: string;                // Loka UUID
    ticket: string;            // e.g. "AF-18"
    ticketNumber: number;      // e.g. 18
    title: string;
    description: string | null;
    status: string;            // Loka status display name, e.g. "In Progress"
    statusCategory: string;    // "backlog" | "active" | "closed"
    priority: string;          // Loka priority display name, e.g. "High"
    assignee: string | null;   // Assignee display name or null
    dueDate: string | null;    // ISO date or null
    updatedAt: string;         // ISO 8601
  };
  changedFields: string[];     // e.g. ["status", "assignee"] — which fields changed
}
```

#### Response Schema

**Success (200):**
```json
{
  "ok": true,
  "ticket": "AF-18",
  "action": "updated"
}
```

**Already processed / idempotent skip (200):**
```json
{
  "ok": true,
  "ticket": "AF-18",
  "action": "skipped",
  "reason": "duplicate delivery"
}
```

**Auth failure (401):**
```json
{
  "ok": false,
  "error": "Invalid signature"
}
```

**Bad request (400):**
```json
{
  "ok": false,
  "error": "Missing required field: projectPrefix"
}
```

**Feature disabled (503):**
```json
{
  "ok": false,
  "error": "Loka sync is not enabled"
}
```

### Webhook Registration (Loka side — contract)

Loka needs a webhook management API (or config UI) where users can register a callback URL. The registration model:

```typescript
interface WebhookRegistration {
  url: string;              // e.g. "http://192.168.1.100:4100/webhook"
  secret: string;           // shared secret for HMAC signing
  events: string[];         // ["task.updated", "task.created", "task.deleted"]
  projectIds?: string[];    // optional — filter by project (empty = all)
  active: boolean;          // enable/disable
}
```

**Loka responsibilities:**
1. Sign every webhook POST with HMAC-SHA256 using the registered secret
2. Include `X-Loka-Signature`, `X-Loka-Delivery`, `X-Loka-Event` headers
3. Retry failed deliveries (5xx) up to 3 times with exponential backoff
4. Log delivery status (success/fail/timeout) for debugging
5. Map internal task mutations to the `WebhookPayload` schema above

This may need a corresponding LOK task for the Loka side implementation.

## Data Model

### No new data structures

The webhook does not introduce a database. It uses:
- **Existing task files** via `FileProvider.get()`, `.update()`, `.move()`
- **In-memory Set** for idempotency (delivery IDs seen during this server process lifetime)
- **Existing config** (`~/.af/config.yaml`) for webhook settings

### Config Extension

Add to `GlobalConfig.loka`:

```typescript
// In LokaConfig interface (src/lib/config.ts)
export interface LokaConfig {
  // ... existing fields ...
  webhook?: {
    /** Shared secret for HMAC signature verification */
    secret: string;
    /** Port to listen on. Default: 4100 */
    port?: number;
  };
}
```

Example `~/.af/config.yaml`:

```yaml
loka:
  url: http://loka.internal:3333/api/v1
  apiKey: lok_xxxx
  webhook:
    secret: whsec_a1b2c3d4e5f6...
    port: 4100
```

### Audit Event Types

Add to `AuditEvent` union in `src/lib/audit.ts`:

```typescript
export type AuditEvent =
  // ... existing ...
  | 'webhook.receive'   // successfully processed a webhook
  | 'webhook.error';    // webhook processing failed
```

## Implementation Notes

### 1. File: `src/commands/webhook.ts`

```typescript
// Pseudocode
export interface WebhookServeOptions {
  port?: number;
  project?: string;  // optional: restrict to single project
  verbose?: boolean;
}

export async function webhookServeCommand(options: WebhookServeOptions): Promise<void> {
  // 1. Guard: ENABLE_AF_12
  // 2. Load config, check loka.webhook.secret exists
  // 3. Resolve port: options.port ?? config.loka.webhook.port ?? 4100
  // 4. Create WebhookHandler instance
  // 5. Create http.createServer, route:
  //    - POST /webhook → handler.handle(req, res)
  //    - GET /health → 200 { status: "ok" }
  //    - Everything else → 404
  // 6. server.listen(port)
  // 7. console.log("Webhook server listening on port {port}")
  // 8. Handle SIGINT/SIGTERM for graceful shutdown
}
```

### 2. File: `src/lib/webhook-handler.ts`

This is the core logic file. Pseudocode:

```typescript
export class WebhookHandler {
  private deliveryCache: Set<string>;  // In-memory idempotency (last N deliveries)
  private readonly MAX_CACHE_SIZE = 10000;

  constructor(
    private secret: string,
    private verbose: boolean,
  ) {
    this.deliveryCache = new Set();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Read raw body (Buffer) for signature verification
    // 2. Verify HMAC signature:
    //    - Extract X-Loka-Signature header
    //    - Compute HMAC-SHA256 of raw body with this.secret
    //    - Timing-safe comparison (crypto.timingSafeEqual)
    //    - Return 401 if mismatch
    // 3. Parse JSON body as WebhookPayload
    // 4. Validate required fields (projectPrefix, task.ticket, event)
    // 5. Check idempotency:
    //    - If deliveryId in deliveryCache, return 200 { action: "skipped" }
    //    - Add to cache (evict oldest if > MAX_CACHE_SIZE)
    // 6. Resolve project workspace:
    //    - Use resolveProject(payload.projectPrefix)
    //    - Return 400 if project not found
    // 7. Create FileProvider for the resolved workspace
    // 8. Apply changes based on event type:
    //    - task.updated: applyUpdate(fileProvider, payload)
    //    - task.created: applyCreate(fileProvider, afPath, payload)
    //    - task.deleted: log only (don't delete local files)
    // 9. Audit log the webhook receipt
    // 10. Return 200 { ok: true }
  }

  private async applyUpdate(fileProvider, payload): Promise<void> {
    // Get existing task
    const task = await fileProvider.get(payload.task.ticket);
    if (!task) {
      // Task doesn't exist locally — skip or create
      return;
    }

    // Build update input from changed fields
    const update: TaskUpdateInput = {};
    if (payload.changedFields.includes('title')) update.title = payload.task.title;
    if (payload.changedFields.includes('priority')) {
      // Map Loka priority name → AF priority using reverse map
      update.priority = mapLokaPriority(payload.task.priority);
    }
    if (payload.changedFields.includes('assignee')) {
      update.assignee = payload.task.assignee ?? null;
    }
    if (payload.changedFields.includes('dueDate')) {
      update.due = payload.task.dueDate ?? null;
    }
    if (payload.changedFields.includes('description')) {
      update.description = payload.task.description ?? '';
    }

    // Apply field updates
    if (Object.keys(update).length > 0) {
      await fileProvider.update(payload.task.ticket, update);
    }

    // Handle status change separately (triggers file move)
    if (payload.changedFields.includes('status')) {
      const afStatus = mapLokaStatus(payload.task.status);
      if (afStatus && afStatus !== task.status) {
        await fileProvider.move(payload.task.ticket, afStatus);
      }
    }
  }

  private verifySignature(rawBody: Buffer, signature: string): boolean {
    // signature format: "sha256=<hex>"
    const expected = 'sha256=' + crypto
      .createHmac('sha256', this.secret)
      .update(rawBody)
      .digest('hex');

    // Timing-safe comparison
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  }
}
```

### 3. Status Mapping

The webhook handler needs the same status/priority mapping as `LokaProvider`. Extract the default maps from `loka-provider.ts` into a shared utility, or duplicate the reverse maps in the handler. Recommended approach: create a small shared function in a new file `src/lib/loka-maps.ts` (or inline in webhook-handler):

```typescript
// Reverse map: Loka display name → AF slug
// Use config.loka.statusMap (reversed) or DEFAULT_STATUS_MAP (reversed)
function mapLokaStatus(lokaStatusName: string, config: LokaConfig): string {
  const statusMap = config.statusMap ?? DEFAULT_STATUS_MAP;
  // Build reverse: find AF slug where value matches lokaStatusName
  for (const [afSlug, lokaName] of Object.entries(statusMap)) {
    if (lokaName.toLowerCase() === lokaStatusName.toLowerCase()) return afSlug;
  }
  // Fallback: slugify the Loka name
  return lokaStatusName.toLowerCase().replace(/\s+/g, '-');
}
```

### 4. Idempotency Strategy

- **In-memory Set** of delivery UUIDs (from `X-Loka-Delivery` / `payload.deliveryId`)
- Capped at 10,000 entries; when full, clear the oldest half (or use a simple FIFO eviction)
- This handles the common case: Loka retries within seconds/minutes
- On server restart, the cache is empty — but the operations are inherently idempotent:
  - `FileProvider.move()` to same status = no-op (returns task unchanged)
  - `FileProvider.update()` with same values = writes same content (harmless)

### 5. CLI Registration

In `src/cli.ts`, add:

```typescript
const webhook = program.command('webhook');

webhook
  .command('serve')
  .description('Start webhook listener for Loka → AF sync')
  .option('-p, --port <port>', 'Port to listen on', '4100')
  .option('--project <prefix>', 'Restrict to a single project')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (opts) => {
    const { webhookServeCommand } = await import('./commands/webhook.js');
    await webhookServeCommand({
      port: parseInt(opts.port, 10),
      project: opts.project,
      verbose: opts.verbose,
    });
  });
```

### 6. Graceful Shutdown

```typescript
process.on('SIGINT', () => {
  console.log('\nShutting down webhook server...');
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
```

### 7. Error Handling

| Scenario | Response | Behavior |
|----------|----------|----------|
| Invalid signature | 401 | Log to audit as `webhook.error` |
| Malformed JSON | 400 | Return error message |
| Missing required fields | 400 | Return which field is missing |
| Unknown project prefix | 400 | Return "project not found" |
| Task not found locally | 200 | Log warning, return `{ action: "skipped", reason: "task not found locally" }` |
| FileProvider throws | 500 | Log error, Loka will retry |
| `ENABLE_AF_12` off | 503 | Immediate rejection |

### 8. Security Considerations

- **HMAC-SHA256** with timing-safe comparison prevents signature forgery
- **Secret rotation**: if the secret changes, both Loka and AF config must be updated. No hot-reload — restart `af webhook serve`
- **No path traversal**: ticket numbers are validated against `^[A-Z]+-\d+$` pattern before being passed to `FileProvider`
- **Request size limit**: reject bodies > 1MB to prevent memory exhaustion
- **Bind address**: default to `0.0.0.0` but document that users should firewall or bind to a specific interface in production

### 9. Logging

Every webhook receipt logs to both stderr (for operator visibility) and `.af/audit.log`:

```typescript
// Successful processing
auditLog(afPath, {
  event: 'webhook.receive',
  ticket: payload.task.ticket,
  actor: 'webhook',
  detail: `Webhook ${payload.event}: ${payload.changedFields.join(', ')}`,
  meta: { deliveryId: payload.deliveryId, event: payload.event },
});

// Error during processing
auditLog(afPath, {
  event: 'webhook.error',
  ticket: payload.task.ticket,
  actor: 'webhook',
  detail: `Webhook error: ${err.message}`,
  meta: { deliveryId: payload.deliveryId, event: payload.event, error: err.message },
});
```

## Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| Node `http` module | Built-in | HTTP server |
| Node `crypto` module | Built-in | HMAC-SHA256 signature verification |
| `FileProvider` | Internal | Task file read/write/move |
| `resolveProject` | Internal | Map projectPrefix to .af/ path |
| `auditLog` | Internal | Audit logging |
| `loadConfig` | Internal | Read webhook secret and port |
| `gray-matter` | Existing dep | Used by FileProvider |
| AF-16 (post-action-sync) | Prerequisite | Must be complete (listed as dependency in task) |

**No new npm dependencies required.**

### Loka Side (External)

A corresponding LOK task should be created for Loka to implement:
1. Webhook registration API or config UI
2. HMAC-SHA256 signing of outbound webhook payloads
3. Retry logic for failed deliveries
4. The `WebhookPayload` schema defined above

## Implementation Role

**ENGINEER** — This is entirely backend: Node.js HTTP server, filesystem operations, HMAC crypto. No frontend/UI components.

## Feature Flag

- **Flag Name:** `ENABLE_AF_12` (existing flag — no new flag needed)
- **Guard:** `webhookServeCommand()` checks `ENABLE_AF_12` at entry and exits with error if disabled
- **Default:** Already `true` in current codebase

## Complexity Estimate

**Medium-High** — The HTTP server and HMAC auth are straightforward, but the handler needs careful integration with FileProvider, status mapping, and idempotency. Estimated 3-4 files to create/modify.

## Files to Create

1. `src/commands/webhook.ts` — CLI command
2. `src/lib/webhook-handler.ts` — Core webhook processing logic

## Files to Modify

1. `src/cli.ts` — Register `webhook serve` subcommand
2. `src/lib/config.ts` — Add `webhook` to `LokaConfig` interface
3. `src/lib/audit.ts` — Add `webhook.receive` and `webhook.error` to `AuditEvent` union
