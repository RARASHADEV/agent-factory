// src/lib/core/sync.ts
// AF-60: Presentation-free core op for `af sync` (Loka task synchronization).
//
// Extracted from src/commands/sync.ts so BOTH the CLI and the HTTP mutation route
// (POST /sync) run synchronization through one code path — no console.*, no chalk,
// no process.exit inside the op. The CLI keeps its terminal formatting; this op
// returns the structured SyncResult (or signals a guardrail condition by throwing).
//
// Guardrails (mapped by the adapter):
//   - unresolved project        → ProjectNotFoundError (HTTP 400, §6 guardrail)
//   - Loka not configured       → SyncNotConfiguredError (HTTP 400)
//   - archived project          → returns { archived: true } (a no-op, not an error)
//
// The Loka network leg lives inside SyncEngine; this op orchestrates it but is
// itself I/O-thin. Tests that must stay hermetic exercise the guardrail/validation
// paths (unknown project, not-configured, archived) which never touch the network.

import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import matter from 'gray-matter';
import { loadConfig } from '../config.js';
import { resolveProject } from '../workspace.js';
import { auditLog } from '../audit.js';
import { FileProvider } from '../providers/file-provider.js';
import { LokaProvider } from '../providers/loka-provider.js';
import { SyncEngine, SyncMode, SyncResult } from '../sync-engine.js';
import { ProjectNotFoundError } from './errors.js';

/** Raised when Loka is not configured (no url/apiKey) for a sync. */
export class SyncNotConfiguredError extends Error {
  constructor() {
    super('Loka not configured. Add loka.url and loka.apiKey to ~/.af/config.yaml');
    this.name = 'SyncNotConfiguredError';
  }
}

export interface SyncProjectInput {
  /** Project prefix; resolved against the registry (Decision 3 guardrail). */
  project?: string;
  /** Sync mode; defaults to config.loka.sync.defaultMode, else 'push'. */
  mode?: SyncMode;
  dryRun?: boolean;
  verbose?: boolean;
}

/** Result of {@link syncProject}. */
export interface SyncProjectResult {
  prefix: string;
  mode: SyncMode;
  /** True when the project is archived and sync was skipped (a no-op). */
  archived?: boolean;
  /** The engine's sync result; absent when archived. */
  result?: SyncResult;
}

/**
 * Synchronize a project's tasks with Loka. Mirrors `af sync`.
 *
 * @throws {ProjectNotFoundError}     if no project resolves (§6 guardrail).
 * @throws {SyncNotConfiguredError}   if Loka url/apiKey are not configured.
 * @throws on a hard engine failure (caller maps to 500/their error message).
 */
export async function syncProject(input: SyncProjectInput): Promise<SyncProjectResult> {
  const resolved = resolveProject(input.project);
  if (!resolved) {
    throw new ProjectNotFoundError(input.project);
  }
  const { afPath, meta } = resolved;

  // Archived projects skip sync (a no-op, not an error).
  const projectFile = join(afPath, 'project.md');
  if (existsSync(projectFile)) {
    const { data } = matter(readFileSync(projectFile, 'utf-8'));
    if (data.status === 'archived') {
      // Resolve mode for the result shape even on the no-op path.
      const cfg = loadConfig();
      const mode = resolveMode(input.mode, cfg.loka?.sync?.defaultMode as SyncMode | undefined);
      return { prefix: meta.prefix, mode, archived: true };
    }
  }

  const config = loadConfig();
  if (!config.loka?.url || !config.loka?.apiKey) {
    throw new SyncNotConfiguredError();
  }

  const mode = resolveMode(input.mode, config.loka.sync?.defaultMode as SyncMode | undefined);
  const dryRun = input.dryRun ?? false;
  const verbose = input.verbose ?? false;

  const fileProvider = new FileProvider(afPath, meta);
  const lokaProvider = new LokaProvider(
    config.loka.url,
    config.loka.apiKey,
    meta.prefix,
    config.loka.statusMap,
    config.loka.priorityMap,
    { name: meta.name, description: '' },
  );
  const engine = new SyncEngine(fileProvider, lokaProvider, afPath);

  try {
    const result = await engine.sync({ mode, dryRun, verbose });

    try {
      if (result.errors.length > 0) {
        auditLog(afPath, {
          event: 'sync.error',
          actor: 'cli',
          detail: `Sync ${mode} completed with ${result.errors.length} error(s)`,
          meta: { mode, dryRun, pushed: result.pushed.length, pulled: result.pulled.length, errors: result.errors },
        });
      } else {
        auditLog(afPath, {
          event: 'sync.complete',
          actor: 'cli',
          detail: `Sync ${mode} complete: ${result.pushed.length} pushed, ${result.pulled.length} pulled`,
          meta: { mode, dryRun, pushed: result.pushed.length, pulled: result.pulled.length },
        });
      }
    } catch {}

    return { prefix: meta.prefix, mode, result };
  } catch (err: any) {
    try {
      auditLog(afPath, {
        event: 'sync.error',
        actor: 'cli',
        detail: `Sync ${mode} failed: ${err?.message ?? String(err)}`,
        meta: { mode, error: err?.message ?? String(err) },
      });
    } catch {}
    throw err;
  }
}

/** Resolve the effective sync mode: explicit → config default → 'push'. */
function resolveMode(explicit: SyncMode | undefined, configDefault: SyncMode | undefined): SyncMode {
  return explicit ?? configDefault ?? 'push';
}
