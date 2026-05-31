/**
 * AF-45: Executor adapter — the seam between orchestration and execution.
 *
 * Spec: docs/tech-design-orchestration.md §5.1.
 *
 * The Executor is a one-method interface: `run(agentId, input) → AgentResult`.
 * It dispatches a single agent through the AF CLI and returns the agent's
 * output plus the *measured* token usage reported by the backend. This single
 * seam is what keeps the orchestrator independent of execution: the orchestrator
 * never talks to a model directly, and the executor never knows which model ran.
 *
 * Key design constraints (from the ticket Acceptance + spec §5.1, §6.4):
 *   - No model/backend branching lives in the executor. Backend routing is the
 *     AF CLI's job (AF-42); the executor is a thin adapter over AF CLI dispatch.
 *   - Usage is MEASURED, not estimated. Every backend reports real token counts;
 *     this module only *normalizes* the differing shapes into a single
 *     `TokenUsage` ({ inputTokens, outputTokens }).
 *   - `AfCliExecutor` is production; `StubExecutor` returns canned results so the
 *     orchestrator can be unit-tested with no models.
 */

// --- Types ---

/**
 * Input handed to a single agent run. The orchestrator builds this; the
 * executor passes it through to AF CLI verbatim. Intentionally open-ended:
 * the orchestration layer owns the contract for what an agent receives, and
 * the executor stays agnostic to it.
 */
export interface AgentInput {
  /** The concrete task / objective text for this agent invocation. */
  objective: string;
  /** Optional structured context (prior outputs, artifacts, hand-offs). */
  context?: unknown;
  /** Working directory the agent should run in, if relevant. */
  cwd?: string;
}

/**
 * Normalized token usage, identical across all backends. Counts are the actual
 * values reported by the backend that ran the agent — never an estimate.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** The result of running one agent: its output plus measured usage. */
export interface AgentResult {
  output: unknown;
  /** Actual usage reported by the backend (not estimated). */
  usage: TokenUsage;
  /**
   * AF-FIX-A6: The backend that actually ran the agent (e.g. 'claude' |
   * 'local'), as reported by AF CLI dispatch. Threaded through so the
   * orchestrator can record it per step instead of defaulting to 'unknown'.
   * Optional so StubExecutor / older callers stay valid.
   */
  backend?: string;
}

/**
 * The Executor seam (spec §5.1). Runs ONE agent by slug and returns its output
 * plus usage. No model logic here.
 */
export interface Executor {
  run(agentId: string, input: AgentInput): Promise<AgentResult>;
}

// --- TokenUsage normalization ---

/**
 * Raw usage payload as it may arrive from any backend. The executor does not
 * branch on *which* backend produced it; it just maps whichever recognized
 * field names are present onto the normalized {@link TokenUsage} shape.
 *
 * Recognized shapes (spec §5.1):
 *   - Claude SDK:            input_tokens     / output_tokens
 *   - Ollama:                prompt_eval_count / eval_count
 *   - vLLM (OpenAI-compat):  prompt_tokens    / completion_tokens
 *
 * camelCase variants (inputTokens/outputTokens) are also accepted so a backend
 * that already normalizes passes through unchanged.
 */
export type RawUsage = Record<string, unknown>;

/** First finite, non-negative number found among the given keys; else 0. */
function pickCount(raw: RawUsage, keys: string[]): number {
  for (const key of keys) {
    const val = raw[key];
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      return val;
    }
  }
  return 0;
}

const INPUT_KEYS = [
  'inputTokens', // already-normalized
  'input_tokens', // Claude SDK
  'prompt_eval_count', // Ollama
  'prompt_tokens', // vLLM / OpenAI-compatible
];

const OUTPUT_KEYS = [
  'outputTokens', // already-normalized
  'output_tokens', // Claude SDK
  'eval_count', // Ollama
  'completion_tokens', // vLLM / OpenAI-compatible
];

/**
 * Normalize a backend's raw usage object into {@link TokenUsage}.
 *
 * This is deliberately shape-driven (it matches field *names*, not a declared
 * backend type) so the executor itself never branches on the backend. A backend
 * that reports nothing usable yields {0, 0} rather than throwing — usage
 * accounting must never crash a run, and a zero is a truthful "unreported".
 */
export function normalizeUsage(raw: unknown): TokenUsage {
  if (raw === null || typeof raw !== 'object') {
    return { inputTokens: 0, outputTokens: 0 };
  }

  // OpenAI/vLLM nest counts under a `usage` object; Claude SDK does too on the
  // result event. Prefer the nested object when present, falling back to top-level.
  const obj = raw as RawUsage;
  const source: RawUsage =
    obj.usage && typeof obj.usage === 'object' ? (obj.usage as RawUsage) : obj;

  return {
    inputTokens: pickCount(source, INPUT_KEYS),
    outputTokens: pickCount(source, OUTPUT_KEYS),
  };
}

/** Add two usage totals — used by the orchestrator to keep a running total. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

// --- AF CLI dispatch surface ---

/**
 * The programmatic AF CLI dispatch surface the production executor binds to
 * (spec §7: "agent-factory … must add … programmatic dispatch surface for the
 * Executor", AF-42). AF CLI resolves the agent's frontmatter and routes the
 * backend; it returns the raw output and the backend's raw usage payload.
 *
 * This is injected (rather than imported directly) so the executor depends only
 * on a narrow contract, AF-42 can evolve the implementation independently, and
 * tests can drive it without spawning a process.
 */
export interface AfCliDispatch {
  (agentId: string, input: AgentInput): Promise<{
    output: unknown;
    usage: unknown;
    /** AF-FIX-A6: backend that ran the agent; AF CLI dispatch computes it. */
    backend?: string;
  }>;
}

/** Construction options for {@link AfCliExecutor}. */
export interface AfCliExecutorOptions {
  /**
   * The AF CLI dispatch function. Required: there is no default model path here
   * by design — the executor must not embed dispatch/backend logic.
   */
  dispatch: AfCliDispatch;
}

/**
 * Production executor. A thin adapter: it forwards the agent + input to the AF
 * CLI dispatch surface and normalizes the returned usage. It contains NO
 * model/backend branching — routing is entirely AF CLI's responsibility.
 */
export class AfCliExecutor implements Executor {
  private readonly dispatch: AfCliDispatch;

  constructor(options: AfCliExecutorOptions) {
    if (typeof options?.dispatch !== 'function') {
      throw new Error('AfCliExecutor requires a `dispatch` function (the AF CLI dispatch surface)');
    }
    this.dispatch = options.dispatch;
  }

  async run(agentId: string, input: AgentInput): Promise<AgentResult> {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw new Error('Executor.run requires a non-empty agentId');
    }

    const { output, usage, backend } = await this.dispatch(agentId, input);
    // AF-FIX-A6: propagate the backend AF CLI reported so the orchestrator can
    // record it per step. Omitted when dispatch doesn't report one.
    const result: AgentResult = { output, usage: normalizeUsage(usage) };
    if (typeof backend === 'string' && backend.length > 0) result.backend = backend;
    return result;
  }
}

// --- StubExecutor (tests) ---

/** A single canned response keyed by agent slug. */
export interface CannedResult {
  output: unknown;
  /**
   * Usage for this agent. Accepts either an already-normalized {@link TokenUsage}
   * or any recognized raw backend shape; both are normalized on the way out so
   * tests can exercise the normalization path too.
   */
  usage: TokenUsage | RawUsage;
  /**
   * AF-FIX-A6: optional backend to report for this canned run, so orchestrator
   * tests can assert the backend is threaded into each step. Defaults to unset.
   */
  backend?: string;
}

/** Construction options for {@link StubExecutor}. */
export interface StubExecutorOptions {
  /**
   * Canned results keyed by agent slug. A `run` for a slug with no entry uses
   * {@link StubExecutorOptions.fallback} if provided, otherwise throws so tests
   * surface unexpected dispatches loudly.
   */
  results?: Record<string, CannedResult>;
  /** Default result for any slug not present in `results`. */
  fallback?: CannedResult;
}

/**
 * Test executor. Returns canned results + usage with no models, letting the
 * orchestrator be unit-tested deterministically. Records every call so tests
 * can assert on dispatch order and inputs.
 */
export class StubExecutor implements Executor {
  private readonly results: Record<string, CannedResult>;
  private readonly fallback?: CannedResult;

  /** Ordered log of every (agentId, input) pair passed to run(). */
  readonly calls: Array<{ agentId: string; input: AgentInput }> = [];

  constructor(options: StubExecutorOptions = {}) {
    this.results = options.results ?? {};
    this.fallback = options.fallback;
  }

  async run(agentId: string, input: AgentInput): Promise<AgentResult> {
    this.calls.push({ agentId, input });

    const canned = this.results[agentId] ?? this.fallback;
    if (!canned) {
      throw new Error(
        `StubExecutor: no canned result for agent "${agentId}" (and no fallback configured)`,
      );
    }

    const result: AgentResult = { output: canned.output, usage: normalizeUsage(canned.usage) };
    if (typeof canned.backend === 'string' && canned.backend.length > 0) {
      result.backend = canned.backend;
    }
    return result;
  }
}
