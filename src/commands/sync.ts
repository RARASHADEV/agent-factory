// src/commands/sync.ts
// af sync — bidirectional task synchronization with Loka.
// Feature-flagged behind ENABLE_AF_12.

import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import matter from 'gray-matter';
import { ENABLE_AF_12 } from '../lib/constants.js';
import { loadConfig } from '../lib/config.js';
import { resolveProject } from '../lib/workspace.js';
import { auditLog } from '../lib/audit.js';
import { success, error, dim } from '../lib/format.js';
import { FileProvider } from '../lib/providers/file-provider.js';
import { LokaProvider } from '../lib/providers/loka-provider.js';
import { SyncEngine, SyncMode } from '../lib/sync-engine.js';

export interface SyncCommandOptions {
  mode?: 'push' | 'pull' | 'bidirectional';
  pull?: boolean;           // shorthand for --mode pull
  bidirectional?: boolean;  // shorthand for --mode bidirectional
  dryRun?: boolean;
  verbose?: boolean;
  project?: string;
}

export async function syncCommand(options: SyncCommandOptions): Promise<void> {
  if (!ENABLE_AF_12) {
    console.log(error('AF-12 Loka sync is not enabled. Set ENABLE_AF_12=true in constants.ts to enable.'));
    process.exit(1);
  }

  // 1. Resolve workspace
  const resolved = resolveProject(options.project);
  if (!resolved) {
    console.log(error('No project found. Run from a project dir or use --project <prefix>.'));
    process.exit(1);
  }

  const { afPath, meta } = resolved;

  // 2. Check project not archived
  const projectFile = join(afPath, 'project.md');
  if (existsSync(projectFile)) {
    const raw = readFileSync(projectFile, 'utf-8');
    const { data } = matter(raw);
    if (data.status === 'archived') {
      console.log(dim(`Project ${meta.prefix} is archived. Sync is disabled for archived projects.`));
      return;
    }
  }

  // 3. Check Loka config exists
  const config = loadConfig();
  if (!config.loka?.url || !config.loka?.apiKey) {
    console.log(error('Loka not configured. Add loka.url and loka.apiKey to ~/.af/config.yaml'));
    process.exit(1);
  }

  // 4. Resolve sync mode
  let mode: SyncMode;
  if (options.pull) {
    mode = 'pull';
  } else if (options.bidirectional) {
    mode = 'bidirectional';
  } else if (options.mode) {
    mode = options.mode as SyncMode;
  } else {
    // Use defaultMode from config, or fall back to 'push'
    mode = (config.loka.sync?.defaultMode as SyncMode) ?? 'push';
  }

  const dryRun = options.dryRun ?? false;
  const verbose = options.verbose ?? false;

  if (dryRun) {
    console.log(dim(`[dry-run] Would sync ${meta.prefix} (mode: ${mode})`));
  } else {
    console.log(dim(`Syncing ${meta.prefix} with Loka (mode: ${mode})...`));
  }

  // 5. Create both providers
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
    // 6. Run sync
    const result = await engine.sync({ mode, dryRun, verbose });

    // 7. Print summary
    console.log('');
    if (result.pushed.length > 0) {
      console.log(success(`Pushed: ${result.pushed.length} task(s)`) + dim(` → ${result.pushed.join(', ')}`));
    }
    if (result.pulled.length > 0) {
      console.log(success(`Pulled: ${result.pulled.length} task(s)`) + dim(` ← ${result.pulled.join(', ')}`));
    }
    if (result.created.length > 0) {
      console.log(success(`Created: ${result.created.length} task(s)`) + dim(` ${result.created.join(', ')}`));
    }
    if (result.conflicts.length > 0) {
      console.log(dim(`Conflicts resolved (LWW): ${result.conflicts.join(', ')}`));
    }
    if (result.skipped.length > 0) {
      console.log(dim(`Skipped: ${result.skipped.length} task(s)`));
    }
    if (result.errors.length > 0) {
      for (const e of result.errors) {
        console.log(error(`Error [${e.ticket}]: ${e.message}`));
      }
    }

    const totalChanges = result.pushed.length + result.pulled.length + result.created.length;
    if (totalChanges === 0 && result.errors.length === 0) {
      console.log(dim('Everything up to date.'));
    }

    // 8. Audit log
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

    if (result.errors.length > 0) {
      process.exit(1);
    }
  } catch (err: any) {
    console.log(error(`Sync failed: ${err.message}`));

    try {
      auditLog(afPath, {
        event: 'sync.error',
        actor: 'cli',
        detail: `Sync ${mode} failed: ${err.message}`,
        meta: { mode, error: err.message },
      });
    } catch {}

    process.exit(1);
  }
}
