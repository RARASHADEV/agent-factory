// src/commands/sync.ts
// af sync — bidirectional task synchronization with Loka.
// Feature-flagged behind ENABLE_AF_12.

import { ENABLE_AF_12 } from '../lib/constants.js';
import { success, error, dim } from '../lib/format.js';
import { SyncMode } from '../lib/sync-engine.js';
import { syncProject, SyncNotConfiguredError } from '../lib/core/sync.js';
import { ProjectNotFoundError } from '../lib/core/errors.js';

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

  // Resolve the requested mode (CLI shorthands win over --mode).
  let requestedMode: SyncMode | undefined;
  if (options.pull) {
    requestedMode = 'pull';
  } else if (options.bidirectional) {
    requestedMode = 'bidirectional';
  } else if (options.mode) {
    requestedMode = options.mode as SyncMode;
  }

  const dryRun = options.dryRun ?? false;
  const verbose = options.verbose ?? false;

  let outcome;
  try {
    outcome = await syncProject({ project: options.project, mode: requestedMode, dryRun, verbose });
  } catch (err: any) {
    if (err instanceof ProjectNotFoundError) {
      console.log(error('No project found. Run from a project dir or use --project <prefix>.'));
      process.exit(1);
    }
    if (err instanceof SyncNotConfiguredError) {
      console.log(error(err.message));
      process.exit(1);
    }
    console.log(error(`Sync failed: ${err?.message ?? String(err)}`));
    process.exit(1);
  }

  const { prefix, mode } = outcome;

  if (outcome.archived) {
    console.log(dim(`Project ${prefix} is archived. Sync is disabled for archived projects.`));
    return;
  }

  if (dryRun) {
    console.log(dim(`[dry-run] Would sync ${prefix} (mode: ${mode})`));
  } else {
    console.log(dim(`Syncing ${prefix} with Loka (mode: ${mode})...`));
  }

  const result = outcome.result!;

  // Print summary
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

  if (result.errors.length > 0) {
    process.exit(1);
  }
}
