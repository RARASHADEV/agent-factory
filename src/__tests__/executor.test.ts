/**
 * AF-45: Unit tests for executor.ts (the Executor seam).
 *
 * Node.js built-in test runner (node:test) — no external dependencies.
 * Run: npx tsx --test src/__tests__/executor.test.ts
 *
 * Covers each Acceptance item:
 *   - Executor.run dispatches via AF CLI and returns { output, usage }
 *   - TokenUsage normalized across Claude / Ollama / vLLM shapes
 *   - StubExecutor returns canned results + usage for orchestrator tests
 *   - No model/backend branching in the executor itself (dispatch is injected)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AfCliExecutor,
  StubExecutor,
  normalizeUsage,
  addUsage,
  type AfCliDispatch,
  type AgentInput,
} from '../lib/executor.js';

const INPUT: AgentInput = { objective: 'write the launch blog post' };

// ============================================================
// normalizeUsage — cross-backend normalization
// ============================================================

describe('normalizeUsage', () => {
  it('normalizes Claude SDK shape (input_tokens / output_tokens)', () => {
    assert.deepEqual(normalizeUsage({ input_tokens: 1200, output_tokens: 340 }), {
      inputTokens: 1200,
      outputTokens: 340,
    });
  });

  it('normalizes Ollama shape (prompt_eval_count / eval_count)', () => {
    assert.deepEqual(normalizeUsage({ prompt_eval_count: 88, eval_count: 512 }), {
      inputTokens: 88,
      outputTokens: 512,
    });
  });

  it('normalizes vLLM / OpenAI shape (prompt_tokens / completion_tokens)', () => {
    assert.deepEqual(normalizeUsage({ prompt_tokens: 50, completion_tokens: 75 }), {
      inputTokens: 50,
      outputTokens: 75,
    });
  });

  it('reads counts nested under a `usage` object (vLLM/Claude result shape)', () => {
    assert.deepEqual(normalizeUsage({ usage: { prompt_tokens: 10, completion_tokens: 20 } }), {
      inputTokens: 10,
      outputTokens: 20,
    });
  });

  it('passes through an already-normalized shape', () => {
    assert.deepEqual(normalizeUsage({ inputTokens: 7, outputTokens: 9 }), {
      inputTokens: 7,
      outputTokens: 9,
    });
  });

  it('returns {0,0} for missing / non-object / unrecognized usage', () => {
    assert.deepEqual(normalizeUsage(undefined), { inputTokens: 0, outputTokens: 0 });
    assert.deepEqual(normalizeUsage(null), { inputTokens: 0, outputTokens: 0 });
    assert.deepEqual(normalizeUsage('nope'), { inputTokens: 0, outputTokens: 0 });
    assert.deepEqual(normalizeUsage({ something_else: 5 }), { inputTokens: 0, outputTokens: 0 });
  });

  it('ignores negative / non-finite counts (treats as unreported)', () => {
    assert.deepEqual(normalizeUsage({ input_tokens: -1, output_tokens: NaN }), {
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe('addUsage', () => {
  it('sums two usage totals field-wise', () => {
    assert.deepEqual(
      addUsage({ inputTokens: 10, outputTokens: 20 }, { inputTokens: 3, outputTokens: 4 }),
      { inputTokens: 13, outputTokens: 24 },
    );
  });
});

// ============================================================
// AfCliExecutor — dispatches via AF CLI, returns { output, usage }
// ============================================================

describe('AfCliExecutor', () => {
  it('dispatches via the injected AF CLI surface and returns { output, usage }', async () => {
    const seen: Array<{ agentId: string; input: AgentInput }> = [];
    const dispatch: AfCliDispatch = async (agentId, input) => {
      seen.push({ agentId, input });
      // Simulate a Claude backend reporting raw usage.
      return { output: 'a drafted post', usage: { input_tokens: 100, output_tokens: 250 } };
    };

    const executor = new AfCliExecutor({ dispatch });
    const result = await executor.run('content-writer', INPUT);

    assert.equal(result.output, 'a drafted post');
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 250 });

    // Forwarded the slug + input verbatim to AF CLI.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].agentId, 'content-writer');
    assert.deepEqual(seen[0].input, INPUT);
  });

  it('normalizes a different backend shape identically (no backend branching)', async () => {
    // Same executor, an Ollama-shaped usage — proves the executor does not
    // branch on backend; normalizeUsage handles the shape.
    const dispatch: AfCliDispatch = async () => ({
      output: 'summary',
      usage: { prompt_eval_count: 30, eval_count: 60 },
    });
    const executor = new AfCliExecutor({ dispatch });
    const result = await executor.run('market-researcher', INPUT);
    assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 60 });
  });

  it('reports {0,0} when the backend reports no usable usage', async () => {
    const dispatch: AfCliDispatch = async () => ({ output: 'x', usage: {} });
    const executor = new AfCliExecutor({ dispatch });
    const result = await executor.run('reviewer', INPUT);
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
  });

  // AF-FIX-A6: backend is threaded from AF CLI dispatch into AgentResult.
  it('propagates the backend reported by AF CLI dispatch', async () => {
    const dispatch: AfCliDispatch = async () => ({
      output: 'out',
      usage: { input_tokens: 1, output_tokens: 1 },
      backend: 'local',
    });
    const executor = new AfCliExecutor({ dispatch });
    const result = await executor.run('content-writer', INPUT);
    assert.equal(result.backend, 'local');
  });

  it('leaves backend unset when AF CLI dispatch reports none', async () => {
    const dispatch: AfCliDispatch = async () => ({ output: 'out', usage: {} });
    const executor = new AfCliExecutor({ dispatch });
    const result = await executor.run('content-writer', INPUT);
    assert.equal(result.backend, undefined);
  });

  it('throws if constructed without a dispatch function', () => {
    // @ts-expect-error — intentionally invalid for the runtime guard test
    assert.throws(() => new AfCliExecutor({}), /requires a `dispatch` function/);
  });

  it('throws on an empty agentId', async () => {
    const executor = new AfCliExecutor({ dispatch: async () => ({ output: null, usage: {} }) });
    await assert.rejects(() => executor.run('   ', INPUT), /non-empty agentId/);
  });

  it('propagates dispatch errors (fail loud, do not swallow)', async () => {
    const executor = new AfCliExecutor({
      dispatch: async () => {
        throw new Error('AF CLI boom');
      },
    });
    await assert.rejects(() => executor.run('content-writer', INPUT), /AF CLI boom/);
  });
});

// ============================================================
// StubExecutor — canned results for orchestrator unit tests
// ============================================================

describe('StubExecutor', () => {
  it('returns canned output + normalized usage keyed by slug', async () => {
    const stub = new StubExecutor({
      results: {
        'market-researcher': { output: { findings: 3 }, usage: { inputTokens: 5, outputTokens: 8 } },
        // A raw backend shape is also accepted and normalized.
        'content-writer': { output: 'draft', usage: { input_tokens: 40, output_tokens: 90 } },
      },
    });

    const r1 = await stub.run('market-researcher', INPUT);
    assert.deepEqual(r1.output, { findings: 3 });
    assert.deepEqual(r1.usage, { inputTokens: 5, outputTokens: 8 });

    const r2 = await stub.run('content-writer', INPUT);
    assert.equal(r2.output, 'draft');
    assert.deepEqual(r2.usage, { inputTokens: 40, outputTokens: 90 });
  });

  // AF-FIX-A6: StubExecutor can carry a backend for orchestrator step tests.
  it('returns an optional backend from a canned result', async () => {
    const stub = new StubExecutor({
      results: { 'content-writer': { output: 'draft', usage: { inputTokens: 1, outputTokens: 1 }, backend: 'claude' } },
    });
    const r = await stub.run('content-writer', INPUT);
    assert.equal(r.backend, 'claude');
  });

  it('omits backend when a canned result does not set one', async () => {
    const stub = new StubExecutor({ fallback: { output: 'ok', usage: { inputTokens: 0, outputTokens: 0 } } });
    const r = await stub.run('x', INPUT);
    assert.equal(r.backend, undefined);
  });

  it('records every call in order for assertions', async () => {
    const stub = new StubExecutor({ fallback: { output: 'ok', usage: { inputTokens: 1, outputTokens: 1 } } });
    await stub.run('a', { objective: 'one' });
    await stub.run('b', { objective: 'two' });
    assert.deepEqual(
      stub.calls.map((c) => c.agentId),
      ['a', 'b'],
    );
    assert.equal(stub.calls[1].input.objective, 'two');
  });

  it('uses the fallback for unknown slugs when provided', async () => {
    const stub = new StubExecutor({ fallback: { output: 'default', usage: { inputTokens: 2, outputTokens: 3 } } });
    const r = await stub.run('anything', INPUT);
    assert.equal(r.output, 'default');
    assert.deepEqual(r.usage, { inputTokens: 2, outputTokens: 3 });
  });

  it('throws for an unknown slug when no fallback is configured', async () => {
    const stub = new StubExecutor({ results: { known: { output: 1, usage: { inputTokens: 0, outputTokens: 0 } } } });
    await assert.rejects(() => stub.run('unknown', INPUT), /no canned result/);
  });

  it('satisfies the Executor interface (usable wherever an Executor is expected)', async () => {
    // Type-level check: a StubExecutor is assignable to Executor.
    const stub: { run: (a: string, i: AgentInput) => Promise<unknown> } = new StubExecutor({
      fallback: { output: null, usage: { inputTokens: 0, outputTokens: 0 } },
    });
    const r = await stub.run('x', INPUT);
    assert.ok(r);
  });
});
