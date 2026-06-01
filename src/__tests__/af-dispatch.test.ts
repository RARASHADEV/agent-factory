/**
 * AF-48: Unit tests for af-dispatch.ts (the concrete AfCliDispatch glue).
 *
 * Node.js built-in test runner (node:test) — no disk reads, no network. Both
 * collaborators (loadAgent, dispatchAgent) are injected as stubs, exercising the
 * DI seams described in design §4 / §11.
 *
 * Run: npx tsx --test src/__tests__/af-dispatch.test.ts
 *
 * Covers (design §11):
 *   - resolves execution frontmatter and calls dispatchFn with composed prompts
 *   - applyCliDefaultModel rules: claude agent gets the CLI default; a local
 *     agent with its own execution.model keeps it
 *   - throws a clear error when loadAgentFn returns null
 *   - returns { output, usage, backend } with backend passed through
 *   - composeTaskPrompt includes the ## Context block only when context present
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAfCliDispatch, composeTaskPrompt } from '../lib/af-dispatch.js';
import type { AgentFile } from '../commands/agent.js';
import type {
  DispatchAgentOptions,
  DispatchAgentResult,
  ExecutionConfig,
} from '../lib/execution.js';

// --- Helpers ---

function agentFile(overrides: Partial<AgentFile['meta']> & { content?: string } = {}): AgentFile {
  const { content, ...meta } = overrides;
  return {
    meta: { slug: 'writer', name: 'Writer', ...meta },
    content: content ?? '  You are the writer.  ',
    filePath: `/fake/agents/${meta.slug ?? 'writer'}.md`,
  };
}

/** A dispatchFn stub that records the (config, opts) it was called with. */
function recordingDispatch(result?: Partial<DispatchAgentResult>) {
  const calls: Array<{ config: ExecutionConfig; opts: DispatchAgentOptions }> = [];
  const fn = async (config: ExecutionConfig, opts: DispatchAgentOptions): Promise<DispatchAgentResult> => {
    calls.push({ config, opts });
    return {
      backend: result?.backend ?? 'claude',
      output: result?.output ?? 'the draft',
      usage: result?.usage ?? { inputTokens: 10, outputTokens: 20 },
      success: result?.success ?? true,
    };
  };
  return { fn, calls };
}

// ============================================================
// resolution + dispatch
// ============================================================

describe('createAfCliDispatch', () => {
  it('resolves execution frontmatter and calls dispatchFn with composed prompts', async () => {
    const { fn, calls } = recordingDispatch();
    const dispatch = createAfCliDispatch({
      loadAgentFn: () => agentFile({ content: '  You are the writer.  ', maxTurns: 7, tools: ['Read'] }),
      dispatchFn: fn,
      cwd: '/work',
    });

    await dispatch('writer', { objective: 'write the post' });

    assert.equal(calls.length, 1);
    const { config, opts } = calls[0];
    // Absent execution block → claude default.
    assert.equal(config.backend, 'claude');
    // System prompt is the trimmed agent body; task prompt is the objective.
    assert.equal(opts.systemPrompt, 'You are the writer.');
    assert.equal(opts.taskPrompt, 'write the post');
    assert.equal(opts.maxTurns, 7);
    assert.deepEqual(opts.tools, ['Read']);
    assert.equal(opts.cwd, '/work');
  });

  it('applies the CLI default model for a claude agent', async () => {
    const { fn, calls } = recordingDispatch();
    const dispatch = createAfCliDispatch({
      loadAgentFn: () => agentFile(), // no execution block → claude
      dispatchFn: fn,
      cliDefaultModel: 'sonnet',
    });

    await dispatch('writer', { objective: 'go' });

    assert.equal(calls[0].config.backend, 'claude');
    assert.equal(calls[0].config.model, 'sonnet');
  });

  it('keeps a local agent\'s own execution.model over the CLI default', async () => {
    const { fn, calls } = recordingDispatch({ backend: 'local' });
    const dispatch = createAfCliDispatch({
      loadAgentFn: () =>
        agentFile({
          slug: 'local-writer',
          execution: { backend: 'local', model: 'llama3.1' },
        }),
      dispatchFn: fn,
      cliDefaultModel: 'sonnet', // a Claude id — must NOT clobber the local tag
    });

    await dispatch('local-writer', { objective: 'go' });

    assert.equal(calls[0].config.backend, 'local');
    assert.equal(calls[0].config.model, 'llama3.1');
  });

  it('throws a clear error when the agent is not found', async () => {
    const dispatch = createAfCliDispatch({
      loadAgentFn: () => null,
      dispatchFn: recordingDispatch().fn,
    });

    await assert.rejects(
      () => dispatch('ghost', { objective: 'go' }),
      /agent "ghost" not found/,
    );
  });

  it('returns { output, usage, backend } passing backend through from dispatchFn', async () => {
    const { fn } = recordingDispatch({
      backend: 'local',
      output: 'local output',
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    const dispatch = createAfCliDispatch({
      loadAgentFn: () => agentFile({ execution: { backend: 'local' } }),
      dispatchFn: fn,
    });

    const result = await dispatch('writer', { objective: 'go' });

    assert.deepEqual(result, {
      output: 'local output',
      usage: { inputTokens: 3, outputTokens: 4 },
      backend: 'local',
    });
  });

  it('threads input.cwd over the dispatch-level cwd default', async () => {
    const { fn, calls } = recordingDispatch();
    const dispatch = createAfCliDispatch({
      loadAgentFn: () => agentFile(),
      dispatchFn: fn,
      cwd: '/default',
    });

    await dispatch('writer', { objective: 'go', cwd: '/override' });

    assert.equal(calls[0].opts.cwd, '/override');
  });
});

// ============================================================
// composeTaskPrompt
// ============================================================

describe('composeTaskPrompt', () => {
  it('returns just the objective when no context is present', () => {
    assert.equal(composeTaskPrompt({ objective: '  ship it  ' }), 'ship it');
  });

  it('includes a ## Context block when context is present', () => {
    const prompt = composeTaskPrompt({
      objective: 'ship it',
      context: { prior: 'research done' },
    });
    assert.match(prompt, /^ship it/);
    assert.match(prompt, /## Context/);
    assert.match(prompt, /"prior": "research done"/);
  });

  it('omits the ## Context block when context is null or undefined', () => {
    assert.equal(composeTaskPrompt({ objective: 'go', context: undefined }), 'go');
    assert.equal(composeTaskPrompt({ objective: 'go', context: null }), 'go');
  });
});
