/**
 * AF-48: Command-level test for `orchestrateCommand`.
 *
 * With ENABLE_AF_48 at its default (false), the command must print the friendly
 * "not enabled" message, dispatch nothing, and return without setting a failing
 * exit code (design §5.1, §6).
 *
 * Run: npx tsx --test src/__tests__/orchestrate-command.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrateCommand } from '../commands/orchestrate.js';
import { ENABLE_AF_48 } from '../lib/constants.js';

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
