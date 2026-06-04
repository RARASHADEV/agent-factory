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

  // 6. Build the router (auth-wrapped) and the HTTP server.
  const routes = buildRouter();
  const server = createServer((req, res) => {
    void dispatch(routes, req, res, resolved);
  });

  // 7. Listen on the resolved tailnet/loopback address only.
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(resolved.port, host, () => resolve());
  });

  console.log(`af serve listening on http://${host}:${resolved.port}`);
  console.log(`  GET /health   — health / capacity`);
  console.log(`  Auth: Authorization: Bearer <secret> required on every route`);
  console.log(`  Capacity: ${resolved.maxConcurrency}`);
  console.log(`Press Ctrl+C to stop.`);

  // 8. Graceful shutdown.
  const shutdown = () => {
    process.stdout.write('\nShutting down af serve...\n');
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
