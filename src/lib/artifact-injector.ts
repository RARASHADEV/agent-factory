/**
 * AF-25: Artifact injection — resolve prior-phase outputs and compose
 * them into downstream agent prompts.
 *
 * Two artifact types, auto-detected:
 *   - File glob: contains '/', '*', or '{ticket}' → resolve as filesystem glob
 *   - Dot-path: everything else → extract value from source phase's result.json
 *
 * Pure functions — no side effects except filesystem reads.
 * Never throws — returns warnings for the pipeline runner (AF-26) to decide on.
 */

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import type { InjectDefinition, PhaseDefinition, PipelineDefinition } from './pipeline.js';
import type { ResultSchema } from './result-schema.js';

// --- Constants ---

/** Maximum file size to inject (100KB). Prevents prompt bloat from large files. */
const MAX_INJECT_FILE_SIZE = 100 * 1024;

/** Maximum total injection size across all files for one artifact (200KB). */
const MAX_INJECT_TOTAL_SIZE = 200 * 1024;

// --- Types ---

/**
 * Everything the injector needs to resolve artifacts.
 * Provided by the pipeline runner at phase spawn time.
 */
export interface InjectionContext {
  /** Ticket being processed (e.g., "AF-30") */
  ticket: string;
  /** Path to the .af/ directory */
  afPath: string;
  /** Path to the project root (parent of .af/) */
  projectDir: string;
  /** Map of phase name → agent slug, for locating output directories.
   *  Derived from pipeline.phases: { "design": "architect", "implement": "engineer", ... }
   */
  phaseAgentMap: Map<string, string>;
}

/**
 * A single resolved injection — ready to compose into a prompt.
 */
export interface ResolvedInjection {
  /** Label from InjectDefinition.as (e.g., "design_document") */
  label: string;
  /** The resolved content to inject into the prompt */
  content: string;
  /** Human-readable source description (e.g., "design phase — docs/designs/AF-30.md") */
  source: string;
}

/**
 * Result of resolving all injections for a phase.
 * Contains resolved injections and any warnings encountered.
 */
export interface InjectionResult {
  /** Successfully resolved injections */
  resolved: ResolvedInjection[];
  /** Warnings (missing files, missing result.json, unresolvable dot-paths) */
  warnings: string[];
}

// --- Detection ---

/**
 * Determine if an artifact string is a file glob or a dot-path.
 *
 * File globs contain filesystem indicators: '/', '*', or '{ticket}'.
 * Everything else is treated as a dot-path into result.json.
 */
export function isFileGlobArtifact(artifact: string): boolean {
  return artifact.includes('/') || artifact.includes('*') || artifact.includes('{ticket}');
}

// --- Helpers ---

/**
 * Replace all {ticket} placeholders with the actual ticket string.
 */
export function expandTicketPlaceholder(str: string, ticket: string): string {
  return str.replace(/\{ticket\}/g, ticket);
}

/**
 * Tokenize a dot-path, extracting both dotted segments and bracket-indexed segments.
 *
 * Examples:
 *   "a.b.c"      → ["a", "b", "c"]
 *   "a[0].c"     → ["a", 0, "c"]
 *   "a.0.c"      → ["a", 0, "c"]  (numeric string segments coerce to number at walk-time)
 *   "a[0].b[1]"  → ["a", 0, "b", 1]
 */
const DOT_PATH_SEGMENT_RE = /[^.[\]]+|\[(\d+)\]/g;

export function tokenizeDotPath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const m of path.matchAll(DOT_PATH_SEGMENT_RE)) {
    if (m[1] !== undefined) {
      // Bracket form [N]
      out.push(Number(m[1]));
    } else if (/^\d+$/.test(m[0])) {
      // Bare numeric segment — represent as number so array indexing works
      out.push(Number(m[0]));
    } else {
      out.push(m[0]);
    }
  }
  return out;
}

/**
 * Traverse a nested object by dot-path. Supports:
 *   - Dotted segments:        "metadata.pr_url"
 *   - Bracket indexing:       "artifacts[0].path"
 *   - Numeric-dot indexing:   "artifacts.0.path"
 *
 * At each step: if `current` is an array and the token is numeric → index by int.
 * If `current` is an object → look up by string key (numeric tokens fall back to string).
 * Otherwise → return undefined.
 */
export function getByDotPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const tokens = tokenizeDotPath(dotPath);
  let current: unknown = obj;

  for (const tok of tokens) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      if (typeof tok === 'number') {
        current = current[tok];
      } else if (/^\d+$/.test(String(tok))) {
        current = current[Number(tok)];
      } else {
        // Accessing a non-numeric key on an array — use object-style lookup
        // (arrays are objects in JS), falls back to undefined for non-existent keys.
        current = (current as unknown as Record<string, unknown>)[String(tok)];
      }
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[String(tok)];
    } else {
      return undefined;
    }
  }

  return current;
}

// --- Resolution ---

/**
 * Resolve a file-glob artifact against the filesystem.
 * Returns matched file contents joined with separators, or null if no matches.
 *
 * Supports * and ? wildcards in the filename portion (single-directory, no **).
 */
export function resolveFileGlob(
  artifact: string,
  ctx: InjectionContext,
): { content: string; paths: string[] } | null {
  const expanded = expandTicketPlaceholder(artifact, ctx.ticket);

  // Split into directory and filename pattern
  const dir = dirname(expanded);
  const pattern = basename(expanded);

  const absDir = join(ctx.projectDir, dir);
  if (!existsSync(absDir)) return null;

  // Path traversal guard
  try {
    const resolvedDir = realpathSync(absDir);
    const resolvedProject = realpathSync(ctx.projectDir);
    if (!resolvedDir.startsWith(resolvedProject)) {
      return null;
    }
  } catch {
    return null;
  }

  // Convert simple glob to regex: * → .*, ? → .
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials (except * and ?)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    + '$';
  const regex = new RegExp(regexStr);

  let entries: string[];
  try {
    entries = readdirSync(absDir).filter(f => regex.test(f)).sort();
  } catch {
    return null;
  }

  if (entries.length === 0) return null;

  const paths: string[] = [];
  const parts: string[] = [];
  let totalSize = 0;

  for (const entry of entries) {
    const absPath = join(absDir, entry);

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }

    // Skip directories, skip files over size limit
    if (stat.isDirectory()) continue;
    if (stat.size > MAX_INJECT_FILE_SIZE) continue;
    if (totalSize + stat.size > MAX_INJECT_TOTAL_SIZE) break;

    try {
      const content = readFileSync(absPath, 'utf-8');
      const relPath = relative(ctx.projectDir, absPath);
      paths.push(relPath);
      parts.push(content);
      totalSize += stat.size;
    } catch {
      // Skip files we can't read
      continue;
    }
  }

  if (parts.length === 0) return null;

  return {
    content: parts.join('\n\n---\n\n'),
    paths,
  };
}

/**
 * Extract a value from result.json via dot-path.
 * Returns the value as a string, or null if not found.
 */
export function resolveDotPath(
  artifact: string,
  resultJson: ResultSchema,
): string | null {
  const value = getByDotPath(resultJson as unknown as Record<string, unknown>, artifact);

  if (value === undefined || value === null) return null;

  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  // Objects/arrays — serialize as JSON for the agent to interpret
  return JSON.stringify(value, null, 2);
}

/**
 * Load a completed phase's result.json.
 *
 * Output path convention: .af/output/<ticket>/<agent-slug>/result.json
 * The phaseAgentMap translates phase name → agent slug.
 */
export function loadPhaseResult(
  phaseName: string,
  ctx: InjectionContext,
): ResultSchema | null {
  const agentSlug = ctx.phaseAgentMap.get(phaseName);
  if (!agentSlug) return null;

  const resultPath = join(ctx.afPath, 'output', ctx.ticket, agentSlug, 'result.json');
  if (!existsSync(resultPath)) return null;

  try {
    const raw = readFileSync(resultPath, 'utf-8');
    return JSON.parse(raw) as ResultSchema;
  } catch {
    return null;
  }
}

/**
 * Resolve a single InjectDefinition to content.
 * Returns the resolved injection (or null) and any warnings.
 */
export function resolveInjection(
  inject: InjectDefinition,
  ctx: InjectionContext,
): { resolved: ResolvedInjection | null; warnings: string[] } {
  const warnings: string[] = [];

  if (isFileGlobArtifact(inject.artifact)) {
    // --- File glob artifact ---
    const result = resolveFileGlob(inject.artifact, ctx);

    if (!result) {
      const expanded = expandTicketPlaceholder(inject.artifact, ctx.ticket);
      warnings.push(
        `inject "${inject.as}" from "${inject.from}": no files matched glob "${expanded}"`,
      );
      return { resolved: null, warnings };
    }

    return {
      resolved: {
        label: inject.as,
        content: result.content,
        source: `${inject.from} phase — ${result.paths.join(', ')}`,
      },
      warnings,
    };
  } else {
    // --- Dot-path artifact ---
    const resultJson = loadPhaseResult(inject.from, ctx);

    if (!resultJson) {
      warnings.push(
        `inject "${inject.as}" from "${inject.from}": result.json not found for phase "${inject.from}"`,
      );
      return { resolved: null, warnings };
    }

    const value = resolveDotPath(inject.artifact, resultJson);

    if (value === null) {
      warnings.push(
        `inject "${inject.as}" from "${inject.from}": dot-path "${inject.artifact}" not found in result.json`,
      );
      return { resolved: null, warnings };
    }

    return {
      resolved: {
        label: inject.as,
        content: value,
        source: `${inject.from} phase — ${inject.artifact}`,
      },
      warnings,
    };
  }
}

// --- Phase-level resolution ---

/**
 * Resolve all inject definitions for a pipeline phase.
 * Returns all successfully resolved injections and accumulated warnings.
 *
 * Phases with no inject[] return an empty result (no warnings).
 */
export function resolvePhaseInjections(
  phase: PhaseDefinition,
  ctx: InjectionContext,
): InjectionResult {
  if (!phase.inject || phase.inject.length === 0) {
    return { resolved: [], warnings: [] };
  }

  const resolved: ResolvedInjection[] = [];
  const warnings: string[] = [];

  for (const inject of phase.inject) {
    const result = resolveInjection(inject, ctx);
    warnings.push(...result.warnings);
    if (result.resolved) {
      resolved.push(result.resolved);
    }
  }

  return { resolved, warnings };
}

// --- Composition ---

/**
 * Compose resolved injections into a prompt section string.
 *
 * Returns empty string if no injections (caller should not append to prompt).
 */
export function composeInjectionPrompt(resolved: ResolvedInjection[]): string {
  if (resolved.length === 0) return '';

  const sections = resolved.map(r => {
    return [
      `### ${r.label}`,
      `> Source: ${r.source}`,
      '',
      r.content,
    ].join('\n');
  });

  return [
    '## Injected Artifacts',
    '',
    ...sections,
  ].join('\n\n');
}

// --- Context builder ---

/**
 * Convenience function to build InjectionContext from a pipeline definition.
 * Builds the phaseAgentMap from the pipeline's phases.
 */
export function buildInjectionContext(
  pipeline: PipelineDefinition,
  ticket: string,
  afPath: string,
  projectDir: string,
): InjectionContext {
  const phaseAgentMap = new Map<string, string>();
  for (const phase of pipeline.phases) {
    phaseAgentMap.set(phase.name, phase.agent);
  }

  return { ticket, afPath, projectDir, phaseAgentMap };
}
