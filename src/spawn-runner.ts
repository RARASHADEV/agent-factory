#!/usr/bin/env node

/**
 * Standalone background runner for AF agent spawn.
 *
 * Usage: node dist/spawn-runner.js <config.json>
 *
 * The config file contains:
 *   systemPrompt, taskPrompt, model, maxTurns, tools, cwd, outputDir
 *
 * Writes status.json (pid, status, timestamps) and result.md (agent output)
 * to the outputDir. Designed to run as a detached subprocess so the caller
 * can return immediately.
 */

import { writeFileSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { runAgent } from './lib/sdk.js';
import { auditLog } from './lib/audit.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

interface SpawnConfig {
  systemPrompt: string;
  taskPrompt: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  cwd: string;
  outputDir: string;
  ticket: string;
  agentSlug: string;
  timeoutMs?: number;
  afPath?: string;   // Optional: workspace .af/ path for audit logging
}

// --- Crash safety ---
// These handlers catch anything that escapes the try/catch in main().
// They sync-write to disk before dying — no buffering, no lost errors.

let statusFile = '';  // set once config is loaded
let crashLog = '';    // set once config is loaded
let status: Record<string, any> = {};

function writeCrash(reason: string, error: any) {
  const stack = error?.stack || error?.message || String(error);
  const entry = `[${new Date().toISOString()}] ${reason}\n${stack}\n\n`;

  try {
    appendFileSync(crashLog, entry);

    // Update status.json if we got far enough to have one
    if (statusFile && status.pid) {
      status.status = 'crashed';
      status.completedAt = new Date().toISOString();
      status.error = `${reason}: ${stack}`;
      writeFileSync(statusFile, JSON.stringify(status, null, 2));
    }
  } catch {
    // If we can't write to disk, we're truly lost. Just die.
  }
}

process.on('uncaughtException', (err) => {
  writeCrash('uncaughtException', err);
  process.exit(2);
});

process.on('unhandledRejection', (reason) => {
  writeCrash('unhandledRejection', reason);
  process.exit(3);
});

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('Usage: spawn-runner <config.json>');
    process.exit(1);
  }

  const config: SpawnConfig = JSON.parse(readFileSync(configPath, 'utf-8'));

  // Ensure output dir exists
  mkdirSync(config.outputDir, { recursive: true });

  statusFile = join(config.outputDir, 'status.json');
  crashLog = join(config.outputDir, 'crash.log');
  const resultFile = join(config.outputDir, 'result.md');

  // Write initial status
  status = {
    pid: process.pid,
    status: 'running',
    agent: config.agentSlug,
    ticket: config.ticket,
    startedAt: new Date().toISOString(),
    completedAt: null as string | null,
    success: false,
    error: null as string | null,
  };
  writeFileSync(statusFile, JSON.stringify(status, null, 2));

  // --- Timeout guard ---
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    writeCrash('timeout', new Error(`Agent exceeded ${Math.round(timeoutMs / 1000)}s time limit`));
    process.exit(4);
  }, timeoutMs);
  timer.unref(); // don't keep process alive just for the timer

  try {
    const result = await runAgent(config.systemPrompt, config.taskPrompt, {
      model: config.model,
      maxTurns: config.maxTurns,
      tools: config.tools,
      cwd: config.cwd,
    });

    clearTimeout(timer);

    // Write result
    writeFileSync(resultFile, result.result || '(no output)');

    // Update status
    status.status = 'completed';
    status.completedAt = new Date().toISOString();
    status.success = result.success;
    writeFileSync(statusFile, JSON.stringify(status, null, 2));

    // Audit: spawn.complete
    const resolvedAfPath = config.afPath || join(config.outputDir, '..', '..');
    try {
      auditLog(resolvedAfPath, {
        event: 'spawn.complete',
        ticket: config.ticket,
        agent: config.agentSlug,
        actor: config.agentSlug,
        detail: `Completed in ${Math.round(result.durationMs / 1000)}s`,
        meta: { success: result.success, durationMs: result.durationMs },
      });
    } catch {}

    console.log(`✅ Agent ${config.agentSlug} completed ${config.ticket} (${result.numTurns} turns, ${Math.round(result.durationMs / 1000)}s)`);
  } catch (err: any) {
    clearTimeout(timer);

    const stack = err?.stack || err?.message || String(err);

    status.status = 'failed';
    status.completedAt = new Date().toISOString();
    status.error = stack;
    writeFileSync(statusFile, JSON.stringify(status, null, 2));

    // Also write to crash.log for forensics
    appendFileSync(crashLog, `[${new Date().toISOString()}] caught error\n${stack}\n\n`);

    // Audit: spawn.fail
    const resolvedAfPathFail = config.afPath || join(config.outputDir, '..', '..');
    try {
      auditLog(resolvedAfPathFail, {
        event: 'spawn.fail',
        ticket: config.ticket,
        agent: config.agentSlug,
        actor: config.agentSlug,
        detail: `Failed: ${err.message}`,
        meta: { error: stack },
      });
    } catch {}

    console.error(`❌ Agent ${config.agentSlug} failed on ${config.ticket}: ${err.message}`);
    process.exit(1);
  }
}

main();
