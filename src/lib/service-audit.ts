// src/lib/service-audit.ts
// AF-53 / AF-69: the log-first / log-last audit middleware for `af serve`.
//
// Design §1.1 + §5.4: a single audit middleware wraps EVERY route (execution,
// query, mutation) and implements the flow `request → ① log → ② AF → ③ log → ④ consumer`:
//
//   ① log-first  — BEFORE routing/handler runs, INSERT a `request_log` row
//                  (received_at, caller, plane, method, path, operation, project,
//                   payload — with the bearer + secret-bearing fields STRIPPED).
//                  This happens even for requests that will be rejected (401/400/429):
//                  the journal records attempts, not just successes.
//   ③ log-last   — after the handler produces a response, UPDATE the same row with
//                  status, outcome, result_summary, responded_at. Committed BEFORE
//                  the response bytes leave the box (ordering guarantee, §5.4).
//
// Secret hygiene (§9): the stored `payload` must NEVER contain the bearer or any
// secret-bearing field. AF-55's insertRequestLog stores the payload verbatim, so
// stripping happens HERE before the row is written.
//
// This module is kept pure-ish (the DB is injected) so the log-first / strip /
// log-last pieces can be unit-tested without a live socket, and so the Stage B
// route tickets (AF-59/AF-60) inherit logging automatically by registering their
// route in the AUDIT_ROUTES mapping and mounting through `wrapWithAudit`.

import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

import type { ServiceDb, NewRequestLog } from './service-db.js';
import type { ResolvedServiceConfig } from './service-config.js';
import type { RouteHandler } from '../commands/serve.js';

// ── Plane / operation mapping (extensible — Stage B routes slot in here) ───────

/** The three audit planes (design §7.2). */
export type Plane = 'execution' | 'query' | 'mutation';

/** Audit metadata for a route: which plane it belongs to + its logical operation. */
export interface RouteAuditMeta {
  plane: Plane;
  operation: string;
}

/**
 * Route → {plane, operation} registry. Keyed by `"METHOD path"` for exact routes;
 * dynamic routes (e.g. `/jobs/:id`) are matched by `matchDynamicAuditMeta` below.
 *
 * AF-69 only needs the routes that exist today (`/jobs*`, `/audit`, `/health`).
 * The map is the extension seam: AF-59 (query plane) and AF-60 (mutation plane)
 * register their routes here and they are logged automatically, with no change to
 * the middleware. Keep this the single source of truth for plane/operation.
 */
export const AUDIT_ROUTES: ReadonlyMap<string, RouteAuditMeta> = new Map<string, RouteAuditMeta>([
  // Execution plane (Stage A).
  ['POST /jobs', { plane: 'execution', operation: 'agent.spawn' }],
  ['GET /jobs', { plane: 'query', operation: 'jobs.list' }],
  // Observability service (read-only, unqueued).
  ['GET /audit', { plane: 'query', operation: 'audit.list' }],
  ['GET /health', { plane: 'query', operation: 'health.get' }],
  // Query plane (AF-59 — read-only, synchronous, NEVER queued). The dynamic
  // id-bearing routes (/projects/:p/*, /tasks/:ticket, /agents/:slug,
  // /pipelines/:ticket) are resolved by matchDynamicAuditMeta below.
  ['GET /projects', { plane: 'query', operation: 'projects.list' }],
  ['GET /agents', { plane: 'query', operation: 'agents.list' }],
  ['GET /pipelines', { plane: 'query', operation: 'pipelines.list' }],
  // Mutation plane (AF-60 — synchronous writes, NEVER queued). The dynamic
  // id-bearing routes (POST /projects/:p/tasks, PATCH /tasks/:ticket) are
  // resolved by matchDynamicAuditMeta below.
  ['POST /projects', { plane: 'mutation', operation: 'projects.init' }],
  ['POST /agents/sync', { plane: 'mutation', operation: 'agents.sync' }],
  ['POST /sync', { plane: 'mutation', operation: 'projects.sync' }],
]);

/**
 * Resolve audit metadata for dynamic routes that carry an id segment. Returns
 * undefined when the path is not one of these (the caller falls back to a default).
 */
export function matchDynamicAuditMeta(method: string, path: string): RouteAuditMeta | undefined {
  if (method === 'POST' && /^\/jobs\/[^/]+\/(pause|resume)$/.test(path)) {
    return { plane: 'execution', operation: 'pipeline.control' };
  }
  if (method === 'GET' && /^\/jobs\/[^/]+$/.test(path)) {
    return { plane: 'query', operation: 'jobs.get' };
  }
  // AF-59 query plane — id-bearing read routes (all sync, unqueued).
  if (method === 'GET' && /^\/projects\/[^/]+\/status$/.test(path)) {
    return { plane: 'query', operation: 'projects.status' };
  }
  if (method === 'GET' && /^\/projects\/[^/]+\/tasks$/.test(path)) {
    return { plane: 'query', operation: 'tasks.list' };
  }
  if (method === 'GET' && /^\/tasks\/[^/]+$/.test(path)) {
    return { plane: 'query', operation: 'tasks.show' };
  }
  if (method === 'GET' && /^\/agents\/[^/]+$/.test(path)) {
    return { plane: 'query', operation: 'agents.show' };
  }
  if (method === 'GET' && /^\/pipelines\/[^/]+$/.test(path)) {
    return { plane: 'query', operation: 'pipelines.status' };
  }
  // AF-60 mutation plane — id-bearing write routes (all sync, NEVER queued).
  if (method === 'POST' && /^\/projects\/[^/]+\/tasks$/.test(path)) {
    return { plane: 'mutation', operation: 'tasks.create' };
  }
  // PATCH /tasks/:ticket multiplexes move/assign/log by body field; the precise
  // sub-operation is not known until the handler inspects the body, so the journal
  // records the generic 'tasks.update' (the status/result_summary still attribute it).
  if (method === 'PATCH' && /^\/tasks\/[^/]+$/.test(path)) {
    return { plane: 'mutation', operation: 'tasks.update' };
  }
  return undefined;
}

/**
 * Resolve the {plane, operation} for a request. Exact routes win; then dynamic
 * `/jobs/:id` routes; otherwise a permissive default so an unknown/404 route is
 * still logged (an attempt is an attempt). GET defaults to the query plane and a
 * write method to the mutation plane.
 */
export function resolveAuditMeta(method: string, path: string): RouteAuditMeta {
  const exact = AUDIT_ROUTES.get(`${method} ${path}`);
  if (exact) return exact;
  const dynamic = matchDynamicAuditMeta(method, path);
  if (dynamic) return dynamic;
  // Unknown route: still log the attempt. Classify the plane by HTTP method so the
  // journal stays sensible even for 404s.
  const plane: Plane = method === 'GET' || method === 'HEAD' ? 'query' : 'mutation';
  return { plane, operation: 'unknown' };
}

// ── Caller attribution (§7.2) ──────────────────────────────────────────────────

/**
 * Derive the caller from an optional client-supplied header. AF-56 uses a single
 * shared secret (no per-client identity), so the caller is whatever the client
 * volunteers via `X-AF-Caller` (preferred) or `X-AF-Client`, else null. Never
 * derived from the bearer (that is the secret).
 */
export function deriveCaller(headers: IncomingMessage['headers']): string | null {
  const raw = headers['x-af-caller'] ?? headers['x-af-client'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, 256);
}

// ── Secret hygiene (§9 — strip bearer + secret-bearing fields) ─────────────────

/**
 * Field names whose VALUES must never be persisted. Matched case-insensitively as
 * a substring so `secret`, `apiKey`, `authorization`, `access_token`, `password`,
 * etc. are all caught regardless of casing/separators.
 */
const SECRET_FIELD_SUBSTRINGS: readonly string[] = [
  'secret',
  'token',
  'password',
  'passwd',
  'authorization',
  'auth',
  'bearer',
  'apikey',
  'api_key',
  'credential',
  'private_key',
  'privatekey',
];

const REDACTED = '[REDACTED]';

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_FIELD_SUBSTRINGS.some((needle) => k.includes(needle));
}

/**
 * Recursively redact secret-bearing fields from an arbitrary JSON-ish value. The
 * structure/keys are preserved (so the journal still shows WHAT was sent) but any
 * value under a secret-named key becomes `[REDACTED]`. Arrays and nested objects
 * are walked. Cyclic graphs are guarded. Pure; never mutates the input.
 */
export function stripSecrets<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripSecrets(v, seen)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value as object)) return value;
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : stripSecrets(v, seen);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Serialize a request body for the journal with secrets stripped. Returns a JSON
 * string (or null for an empty body). Defensive: any serialization failure falls
 * back to a redacted marker rather than risking a raw secret in the log.
 */
export function serializePayload(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'object' && Object.keys(body as object).length === 0 && !Array.isArray(body)) {
    return null;
  }
  try {
    return JSON.stringify(stripSecrets(body));
  } catch {
    return JSON.stringify({ payload: REDACTED });
  }
}

// ── Body buffering (read the stream once, share it with the handler) ───────────

/**
 * Where the buffered, parsed request body is stashed on the IncomingMessage so the
 * downstream handler (`readJsonBody`) reuses it instead of re-reading the stream
 * (a stream can only be consumed once). Exported so service-jobs can read it.
 */
export const BUFFERED_BODY = Symbol.for('af.service.bufferedBody');

interface BufferedReq extends IncomingMessage {
  [BUFFERED_BODY]?: { parsed: Record<string, unknown> };
}

const MAX_BODY = 1024 * 1024; // 1 MiB guard (mirrors readJsonBody)

/**
 * Read the request body once, parse it as JSON (empty/invalid → {}), and stash the
 * parsed object on the request so the downstream handler reuses it. Returns the
 * parsed body for log-first payload capture. Never throws (audit must not break the
 * request): an oversized/invalid body yields {} and the handler re-validates.
 */
export async function bufferBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const method = req.method ?? 'GET';
  // GET/HEAD/DELETE carry no body of interest; skip reading the stream.
  if (method === 'GET' || method === 'HEAD') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  const parsed = await new Promise<Record<string, unknown>>((resolve) => {
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        resolve({});
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        const obj = JSON.parse(raw);
        resolve(obj && typeof obj === 'object' ? obj : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
  (req as BufferedReq)[BUFFERED_BODY] = { parsed };
  return parsed;
}

/**
 * Retrieve a pre-buffered body stashed by `bufferBody`, or undefined if none.
 * `readJsonBody` (service-jobs) calls this to avoid re-reading the stream.
 */
export function takeBufferedBody(req: IncomingMessage): Record<string, unknown> | undefined {
  return (req as BufferedReq)[BUFFERED_BODY]?.parsed;
}

// ── Outcome classification (§7.2 outcome column) ───────────────────────────────

/**
 * Map an HTTP status to the `outcome` enum (design §7.2):
 *   202 accepted (job queued) · 2xx ok · 4xx rejected · 5xx error.
 */
export function classifyOutcome(status: number): 'accepted' | 'ok' | 'rejected' | 'error' {
  if (status === 202) return 'accepted';
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 400 && status < 500) return 'rejected';
  if (status >= 500) return 'error';
  return 'ok';
}

/** Extract a short result summary from a JSON response body string (best-effort). */
export function summarize(status: number, responseBody: string): string | null {
  if (!responseBody) return null;
  try {
    const obj = JSON.parse(responseBody) as Record<string, unknown>;
    if (typeof obj.error === 'string') return obj.error.slice(0, 500);
    if (typeof obj.id === 'string') {
      const st = typeof obj.status === 'string' ? `:${obj.status}` : '';
      return `${obj.id}${st}`.slice(0, 500);
    }
    if (typeof obj.status === 'string') return obj.status.slice(0, 500);
  } catch {
    /* non-JSON body → no structured summary */
  }
  // Fall back to a terse marker so the row is never empty for an error status.
  return status >= 400 ? `status ${status}` : null;
}

// ── The middleware ─────────────────────────────────────────────────────────────

/**
 * Optional per-response captured fields the handler can surface to log-last. The
 * execution plane uses this to backfill `request_log.job_id` once the job row is
 * created (a `POST /jobs` returns 202 before the job is terminal).
 */
export interface AuditContext {
  /** Set by the execution handler so log-last can backfill request_log.job_id. */
  jobId?: string;
}

/** Where the per-request AuditContext is stashed so handlers can populate it. */
export const AUDIT_CONTEXT = Symbol.for('af.service.auditContext');

interface AuditedReq extends IncomingMessage {
  [AUDIT_CONTEXT]?: AuditContext;
}

/** Read the AuditContext for a request (handlers call this to set jobId). */
export function auditContext(req: IncomingMessage): AuditContext {
  const r = req as AuditedReq;
  if (!r[AUDIT_CONTEXT]) r[AUDIT_CONTEXT] = {};
  return r[AUDIT_CONTEXT]!;
}

/**
 * Wrap a route handler with the §5.4 log-first / log-last audit journal.
 *
 * Flow:
 *   ① buffer the body (so the payload can be logged AND the handler can re-read it)
 *      → INSERT a request_log row with the bearer/secret-stripped payload, BEFORE
 *      the handler runs. Even rejected requests are logged here.
 *   ②  run the inner handler.
 *   ③ intercept res.writeHead/res.end so the request_log row is UPDATED with the
 *      final status/outcome/result_summary/responded_at BEFORE the bytes are
 *      flushed (ordering guarantee). For 202 the outcome is 'accepted' and the
 *      handler-provided jobId (via auditContext) is backfilled.
 *
 * `meta` may be omitted; it is resolved from the route by `resolveAuditMeta`.
 */
export function wrapWithAudit(
  db: ServiceDb,
  handler: RouteHandler,
  meta?: RouteAuditMeta,
): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse, cfg: ResolvedServiceConfig) => {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];
    const routeMeta = meta ?? resolveAuditMeta(method, path);

    // Buffer the body up front so we can log its (stripped) payload AND let the
    // downstream handler re-read it. Never throws.
    const body = await bufferBody(req);
    const project = typeof body.project === 'string' ? body.project : null;

    const id = randomUUID();
    const entry: NewRequestLog = {
      id,
      receivedAt: Date.now(),
      caller: deriveCaller(req.headers),
      plane: routeMeta.plane,
      method,
      path,
      operation: routeMeta.operation,
      project,
      payload: serializePayload(body),
    };
    // ① log-first — committed BEFORE any work runs.
    try {
      db.insertRequestLog(entry);
    } catch {
      /* auditing must never break the request path */
    }

    // ③ log-last — intercept the response so the outcome is committed before bytes
    // leave. We capture the status + body, write the row, then delegate to the real
    // writeHead/end. Guard against double-finalization.
    let finalized = false;
    let capturedStatus = 0;
    let capturedBody = '';

    const finalize = (status: number) => {
      if (finalized) return;
      finalized = true;
      const ctx = auditContext(req);
      try {
        db.updateRequestLog(id, {
          status,
          outcome: classifyOutcome(status),
          resultSummary: summarize(status, capturedBody),
          respondedAt: Date.now(),
          ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
        });
      } catch {
        /* never break the response on an audit failure */
      }
    };

    const realWriteHead = res.writeHead.bind(res) as ServerResponse['writeHead'];
    const realEnd = res.end.bind(res) as ServerResponse['end'];

    (res as ServerResponse).writeHead = function patchedWriteHead(
      this: ServerResponse,
      status: number,
      ...rest: unknown[]
    ): ServerResponse {
      capturedStatus = status;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realWriteHead as any)(status, ...rest);
    } as ServerResponse['writeHead'];

    (res as ServerResponse).end = function patchedEnd(
      this: ServerResponse,
      chunk?: unknown,
      ...rest: unknown[]
    ): ServerResponse {
      if (typeof chunk === 'string') capturedBody += chunk;
      else if (Buffer.isBuffer(chunk)) capturedBody += chunk.toString('utf-8');
      // Commit ③ before the bytes leave the box.
      finalize(capturedStatus || res.statusCode || 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realEnd as any)(chunk, ...rest);
    } as ServerResponse['end'];

    try {
      await handler(req, res, cfg);
    } catch (err) {
      // The handler threw before sending anything. Record the error outcome and
      // rethrow so dispatch's catch can send the 500 (its res.end → finalize runs,
      // but `finalized` guards against a double-write).
      if (!finalized) finalize(500);
      throw err;
    }
  };
}
