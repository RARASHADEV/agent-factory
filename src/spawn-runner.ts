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
import { dispatchAgent, resolveExecution, applyCliDefaultModel, type ExecutionFrontmatter } from './lib/execution.js';
import { auditLog } from './lib/audit.js';
import { postActivityToLoka } from './lib/audit-bridge.js';
import { extractResultJson, synthesizeResult, type ResultSchema } from './lib/result-schema.js';
import { ENABLE_AF_23 } from './lib/constants.js';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

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
  execution?: ExecutionFrontmatter;  // AF-42: per-agent backend routing
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
    // AF-42: resolve the agent's execution backend (claude default, or local).
    const execConfig = resolveExecution(config.execution);
    // AF-FIX-A2: the CLI always passes a default model (e.g. 'sonnet'), which
    // would clobber a local agent's resolved execution.model. The per-agent
    // execution.model must win for backend:'local'; only apply the CLI default
    // for the claude backend, or when no execution.model was specified at all.
    execConfig.model = applyCliDefaultModel(execConfig, config.model);

    // AF-FIX-A5: pass the resolved run budget to the local dispatch path.
    // config.timeoutMs is usually undefined; without this dispatchLocal would
    // default to 120s and abort long local generations well before the
    // process-level guard (DEFAULT_TIMEOUT_MS) fires.
    const runStart = Date.now();
    const dispatched = await dispatchAgent(execConfig, {
      systemPrompt: config.systemPrompt,
      taskPrompt: config.taskPrompt,
      maxTurns: config.maxTurns,
      tools: config.tools,
      cwd: config.cwd,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    // Normalize into the shape the rest of main() expects. Success is the real
    // outcome reported by the backend (AF-FIX-A1) — Claude's SDK subtype, or a
    // non-error local completion with non-empty output — never hardcoded.
    const result = {
      result: dispatched.output,
      success: dispatched.success,
      numTurns: 0,
      durationMs: Date.now() - runStart,
      usage: dispatched.usage,
      backend: dispatched.backend,
    };

    clearTimeout(timer);

    // Write result
    writeFileSync(resultFile, result.result || '(no output)');

    // Update status. AF-FIX-A1: a non-error completion that the backend reports
    // as unsuccessful (e.g. empty local output) is recorded as completed but
    // NOT successful — the real outcome is surfaced, not masked as success.
    status.status = result.success ? 'completed' : 'failed';
    status.completedAt = new Date().toISOString();
    status.success = result.success;
    status.backend = result.backend;        // AF-42
    status.usage = result.usage;            // AF-42/AF-45: normalized TokenUsage
    writeFileSync(statusFile, JSON.stringify(status, null, 2));

    // AF-23: Extract or synthesize result.json
    let resultJsonFile: string | undefined;
    let resultData: ResultSchema | undefined;
    if (ENABLE_AF_23) {
      resultJsonFile = join(config.outputDir, 'result.json');
      const resultText = result.result || '';

      const extraction = extractResultJson(resultText);

      if (extraction && extraction.valid) {
        resultData = extraction.data;
      } else {
        if (extraction && !extraction.valid) {
          console.warn(`[result-json] Extraction found block but validation failed: ${extraction.errors.join(', ')}`);
        }
        resultData = synthesizeResult({
          status: status.status,
          success: result.success,
          agent: config.agentSlug,
          ticket: config.ticket,
        });
      }

      try {
        writeFileSync(resultJsonFile, JSON.stringify(resultData, null, 2));
      } catch (writeErr: any) {
        console.warn(`[result-json] Failed to write result.json: ${writeErr.message}`);
      }
    }

    // Audit: spawn.complete
    const resolvedAfPath = config.afPath || join(config.outputDir, '..', '..');
    try {
      auditLog(resolvedAfPath, {
        event: 'spawn.complete',
        ticket: config.ticket,
        agent: config.agentSlug,
        actor: config.agentSlug,
        detail: `Completed in ${Math.round(result.durationMs / 1000)}s`,
        meta: {
          success: result.success,
          durationMs: result.durationMs,
          ...(resultJsonFile ? { resultJsonPath: resultJsonFile } : {}),
          ...(resultData ? { resultSynthetic: resultData._synthetic } : {}),
        },
      });
    } catch {}
    void postActivityToLoka(
      resolvedAfPath,
      config.ticket,
      `✅ Agent ${config.agentSlug} completed work on ${config.ticket} (${Math.round(result.durationMs / 1000)}s)`,
    );

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

    // AF-23: Write synthetic result.json on failure
    if (ENABLE_AF_23) {
      const resultJsonFile = join(config.outputDir, 'result.json');
      const failedResult = synthesizeResult({
        status: 'failed',
        success: false,
        agent: config.agentSlug,
        ticket: config.ticket,
      });
      failedResult.blockers = [err.message || String(err)];

      try {
        writeFileSync(resultJsonFile, JSON.stringify(failedResult, null, 2));
      } catch (writeErr: any) {
        console.warn(`[result-json] Failed to write result.json: ${writeErr.message}`);
      }
    }

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
    void postActivityToLoka(
      resolvedAfPathFail,
      config.ticket,
      `❌ Agent ${config.agentSlug} failed on ${config.ticket}: ${err.message}`,
    );

    console.error(`❌ Agent ${config.agentSlug} failed on ${config.ticket}: ${err.message}`);
    process.exit(1);
  }
}

main();
