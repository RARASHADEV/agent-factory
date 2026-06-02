/**
 * AF-48: `af orchestrate <domain> <objective>` — production entry point.
 *
 * Spec: docs/designs/AF-48.md §5, §6.
 *
 * Builds the wiring the orchestration engine needs to run end-to-end:
 *   dispatch (af-dispatch.ts) → AfCliExecutor (AF-45) → Orchestrator (AF-46) → run().
 * Then renders a human report (stopReason, per-step backend, totalUsage,
 * finalizer verdicts) or the raw OrchestrationResult as JSON (`--json`).
 *
 * No engine logic lives here. Backend/model routing is dispatchAgent's job; the
 * loop + guardrails are the Orchestrator's. This command is glue + presentation,
 * gated by the ENABLE_AF_48 feature flag (default off).
 */

import chalk from 'chalk';
import { ENABLE_AF_48 } from '../lib/constants.js';
import { loadConfig } from '../lib/config.js';
import { createAfCliDispatch } from '../lib/af-dispatch.js';
import { AfCliExecutor } from '../lib/executor.js';
import {
  createOrchestrator,
  type OrchestrationResult,
} from '../lib/orchestrator.js';
import { persistOrchestrationResult } from '../lib/orchestration-output.js';
import { heading, dim } from '../lib/format.js';

export interface OrchestrateOptions {
  dryRun?: boolean;
  maxDelegations?: string; // commander passes strings → parseInt
  domainsDir?: string; // override for tests / non-default layout
  project?: string;
  json?: boolean;
}

export async function orchestrateCommand(
  domain: string,
  objective: string,
  options: OrchestrateOptions = {},
): Promise<void> {
  // ── Feature flag: off → friendly message, exit 0 (not an error) ──────────
  if (!ENABLE_AF_48) {
    console.log(dim('Orchestration is not enabled (ENABLE_AF_48=false).'));
    return;
  }

  const config = loadConfig();
  const cliDefaultModel = config.defaults?.model;

  // ── Build dispatch → executor → orchestrator ─────────────────────────────
  const dispatch = createAfCliDispatch({
    cliDefaultModel,
    cwd: process.cwd(),
  });
  const executor = new AfCliExecutor({ dispatch });
  const orchestrator = createOrchestrator(executor);

  // maxDelegations: only override the domain policy when explicitly provided
  // and parseable; otherwise omit so the policy value applies (design §8.4).
  let maxDelegations: number | undefined;
  if (options.maxDelegations !== undefined) {
    const parsed = parseInt(options.maxDelegations, 10);
    if (Number.isFinite(parsed)) maxDelegations = parsed;
  }

  try {
    const result = await orchestrator.run(domain, objective, {
      dryRun: options.dryRun === true,
      maxDelegations,
      domainsDir: options.domainsDir,
      // Stream each plan/trace line live so the user sees progress.
      logger: (line) => console.log(dim(line)),
    });

    // AF-50: structural persistence — always on for real runs. The block sits
    // inside the same try so a thrown error from run() still hits the §6 handler.
    let outputDir: string | undefined;
    if (!result.dryRun) {
      try {
        outputDir = persistOrchestrationResult(result, { cwd: process.cwd() });
      } catch (writeErr) {
        // Never lose the output: fall back to stdout, flag the failure.
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        console.error(chalk.red(`Failed to persist orchestration output: ${msg}`));
        console.error(chalk.yellow('Dumping full result to stdout so it is not lost:'));
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = 1;
      }
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      renderReport(result);
    }

    if (outputDir) {
      console.log('');
      console.log(dim(`output saved to ${outputDir}`));
    }
  } catch (err) {
    // §6: surface a readable message, no stack trace. OrchestrationInputError /
    // DomainConfigError both carry an `errors` list — print it when present.
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(message));
    const errors = (err as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      for (const e of errors) {
        if (e !== message) console.error(chalk.red(`  - ${e}`));
      }
    }
    process.exitCode = 1;
  }
}

/** Render a human-readable report of an OrchestrationResult (design §5.5). */
function renderReport(result: OrchestrationResult): void {
  console.log('');
  console.log(heading(`Orchestration — ${result.domain}${result.dryRun ? '  (DRY RUN)' : ''}`));
  console.log(dim(`objective: ${result.objective}`));
  console.log('');

  // Per-step table: #  agent  backend  tokens(in/out)
  if (result.steps.length > 0) {
    console.log(chalk.bold('  #  agent                  backend    tokens(in/out)'));
    result.steps.forEach((step, i) => {
      const n = String(i + 1).padStart(2);
      const agent = step.agent.padEnd(22);
      const backend = step.backend.padEnd(10);
      const tokens = `${step.usage.inputTokens}/${step.usage.outputTokens}`;
      console.log(`  ${n}  ${agent} ${backend} ${tokens}`);
    });
    console.log('');
  } else {
    console.log(dim('  (no delegation steps)'));
    console.log('');
  }

  // Finalizers: each slug + approved/verdict
  const finalizerSlugs = Object.keys(result.finalizers);
  if (finalizerSlugs.length > 0) {
    console.log(chalk.bold('  finalizers:'));
    for (const slug of finalizerSlugs) {
      const output = result.finalizers[slug];
      const approved =
        output && typeof output === 'object' && 'approved' in output
          ? (output as { approved: unknown }).approved !== false
          : undefined;
      const verdict =
        approved === undefined
          ? dim('(no verdict)')
          : approved
            ? chalk.green('approved')
            : chalk.red('not approved');
      console.log(`    ${slug.padEnd(22)} ${verdict}`);
    }
    console.log('');
  }

  // Footer
  const approvedLabel = result.approved ? chalk.green('true') : chalk.red('false');
  const total = result.totalUsage.inputTokens + result.totalUsage.outputTokens;
  console.log(
    `  stopReason: ${chalk.bold(result.stopReason)}   approved: ${approvedLabel}   ` +
      `steps: ${result.steps.length}   tokens: ${total} ` +
      dim(`(${result.totalUsage.inputTokens} in / ${result.totalUsage.outputTokens} out)`),
  );
}
