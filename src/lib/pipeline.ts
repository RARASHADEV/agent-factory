/**
 * AF-24: Pipeline definition format — YAML schema, TypeScript types,
 * loader, validator, and topological sort.
 *
 * Pipeline definitions live in `.af/pipelines/<name>.yaml`.
 * This module provides the typed data structures and validation logic
 * consumed by AF-25 (artifact injection), AF-26 (pipeline runner),
 * and AF-27 (gate evaluation).
 *
 * Pure data + validation — does not execute pipelines or evaluate gates.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { ENABLE_AF_27 } from './constants.js';

// --- Constants ---

const PIPELINES_DIR = 'pipelines';

/** Maximum allowed retries on a gate. Soft cap to prevent runaway compute on deterministic failures. */
export const MAX_GATE_RETRY = 5;

// --- Gate operators ---

export const GATE_OPERATORS = [
  'eq', 'neq', 'exists', 'not_exists', 'contains', 'matches',
  'gt', 'gte', 'lt', 'lte',
] as const;

export type GateOperator = (typeof GATE_OPERATORS)[number];

/** Operators that require a `value` field */
const VALUE_REQUIRED_OPERATORS: readonly GateOperator[] = [
  'eq', 'neq', 'contains', 'matches', 'gt', 'gte', 'lt', 'lte',
];

/** Operators gated behind ENABLE_AF_27 */
const AF_27_OPERATORS: readonly GateOperator[] = ['matches'];

// --- Gate definition ---

/**
 * A single atomic gate condition — one field, one operator, one expected value.
 */
export interface GateCondition {
  /** Dot-path into result.json. E.g., "status", "metadata.pr_url", "artifacts[0].path" */
  field: string;
  /** Comparison operator */
  operator: GateOperator;
  /** Expected value. Required for eq/neq/contains/matches/gt/gte/lt/lte. Omit for exists/not_exists. */
  value?: string | number | boolean;
}

/**
 * Gate definition. Backward-compatible superset of AF-26's single-condition shape.
 *
 * One-of:
 *   - Shorthand: top-level { field, operator, value } — same as AF-26
 *   - Compound:  { all: GateCondition[] }     — all conditions must pass (AND)
 *   - Compound:  { any: GateCondition[] }     — at least one must pass  (OR)
 *
 * Optional: `retry: N` — re-run the phase up to N additional times on gate failure.
 *
 * Invalid combinations (rejected by validator):
 *   - shorthand fields + `all` or `any` in the same spec
 *   - `all` AND `any` in the same spec (nested groups are a future extension)
 *   - neither shorthand nor all/any present (empty gate)
 */
export interface GateDefinition {
  // Shorthand (AF-26 compat)
  field?: string;
  operator?: GateOperator;
  value?: string | number | boolean;

  // Compound
  all?: GateCondition[];
  any?: GateCondition[];

  // Retry
  retry?: number;
}

// --- Artifact injection ---

export interface InjectDefinition {
  /** Phase name to inject from (must be in `requires` or a transitive dependency) */
  from: string;
  /** What to inject — a file glob with {ticket} placeholder or a dot-path into result.json */
  artifact: string;
  /** Label for this injection in the composed prompt */
  as: string;
}

// --- Phase definition ---

export interface PhaseDefinition {
  /** Unique phase name (e.g., "design", "implement", "verify") */
  name: string;
  /** Agent slug to spawn (must exist in agents/ registry) */
  agent: string;
  /** Phase names that must complete before this phase runs */
  requires?: string[];
  /** Artifacts to inject from prior phases into this agent's prompt */
  inject?: InjectDefinition[];
  /** Gate condition — evaluated against result.json after agent completes */
  gate?: GateDefinition;
}

// --- Pipeline definition ---

export interface PipelineDefinition {
  /** Pipeline name (matches filename without .yaml extension) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** List of phases (YAML authoring order; execution order is topological) */
  phases: PhaseDefinition[];
}

// --- Validation result types ---

export interface PipelineValidationSuccess {
  valid: true;
  data: PipelineDefinition;
}

export interface PipelineValidationFailure {
  valid: false;
  errors: string[];
}

export type PipelineValidationResult =
  | PipelineValidationSuccess
  | PipelineValidationFailure;

// --- Gate validation helpers ---

/**
 * Validate a single gate condition (field + operator + value).
 * Pushes any errors onto the supplied accumulator.
 */
function validateSingleCondition(
  raw: unknown,
  prefix: string,
  errors: string[],
): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${prefix}: must be a plain object`);
    return;
  }
  const c = raw as Record<string, unknown>;

  if (typeof c.field !== 'string' || c.field.trim().length === 0) {
    errors.push(`${prefix}.field: must be a non-empty string`);
  }

  if (typeof c.operator !== 'string' || !(GATE_OPERATORS as readonly string[]).includes(c.operator)) {
    errors.push(
      `${prefix}.operator: invalid operator '${String(c.operator)}' (expected: ${GATE_OPERATORS.join(', ')})`,
    );
    return;
  }

  const op = c.operator as GateOperator;

  // Feature flag gate on AF-27 operators
  if (!ENABLE_AF_27 && AF_27_OPERATORS.includes(op)) {
    errors.push(
      `${prefix}.operator: '${op}' is disabled (ENABLE_AF_27=false)`,
    );
    return;
  }

  if (VALUE_REQUIRED_OPERATORS.includes(op) && c.value === undefined) {
    errors.push(`${prefix}: operator '${op}' requires a 'value' field`);
  }

  // For matches, best-effort pre-validate the regex so obvious typos fail fast.
  if (op === 'matches' && c.value !== undefined) {
    if (typeof c.value !== 'string') {
      errors.push(`${prefix}.value: 'matches' requires a string pattern (got ${typeof c.value})`);
    } else {
      try {
        // eslint-disable-next-line no-new
        new RegExp(c.value);
      } catch (e: any) {
        errors.push(`${prefix}.value: invalid regex pattern ${JSON.stringify(c.value)}: ${e?.message ?? String(e)}`);
      }
    }
  }
}

/**
 * Validate a gate block — supports the shorthand, compound all/any, and retry shapes.
 */
function validateGateBlock(
  g: Record<string, unknown>,
  prefix: string,
  errors: string[],
): void {
  const hasShorthand =
    g.field !== undefined || g.operator !== undefined || g.value !== undefined;
  const hasAll = g.all !== undefined;
  const hasAny = g.any !== undefined;

  // Compound forms require AF-27
  if (!ENABLE_AF_27 && (hasAll || hasAny)) {
    errors.push(
      `${prefix}: compound gates ('all'/'any') are disabled (ENABLE_AF_27=false)`,
    );
    return;
  }

  // Exclusivity checks
  if (hasShorthand && (hasAll || hasAny)) {
    errors.push(
      `${prefix}: cannot mix shorthand (field/operator/value) with 'all' or 'any'`,
    );
  }
  if (hasAll && hasAny) {
    errors.push(
      `${prefix}: cannot specify both 'all' and 'any' (nested groups are not supported)`,
    );
  }
  if (!hasShorthand && !hasAll && !hasAny) {
    errors.push(`${prefix}: must specify a condition (shorthand or 'all' or 'any')`);
  }

  // Shorthand → validate like a single condition
  if (hasShorthand) {
    validateSingleCondition(g, prefix, errors);
  }

  // Compound — each entry must be a valid condition
  if (hasAll) {
    if (!Array.isArray(g.all)) {
      errors.push(`${prefix}.all: must be an array`);
    } else if (g.all.length === 0) {
      errors.push(`${prefix}.all: must contain at least one condition`);
    } else {
      for (let i = 0; i < g.all.length; i++) {
        validateSingleCondition(g.all[i], `${prefix}.all[${i}]`, errors);
      }
    }
  }
  if (hasAny) {
    if (!Array.isArray(g.any)) {
      errors.push(`${prefix}.any: must be an array`);
    } else if (g.any.length === 0) {
      errors.push(`${prefix}.any: must contain at least one condition`);
    } else {
      for (let i = 0; i < g.any.length; i++) {
        validateSingleCondition(g.any[i], `${prefix}.any[${i}]`, errors);
      }
    }
  }

  // Retry
  if (g.retry !== undefined) {
    if (!ENABLE_AF_27) {
      errors.push(`${prefix}.retry: is disabled (ENABLE_AF_27=false)`);
    } else if (
      typeof g.retry !== 'number' ||
      !Number.isInteger(g.retry) ||
      g.retry < 0
    ) {
      errors.push(`${prefix}.retry: must be a non-negative integer`);
    } else if (g.retry > MAX_GATE_RETRY) {
      errors.push(`${prefix}.retry: must be ≤ ${MAX_GATE_RETRY} (found ${g.retry})`);
    }
  }
}

// --- Validation ---

/**
 * Validate an unknown input against the pipeline definition schema.
 * Hand-rolled — no external validation dependencies.
 */
export function validatePipeline(raw: unknown): PipelineValidationResult {
  const errors: string[] = [];

  // 1. Top-level structure
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ['Input must be a plain object'] };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    errors.push('name: must be a non-empty string');
  }

  if (!Array.isArray(obj.phases)) {
    errors.push('phases: must be an array');
    return { valid: false, errors };
  }

  if (obj.phases.length === 0) {
    errors.push('phases: must contain at least one phase');
    return { valid: false, errors };
  }

  if (obj.description !== undefined && typeof obj.description !== 'string') {
    errors.push('description: must be a string if provided');
  }

  // 2. Phase-level checks — collect names for reference integrity
  const phaseNames = new Set<string>();
  const phaseNameOrder: string[] = [];

  for (let i = 0; i < obj.phases.length; i++) {
    const phase = obj.phases[i];
    const prefix = `phases[${i}]`;

    if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
      errors.push(`${prefix}: must be a plain object`);
      continue;
    }

    const p = phase as Record<string, unknown>;

    // name
    if (typeof p.name !== 'string' || p.name.trim().length === 0) {
      errors.push(`${prefix}.name: must be a non-empty string`);
    } else if (phaseNames.has(p.name)) {
      errors.push(
        `${prefix}.name: duplicate phase name '${p.name}' (first defined at phases[${phaseNameOrder.indexOf(p.name)}])`,
      );
    } else {
      phaseNames.add(p.name);
      phaseNameOrder.push(p.name);
    }

    // agent
    if (typeof p.agent !== 'string' || p.agent.trim().length === 0) {
      errors.push(`${prefix}.agent: must be a non-empty string`);
    }

    // requires (validated for structure here; references checked below)
    if (p.requires !== undefined) {
      if (!Array.isArray(p.requires)) {
        errors.push(`${prefix}.requires: must be an array`);
      } else {
        for (let j = 0; j < p.requires.length; j++) {
          if (typeof p.requires[j] !== 'string') {
            errors.push(`${prefix}.requires[${j}]: must be a string`);
          }
        }
      }
    }

    // inject (validated for structure here; from references checked below)
    if (p.inject !== undefined) {
      if (!Array.isArray(p.inject)) {
        errors.push(`${prefix}.inject: must be an array`);
      } else {
        for (let j = 0; j < p.inject.length; j++) {
          const inj = p.inject[j];
          const injPrefix = `${prefix}.inject[${j}]`;
          if (typeof inj !== 'object' || inj === null || Array.isArray(inj)) {
            errors.push(`${injPrefix}: must be a plain object`);
            continue;
          }
          const injObj = inj as Record<string, unknown>;
          if (typeof injObj.from !== 'string' || injObj.from.trim().length === 0) {
            errors.push(`${injPrefix}.from: must be a non-empty string`);
          }
          if (typeof injObj.artifact !== 'string' || injObj.artifact.trim().length === 0) {
            errors.push(`${injPrefix}.artifact: must be a non-empty string`);
          }
          if (typeof injObj.as !== 'string' || injObj.as.trim().length === 0) {
            errors.push(`${injPrefix}.as: must be a non-empty string`);
          }
        }
      }
    }

    // gate
    if (p.gate !== undefined) {
      const gatePrefix = `${prefix}.gate`;
      if (typeof p.gate !== 'object' || p.gate === null || Array.isArray(p.gate)) {
        errors.push(`${gatePrefix}: must be a plain object`);
      } else {
        validateGateBlock(p.gate as Record<string, unknown>, gatePrefix, errors);
      }
    }
  }

  // 3. Reference integrity (requires all phase names collected)
  const available = Array.from(phaseNames).join(', ');

  for (let i = 0; i < obj.phases.length; i++) {
    const phase = obj.phases[i];
    if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) continue;
    const p = phase as Record<string, unknown>;
    const prefix = `phases[${i}]`;

    // requires references
    if (Array.isArray(p.requires)) {
      for (let j = 0; j < p.requires.length; j++) {
        const ref = p.requires[j];
        if (typeof ref === 'string' && !phaseNames.has(ref)) {
          errors.push(
            `${prefix}.requires: unknown phase '${ref}' (available: ${available})`,
          );
        }
      }
    }

    // inject.from references
    if (Array.isArray(p.inject)) {
      for (let j = 0; j < p.inject.length; j++) {
        const inj = p.inject[j];
        if (typeof inj !== 'object' || inj === null || Array.isArray(inj)) continue;
        const injObj = inj as Record<string, unknown>;
        if (typeof injObj.from === 'string' && !phaseNames.has(injObj.from)) {
          errors.push(
            `${prefix}.inject[${j}].from: unknown phase '${injObj.from}' (available: ${available})`,
          );
        }
      }
    }
  }

  // 4. Cycle detection via Kahn's algorithm
  if (errors.length === 0) {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const name of phaseNames) {
      inDegree.set(name, 0);
      adjacency.set(name, []);
    }

    for (const phase of obj.phases as Record<string, unknown>[]) {
      const p = phase as Record<string, unknown>;
      if (Array.isArray(p.requires)) {
        for (const req of p.requires as string[]) {
          adjacency.get(req)!.push(p.name as string);
          inDegree.set(p.name as string, (inDegree.get(p.name as string) ?? 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [name, degree] of inDegree) {
      if (degree === 0) queue.push(name);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const name = queue.shift()!;
      sorted.push(name);
      for (const neighbor of adjacency.get(name) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    if (sorted.length < phaseNames.size) {
      const remaining = [...phaseNames].filter(n => !sorted.includes(n));
      errors.push(
        `phases: circular dependency detected involving: ${remaining.join(', ')}`,
      );
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: raw as unknown as PipelineDefinition };
}

// --- Loading ---

/**
 * Load and validate a pipeline definition from `.af/pipelines/<name>.yaml`.
 * Throws on missing file, invalid YAML, or validation failure.
 */
export function loadPipeline(afPath: string, name: string): PipelineDefinition {
  // Path traversal guard
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(
      `Invalid pipeline name "${name}" — must not contain path separators`,
    );
  }

  const filePath = join(afPath, PIPELINES_DIR, `${name}.yaml`);

  if (!existsSync(filePath)) {
    throw new Error(`Pipeline "${name}" not found at ${filePath}`);
  }

  const rawText = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseYaml(rawText);
  } catch (e: any) {
    throw new Error(`Pipeline "${name}" has invalid YAML: ${e.message}`);
  }

  const result = validatePipeline(parsed);
  if (!result.valid) {
    throw new Error(
      `Pipeline "${name}" validation failed:\n  - ${result.errors.join('\n  - ')}`,
    );
  }

  return result.data;
}

/**
 * Discover all pipeline definitions in `.af/pipelines/`.
 * Returns pipeline names (without extension), sorted alphabetically.
 * Returns empty array if the pipelines directory doesn't exist.
 */
export function listPipelines(afPath: string): string[] {
  const dir = join(afPath, PIPELINES_DIR);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => f.replace(/\.ya?ml$/, ''))
    .sort();
}

// --- Topological sort ---

/**
 * Return phases in execution order (dependencies first) using Kahn's algorithm.
 * Preserves YAML authoring order for phases with equal in-degree (tie-breaking).
 *
 * Expects a validated pipeline — call validatePipeline() first.
 * Throws if a cycle is detected (safety net; validator already catches this).
 */
export function resolvePhaseOrder(pipeline: PipelineDefinition): PhaseDefinition[] {
  const phases = pipeline.phases;
  const phaseMap = new Map<string, PhaseDefinition>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const phase of phases) {
    phaseMap.set(phase.name, phase);
    inDegree.set(phase.name, 0);
    adjacency.set(phase.name, []);
  }

  // Build edges from requires
  for (const phase of phases) {
    for (const req of phase.requires ?? []) {
      adjacency.get(req)!.push(phase.name);
      inDegree.set(phase.name, (inDegree.get(phase.name) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: PhaseDefinition[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(phaseMap.get(name)!);

    for (const neighbor of adjacency.get(name) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // Safety net — validator already catches cycles
  if (sorted.length < phases.length) {
    const remaining = phases.filter(p => !sorted.includes(p)).map(p => p.name);
    throw new Error(
      `Circular dependency detected involving: ${remaining.join(', ')}`,
    );
  }

  return sorted;
}
