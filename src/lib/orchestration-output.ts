/**
 * AF-50: Orchestration output persistence — writer module.
 *
 * Spec: docs/designs/AF-50.md §5.
 *
 * Durably saves an {@link OrchestrationResult} to the existing `.af/output/`
 * convention (mirroring `af agent spawn`), namespaced under `orchestrate/`:
 *
 *   .af/output/orchestrate/<domain>/<run-id>/
 *       result.json              # full OrchestrationResult (machine-readable)
 *       summary.md               # human report (twin of the console render)
 *       step-NN-<agent>.md       # each delegated step's output text
 *       finalizer-<slug>.md      # each finalizer's output
 *
 * This is the *only* place orchestration I/O lives. The engine
 * (`orchestrator.ts`) stays a pure function — it must NOT import this module.
 * Persistence is wired in at the command layer (`commands/orchestrate.ts`).
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AF_DIR } from './constants.js';
import type { OrchestrationResult } from './orchestrator.js';

export interface PersistOptions {
  /** Project root; the run dir is created under <cwd>/.af/output/orchestrate/. */
  cwd: string;
  /** Injectable clock (ms) for a deterministic run-id in tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Write an OrchestrationResult to `.af/output/orchestrate/<domain>/<run-id>/`.
 * Returns the absolute run directory. Throws on I/O failure (the caller handles
 * the stdout fallback so output is never lost). Never called for dry runs.
 */
export function persistOrchestrationResult(
  result: OrchestrationResult,
  opts: PersistOptions,
): string {
  const now = opts.now ?? Date.now;
  const runId = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const dir = join(opts.cwd, AF_DIR, 'output', 'orchestrate', sanitize(result.domain), runId);
  mkdirSync(dir, { recursive: true });

  // 1. Machine-readable full result.
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));

  // 2. Human summary (same content the console renders).
  writeFileSync(join(dir, 'summary.md'), renderSummaryMarkdown(result));

  // 3. One file per delegated step.
  result.steps.forEach((step, i) => {
    const name = `step-${String(i + 1).padStart(2, '0')}-${sanitize(step.agent)}.md`;
    writeFileSync(join(dir, name), stringifyOutput(step.output));
  });

  // 4. One file per finalizer.
  for (const [slug, output] of Object.entries(result.finalizers)) {
    writeFileSync(join(dir, `finalizer-${sanitize(slug)}.md`), stringifyOutput(output));
  }

  return dir;
}

/**
 * Serialize an agent's `output` (typed `unknown`) for a `.md` file:
 *   - string → verbatim
 *   - null/undefined → "(no output)"
 *   - anything else → pretty-printed JSON
 */
export function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output == null) return '(no output)';
  return JSON.stringify(output, null, 2);
}

/**
 * Defensive filename/path-segment sanitizer: lowercase, keep `[a-z0-9-_]`,
 * collapse everything else to `-`, trim leading/trailing `-`. Roster + domain
 * slugs are already AF-43-validated; this guards against slug drift and keeps
 * a value from escaping the run directory. Empty input falls back to "agent".
 */
export function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

/**
 * Markdown twin of `renderReport()` in `commands/orchestrate.ts`: objective,
 * per-step table, finalizer verdicts, and a footer (stopReason, approved,
 * steps, totalUsage). Pure string building — no ANSI, no I/O.
 */
function renderSummaryMarkdown(result: OrchestrationResult): string {
  const lines: string[] = [];

  lines.push(`# Orchestration — ${result.domain}${result.dryRun ? '  (DRY RUN)' : ''}`);
  lines.push('');
  lines.push(`**objective:** ${result.objective}`);
  lines.push('');

  // Per-step table: # | agent | backend | tokens(in/out)
  if (result.steps.length > 0) {
    lines.push('## Steps');
    lines.push('');
    lines.push('| # | agent | backend | tokens (in/out) |');
    lines.push('| --- | --- | --- | --- |');
    result.steps.forEach((step, i) => {
      const n = i + 1;
      const tokens = `${step.usage.inputTokens}/${step.usage.outputTokens}`;
      lines.push(`| ${n} | ${step.agent} | ${step.backend} | ${tokens} |`);
    });
    lines.push('');
  } else {
    lines.push('_(no delegation steps)_');
    lines.push('');
  }

  // Finalizers: each slug + verdict.
  const finalizerSlugs = Object.keys(result.finalizers);
  if (finalizerSlugs.length > 0) {
    lines.push('## Finalizers');
    lines.push('');
    for (const slug of finalizerSlugs) {
      const output = result.finalizers[slug];
      const approved =
        output && typeof output === 'object' && 'approved' in output
          ? (output as { approved: unknown }).approved !== false
          : undefined;
      const verdict =
        approved === undefined ? '(no verdict)' : approved ? 'approved' : 'not approved';
      lines.push(`- **${slug}** — ${verdict}`);
    }
    lines.push('');
  }

  // Footer.
  const total = result.totalUsage.inputTokens + result.totalUsage.outputTokens;
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **stopReason:** ${result.stopReason}`);
  lines.push(`- **approved:** ${result.approved}`);
  lines.push(`- **steps:** ${result.steps.length}`);
  lines.push(
    `- **tokens:** ${total} (${result.totalUsage.inputTokens} in / ${result.totalUsage.outputTokens} out)`,
  );
  lines.push('');

  return lines.join('\n');
}
