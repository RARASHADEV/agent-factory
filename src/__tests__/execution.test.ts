/**
 * AF-42: Unit tests for execution backend routing.
 *
 * Run: npx tsx --test src/__tests__/execution.test.ts
 *
 * NOTE: relies on the default allow-list (localhost, 127.0.0.1, ::1). The
 * AF_LOCAL_ENDPOINT_ALLOWLIST env var must not be set when running these.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveExecution,
  validateEndpoint,
  buildPromptToolPreamble,
  parsePromptToolAction,
  normalizeUsage,
  dispatchLocal,
  dispatchAgent,
  DEFAULT_LOCAL_ENDPOINT,
  type ExecutionConfig,
} from '../lib/execution.js';

// ============================================================
// resolveExecution — frontmatter parsing + defaults (back-compat)
// ============================================================

describe('resolveExecution', () => {
  it('defaults to claude/native when block is absent', () => {
    const cfg = resolveExecution(undefined);
    assert.equal(cfg.backend, 'claude');
    assert.equal(cfg.toolCalling, 'native');
    assert.equal(cfg.endpoint, undefined);
  });

  it('defaults to claude when block is null (existing agents unchanged)', () => {
    const cfg = resolveExecution(null);
    assert.equal(cfg.backend, 'claude');
    assert.equal(cfg.toolCalling, 'native');
  });

  it('treats an array as no block (defaults to claude)', () => {
    const cfg = resolveExecution([]);
    assert.equal(cfg.backend, 'claude');
  });

  it('resolves an explicit claude block', () => {
    const cfg = resolveExecution({ backend: 'claude', model: 'claude-sonnet-4-5' });
    assert.equal(cfg.backend, 'claude');
    assert.equal(cfg.model, 'claude-sonnet-4-5');
    assert.equal(cfg.toolCalling, 'native');
    assert.equal(cfg.endpoint, undefined);
  });

  it('resolves a local block and defaults toolCalling to prompt', () => {
    const cfg = resolveExecution({ backend: 'local', model: 'llama3.1:70b' });
    assert.equal(cfg.backend, 'local');
    assert.equal(cfg.model, 'llama3.1:70b');
    assert.equal(cfg.toolCalling, 'prompt');
    assert.equal(cfg.endpoint, DEFAULT_LOCAL_ENDPOINT);
  });

  it('honors an explicit local endpoint', () => {
    const cfg = resolveExecution({ backend: 'local', endpoint: 'http://localhost:8000/v1' });
    assert.equal(cfg.endpoint, 'http://localhost:8000/v1');
  });

  it('honors an explicit toolCalling: native on local', () => {
    const cfg = resolveExecution({ backend: 'local', toolCalling: 'native' });
    assert.equal(cfg.toolCalling, 'native');
  });

  it('is case-insensitive for backend/toolCalling', () => {
    const cfg = resolveExecution({ backend: 'LOCAL', toolCalling: 'PROMPT' });
    assert.equal(cfg.backend, 'local');
    assert.equal(cfg.toolCalling, 'prompt');
  });

  it('ignores endpoint for claude backend', () => {
    const cfg = resolveExecution({ backend: 'claude', endpoint: 'http://localhost:11434' });
    assert.equal(cfg.endpoint, undefined);
  });

  it('throws on an unknown backend (fail loud)', () => {
    assert.throws(() => resolveExecution({ backend: 'gpt4' }), /backend/);
  });

  it('throws on an unknown toolCalling value', () => {
    assert.throws(() => resolveExecution({ backend: 'local', toolCalling: 'magic' }), /toolCalling/);
  });

  it('normalizes an empty model string to undefined', () => {
    const cfg = resolveExecution({ backend: 'local', model: '  ' });
    assert.equal(cfg.model, undefined);
  });
});

// ============================================================
// validateEndpoint — SSRF allow-list guard (§8)
// ============================================================

describe('validateEndpoint', () => {
  it('accepts an allow-listed localhost endpoint', () => {
    const url = validateEndpoint('http://localhost:11434');
    assert.equal(url.hostname, 'localhost');
  });

  it('accepts 127.0.0.1', () => {
    const url = validateEndpoint('http://127.0.0.1:8000/v1');
    assert.equal(url.hostname, '127.0.0.1');
  });

  it('rejects an arbitrary external host (SSRF)', () => {
    assert.throws(() => validateEndpoint('http://evil.example.com/api'), /allow-list/);
  });

  it('rejects a cloud metadata endpoint (classic SSRF target)', () => {
    assert.throws(() => validateEndpoint('http://169.254.169.254/latest/meta-data'), /allow-list/);
  });

  it('rejects a non-http scheme', () => {
    assert.throws(() => validateEndpoint('file:///etc/passwd'), /scheme/);
  });

  it('rejects a malformed URL', () => {
    assert.throws(() => validateEndpoint('not a url'), /valid URL/);
  });
});

// ============================================================
// Prompt-based tool calling (§6.2)
// ============================================================

describe('prompt tool-calling protocol', () => {
  it('builds a non-empty preamble describing the action block', () => {
    const p = buildPromptToolPreamble();
    assert.ok(p.includes('action'));
    assert.ok(p.length > 0);
  });

  it('parses a valid action block', () => {
    const text = 'Sure, let me search.\n```action\n{ "tool": "Read", "input": { "path": "x.md" } }\n```';
    const action = parsePromptToolAction(text);
    assert.notEqual(action, null);
    assert.equal(action!.tool, 'Read');
    assert.deepEqual(action!.input, { path: 'x.md' });
  });

  it('returns null when there is no action block (final answer)', () => {
    assert.equal(parsePromptToolAction('Here is the final answer.'), null);
  });

  it('returns null when the action block has no tool field', () => {
    const text = '```action\n{ "input": {} }\n```';
    assert.equal(parsePromptToolAction(text), null);
  });

  it('returns null for an unparseable action block', () => {
    const text = '```action\n{ not json }\n```';
    assert.equal(parsePromptToolAction(text), null);
  });
});

// ============================================================
// normalizeUsage — backend-specific usage → TokenUsage (§5.1)
// ============================================================

describe('normalizeUsage', () => {
  it('normalizes Ollama usage (prompt_eval_count / eval_count)', () => {
    const u = normalizeUsage({ prompt_eval_count: 120, eval_count: 45 });
    assert.deepEqual(u, { inputTokens: 120, outputTokens: 45 });
  });

  it('normalizes vLLM/OpenAI usage (nested usage object)', () => {
    const u = normalizeUsage({ usage: { prompt_tokens: 200, completion_tokens: 80 } });
    assert.deepEqual(u, { inputTokens: 200, outputTokens: 80 });
  });

  it('defaults to zeros for missing usage', () => {
    assert.deepEqual(normalizeUsage(null), { inputTokens: 0, outputTokens: 0 });
    assert.deepEqual(normalizeUsage({}), { inputTokens: 0, outputTokens: 0 });
  });
});

// ============================================================
// dispatchLocal — Ollama + vLLM via injected fetch
// ============================================================

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('dispatchLocal', () => {
  it('dispatches to an Ollama endpoint and returns output + usage', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    const fakeFetch = (async (input: any, init?: any) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(init.body);
      return jsonResponse({
        message: { role: 'assistant', content: 'local model says hi' },
        prompt_eval_count: 10,
        eval_count: 3,
      });
    }) as unknown as typeof fetch;

    const cfg: ExecutionConfig = {
      backend: 'local',
      model: 'llama3.1:70b',
      endpoint: 'http://localhost:11434',
      toolCalling: 'prompt',
    };
    const res = await dispatchLocal(cfg, {
      systemPrompt: 'You are helpful.',
      taskPrompt: 'Say hi.',
      fetchImpl: fakeFetch,
    });

    assert.ok(capturedUrl.endsWith('/api/chat'));
    assert.equal(capturedBody.model, 'llama3.1:70b');
    // toolCalling=prompt injects the protocol preamble into the system message.
    assert.ok(capturedBody.messages[0].content.includes('action'));
    assert.equal(res.output, 'local model says hi');
    assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 3 });
  });

  it('dispatches to a vLLM (OpenAI-compatible) endpoint', async () => {
    let capturedUrl = '';
    const fakeFetch = (async (input: any) => {
      capturedUrl = String(input);
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'vllm output' } }],
        usage: { prompt_tokens: 50, completion_tokens: 12 },
      });
    }) as unknown as typeof fetch;

    const cfg: ExecutionConfig = {
      backend: 'local',
      model: 'mistral',
      endpoint: 'http://localhost:8000/v1',
      toolCalling: 'native',
    };
    const res = await dispatchLocal(cfg, {
      systemPrompt: 'sys',
      taskPrompt: 'go',
      fetchImpl: fakeFetch,
    });

    assert.ok(capturedUrl.endsWith('/v1/chat/completions'));
    assert.equal(res.output, 'vllm output');
    assert.deepEqual(res.usage, { inputTokens: 50, outputTokens: 12 });
  });

  it('validates the endpoint before any network call (SSRF guard)', async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const cfg: ExecutionConfig = {
      backend: 'local',
      endpoint: 'http://evil.example.com',
      toolCalling: 'prompt',
    };
    await assert.rejects(
      dispatchLocal(cfg, { systemPrompt: 's', taskPrompt: 't', fetchImpl: fakeFetch }),
      /allow-list/,
    );
    assert.equal(called, false, 'fetch must not be called for a disallowed endpoint');
  });

  it('throws on a non-2xx backend response', async () => {
    const fakeFetch = (async () =>
      new Response('boom', { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;
    const cfg: ExecutionConfig = {
      backend: 'local',
      endpoint: 'http://localhost:11434',
      toolCalling: 'prompt',
    };
    await assert.rejects(
      dispatchLocal(cfg, { systemPrompt: 's', taskPrompt: 't', fetchImpl: fakeFetch }),
      /500/,
    );
  });
});

// ============================================================
// dispatchAgent — router routes local without touching Claude SDK
// ============================================================

describe('dispatchAgent', () => {
  it('routes a local agent through the local backend', async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        message: { content: 'routed local' },
        prompt_eval_count: 1,
        eval_count: 1,
      })) as unknown as typeof fetch;

    const cfg: ExecutionConfig = {
      backend: 'local',
      endpoint: 'http://127.0.0.1:11434',
      toolCalling: 'prompt',
    };
    const res = await dispatchAgent(cfg, {
      systemPrompt: 's',
      taskPrompt: 't',
      fetchImpl: fakeFetch,
    });
    assert.equal(res.backend, 'local');
    assert.equal(res.output, 'routed local');
    assert.deepEqual(res.usage, { inputTokens: 1, outputTokens: 1 });
  });
});
