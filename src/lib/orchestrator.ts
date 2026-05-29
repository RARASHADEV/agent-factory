/**
 * AF-46: Orchestrator engine — constrained-dynamic supervisor + guardrails.
 *
 * Spec: docs/tech-design-orchestration.md §3 (control loop), §5.2 (interface),
 * §6.1 (input validation), §6.6 (guardrails).
 *
 * The orchestrator is domain- and model-agnostic. It loads a domain config
 * (AF-43), runs the configured supervisor in a constrained-dynamic loop
 * (Option B), exposes the roster as the only legal delegation targets, executes
 * delegated agents through the Executor seam (AF-45) — never a model directly —
 * and enforces every guardrail in §6.6. It returns a structured
 * {@link OrchestrationResult} carrying `stopReason` and `totalUsage`.
 *
 * Why a pluggable supervisor planner?
 *   The "supervisor decides which agents to call next" step is the only part
 *   that fundamentally needs a model. To keep the engine model-agnostic AND
 *   unit-testable with no live models, that decision is factored into a
 *   {@link SupervisorPlanner}. The default planner ({@link executorPlanner})
 *   runs the supervisor agent through the same Executor and parses its output
 *   into a {@link SupervisorDecision}. Tests inject a deterministic planner.
 *   Either way the loop, guardrails and result assembly are identical.
 */

import {
  addUsage,
  type AgentInput,
  type AgentResult,
  type Executor,
  type TokenUsage,
} from './executor.js';
import {
  loadDomainConfig,
  type DomainConfig,
  type ValidateOptions,
} from './domain-config.js';

// Re-export so callers/tests can type against the config without a second import.
export type { DomainConfig } from './domain-config.js';

// ── Public result + option types (spec §5.2) ─────────────────────────────

export type StopReason =
  | 'done'
  | 'max_delegations'
  | 'token_budget'
  | 'timeout'
  | 'no_progress'
  | 'max_revisions';

/** One executed delegation step recorded in the result. */
export interface OrchestrationStep {
  agent: string;
  /** Backend that ran the agent, if the executor reported one. */
  backend: string;
  output: unknown;
  usage: TokenUsage;
}

export interface OrchestrationResult {
  domain: string;
  objective: string;
  steps: OrchestrationStep[];
  /** Finalizer outputs keyed by agent slug (e.g. the reviewer verdict). */
  finalizers: Record<string, unknown>;
  /** Overall approval — true unless a finalizer returned approved:false. */
  approved: boolean;
  /** Accumulated usage across every step + finalizer. */
  totalUsage: TokenUsage;
  stopReason: StopReason;
  /** True when the run was a dry run (plan logged, nothing dispatched). */
  dryRun: boolean;
  /** Human-readable plan/trace lines (always populated; the only output in dryRun). */
  plan: string[];
}

export interface OrchestrateOptions {
  /** Log the plan, dispatch nothing. */
  dryRun?: boolean;
  /** Override policy.max_delegations. */
  maxDelegations?: number;
  /**
   * Injectable clock (ms) for the timeout guardrail. Defaults to Date.now.
   * Lets tests drive timeout deterministically without real waiting.
   */
  now?: () => number;
  /** Sink for plan/trace lines. Defaults to a no-op; lines are also in the result. */
  logger?: (line: string) => void;
  /** Directory holding agents/<slug>.md (for domain-config validation in tests). */
  agentsDir?: string;
  /** Directory holding orchestration/domains/*.yaml (for tests). */
  domainsDir?: string;
  /**
   * Pre-loaded domain config. When provided, the orchestrator uses it directly
   * instead of loading by name (useful for tests / callers that already hold one).
   */
  config?: DomainConfig;
  /**
   * Supervisor planner. Defaults to {@link executorPlanner} (runs the supervisor
   * agent via the Executor and parses its output). Tests inject deterministic ones.
   */
  planner?: SupervisorPlanner;
}

// ── Supervisor decision contract ─────────────────────────────────────────

/** A single delegation the supervisor wants to perform this round. */
export interface DelegationCall {
  /** Roster agent slug to invoke. */
  agent: string;
  /** Input for the agent. If omitted, the orchestrator builds a default input. */
  input?: AgentInput;
}

/**
 * What the supervisor decides each loop iteration: either it's `done`, or it
 * wants to delegate one or more `calls`. Multiple calls whose agents are all in
 * `policy.parallelizable` are fanned out concurrently (spec §3.1).
 */
export interface SupervisorDecision {
  done: boolean;
  calls?: DelegationCall[];
}

/** Read-only view of loop state handed to the planner each round. */
export interface PlannerState {
  domain: string;
  objective: string;
  supervisor: string;
  roster: readonly string[];
  /** Steps executed so far (most recent last). */
  history: readonly OrchestrationStep[];
  /** Total delegations dispatched so far. */
  delegations: number;
}

/**
 * The supervisor's decision function. Given current state, returns the next
 * decision. The default implementation runs the supervisor agent via the
 * Executor; tests supply a deterministic one.
 */
export interface SupervisorPlanner {
  (state: PlannerState): Promise<SupervisorDecision> | SupervisorDecision;
}

// ── Errors ───────────────────────────────────────────────────────────────

/** Thrown by input validation (spec §6.1) — fail loud before any dispatch. */
export class OrchestrationInputError extends Error {
  readonly errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = 'OrchestrationInputError';
    this.errors = errors.length > 0 ? errors : [message];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build the default per-agent input from the objective + accumulated history. */
function defaultInput(objective: string, history: readonly OrchestrationStep[]): AgentInput {
  return {
    objective,
    context: history.map((s) => ({ agent: s.agent, output: s.output })),
  };
}

/**
 * Extract an `approved` verdict from a finalizer's output. The reviewer returns
 * a structured `{ approved, score, issues }` (spec §3.3). We read `approved`
 * leniently: an explicit `false` means "not approved"; anything else (including
 * a missing field) is treated as approved so a finalizer that doesn't emit a
 * verdict never silently blocks completion.
 */
function readApproved(output: unknown): boolean {
  if (output && typeof output === 'object' && 'approved' in output) {
    return (output as { approved: unknown }).approved !== false;
  }
  return true;
}

/** Stable signature of a delegation for the no-progress detector. */
function callSignature(call: DelegationCall): string {
  return JSON.stringify({ agent: call.agent, input: call.input ?? null });
}

// ── Orchestrator ─────────────────────────────────────────────────────────

export class Orchestrator {
  private readonly executor: Executor;

  constructor(executor: Executor) {
    if (!executor || typeof executor.run !== 'function') {
      throw new Error('Orchestrator requires an Executor with a run() method');
    }
    this.executor = executor;
  }

  /**
   * Run the constrained-dynamic orchestration loop for a domain + objective.
   * Validates inputs first (§6.1, throws before any dispatch), then loops the
   * supervisor under the §6.6 guardrails, always runs required finalizers, and
   * returns a structured result with `stopReason` + `totalUsage`.
   */
  async run(
    domain: string,
    objective: string,
    opts: OrchestrateOptions = {},
  ): Promise<OrchestrationResult> {
    const now = opts.now ?? Date.now;
    const log = opts.logger ?? (() => {});
    const plan: string[] = [];
    const trace = (line: string) => {
      plan.push(line);
      log(line);
    };

    // --- Load + validate config and inputs BEFORE any dispatch (§6.1) ---
    const config = this.resolveConfig(domain, objective, opts);
    const policy = config.policy;
    const rosterSet = new Set(config.roster);

    const maxDelegations =
      opts.maxDelegations !== undefined ? opts.maxDelegations : policy.max_delegations;
    const tokenBudget = policy.token_budget;
    const timeoutMs =
      policy.timeout_seconds !== undefined ? policy.timeout_seconds * 1000 : undefined;
    const maxRevisions = policy.max_revision_loops;
    const abortOnNoProgress = policy.abort_on_no_progress === true;
    const rosterOnly = policy.roster_only !== false; // default true (spec §4.2 example)
    const finalizers = policy.required_finalizers ?? [];
    const parallelizable = new Set(policy.parallelizable ?? []);

    const startedAt = now();
    const planner = opts.planner ?? this.executorPlanner(config);

    const steps: OrchestrationStep[] = [];
    const finalizerOutputs: Record<string, unknown> = {};
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let delegations = 0;
    let stopReason: StopReason = 'done';

    const seenSignatures = new Set<string>();

    trace(
      `[orchestrate] domain=${config.domain} supervisor=${config.supervisor.agent} ` +
        `roster=[${config.roster.join(', ')}]${opts.dryRun ? ' (DRY RUN)' : ''}`,
    );
    trace(`[orchestrate] objective: ${objective}`);

    // --- Constrained-dynamic supervisor loop (§3.2) ---
    loop: while (true) {
      // Timeout is a wall-clock kill switch checked at the top of each round.
      if (timeoutMs !== undefined && now() - startedAt >= timeoutMs) {
        stopReason = 'timeout';
        trace(`[guardrail] timeout: ${policy.timeout_seconds}s elapsed — stopping`);
        break;
      }

      const decision = await planner({
        domain: config.domain,
        objective,
        supervisor: config.supervisor.agent,
        roster: config.roster,
        history: steps,
        delegations,
      });

      if (decision.done) {
        trace('[supervisor] decided: done');
        stopReason = 'done';
        break;
      }

      const calls = decision.calls ?? [];
      if (calls.length === 0) {
        // No work and not done → nothing to make progress with.
        trace('[supervisor] no calls and not done — treating as done');
        stopReason = 'done';
        break;
      }

      // roster_only guardrail (breadth) — validate every requested agent.
      if (rosterOnly) {
        for (const call of calls) {
          if (!rosterSet.has(call.agent)) {
            throw new OrchestrationInputError(
              `supervisor attempted to delegate to "${call.agent}" which is not in the roster ` +
                `(roster_only is enforced)`,
            );
          }
        }
      }

      // no_progress guardrail — repeated identical (agent+input) call.
      if (abortOnNoProgress) {
        for (const call of calls) {
          const sig = callSignature(call);
          if (seenSignatures.has(sig)) {
            stopReason = 'no_progress';
            trace(`[guardrail] no_progress: repeated call ${call.agent} — stopping`);
            break loop;
          }
        }
      }

      // max_delegations guardrail (length) — would this round exceed the cap?
      if (maxDelegations !== undefined && delegations + calls.length > maxDelegations) {
        stopReason = 'max_delegations';
        trace(
          `[guardrail] max_delegations: ${delegations}+${calls.length} > ${maxDelegations} — stopping`,
        );
        break;
      }

      // Mark signatures only once we've committed to executing this round.
      if (abortOnNoProgress) {
        for (const call of calls) seenSignatures.add(callSignature(call));
      }

      // Execute the round. Fan out concurrently iff every call is parallelizable
      // and there is more than one (spec §3.1, §3.2).
      const canParallel =
        calls.length > 1 && calls.every((c) => parallelizable.has(c.agent));

      const roundSteps = await this.executeCalls(
        calls,
        objective,
        steps,
        canParallel,
        opts.dryRun === true,
        trace,
      );

      for (const step of roundSteps) {
        steps.push(step);
        totalUsage = addUsage(totalUsage, step.usage);
      }
      delegations += calls.length;

      // token_budget guardrail (cost) — running total checked AFTER the step
      // (spec §5.1/§6.6: stops on the step after the budget is crossed).
      if (tokenBudget !== undefined) {
        const spent = totalUsage.inputTokens + totalUsage.outputTokens;
        if (spent >= tokenBudget) {
          stopReason = 'token_budget';
          trace(`[guardrail] token_budget: ${spent} >= ${tokenBudget} — stopping`);
          break;
        }
      }
    }

    // --- Required finalizers always run (§6.6 quality gate) ---
    // They run even on an enforced stop, with a bounded revision loop: if a
    // finalizer returns approved:false we re-run the latest non-finalizer worker
    // then the finalizer again, up to max_revision_loops times.
    let approved = true;
    if (finalizers.length > 0) {
      const result = await this.runFinalizers(
        finalizers,
        config,
        objective,
        steps,
        finalizerOutputs,
        maxRevisions,
        opts.dryRun === true,
        trace,
      );
      approved = result.approved;
      totalUsage = addUsage(totalUsage, result.usage);
      if (result.exhaustedRevisions) {
        // A still-unapproved result after exhausting the revision budget is a
        // distinct stop reason, but never overrides an earlier hard stop.
        if (stopReason === 'done') stopReason = 'max_revisions';
      }
    }

    trace(
      `[orchestrate] stopReason=${stopReason} approved=${approved} ` +
        `steps=${steps.length} tokens=${totalUsage.inputTokens + totalUsage.outputTokens}`,
    );

    return {
      domain: config.domain,
      objective,
      steps,
      finalizers: finalizerOutputs,
      approved,
      totalUsage,
      stopReason,
      dryRun: opts.dryRun === true,
      plan,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────

  /** Load (or accept) and shallow-validate the domain config + objective (§6.1). */
  private resolveConfig(
    domain: string,
    objective: string,
    opts: OrchestrateOptions,
  ): DomainConfig {
    const errors: string[] = [];

    // Objective must be a non-empty string — the prototype bug (§6.1): a missing
    // objective let agents confabulate. Fail loud before loading anything.
    if (typeof objective !== 'string' || objective.trim().length === 0) {
      errors.push('objective must be a non-empty string');
    }
    if (typeof domain !== 'string' || domain.trim().length === 0) {
      errors.push('domain must be a non-empty string');
    }
    if (errors.length > 0) {
      throw new OrchestrationInputError(
        `Invalid orchestration input: ${errors.length} problem${errors.length === 1 ? '' : 's'}`,
        errors,
      );
    }

    // Loading the config validates the supervisor + roster slugs resolve to real
    // agent files and that finalizers/parallelizable ⊆ roster (AF-43 validator,
    // which itself throws on any problem — satisfying "unresolved slugs" of §6.1).
    if (opts.config) return opts.config;

    const validateOpts: ValidateOptions & { domainsDir?: string } = {};
    if (opts.agentsDir) validateOpts.agentsDir = opts.agentsDir;
    if (opts.domainsDir) validateOpts.domainsDir = opts.domainsDir;
    return loadDomainConfig(domain, validateOpts);
  }

  /**
   * Execute one round of delegation calls and return the resulting steps. When
   * `dryRun`, nothing is dispatched: a zero-usage placeholder step is recorded
   * so the plan is fully traceable without touching a model.
   */
  private async executeCalls(
    calls: DelegationCall[],
    objective: string,
    history: readonly OrchestrationStep[],
    parallel: boolean,
    dryRun: boolean,
    trace: (line: string) => void,
  ): Promise<OrchestrationStep[]> {
    const runOne = async (call: DelegationCall): Promise<OrchestrationStep> => {
      const input = call.input ?? defaultInput(objective, history);
      if (dryRun) {
        trace(`[dry-run] would dispatch ${call.agent}`);
        return { agent: call.agent, backend: 'dry-run', output: null, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      trace(`[dispatch] ${call.agent}`);
      const result = await this.executor.run(call.agent, input);
      return toStep(call.agent, result);
    };

    if (parallel) {
      trace(`[parallel] fan out ${calls.length}: [${calls.map((c) => c.agent).join(', ')}]`);
      return Promise.all(calls.map(runOne));
    }
    const out: OrchestrationStep[] = [];
    for (const call of calls) out.push(await runOne(call));
    return out;
  }

  /**
   * Run the required finalizers, applying the bounded revision loop. On a
   * finalizer verdict approved:false, re-run the most recent worker (the last
   * non-finalizer step's agent) then the finalizer again, up to
   * `maxRevisions` times.
   */
  private async runFinalizers(
    finalizers: string[],
    config: DomainConfig,
    objective: string,
    steps: OrchestrationStep[],
    finalizerOutputs: Record<string, unknown>,
    maxRevisions: number | undefined,
    dryRun: boolean,
    trace: (line: string) => void,
  ): Promise<{ approved: boolean; usage: TokenUsage; exhaustedRevisions: boolean }> {
    const finalizerSet = new Set(finalizers);
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let approved = true;
    let exhaustedRevisions = false;
    const maxLoops = maxRevisions ?? 0;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      approved = true;
      for (const slug of finalizers) {
        if (dryRun) {
          trace(`[dry-run] would run finalizer ${slug}`);
          finalizerOutputs[slug] = null;
          continue;
        }
        trace(`[finalizer] ${slug}${attempt > 0 ? ` (revision ${attempt})` : ''}`);
        const result = await this.executor.run(slug, defaultInput(objective, steps));
        const step = toStep(slug, result);
        steps.push(step);
        usage = addUsage(usage, step.usage);
        finalizerOutputs[slug] = result.output;
        if (!readApproved(result.output)) approved = false;
      }

      if (approved || dryRun) break;

      // Not approved → maybe revise.
      if (attempt >= maxLoops) {
        exhaustedRevisions = true;
        trace(`[guardrail] max_revisions: ${maxLoops} revision loop(s) exhausted, still not approved`);
        break;
      }
      attempt++;

      // Re-run the most recent non-finalizer worker (e.g. the writer).
      const worker = [...steps].reverse().find((s) => !finalizerSet.has(s.agent));
      if (!worker) {
        // Nothing to revise — bail out of the loop rather than spin.
        exhaustedRevisions = true;
        trace('[revision] no worker step to re-run — stopping revision loop');
        break;
      }
      trace(`[revision ${attempt}] re-running worker ${worker.agent}`);
      const revised = await this.executor.run(worker.agent, defaultInput(objective, steps));
      const revisedStep = toStep(worker.agent, revised);
      steps.push(revisedStep);
      usage = addUsage(usage, revisedStep.usage);
    }

    return { approved, usage, exhaustedRevisions };
  }

  /**
   * Default supervisor planner: runs the supervisor agent through the Executor
   * and parses its output into a {@link SupervisorDecision}. The supervisor is
   * expected to emit either `{ done: true }` or `{ calls: [{ agent, ... }] }`
   * (as an object or a JSON string). Anything unrecognized is treated as done
   * so an under-specified supervisor stops cleanly rather than looping.
   */
  private executorPlanner(config: DomainConfig): SupervisorPlanner {
    return async (state: PlannerState): Promise<SupervisorDecision> => {
      const result = await this.executor.run(config.supervisor.agent, {
        objective: state.objective,
        context: {
          roster: config.roster,
          history: state.history.map((s) => ({ agent: s.agent, output: s.output })),
          delegations: state.delegations,
          goal: config.supervisor.goal,
        },
      });
      return parseSupervisorDecision(result.output);
    };
  }
}

// ── Parsing helpers (exported for tests) ─────────────────────────────────

function toStep(agent: string, result: AgentResult): OrchestrationStep {
  const backend =
    result && typeof result === 'object' && 'backend' in result &&
    typeof (result as { backend?: unknown }).backend === 'string'
      ? (result as { backend: string }).backend
      : 'unknown';
  return { agent, backend, output: result.output, usage: result.usage };
}

/**
 * Parse a supervisor's raw output into a {@link SupervisorDecision}. Accepts
 * either a decision object or a JSON string holding one. Recognized shapes:
 *   - { done: true }
 *   - { calls: [{ agent: "slug", input?: {...} }, ...] }
 *   - { agent: "slug" }  (single-call shorthand)
 * Unrecognized / empty output → { done: true } (stop cleanly).
 */
export function parseSupervisorDecision(output: unknown): SupervisorDecision {
  let value = output;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    try {
      value = JSON.parse(trimmed);
    } catch {
      // Non-JSON text from the supervisor → treat as "done".
      return { done: true };
    }
  }

  if (!value || typeof value !== 'object') return { done: true };
  const obj = value as Record<string, unknown>;

  if (obj.done === true) return { done: true };

  let rawCalls: unknown[] | undefined;
  if (Array.isArray(obj.calls)) {
    rawCalls = obj.calls;
  } else if (typeof obj.agent === 'string') {
    rawCalls = [obj];
  }

  if (!rawCalls || rawCalls.length === 0) return { done: true };

  const calls: DelegationCall[] = [];
  for (const c of rawCalls) {
    if (c && typeof c === 'object' && typeof (c as { agent?: unknown }).agent === 'string') {
      const co = c as { agent: string; input?: unknown };
      const call: DelegationCall = { agent: co.agent };
      if (co.input && typeof co.input === 'object' && 'objective' in co.input) {
        call.input = co.input as AgentInput;
      }
      calls.push(call);
    }
  }

  if (calls.length === 0) return { done: true };
  return { done: false, calls };
}

/** Convenience factory mirroring other AF modules. */
export function createOrchestrator(executor: Executor): Orchestrator {
  return new Orchestrator(executor);
}
