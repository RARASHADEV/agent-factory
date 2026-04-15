/**
 * AF-26: Gate evaluator — evaluates a single-condition gate against a
 * phase's result.json.
 *
 * Supports the 9 operators defined in AF-24's GateDefinition:
 *   eq, neq, exists, not_exists, contains, gt, gte, lt, lte
 *
 * Pure function — never throws. The caller (pipeline runner) decides
 * how to react to a failure.
 *
 * AF-27 will layer compound gates (all/any), retry, and regex on top;
 * this module stays compatible with that extension.
 */

import type { GateDefinition, GateOperator } from './pipeline.js';
import type { ResultSchema } from './result-schema.js';
import { getByDotPath } from './artifact-injector.js';

// --- Types ---

export interface GateEvaluationSuccess {
  passed: true;
}

export interface GateEvaluationFailure {
  passed: false;
  field: string;
  operator: GateOperator;
  expected?: unknown;
  actual: unknown;
  message: string;
}

export type GateEvaluationResult = GateEvaluationSuccess | GateEvaluationFailure;

// --- Evaluation ---

/**
 * Evaluate a single-condition gate against a phase's result.json.
 *
 * - Dot-path field access (e.g., "metadata.pr_url" → resultJson.metadata.pr_url)
 * - Supports the 9 operators defined in AF-24: eq, neq, exists, not_exists,
 *   contains, gt, gte, lt, lte
 * - Never throws — always returns a result
 *
 * Phases without a gate pass automatically (caller short-circuits).
 */
export function evaluateGate(
  gate: GateDefinition,
  result: ResultSchema,
): GateEvaluationResult {
  const actual = getByDotPath(
    result as unknown as Record<string, unknown>,
    gate.field,
  );

  const mkFail = (message: string): GateEvaluationFailure => ({
    passed: false,
    field: gate.field,
    operator: gate.operator,
    expected: gate.value,
    actual,
    message,
  });

  switch (gate.operator) {
    case 'exists':
      return actual !== undefined && actual !== null
        ? { passed: true }
        : mkFail(
            `Gate failed at ${gate.field}: expected field to exist, got ${JSON.stringify(actual)}`,
          );

    case 'not_exists':
      return actual === undefined || actual === null
        ? { passed: true }
        : mkFail(
            `Gate failed at ${gate.field}: expected field to not exist, got ${JSON.stringify(actual)}`,
          );

    case 'eq':
      return actual === gate.value
        ? { passed: true }
        : mkFail(
            `Gate failed at ${gate.field}: expected eq ${JSON.stringify(gate.value)}, got ${JSON.stringify(actual)}`,
          );

    case 'neq':
      return actual !== gate.value
        ? { passed: true }
        : mkFail(
            `Gate failed at ${gate.field}: expected neq ${JSON.stringify(gate.value)}, got ${JSON.stringify(actual)}`,
          );

    case 'contains': {
      let ok = false;
      if (Array.isArray(actual)) {
        ok = actual.includes(gate.value);
      } else if (typeof actual === 'string' && gate.value !== undefined) {
        ok = actual.includes(String(gate.value));
      }
      return ok
        ? { passed: true }
        : mkFail(
            `Gate failed at ${gate.field}: expected to contain ${JSON.stringify(gate.value)}, got ${JSON.stringify(actual)}`,
          );
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual);
      const v = Number(gate.value);
      if (!Number.isFinite(a) || !Number.isFinite(v)) {
        return mkFail(
          `Gate failed at ${gate.field}: ${gate.operator} requires numeric operands, got actual=${JSON.stringify(actual)} value=${JSON.stringify(gate.value)}`,
        );
      }
      const ok =
        gate.operator === 'gt' ? a > v
        : gate.operator === 'gte' ? a >= v
        : gate.operator === 'lt' ? a < v
        : /* lte */ a <= v;
      return ok
        ? { passed: true }
        : mkFail(
            `Gate failed at ${gate.field}: expected ${gate.operator} ${v}, got ${a}`,
          );
    }
  }
}
