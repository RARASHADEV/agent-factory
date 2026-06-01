/**
 * AF-48: Integration test — the WIRED executor path.
 *
 * Proves AF-FIX-A6 end-to-end through the *real* AfCliExecutor (not the
 * StubExecutor): a deterministic dispatch reports a backend, AfCliExecutor
 * threads it onto AgentResult, and the Orchestrator records it on every step.
 * Also asserts the --dry-run path dispatches nothing yet populates the plan.
 *
 * Run: npx tsx --test src/__tests__/orchestrator-wired.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AfCliExecutor, type AfCliDispatch } from '../lib/executor.js';
import {
  createOrchestrator,
  type DomainConfig,
  type SupervisorDecision,
  type SupervisorPlanner,
} from '../lib/orchestrator.js';

// In-memory domain config so config loading is hermetic (no disk).
function config(): DomainConfig {
  return {
    domain: 'marketing',
    supervisor: { agent: 'campaign-director', goal: 'ship it' },
    roster: ['writer', 'reviewer'],
    policy: {
      max_delegations: 12,
      roster_only: true,
      required_finalizers: ['reviewer'],
      max_revision_loops: 0,
    },
  };
}

/** Planner that emits a fixed script of decisions, one per call. */
function scriptedPlanner(script: SupervisorDecision[]): SupervisorPlanner {
  let i = 0;
  return () => script[Math.min(i++, script.length - 1)];
}

describe('wired executor (AfCliExecutor) end-to-end', () => {
  it('records the dispatched backend on every step (AF-FIX-A6)', async () => {
    // Deterministic dispatch — no live model. Returns a canned backend so we can
    // assert it flows: dispatch → AfCliExecutor → orchestrator step.backend.
    const dispatch: AfCliDispatch = async (agentId) => ({
      output: { from: agentId, approved: true },
      usage: { prompt_eval_count: 5, eval_count: 7 }, // Ollama-shaped raw usage
      backend: 'local',
    });

    const executor = new AfCliExecutor({ dispatch });
    const orchestrator = createOrchestrator(executor);

    const result = await orchestrator.run('marketing', 'launch the spring campaign', {
      config: config(),
      planner: scriptedPlanner([
        { done: false, calls: [{ agent: 'writer' }] },
        { done: true },
      ]),
    });

    assert.ok(result.steps.length >= 1, 'expected at least one delegation step');
    for (const step of result.steps) {
      assert.equal(step.backend, 'local', `step ${step.agent} should record backend=local`);
      assert.notEqual(step.backend, 'unknown');
    }
    // The finalizer (reviewer) ran through the same wired executor too.
    assert.ok('reviewer' in result.finalizers);
    // Usage was normalized from the Ollama raw shape on every step.
    assert.ok(result.totalUsage.inputTokens > 0);
    assert.ok(result.totalUsage.outputTokens > 0);
  });

  it('--dry-run dispatches nothing and populates the plan', async () => {
    let dispatched = 0;
    const dispatch: AfCliDispatch = async () => {
      dispatched++;
      return { output: null, usage: {}, backend: 'local' };
    };

    const executor = new AfCliExecutor({ dispatch });
    const orchestrator = createOrchestrator(executor);

    const result = await orchestrator.run('marketing', 'launch the spring campaign', {
      config: config(),
      dryRun: true,
    });

    assert.equal(dispatched, 0, 'dry run must not dispatch any agent');
    assert.equal(result.dryRun, true);
    assert.ok(result.plan.length > 0, 'plan should be populated in dry run');
  });
});
