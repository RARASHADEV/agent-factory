/**
 * AF-46: Unit tests for orchestrator.ts (constrained-dynamic supervisor + guardrails).
 *
 * Node.js built-in test runner (node:test) — no external dependencies, no live
 * models. The orchestrator is driven entirely through a StubExecutor (AF-45)
 * and injected deterministic supervisor planners, per Acceptance:
 * "Unit-tested against StubExecutor (no live models)".
 *
 * Run: npx tsx --test src/__tests__/orchestrator.test.ts
 *
 * Coverage maps to the Acceptance checklist:
 *   - run() runs the loop and returns OrchestrationResult
 *   - input validation throws before any dispatch (§6.1)
 *   - guardrails: max_delegations, roster_only, token_budget, timeout_seconds,
 *     required_finalizers, max_revision_loops, abort_on_no_progress
 *   - parallelizable agents fan out concurrently
 *   - result reports stopReason + totalUsage; dryRun logs without dispatching
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StubExecutor } from '../lib/executor.js';
import {
  Orchestrator,
  OrchestrationInputError,
  parseSupervisorDecision,
  type DomainConfig,
  type SupervisorDecision,
  type SupervisorPlanner,
} from '../lib/orchestrator.js';

// --- Fixture: a temp agents dir so domain-config slug resolution is hermetic ---

let agentsDir: string;

const KNOWN_AGENTS = ['campaign-director', 'researcher', 'analyst', 'writer', 'reviewer'];

before(() => {
  const base = mkdtempSync(join(tmpdir(), 'af46-'));
  agentsDir = join(base, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const slug of KNOWN_AGENTS) {
    writeFileSync(join(agentsDir, `${slug}.md`), `---\nslug: ${slug}\n---\n# ${slug}\n`);
  }
});

after(() => {
  try {
    rmSync(join(agentsDir, '..'), { recursive: true, force: true });
  } catch {}
});

// --- Helpers ---

function config(policy: Partial<DomainConfig['policy']> = {}): DomainConfig {
  return {
    domain: 'marketing',
    supervisor: { agent: 'campaign-director', goal: 'ship it' },
    roster: ['researcher', 'analyst', 'writer', 'reviewer'],
    policy: {
      max_delegations: 12,
      roster_only: true,
      token_budget: 200000,
      timeout_seconds: 600,
      required_finalizers: ['reviewer'],
      max_revision_loops: 2,
      abort_on_no_progress: true,
      parallelizable: ['researcher', 'analyst'],
      ...policy,
    },
  };
}

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

/** A planner that emits a fixed script of decisions, one per call. */
function scriptedPlanner(script: SupervisorDecision[]): SupervisorPlanner {
  let i = 0;
  return () => script[i++] ?? { done: true };
}

// ============================================================
// Happy path — full loop returns an OrchestrationResult
// ============================================================

describe('Orchestrator.run — happy path', () => {
  it('runs the loop, runs the finalizer, and returns a structured result', async () => {
    const stub = new StubExecutor({
      results: {
        researcher: { output: 'research', usage: usage(10, 20) },
        writer: { output: 'draft', usage: usage(30, 40) },
        reviewer: { output: { approved: true, score: 9 }, usage: usage(5, 5) },
      },
    });
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'researcher' }] },
      { done: false, calls: [{ agent: 'writer' }] },
      { done: true },
    ]);

    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'launch FlowNote', {
      config: config(),
      planner,
      agentsDir,
    });

    assert.equal(result.stopReason, 'done');
    assert.equal(result.approved, true);
    // researcher, writer, then reviewer (finalizer)
    assert.deepEqual(result.steps.map((s) => s.agent), ['researcher', 'writer', 'reviewer']);
    assert.deepEqual(result.finalizers, { reviewer: { approved: true, score: 9 } });
    // totalUsage = sum of all four... three steps: 10+20 + 30+40 + 5+5
    assert.deepEqual(result.totalUsage, usage(45, 65));
    assert.equal(result.domain, 'marketing');
    assert.equal(result.objective, 'launch FlowNote');
  });
});

// ============================================================
// Input validation (§6.1) — throws BEFORE any dispatch
// ============================================================

describe('Orchestrator.run — input validation (§6.1)', () => {
  it('throws on an empty objective and dispatches nothing', async () => {
    const stub = new StubExecutor({ fallback: { output: 'x', usage: usage(1, 1) } });
    const orch = new Orchestrator(stub);
    await assert.rejects(
      () => orch.run('marketing', '   ', { config: config(), planner: scriptedPlanner([{ done: true }]) }),
      OrchestrationInputError,
    );
    assert.equal(stub.calls.length, 0, 'must not dispatch any agent');
  });

  it('throws (via domain-config) on unresolved roster slugs before dispatch', async () => {
    const stub = new StubExecutor({ fallback: { output: 'x', usage: usage(1, 1) } });
    const orch = new Orchestrator(stub);
    // No `config` provided → loads + validates; a bogus domainsDir/agents fails.
    await assert.rejects(
      () =>
        orch.run('marketing', 'do it', {
          agentsDir: join(agentsDir, 'does-not-exist'),
          domainsDir: agentsDir, // no marketing.yaml here
        }),
      /Domain config not found|does not resolve/,
    );
    assert.equal(stub.calls.length, 0);
  });
});

// ============================================================
// AF-FIX-A6: backend is threaded from the executor into each step
// ============================================================

describe('Step backend threading (AF-FIX-A6)', () => {
  it('records the backend the executor reported per step', async () => {
    const stub = new StubExecutor({
      results: {
        researcher: { output: 'r', usage: usage(1, 1), backend: 'local' },
        reviewer: { output: { approved: true }, usage: usage(1, 1), backend: 'claude' },
      },
    });
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'researcher' }] },
      { done: true },
    ]);
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', { config: config(), planner });

    const researcherStep = result.steps.find((s) => s.agent === 'researcher');
    const reviewerStep = result.steps.find((s) => s.agent === 'reviewer');
    assert.equal(researcherStep?.backend, 'local');
    assert.equal(reviewerStep?.backend, 'claude');
  });

  it('falls back to "unknown" when the executor reports no backend', async () => {
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'researcher' }] },
      { done: true },
    ]);
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ required_finalizers: [] }),
      planner,
    });
    assert.equal(result.steps[0].backend, 'unknown');
  });
});

// ============================================================
// Guardrail: max_delegations
// ============================================================

describe('Guardrail — max_delegations', () => {
  it('stops with stopReason max_delegations when the cap would be exceeded', async () => {
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    // Supervisor keeps asking for one researcher each round, forever.
    const planner: SupervisorPlanner = (state) => ({
      done: false,
      calls: [{ agent: 'researcher', input: { objective: `round ${state.delegations}` } }],
    });
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ max_delegations: 3, required_finalizers: [], abort_on_no_progress: false }),
      planner,
    });
    assert.equal(result.stopReason, 'max_delegations');
    assert.equal(result.steps.length, 3);
  });

  it('honors the maxDelegations opts override', async () => {
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    const planner: SupervisorPlanner = (state) => ({
      done: false,
      calls: [{ agent: 'researcher', input: { objective: `r${state.delegations}` } }],
    });
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ required_finalizers: [], abort_on_no_progress: false }),
      planner,
      maxDelegations: 1,
    });
    assert.equal(result.stopReason, 'max_delegations');
    assert.equal(result.steps.length, 1);
  });
});

// ============================================================
// Guardrail: roster_only
// ============================================================

describe('Guardrail — roster_only', () => {
  it('throws when the supervisor delegates outside the roster', async () => {
    const stub = new StubExecutor({ fallback: { output: 'x', usage: usage(1, 1) } });
    const planner = scriptedPlanner([{ done: false, calls: [{ agent: 'hacker-agent' }] }]);
    const orch = new Orchestrator(stub);
    await assert.rejects(
      () => orch.run('marketing', 'go', { config: config(), planner }),
      /not in the roster/,
    );
  });

  it('allows non-roster calls when roster_only is false', async () => {
    const stub = new StubExecutor({ fallback: { output: 'x', usage: usage(1, 1) } });
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'off-roster' }] },
      { done: true },
    ]);
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ roster_only: false, required_finalizers: [] }),
      planner,
    });
    assert.equal(result.steps.map((s) => s.agent).includes('off-roster'), true);
  });
});

// ============================================================
// Guardrail: token_budget (running total, checked after each step)
// ============================================================

describe('Guardrail — token_budget', () => {
  it('stops on the step after the budget is crossed', async () => {
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(50, 50) } }); // 100/step
    const planner: SupervisorPlanner = (state) => ({
      done: false,
      calls: [{ agent: 'researcher', input: { objective: `r${state.delegations}` } }],
    });
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ token_budget: 250, required_finalizers: [], abort_on_no_progress: false }),
      planner,
    });
    // 100, 200, 300 → crosses 250 on the 3rd step; stops after it.
    assert.equal(result.stopReason, 'token_budget');
    assert.equal(result.steps.length, 3);
    assert.deepEqual(result.totalUsage, usage(150, 150));
  });
});

// ============================================================
// Guardrail: timeout_seconds (injected clock)
// ============================================================

describe('Guardrail — timeout_seconds', () => {
  it('stops with stopReason timeout when wall-clock elapses', async () => {
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    const planner: SupervisorPlanner = (state) => ({
      done: false,
      calls: [{ agent: 'researcher', input: { objective: `r${state.delegations}` } }],
    });
    // Clock jumps 5s per read; timeout is 10s → trips by the 3rd loop-top check.
    let t = 0;
    const now = () => (t += 5000);
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ timeout_seconds: 10, required_finalizers: [], abort_on_no_progress: false }),
      planner,
      now,
    });
    assert.equal(result.stopReason, 'timeout');
  });
});

// ============================================================
// Guardrail: required_finalizers (always run) + approval verdict
// ============================================================

describe('Guardrail — required_finalizers', () => {
  it('always runs the finalizer even when the supervisor says done immediately', async () => {
    const stub = new StubExecutor({
      results: { reviewer: { output: { approved: true }, usage: usage(2, 3) } },
    });
    const planner = scriptedPlanner([{ done: true }]);
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', { config: config(), planner });
    assert.deepEqual(stub.calls.map((c) => c.agentId), ['reviewer']);
    assert.equal(result.approved, true);
    assert.deepEqual(result.finalizers, { reviewer: { approved: true } });
  });
});

// ============================================================
// Guardrail: max_revision_loops (writer<->review retries)
// ============================================================

describe('Guardrail — max_revision_loops', () => {
  it('re-runs the worker on approved:false up to the limit then stops', async () => {
    // reviewer always rejects → revision loop should run exactly max times.
    const stub = new StubExecutor({
      results: {
        writer: { output: 'draft', usage: usage(10, 10) },
        reviewer: { output: { approved: false, issues: ['weak'] }, usage: usage(1, 1) },
      },
    });
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'writer' }] },
      { done: true },
    ]);
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ max_revision_loops: 2 }),
      planner,
    });

    assert.equal(result.approved, false);
    assert.equal(result.stopReason, 'max_revisions');
    // writer(initial) + reviewer + [writer + reviewer]*2 revisions
    const agents = stub.calls.map((c) => c.agentId);
    assert.equal(agents.filter((a) => a === 'reviewer').length, 3); // 1 + 2 revisions
    assert.equal(agents.filter((a) => a === 'writer').length, 3); // 1 + 2 revisions
  });

  it('does not loop when the finalizer approves on the first pass', async () => {
    const stub = new StubExecutor({
      results: {
        writer: { output: 'draft', usage: usage(10, 10) },
        reviewer: { output: { approved: true }, usage: usage(1, 1) },
      },
    });
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'writer' }] },
      { done: true },
    ]);
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', { config: config(), planner });
    assert.equal(result.approved, true);
    assert.equal(result.stopReason, 'done');
    assert.equal(stub.calls.filter((c) => c.agentId === 'reviewer').length, 1);
  });
});

// ============================================================
// Guardrail: abort_on_no_progress
// ============================================================

describe('Guardrail — abort_on_no_progress', () => {
  it('stops with no_progress on a repeated identical call', async () => {
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    // Same agent + same (default) input every round → identical signature.
    const planner: SupervisorPlanner = () => ({
      done: false,
      calls: [{ agent: 'researcher', input: { objective: 'same' } }],
    });
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ required_finalizers: [] }),
      planner,
    });
    assert.equal(result.stopReason, 'no_progress');
    // First call executes; the repeat trips the guard before executing.
    assert.equal(result.steps.length, 1);
  });
});

// ============================================================
// parallelizable — fan out concurrently
// ============================================================

describe('parallelizable — concurrent fan-out', () => {
  it('runs parallelizable agents concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    // Wrap run to observe concurrency.
    const orig = stub.run.bind(stub);
    stub.run = async (agentId, input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return orig(agentId, input);
    };
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'researcher' }, { agent: 'analyst' }] },
      { done: true },
    ]);
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ required_finalizers: [] }),
      planner,
    });
    assert.equal(maxActive, 2, 'both parallelizable agents should run concurrently');
    assert.equal(result.steps.length, 2);
  });

  it('runs sequentially when an agent is not in parallelizable', async () => {
    let active = 0;
    let maxActive = 0;
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    const orig = stub.run.bind(stub);
    stub.run = async (agentId, input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return orig(agentId, input);
    };
    // writer is NOT parallelizable → mixed batch runs sequentially.
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'researcher' }, { agent: 'writer' }] },
      { done: true },
    ]);
    const orch = new Orchestrator(stub);
    await orch.run('marketing', 'go', { config: config({ required_finalizers: [] }), planner });
    assert.equal(maxActive, 1, 'a non-parallelizable batch must run sequentially');
  });
});

// ============================================================
// dryRun — logs the plan, dispatches nothing
// ============================================================

describe('dryRun', () => {
  it('logs the plan and dispatches no agents', async () => {
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'researcher' }] },
      { done: true },
    ]);
    const lines: string[] = [];
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config(),
      planner,
      dryRun: true,
      logger: (l) => lines.push(l),
    });
    assert.equal(stub.calls.length, 0, 'dryRun must not dispatch');
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.totalUsage, usage(0, 0));
    assert.ok(result.plan.length > 0);
    assert.ok(lines.some((l) => l.includes('dry-run') || l.includes('DRY RUN')));
  });
});

// ============================================================
// AF-FIX-B3 — dryRun never dispatches the supervisor (default planner)
// ============================================================

describe('AF-FIX-B3 — dryRun does not dispatch the supervisor', () => {
  it('with the DEFAULT planner, dryRun runs no Executor.run at all', async () => {
    // No injected planner → exercises executorPlanner. The supervisor agent
    // (campaign-director) must NOT be dispatched in dryRun.
    const stub = new StubExecutor({ fallback: { output: 'x', usage: usage(7, 7) } });
    const lines: string[] = [];
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config(),
      dryRun: true,
      logger: (l) => lines.push(l),
    });

    // The core QA assertion: zero Executor.run calls in dryRun.
    assert.equal(stub.calls.length, 0, 'dryRun must not dispatch ANY agent, incl. the supervisor');
    assert.equal(stub.calls.some((c) => c.agentId === 'campaign-director'), false);
    assert.equal(result.dryRun, true);
    assert.equal(result.stopReason, 'done');
    assert.deepEqual(result.totalUsage, usage(0, 0));
    // Static plan mentions the supervisor would delegate at runtime + the roster.
    assert.ok(
      lines.some((l) => l.includes('would delegate at runtime')),
      'should emit a static "supervisor would delegate at runtime" plan line',
    );
    // Finalizers still appear in the plan (as dry-run lines) but aren't dispatched.
    assert.ok(lines.some((l) => l.includes('would run finalizer reviewer')));
  });
});

// ============================================================
// AF-FIX-B4 — supervisor usage is counted and budgeted
// ============================================================

describe('AF-FIX-B4 — supervisor token usage is accounted', () => {
  it('adds the default planner (supervisor) usage to totalUsage', async () => {
    // Supervisor emits one delegation then done; each supervisor turn costs 3/4.
    let round = 0;
    const stub = new StubExecutor({
      results: {
        'campaign-director': { output: '', usage: usage(3, 4) },
        researcher: { output: 'r', usage: usage(10, 20) },
        reviewer: { output: { approved: true }, usage: usage(1, 1) },
      },
    });
    const orig = stub.run.bind(stub);
    stub.run = async (agentId, input) => {
      if (agentId === 'campaign-director') {
        round++;
        const decision = round === 1 ? { calls: [{ agent: 'researcher' }] } : { done: true };
        return { output: JSON.stringify(decision), usage: usage(3, 4) };
      }
      return orig(agentId, input);
    };

    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', { config: config() });

    // 2 supervisor turns (3+4 each) + researcher (10+20) + reviewer (1+1)
    //  input:  3 + 3 + 10 + 1 = 17 ; output: 4 + 4 + 20 + 1 = 29
    assert.deepEqual(result.totalUsage, usage(17, 29));
  });

  it('token_budget stops the run on a supervisor turn that crosses the budget', async () => {
    // Supervisor alone burns 100/turn; budget 150 → 2nd supervisor turn crosses it.
    const stub = new StubExecutor({
      results: {
        'campaign-director': { output: '', usage: usage(50, 50) },
        researcher: { output: 'r', usage: usage(0, 0) },
      },
    });
    stub.run = async (agentId) => {
      if (agentId === 'campaign-director') {
        // Always keep delegating so only the budget can stop the run.
        return { output: JSON.stringify({ calls: [{ agent: 'researcher' }] }), usage: usage(50, 50) };
      }
      return { output: 'r', usage: usage(0, 0) };
    };
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ token_budget: 150, required_finalizers: [], abort_on_no_progress: false }),
    });
    assert.equal(result.stopReason, 'token_budget');
    // turn1 supervisor=100 (<150) → researcher; turn2 supervisor=200 (>=150) → stop.
    assert.equal(result.totalUsage.inputTokens + result.totalUsage.outputTokens >= 150, true);
  });
});

// ============================================================
// AF-FIX-B9 — no_progress no longer false-trips on default input
// ============================================================

describe('AF-FIX-B9 — no_progress robustness', () => {
  it('does NOT trip when the same agent is re-called with default input across rounds', async () => {
    // The default planner emits calls with no explicit input. Because history
    // grows each round, the effective signature differs → legitimate progress.
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    // researcher each round (no input) for 3 rounds, then done.
    const planner = scriptedPlanner([
      { done: false, calls: [{ agent: 'researcher' }] },
      { done: false, calls: [{ agent: 'researcher' }] },
      { done: false, calls: [{ agent: 'researcher' }] },
      { done: true },
    ]);
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ required_finalizers: [], abort_on_no_progress: true }),
      planner,
    });
    assert.equal(result.stopReason, 'done', 'a healthy re-call run must not false-trip no_progress');
    assert.equal(result.steps.length, 3);
  });

  it('still trips on a genuinely identical repeated call (explicit input)', async () => {
    // Same agent + same EXPLICIT input → identical signature regardless of history.
    const stub = new StubExecutor({ fallback: { output: 'r', usage: usage(1, 1) } });
    const planner: SupervisorPlanner = () => ({
      done: false,
      calls: [{ agent: 'researcher', input: { objective: 'identical' } }],
    });
    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', {
      config: config({ required_finalizers: [], abort_on_no_progress: true }),
      planner,
    });
    assert.equal(result.stopReason, 'no_progress');
    assert.equal(result.steps.length, 1);
  });
});

// ============================================================
// parseSupervisorDecision — output parsing
// ============================================================

describe('parseSupervisorDecision', () => {
  it('parses a done object', () => {
    assert.deepEqual(parseSupervisorDecision({ done: true }), { done: true });
  });
  it('parses a calls array', () => {
    assert.deepEqual(parseSupervisorDecision({ calls: [{ agent: 'writer' }] }), {
      done: false,
      calls: [{ agent: 'writer' }],
    });
  });
  it('parses single-agent shorthand', () => {
    assert.deepEqual(parseSupervisorDecision({ agent: 'writer' }), {
      done: false,
      calls: [{ agent: 'writer' }],
    });
  });
  it('parses a JSON string', () => {
    assert.deepEqual(parseSupervisorDecision('{"done":true}'), { done: true });
  });
  it('treats non-JSON text as done', () => {
    assert.deepEqual(parseSupervisorDecision('all finished, nothing more to do'), { done: true });
  });
  it('treats empty / unrecognized output as done', () => {
    assert.deepEqual(parseSupervisorDecision(null), { done: true });
    assert.deepEqual(parseSupervisorDecision({ calls: [] }), { done: true });
  });
});

// ============================================================
// executorPlanner (default) — drives the supervisor via the Executor
// ============================================================

describe('default executor planner', () => {
  it('runs the supervisor agent and follows its parsed decisions', async () => {
    let round = 0;
    const stub = new StubExecutor({
      results: {
        // The supervisor agent emits decisions as JSON output.
        'campaign-director': { output: '', usage: usage(1, 1) },
        researcher: { output: 'research', usage: usage(2, 2) },
        reviewer: { output: { approved: true }, usage: usage(1, 1) },
      },
    });
    // Make the supervisor's output dynamic across rounds.
    const orig = stub.run.bind(stub);
    stub.run = async (agentId, input) => {
      if (agentId === 'campaign-director') {
        round++;
        const decision =
          round === 1
            ? { calls: [{ agent: 'researcher' }] }
            : { done: true };
        return { output: JSON.stringify(decision), usage: usage(1, 1) };
      }
      return orig(agentId, input);
    };

    const orch = new Orchestrator(stub);
    const result = await orch.run('marketing', 'go', { config: config() });
    assert.equal(result.steps.map((s) => s.agent).join(','), 'researcher,reviewer');
    assert.equal(result.approved, true);
    assert.equal(result.stopReason, 'done');
  });
});
