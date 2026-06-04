// src/commands/serve.ts
// AF-53: `af serve` — the authenticated AF HTTP service skeleton.
// Feature-flagged behind ENABLE_AF_53.
//
// Scope of AF-54 (this file): flag gate, config load + secret/bind resolution,
// fail-closed bind (Decision 4 / §14 R2), constant-time bearer auth on every
// request, and a single read route GET /health. The queue, SQLite layer, and
// the /jobs · /audit · query/mutation routes land in later tickets — the router
// and the withAuth wrapper below are the seams they mount onto.

import { createServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { ENABLE_AF_53 } from '../lib/constants.js';
import { loadConfig } from '../lib/config.js';
import {
  resolveServiceConfig,
  resolveTailscaleIp,
  decideBind,
  type ResolvedServiceConfig,
} from '../lib/service-config.js';
import { isAuthorized } from '../lib/service-auth.js';
import { openServiceDb, type ServiceDb } from '../lib/service-db.js';
import { error } from '../lib/format.js';

export interface ServeOptions {
  port?: number;
  /** Override bind address (also via AF_SERVICE_BIND). */
  bind?: string;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** A route handler: receives the request, response, and the resolved config. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ResolvedServiceConfig,
) => void | Promise<void>;

/**
 * Wrap a handler so every request is authenticated first (design §9: auth on
 * every route). Missing / wrong bearer → 401, handler never runs. Later tickets
 * mount their route handlers through this same wrapper.
 */
export function withAuth(handler: RouteHandler): RouteHandler {
  return (req, res, cfg) => {
    if (!isAuthorized(req.headers['authorization'], cfg.secret)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }
    return handler(req, res, cfg);
  };
}

// ── Routes (AF-54: /health only) ─────────────────────────────────────────────

/**
 * GET /health → { ok, running, queued, capacity }. The queue is not built yet,
 * so running/queued are placeholder zeros; capacity reflects AF_MAX_CONCURRENCY.
 */
const healthRoute: RouteHandler = (_req, res, cfg) => {
  sendJson(res, 200, {
    ok: true,
    running: 0,
    queued: 0,
    capacity: cfg.maxConcurrency,
  });
};

/**
 * Minimal router. Keyed by "METHOD path"; later tickets add /jobs, /audit, and
 * the query/mutation routes here. All entries go through withAuth.
 */
export function buildRouter(): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();
  routes.set('GET /health', withAuth(healthRoute));
  return routes;
}

/** Dispatch a request to the router, returning 404 for unknown routes. */
export async function dispatch(
  routes: Map<string, RouteHandler>,
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ResolvedServiceConfig,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0];
  const handler = routes.get(`${method} ${path}`);
  if (!handler) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }
  try {
    await handler(req, res, cfg);
  } catch (err: any) {
    process.stderr.write(`[serve] Unhandled error: ${err?.message ?? String(err)}\n`);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
  }
}

// ── Command entry ────────────────────────────────────────────────────────────

export async function serveCommand(options: ServeOptions): Promise<void> {
  // 1. Flag gate (checked once at entry, mirroring webhook/ENABLE_AF_12).
  //    Off → disabled notice, exit 0, no listener opened.
  if (!ENABLE_AF_53) {
    console.log('AF-53 service (af serve) is not enabled. Set ENABLE_AF_53=true in constants.ts to enable.');
    process.exit(0);
  }

  // 2. Resolve config (env overrides the `service` config block, §8).
  const config = loadConfig();
  const resolved = resolveServiceConfig(config.service);

  // CLI flags win over env/config for port and bind.
  if (options.port !== undefined) resolved.port = options.port;
  if (options.bind !== undefined) resolved.bind = options.bind;

  // 3. Secret is required — fail to start with a clear error if missing (§9).
  if (!resolved.secret) {
    console.log(error(
      'Service secret not configured. Set AF_SERVICE_SECRET, or add service.secret to ~/.af/config.yaml\n' +
      'Example:\n  service:\n    secret: <shared_secret>\n    port: 4150',
    ));
    process.exit(1);
  }

  // 4. Resolve bind address: explicit (config/env/flag) or the Tailscale IPv4.
  const bindAddress = resolved.bind ?? resolveTailscaleIp() ?? '';

  // 5. Fail-closed bind safety (Decision 4 / §14 R2): never silently fall back
  //    to 0.0.0.0 / a public interface. Refuse to start, bind nothing.
  const decision = decideBind(bindAddress, resolved.allowPublic);
  if (!decision.ok) {
    console.log(error(`Cannot start af serve: ${decision.reason}`));
    process.exit(1);
  }
  const host = decision.address;

  // 6. Open the SQLite store (AF-55): creates/opens cfg.db, enables WAL, applies
  //    the §7 schema. Then reconcile on boot so no in-flight job is silently lost
  //    across a restart — orphaned `running` rows become `failed` (re-dispatchable)
  //    and still-`queued` rows are reported for re-dispatch (the queue lands in AF-56).
  let db: ServiceDb;
  try {
    db = openServiceDb(resolved.db);
  } catch (err: any) {
    console.log(error(`Cannot open service database at ${resolved.db}: ${err?.message ?? String(err)}`));
    process.exit(1);
  }
  const reconciled = db.reconcileOnBoot();
  console.log(
    `Storage: ${resolved.db} (WAL) — reconcile: ${reconciled.requeued} queued re-dispatchable, ${reconciled.failed} orphaned running → failed`,
  );

  // Retention (Decision 10): boot-time sweep + a daily timer. Default 0 = keep
  // everything; request_log is never pruned. The timer is unref'd so it never
  // keeps the process alive on its own.
  if (resolved.retentionDays > 0) {
    const pruned = db.pruneRetention(resolved.retentionDays);
    console.log(`Retention: ${resolved.retentionDays}d — pruned ${pruned} terminal job(s) on boot`);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    setInterval(() => {
      try {
        db.pruneRetention(resolved.retentionDays);
      } catch (err: any) {
        process.stderr.write(`[serve] retention sweep failed: ${err?.message ?? String(err)}\n`);
      }
    }, ONE_DAY_MS).unref();
  }

  // 7. Build the router (auth-wrapped) and the HTTP server.
  const routes = buildRouter();
  const server = createServer((req, res) => {
    void dispatch(routes, req, res, resolved);
  });

  // 8. Listen on the resolved tailnet/loopback address only.
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(resolved.port, host, () => resolve());
  });

  console.log(`af serve listening on http://${host}:${resolved.port}`);
  console.log(`  GET /health   — health / capacity`);
  console.log(`  Auth: Authorization: Bearer <secret> required on every route`);
  console.log(`  Capacity: ${resolved.maxConcurrency}`);
  console.log(`Press Ctrl+C to stop.`);

  // 9. Graceful shutdown — close the DB connection before exit.
  const shutdown = () => {
    process.stdout.write('\nShutting down af serve...\n');
    try {
      db.close();
    } catch { /* best-effort */ }
    server.close(() => process.exit(0));
    setTimeout(() => {
      process.stderr.write('Forced exit after timeout.\n');
      process.exit(1);
    }, 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive until a signal arrives.
  await new Promise<never>(() => { /* run forever */ });
}
