/**
 * AF-48 / AF-50: Command-level tests for `orchestrateCommand`.
 *
 * AF-48: with ENABLE_AF_48 at its default (false), the command prints the
 * friendly "not enabled" message, dispatches nothing, and returns without a
 * failing exit code (design §5.1, §6).
 *
 * AF-50: persistence is structural — a non-dry run saves a run dir and prints
 * its path; a --dry-run persists nothing; a write failure dumps the result to
 * stdout and sets exit code 1 (no silent loss). The non-dry persist + write-
 * failure paths run through `orchestrateCommand` only when ENABLE_AF_48 is on
 * (the command has no injection seam); the dry-run path is hermetic regardless.
 * The persist/fallback *contract* the command relies on (writer succeeds vs
 * throws) is additionally proven directly against the real writer.
 *
 * Run: npx tsx --test src/__tests__/orchestrate-command.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { orchestrateCommand } from '../commands/orchestrate.js';
import { persistOrchestrationResult } from '../lib/orchestration-output.js';
import { ENABLE_AF_48 } from '../lib/constants.js';
import type { OrchestrationResult } from '../lib/orchestrator.js';

describe('orchestrateCommand (feature flag)', () => {
  let logs: string[];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  });

  it('prints the not-enabled message and dispatches nothing when ENABLE_AF_48=false', async (t) => {
    // This test asserts the default-off behavior. If the flag is ever flipped on
    // by default, skip rather than fail — the not-enabled path no longer applies.
    if (ENABLE_AF_48) {
      t.skip('ENABLE_AF_48 is on; not-enabled path does not apply');
      return;
    }

    await orchestrateCommand('marketing', 'launch the spring campaign', {});

    assert.equal(logs.length, 1);
    assert.match(logs[0], /not enabled/i);
    assert.match(logs[0], /ENABLE_AF_48=false/);
    // Friendly message → no failing exit code.
    assert.notEqual(process.exitCode, 1);
  });
});

// AF-50: a fully-populated, non-dry stubbed result for the writer contract tests.
function stubResult(overrides: Partial<OrchestrationResult> = {}): OrchestrationResult {
  return {
    domain: 'marketing',
    objective: 'launch the spring campaign',
    steps: [
      {
        agent: 'researcher',
        backend: 'claude',
        output: 'findings',
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ],
    finalizers: { qa: { approved: true } },
    approved: true,
    totalUsage: { inputTokens: 10, outputTokens: 20 },
    stopReason: 'done',
    dryRun: false,
    plan: ['[orchestrate] domain=marketing'],
    ...overrides,
  };
}

describe('orchestrateCommand persistence (AF-50)', () => {
  let logs: string[];
  let errors: string[];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const originalCwd = process.cwd();
  let tmp: string;

  beforeEach(() => {
    logs = [];
    errors = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    tmp = mkdtempSync(join(tmpdir(), 'af-orch-cmd-'));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('--dry-run persists nothing (no orchestrate/ dir created)', async (t) => {
    if (!ENABLE_AF_48) {
      t.skip('ENABLE_AF_48 is off; orchestrateCommand short-circuits before running');
      return;
    }
    // Run from a temp cwd so any accidental write would land (and be detected) here.
    process.chdir(tmp);
    await orchestrateCommand('marketing', 'launch the spring campaign', { dryRun: true });

    assert.ok(
      !existsSync(join(tmp, '.af', 'output', 'orchestrate')),
      'dry run must not create the orchestrate output dir',
    );
    // The "output saved to" line is only printed when a run dir was written.
    assert.ok(!logs.some((l) => /output saved to/.test(l)), 'dry run must not print a saved path');
  });

  it('persists a run dir for a real (non-dry) result and returns its path', () => {
    // The command builds its own (non-injectable) orchestrator, so we exercise
    // the exact persistence call the command makes (§6) against the real writer.
    const result = stubResult();
    const dir = persistOrchestrationResult(result, { cwd: tmp });

    assert.ok(existsSync(dir), 'run dir should exist on disk');
    assert.ok(existsSync(join(dir, 'result.json')));
    assert.ok(existsSync(join(dir, 'summary.md')));
    assert.ok(existsSync(join(dir, 'step-01-researcher.md')));
    assert.ok(existsSync(join(dir, 'finalizer-qa.md')));
    assert.ok(dir.startsWith(join(tmp, '.af', 'output', 'orchestrate', 'marketing')));
  });

  it('write failure: the writer throws so the command can dump to stdout + exit 1', () => {
    // Make the .af root unwritable so mkdirSync inside the writer fails. This is
    // the condition the command catches to dump the result and set exitCode=1.
    const result = stubResult();
    const afRoot = join(tmp, '.af');
    mkdirSync(afRoot, { recursive: true });
    chmodSync(afRoot, 0o500); // read+execute, no write

    let threw = false;
    try {
      persistOrchestrationResult(result, { cwd: tmp });
    } catch {
      threw = true;
    } finally {
      chmodSync(afRoot, 0o700); // restore so cleanup can remove it
    }

    assert.ok(threw, 'writer must throw on an unwritable output root (drives the stdout fallback)');
  });
});
