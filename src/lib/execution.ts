/**
 * AF-42: Execution backend routing.
 *
 * Resolves an agent's `execution` frontmatter block into a normalized
 * ExecutionConfig and dispatches to the correct backend (Claude SDK or a
 * local Ollama/vLLM endpoint). Model routing lives HERE — one place — per
 * the orchestration design (docs/tech-design-orchestration.md §2.1, §4.1).
 *
 * Nothing above AF CLI knows or cares which backend ran.
 */

import { ENABLE_AF_42, LOCAL_ENDPOINT_ALLOWLIST } from './constants.js';

// ── Types (design §4.1, §5.1) ────────────────────────────────────────────

export type Backend = 'claude' | 'local';
export type ToolCalling = 'native' | 'prompt';

/** Raw `execution` block as it may appear in agent frontmatter. All optional. */
export interface ExecutionFrontmatter {
  backend?: string;
  model?: string;
  endpoint?: string;
  toolCalling?: string;
}

/** Fully-resolved, validated execution config (no undefined fields). */
export interface ExecutionConfig {
  backend: Backend;
  /** Backend-specific model id/tag. May be undefined → backend default applies. */
  model?: string;
  /** Resolved endpoint URL for local backends. undefined for claude. */
  endpoint?: string;
  toolCalling: ToolCalling;
}

/** Normalized token usage reported by a backend (design §5.1, AF-45). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface BackendResult {
  output: string;
  usage: TokenUsage;
}

/** Default local endpoint when an agent specifies no `endpoint` (Ollama default). */
export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434';

// ── Frontmatter resolution (design §4.1) ─────────────────────────────────

/**
 * Resolve an agent's raw `execution` frontmatter into a normalized
 * ExecutionConfig, applying defaults. An absent block defaults to Claude —
 * preserving today's behavior for every existing agent (back-compat).
 *
 * Throws on an unknown backend or toolCalling value so misconfiguration
 * fails loud rather than silently routing to the wrong place (design §6.1).
 */
export function resolveExecution(raw: unknown): ExecutionConfig {
  // Absent / non-object block → Claude default (back-compat).
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { backend: 'claude', toolCalling: 'native' };
  }

  const block = raw as ExecutionFrontmatter;

  const backend = (block.backend ?? 'claude').toString().trim().toLowerCase();
  if (backend !== 'claude' && backend !== 'local') {
    throw new Error(
      `execution.backend "${block.backend}" is invalid (expected "claude" or "local")`,
    );
  }

  // toolCalling default is per-backend: native for claude, prompt for local.
  let toolCalling: ToolCalling;
  if (block.toolCalling == null) {
    toolCalling = backend === 'local' ? 'prompt' : 'native';
  } else {
    const tc = block.toolCalling.toString().trim().toLowerCase();
    if (tc !== 'native' && tc !== 'prompt') {
      throw new Error(
        `execution.toolCalling "${block.toolCalling}" is invalid (expected "native" or "prompt")`,
      );
    }
    toolCalling = tc;
  }

  const model = block.model != null ? String(block.model).trim() || undefined : undefined;

  let endpoint: string | undefined;
  if (backend === 'local') {
    endpoint = block.endpoint
      ? String(block.endpoint).trim()
      : DEFAULT_LOCAL_ENDPOINT;
  } else if (block.endpoint != null) {
    // endpoint is meaningless for claude; ignore it but don't error.
    endpoint = undefined;
  }

  return { backend, model, endpoint, toolCalling };
}

// ── SSRF guard (design §8) ───────────────────────────────────────────────

/**
 * Validate a local endpoint URL against an allow-list of host:scheme pairs.
 * The endpoint is operator-set inside an agent file, so a tampered file could
 * otherwise point the dispatcher at an arbitrary internal service (SSRF).
 *
 * Returns the parsed URL on success; throws with a clear reason otherwise.
 */
export function validateEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`execution.endpoint "${endpoint}" is not a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `execution.endpoint "${endpoint}" uses disallowed scheme "${url.protocol}" (expected http/https)`,
    );
  }

  const host = url.hostname.toLowerCase();
  const allowed = LOCAL_ENDPOINT_ALLOWLIST.some((entry) => {
    const e = entry.toLowerCase();
    // Exact host match, or a "*.suffix" wildcard entry.
    if (e.startsWith('*.')) {
      return host === e.slice(2) || host.endsWith(e.slice(1));
    }
    return host === e;
  });

  if (!allowed) {
    throw new Error(
      `execution.endpoint host "${url.hostname}" is not in the allow-list ` +
        `[${LOCAL_ENDPOINT_ALLOWLIST.join(', ')}] (SSRF guard)`,
    );
  }

  return url;
}

// ── Local backend dispatch (design §6.2) ─────────────────────────────────

interface DispatchOptions {
  systemPrompt: string;
  taskPrompt: string;
  /** Wall-clock cap for the HTTP request (ms). */
  timeoutMs?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Detect a vLLM (OpenAI-compatible) endpoint vs. native Ollama.
 * vLLM serves `/v1/...`; Ollama serves `/api/...`. We key off the path.
 */
function isOpenAiCompatible(url: URL): boolean {
  return url.pathname.includes('/v1');
}

/**
 * Build the prompt-based tool-calling preamble (design §6.2). Local models
 * have weak native function-calling, so when toolCalling=prompt we ask the
 * model to emit a structured JSON action block we can parse downstream,
 * rather than relying on a native tools API.
 */
export function buildPromptToolPreamble(): string {
  return [
    'You do not have a native tool API. When you need to use a tool, respond',
    'with a single fenced ```action block containing JSON of the form:',
    '{ "tool": "<name>", "input": { ... } }.',
    'When you are finished, respond with your final answer as plain text and',
    'no action block.',
  ].join(' ');
}

/**
 * Parse a prompt-protocol tool action out of local-model output (design §6.2).
 * Returns the parsed action, or null if the model produced a final answer.
 */
export function parsePromptToolAction(
  text: string,
): { tool: string; input: unknown } | null {
  const match = text.match(/```action\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed && typeof parsed.tool === 'string') {
      return { tool: parsed.tool, input: parsed.input };
    }
  } catch {
    // Not parseable → treat as final answer, not an action.
  }
  return null;
}

/**
 * Normalize a backend's raw usage payload into TokenUsage (design §5.1).
 *  - Ollama:               prompt_eval_count / eval_count
 *  - vLLM (OpenAI-compat):  usage.prompt_tokens / usage.completion_tokens
 */
export function normalizeUsage(raw: any): TokenUsage {
  if (!raw || typeof raw !== 'object') {
    return { inputTokens: 0, outputTokens: 0 };
  }
  // OpenAI-compatible nested usage.
  const u = raw.usage ?? raw;
  const inputTokens =
    u.prompt_tokens ?? u.prompt_eval_count ?? raw.prompt_eval_count ?? 0;
  const outputTokens =
    u.completion_tokens ?? u.eval_count ?? raw.eval_count ?? 0;
  return {
    inputTokens: Number(inputTokens) || 0,
    outputTokens: Number(outputTokens) || 0,
  };
}

/**
 * Dispatch a single agent run to a local Ollama/vLLM backend.
 * Validates the endpoint (SSRF guard) before any network call.
 */
export async function dispatchLocal(
  config: ExecutionConfig,
  opts: DispatchOptions,
): Promise<BackendResult> {
  if (config.backend !== 'local') {
    throw new Error(`dispatchLocal called with backend "${config.backend}"`);
  }
  const endpoint = config.endpoint ?? DEFAULT_LOCAL_ENDPOINT;
  const url = validateEndpoint(endpoint); // throws on disallowed host/scheme

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // For toolCalling=prompt, inject the prompt-based tool protocol preamble.
  const systemPrompt =
    config.toolCalling === 'prompt'
      ? `${opts.systemPrompt.trim()}\n\n${buildPromptToolPreamble()}`
      : opts.systemPrompt.trim();

  try {
    if (isOpenAiCompatible(url)) {
      return await dispatchOpenAiCompatible(url, config, systemPrompt, opts.taskPrompt, doFetch, controller.signal);
    }
    return await dispatchOllama(url, config, systemPrompt, opts.taskPrompt, doFetch, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function dispatchOllama(
  url: URL,
  config: ExecutionConfig,
  systemPrompt: string,
  taskPrompt: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<BackendResult> {
  // Ollama chat API: POST {base}/api/chat
  const target = new URL('/api/chat', url).toString();
  const body = {
    model: config.model ?? 'llama3.1',
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: taskPrompt },
    ],
  };

  const res = await doFetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Ollama backend returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as any;
  const output = data?.message?.content ?? data?.response ?? '';
  return { output: String(output), usage: normalizeUsage(data) };
}

async function dispatchOpenAiCompatible(
  url: URL,
  config: ExecutionConfig,
  systemPrompt: string,
  taskPrompt: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<BackendResult> {
  // vLLM OpenAI-compatible: POST {base}/v1/chat/completions
  // Preserve any path prefix up to /v1.
  const base = url.toString().replace(/\/+$/, '').replace(/\/v1.*$/, '');
  const target = `${base}/v1/chat/completions`;
  const body = {
    model: config.model ?? 'default',
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: taskPrompt },
    ],
  };

  const res = await doFetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`vLLM backend returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as any;
  const output = data?.choices?.[0]?.message?.content ?? '';
  return { output: String(output), usage: normalizeUsage(data) };
}

// ── Backend router (design §2.1 — routing lives in ONE place) ────────────

export interface DispatchAgentOptions {
  systemPrompt: string;
  taskPrompt: string;
  /** Claude-path knobs (ignored for local). */
  maxTurns?: number;
  tools?: string[];
  disallowedTools?: string[];
  cwd?: string;
  /** Local-path wall-clock cap (ms). */
  timeoutMs?: number;
  /** Injectable fetch for the local path (tests). */
  fetchImpl?: typeof fetch;
}

export interface DispatchAgentResult {
  backend: Backend;
  output: string;
  usage: TokenUsage;
}

/**
 * Route a single agent run to the backend named in its resolved execution
 * config. This is the single routing point (design §2.1): callers above never
 * choose a backend. Claude runs through the existing SDK wrapper; `local`
 * dispatches to Ollama/vLLM with endpoint validation + prompt-tool support.
 */
export async function dispatchAgent(
  config: ExecutionConfig,
  opts: DispatchAgentOptions,
): Promise<DispatchAgentResult> {
  if (config.backend === 'local') {
    if (!ENABLE_AF_42) {
      throw new Error(
        'execution.backend "local" requested but the local backend is disabled (ENABLE_AF_42=false)',
      );
    }
    const res = await dispatchLocal(config, {
      systemPrompt: opts.systemPrompt,
      taskPrompt: opts.taskPrompt,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
    });
    return { backend: 'local', output: res.output, usage: res.usage };
  }

  // Claude path — existing SDK wrapper. Imported lazily to avoid loading the
  // Agent SDK in tests / local-only runs.
  const { runAgent } = await import('./sdk.js');
  const result = await runAgent(opts.systemPrompt, opts.taskPrompt, {
    model: config.model,
    maxTurns: opts.maxTurns,
    tools: opts.tools,
    disallowedTools: opts.disallowedTools,
    cwd: opts.cwd,
  });
  return {
    backend: 'claude',
    output: result.result,
    usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
  };
}

// ── Guard so the feature can be disabled wholesale ───────────────────────

/** True when the local backend is enabled. Mirrors other AF feature flags. */
export function localBackendEnabled(): boolean {
  return ENABLE_AF_42;
}
