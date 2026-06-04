// src/lib/service-config.ts
// AF-53: pure, unit-testable resolution + bind-safety logic for `af serve`.
//
// These helpers are kept free of HTTP / sockets / process side effects so the
// auth and bind-decision rules can be exercised directly in tests. The command
// (src/commands/serve.ts) wires them to a live http.createServer.

import { execFileSync } from 'child_process';
import {
  AF_MAX_CONCURRENCY_DEFAULT,
  AF_SERVICE_PORT_DEFAULT,
  AF_SERVICE_DB_DEFAULT,
} from './constants.js';
import type { ServiceConfig } from './config.js';

/** Fully-resolved runtime settings for the service. */
export interface ResolvedServiceConfig {
  secret: string;
  port: number;
  /** Explicit bind address, or undefined to resolve via Tailscale at boot. */
  bind?: string;
  allowPublic: boolean;
  maxConcurrency: number;
  db: string;
}

/** Parse a boolean-ish env/config value. Only "true"/"1" (case-insensitive) is true. */
function asBool(value: string | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0' || v === '') return false;
  return fallback;
}

function asInt(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve the effective service config from the `service` config block, with
 * environment variables taking precedence (design §8: "env vars override config").
 * `env` is injected for testability; defaults to process.env.
 *
 * Does NOT resolve the Tailscale bind address (that requires a subprocess and
 * happens at boot) — leaves `bind` undefined when neither config nor env set it.
 */
export function resolveServiceConfig(
  cfg: ServiceConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedServiceConfig {
  const secret = env.AF_SERVICE_SECRET ?? cfg?.secret ?? '';
  return {
    secret,
    port: asInt(env.AF_SERVICE_PORT ?? cfg?.port, AF_SERVICE_PORT_DEFAULT),
    bind: env.AF_SERVICE_BIND ?? cfg?.bind,
    allowPublic: asBool(env.AF_SERVICE_ALLOW_PUBLIC ?? cfg?.allowPublic, false),
    maxConcurrency: asInt(
      env.AF_MAX_CONCURRENCY ?? cfg?.maxConcurrency,
      AF_MAX_CONCURRENCY_DEFAULT,
    ),
    db: env.AF_SERVICE_DB ?? cfg?.db ?? AF_SERVICE_DB_DEFAULT,
  };
}

// ── Bind safety (Decision 4 / §14 R2) ───────────────────────────────────────

/** A loopback IPv4 address (127.0.0.0/8) — safe, never public. */
function isLoopback(ip: string): boolean {
  return /^127\./.test(ip) || ip === '::1';
}

/**
 * Is `ip` a Tailscale CGNAT address (100.64.0.0/10, i.e. 100.64–100.127.x.x)?
 * This is the tailnet range Tailscale assigns; binding here is the intended path.
 */
export function isTailscaleIp(ip: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const second = parseInt(m[1], 10);
  return second >= 64 && second <= 127;
}

/**
 * Decide whether a resolved bind address is allowed to bind, fail-closed
 * (Decision 4). Anything that is the wildcard 0.0.0.0 / :: or a non-tailnet,
 * non-loopback address is treated as "public" and refused unless allowPublic.
 *
 * Pure: returns the decision; the caller exits / listens accordingly.
 */
export function decideBind(
  bind: string,
  allowPublic: boolean,
): { ok: true; address: string } | { ok: false; reason: string } {
  const address = bind.trim();

  if (address === '') {
    return { ok: false, reason: 'bind address is empty (could not resolve Tailscale IPv4)' };
  }

  const isWildcard =
    address === '0.0.0.0' || address === '::' || address === '*';

  // Loopback and Tailscale addresses are always safe to bind.
  if (!isWildcard && (isLoopback(address) || isTailscaleIp(address))) {
    return { ok: true, address };
  }

  // Everything else (wildcard or a public/LAN interface) is refused unless
  // the operator explicitly opted in.
  if (allowPublic) {
    return { ok: true, address };
  }

  const what = isWildcard ? `wildcard ${address}` : `non-tailnet address ${address}`;
  return {
    ok: false,
    reason:
      `refusing to bind to ${what}: not a Tailscale (100.64.0.0/10) or loopback address. ` +
      `Set AF_SERVICE_BIND to the tailnet IPv4, or AF_SERVICE_ALLOW_PUBLIC=true to override (discouraged).`,
  };
}

/**
 * Resolve the host's Tailscale IPv4 via `tailscale ip -4`. Returns the first
 * IPv4 line, or undefined if Tailscale is unavailable / returns nothing.
 * Side-effecting (spawns a process) — kept out of the pure decideBind path.
 */
export function resolveTailscaleIp(): string | undefined {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const first = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l));
    return first;
  } catch {
    return undefined;
  }
}
