/**
 * AF-43: Domain-config loader and validator.
 *
 * Loads and validates domain configs stored as
 * `orchestration/domains/<domain>.yaml`. These are data-only artifacts
 * (spec §4.2) that parameterize the generic orchestration engine: they
 * declare a supervisor, a roster of agent slugs, and a guardrail policy.
 *
 * This module contains NO orchestration logic — only parsing + strict
 * validation. Per spec §6.1, validation must fail loud: any invalid or
 * missing required field throws a clear error before the data is used.
 * There are no silent defaults for required fields.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { AGENTS_DIR } from './constants.js';

// --- Types ---

export interface DomainSupervisor {
  /** Agent slug — must resolve to a real agents/<slug>.md file. */
  agent: string;
  /** Optional human-readable goal statement. */
  goal?: string;
}

export interface DomainPolicy {
  /** Max total agent calls (length guard). */
  max_delegations?: number;
  /** Supervisor may only call roster agents (breadth guard). */
  roster_only?: boolean;
  /** Hard ceiling on accumulated tokens (cost guard). */
  token_budget?: number;
  /** Wall-clock kill switch in seconds. */
  timeout_seconds?: number;
  /** Agents that must always run before "done" — must be a subset of roster. */
  required_finalizers?: string[];
  /** Bound on writer<->review retries on approved:false. */
  max_revision_loops?: number;
  /** Abort on repeated identical calls / no progress. */
  abort_on_no_progress?: boolean;
  /** Agents safe to run in parallel — must be a subset of roster. */
  parallelizable?: string[];
}

export interface DomainConfig {
  /** Domain name, e.g. "marketing". */
  domain: string;
  supervisor: DomainSupervisor;
  /** Agent slugs participating in the domain. */
  roster: string[];
  /** Guardrail policy. */
  policy: DomainPolicy;
}

// --- Error ---

/**
 * Thrown when a domain config is missing, unparseable, or fails validation.
 * Carries the list of validation messages so callers can surface all of them.
 */
export class DomainConfigError extends Error {
  readonly errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = 'DomainConfigError';
    this.errors = errors.length > 0 ? errors : [message];
  }
}

// --- Directory resolution ---

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the orchestration domains directory. At runtime this file lives at
 * <pkg>/dist/lib/domain-config.js, so the orchestration dir is two levels up.
 * Override with AF_DOMAINS_DIR (mirrors the AF_AGENTS_DIR convention).
 */
export const DOMAINS_DIR =
  process.env.AF_DOMAINS_DIR ?? join(HERE, '..', '..', 'orchestration', 'domains');

// --- Helpers ---

/**
 * Resolve an agent slug to its agents/<slug>.md file. Returns true if the
 * file exists. `agentsDir` is injectable for tests.
 */
function agentExists(slug: string, agentsDir: string): boolean {
  if (typeof slug !== 'string' || slug.trim().length === 0) return false;
  return existsSync(join(agentsDir, `${slug}.md`));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

// --- Validation ---

export interface ValidateOptions {
  /** Directory holding agents/<slug>.md files. Defaults to AGENTS_DIR. */
  agentsDir?: string;
}

/**
 * Validate an already-parsed value against the DomainConfig schema, resolving
 * every supervisor and roster slug against real agents/*.md files.
 *
 * Returns the typed config on success; throws DomainConfigError listing every
 * problem on failure. No silent defaults are applied to required fields.
 */
export function validateDomainConfig(
  input: unknown,
  options: ValidateOptions = {},
): DomainConfig {
  const agentsDir = options.agentsDir ?? AGENTS_DIR;
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    throw new DomainConfigError('Domain config must be a YAML mapping (object)');
  }

  const obj = input;

  // domain: required non-empty string
  if (typeof obj.domain !== 'string' || obj.domain.trim().length === 0) {
    errors.push('`domain` must be a non-empty string');
  }

  // supervisor: required object with an `agent` slug that resolves
  if (!isPlainObject(obj.supervisor)) {
    errors.push('`supervisor` must be a mapping with an `agent` field');
  } else {
    const sup = obj.supervisor;
    if (typeof sup.agent !== 'string' || sup.agent.trim().length === 0) {
      errors.push('`supervisor.agent` must be a non-empty agent slug');
    } else if (!agentExists(sup.agent, agentsDir)) {
      errors.push(
        `\`supervisor.agent\` "${sup.agent}" does not resolve to an agent file (${join(agentsDir, `${sup.agent}.md`)})`,
      );
    }
    if (sup.goal !== undefined && typeof sup.goal !== 'string') {
      errors.push('`supervisor.goal` must be a string when present');
    }
  }

  // roster: required non-empty array of slugs, each resolving to an agent file
  let roster: string[] = [];
  if (!Array.isArray(obj.roster)) {
    errors.push('`roster` must be an array of agent slugs');
  } else if (obj.roster.length === 0) {
    errors.push('`roster` must contain at least one agent slug');
  } else if (!isStringArray(obj.roster)) {
    errors.push('`roster` entries must all be strings');
  } else {
    roster = obj.roster;
    for (let i = 0; i < roster.length; i++) {
      const slug = roster[i];
      if (!agentExists(slug, agentsDir)) {
        errors.push(
          `\`roster[${i}]\` "${slug}" does not resolve to an agent file (${join(agentsDir, `${slug}.md`)})`,
        );
      }
    }
  }

  const rosterSet = new Set(roster);

  // policy: required mapping; field-level type checks + subset constraints
  let policy: DomainPolicy = {};
  if (!isPlainObject(obj.policy)) {
    errors.push('`policy` must be a mapping');
  } else {
    const p = obj.policy;
    policy = p as DomainPolicy;

    const numFields: Array<keyof DomainPolicy> = [
      'max_delegations',
      'token_budget',
      'timeout_seconds',
      'max_revision_loops',
    ];
    for (const f of numFields) {
      const val = p[f];
      if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val) || val < 0)) {
        errors.push(`\`policy.${f}\` must be a non-negative number when present`);
      }
    }

    const boolFields: Array<keyof DomainPolicy> = ['roster_only', 'abort_on_no_progress'];
    for (const f of boolFields) {
      const val = p[f];
      if (val !== undefined && typeof val !== 'boolean') {
        errors.push(`\`policy.${f}\` must be a boolean when present`);
      }
    }

    // required_finalizers ⊆ roster
    if (p.required_finalizers !== undefined) {
      if (!isStringArray(p.required_finalizers)) {
        errors.push('`policy.required_finalizers` must be an array of agent slugs');
      } else {
        for (const slug of p.required_finalizers) {
          if (!rosterSet.has(slug)) {
            errors.push(`\`policy.required_finalizers\` entry "${slug}" is not in the roster`);
          }
        }
      }
    }

    // parallelizable ⊆ roster
    if (p.parallelizable !== undefined) {
      if (!isStringArray(p.parallelizable)) {
        errors.push('`policy.parallelizable` must be an array of agent slugs');
      } else {
        for (const slug of p.parallelizable) {
          if (!rosterSet.has(slug)) {
            errors.push(`\`policy.parallelizable\` entry "${slug}" is not in the roster`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new DomainConfigError(
      `Invalid domain config: ${errors.length} problem${errors.length === 1 ? '' : 's'}`,
      errors,
    );
  }

  const sup = obj.supervisor as Record<string, unknown>;
  return {
    domain: obj.domain as string,
    supervisor: {
      agent: sup.agent as string,
      ...(typeof sup.goal === 'string' ? { goal: sup.goal } : {}),
    },
    roster,
    policy,
  };
}

/**
 * Parse a YAML string into a validated DomainConfig.
 * Throws DomainConfigError on a YAML parse error or any validation failure.
 */
export function parseDomainConfig(yaml: string, options: ValidateOptions = {}): DomainConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DomainConfigError(`YAML parse error: ${msg}`);
  }
  if (parsed === null || parsed === undefined) {
    throw new DomainConfigError('Domain config is empty');
  }
  return validateDomainConfig(parsed, options);
}

/**
 * Load and validate a domain config by name from the domains directory
 * (`orchestration/domains/<domain>.yaml`). Throws DomainConfigError if the
 * file is missing or invalid.
 */
export function loadDomainConfig(
  domain: string,
  options: ValidateOptions & { domainsDir?: string } = {},
): DomainConfig {
  const domainsDir = options.domainsDir ?? DOMAINS_DIR;
  const filePath = join(domainsDir, `${domain}.yaml`);
  if (!existsSync(filePath)) {
    throw new DomainConfigError(`Domain config not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  return parseDomainConfig(raw, options);
}

/**
 * List the domain names available in the domains directory (files ending in
 * `.yaml` / `.yml`). Does not validate them. Returns [] if the dir is absent.
 */
export function listDomains(domainsDir: string = DOMAINS_DIR): string[] {
  if (!existsSync(domainsDir)) return [];
  return readdirSync(domainsDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => f.replace(/\.ya?ml$/, ''))
    .sort();
}
