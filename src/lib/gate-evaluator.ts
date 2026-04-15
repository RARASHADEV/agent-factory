/**
 * AF-27: Gate evaluator — evaluate a gate (single or compound) against a
 * phase's result.json.
 *
 * Supports the 10 operators defined in AF-24/27's gate schema:
 *   eq, neq, exists, not_exists, contains, matches, gt, gte, lt, lte
 *
 * Compound modes:
 *   - single (shorthand): a top-level { field, operator, value } condition
 *   - all:                every condition must pass (AND)
 *   - any:                at least one condition must pass (OR)
 *
 * Pure function — never throws. The caller (pipeline runner) decides how to
 * react to a failure and whether to retry.
 *
 * Retry and remediation are wired here in terms of return shape; the runner
 * owns the retry loop itself (this module is I/O-free).
 */

import type { GateCondition, GateDefinition, GateOperator } from './pipeline.js';
import type { ResultSchema } from './result-schema.js';
import { getByDotPath } from './artifact-injector.js';

// --- Types ---

/**
 * A single failing condition — with enough context for a human to diagnose
 * and an actionable remediation string.
 */
export interface GateFailure {
  /** The condition that failed (normalized — shorthand is lifted to a condition). */
  condition: GateCondition;
  /** The value observed at `condition.field`. */
  actual: unknown;
  /** Human-readable "expected X, got Y" message. */
  message: string;
  /** One-line suggestion for how to fix the failure. */
  remediation?: string;
}

/**
 * Result of evaluating a gate. `failures` is [] when the gate passed.
 *
 * For `all`: failures contains every failing condition (order-preserving).
 * For `any`: failures is [] if any condition passed; otherwise contains all failures.
 * For `single`: failures is [] or exactly one entry.
 */
export interface GateEvaluationResult {
  passed: boolean;
  failures: GateFailure[];
  mode: 'single' | 'all' | 'any';
}

// --- Normalization ---

/**
 * Normalize a GateDefinition into an (mode, conditions) pair.
 * Undefined/empty gates return mode='single' with an empty condition list so
 * downstream evaluation treats the gate as a no-op success (defensive — the
 * validator rejects this at load time).
 */
function normalizeGate(gate: GateDefinition): {
  mode: 'single' | 'all' | 'any';
  conditions: GateCondition[];
} {
  const hasShorthand =
    gate.field !== undefined || gate.operator !== undefined;

  if (hasShorthand) {
    return {
      mode: 'single',
      conditions: [
        {
          field: gate.field ?? '',
          operator: (gate.operator ?? 'eq') as GateOperator,
          value: gate.value,
        },
      ],
    };
  }

  if (Array.isArray(gate.all)) {
    return { mode: 'all', conditions: gate.all };
  }
  if (Array.isArray(gate.any)) {
    return { mode: 'any', conditions: gate.any };
  }

  // Defensive — validator catches this.
  return { mode: 'single', conditions: [] };
}

// --- Evaluation ---

/**
 * Evaluate a single condition. Returns null on pass, or a GateFailure on fail.
 * Pure — never throws.
 */
export function evaluateCondition(
  cond: GateCondition,
  result: ResultSchema,
): GateFailure | null {
  const actual = getByDotPath(
    result as unknown as Record<string, unknown>,
    cond.field,
  );

  const fail = (message: string, remediation?: string): GateFailure => ({
    condition: cond,
    actual,
    message,
    remediation,
  });

  switch (cond.operator) {
    case 'exists':
      return actual !== undefined && actual !== null
        ? null
        : fail(
            `Gate failed at ${cond.field}: expected field to exist, got ${JSON.stringify(actual)}`,
            `Ensure the agent emits '${cond.field}' in its result.json.`,
          );

    case 'not_exists':
      return actual === undefined || actual === null
        ? null
        : fail(
            `Gate failed at ${cond.field}: expected field to not exist, got ${JSON.stringify(actual)}`,
            `Ensure the agent omits '${cond.field}' from its result.json.`,
          );

    case 'eq':
      return actual === cond.value
        ? null
        : fail(
            `Gate failed at ${cond.field}: expected eq ${JSON.stringify(cond.value)}, got ${JSON.stringify(actual)}`,
            `Expected '${cond.field}' to equal ${JSON.stringify(cond.value)}; agent returned ${JSON.stringify(actual)}. Check agent logic or update the gate.`,
          );

    case 'neq':
      return actual !== cond.value
        ? null
        : fail(
            `Gate failed at ${cond.field}: expected neq ${JSON.stringify(cond.value)}, got ${JSON.stringify(actual)}`,
            `Expected '${cond.field}' to not equal ${JSON.stringify(cond.value)}; agent returned ${JSON.stringify(actual)}. Check agent logic or update the gate.`,
          );

    case 'contains': {
      let ok = false;
      if (Array.isArray(actual)) {
        ok = actual.includes(cond.value);
      } else if (typeof actual === 'string' && cond.value !== undefined) {
        ok = actual.includes(String(cond.value));
      }
      return ok
        ? null
        : fail(
            `Gate failed at ${cond.field}: expected to contain ${JSON.stringify(cond.value)}, got ${JSON.stringify(actual)}`,
            `Expected '${cond.field}' to contain ${JSON.stringify(cond.value)}. Verify the agent populates this field correctly.`,
          );
    }

    case 'matches': {
      if (typeof actual !== 'string') {
        return fail(
          `Gate failed at ${cond.field}: expected string for regex match, got ${typeof actual} (${JSON.stringify(actual)})`,
          `Check that '${cond.field}' is a string field in result.json.`,
        );
      }
      let re: RegExp;
      try {
        re = new RegExp(String(cond.value));
      } catch (e: any) {
        return fail(
          `Gate failed at ${cond.field}: gate value is not a valid regex: ${JSON.stringify(cond.value)}`,
          `Fix the regex pattern in the gate definition.`,
        );
      }
      return re.test(actual)
        ? null
        : fail(
            `Gate failed at ${cond.field}: expected to match /${String(cond.value)}/, got ${JSON.stringify(actual)}`,
            `Check the agent's output format or relax the regex.`,
          );
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual);
      const v = Number(cond.value);
      if (!Number.isFinite(a) || !Number.isFinite(v)) {
        return fail(
          `Gate failed at ${cond.field}: ${cond.operator} requires numeric operands, got actual=${JSON.stringify(actual)} value=${JSON.stringify(cond.value)}`,
          `Check that '${cond.field}' is produced as a finite number in result.json.`,
        );
      }
      const ok =
        cond.operator === 'gt' ? a > v
        : cond.operator === 'gte' ? a >= v
        : cond.operator === 'lt' ? a < v
        : /* lte */ a <= v;
      return ok
        ? null
        : fail(
            `Gate failed at ${cond.field}: expected ${cond.operator} ${v}, got ${a}`,
            `Numeric comparison failed. Check that '${cond.field}' is produced as a finite number and meets the threshold.`,
          );
    }
  }

  // Exhaustiveness — unreachable for valid operators (validator rejects others).
  return fail(
    `Gate failed at ${cond.field}: unknown operator '${String(cond.operator)}'`,
    `Use one of the supported operators (eq, neq, exists, not_exists, contains, matches, gt, gte, lt, lte).`,
  );
}

/**
 * Evaluate a gate (single or compound) against a phase's result.json.
 *
 * - Dot-path field access (incl. bracket indexing like `artifacts[0].path`)
 * - Supports 10 operators (AF-24 9 ops + `matches`)
 * - Supports compound gates: `all` (AND) and `any` (OR)
 * - Returns every failing condition (not just the first) for diagnostics
 * - Never throws — always returns a result
 *
 * Phases without a gate should short-circuit in the caller; an empty gate
 * passed here defensively returns passed=true.
 */
export function evaluateGate(
  gate: GateDefinition,
  result: ResultSchema,
): GateEvaluationResult {
  const { mode, conditions } = normalizeGate(gate);

  if (conditions.length === 0) {
    return { passed: true, failures: [], mode };
  }

  const failures: GateFailure[] = [];
  let anyPassed = false;

  for (const cond of conditions) {
    const failure = evaluateCondition(cond, result);
    if (failure === null) {
      anyPassed = true;
    } else {
      failures.push(failure);
    }
  }

  if (mode === 'any') {
    return anyPassed
      ? { passed: true, failures: [], mode }
      : { passed: false, failures, mode };
  }

  // single / all: pass iff no failures
  return {
    passed: failures.length === 0,
    failures,
    mode,
  };
}
