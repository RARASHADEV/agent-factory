// src/lib/service-executor.ts
// AF-53 / AF-56: the PRODUCTION JobExecutor — the bridge from the global queue
// (job-queue.ts) to AF's EXISTING execution machinery (design §5.3).
//
// The queue owns admission + tracking + notification ONLY. The actual work still
// runs through the same code the CLI uses, in the PROJECT-LOCAL workspace:
//   - kind 'agent'         → dispatchAgent (AF-42), the same path `af agent spawn` /
//                            the orchestrator's af-dispatch use. Output stays under
//                            <project>/.af/output/<ticket>/.
//   - kind 'orchestration' → the Orchestrator (AF-46) via createAfCliDispatch →
//                            AfCliExecutor, exactly as `af orchestrate` builds it.
//   - kind 'pipeline'      → the pipeline run engine (AF-26 sharedPhaseLoop). Pause/
//                            resume are routed to the pipeline pause/resume mechanism.
//
// This module adds NO routing/backend logic of its own — it composes the existing
// pieces and normalises each into the queue's JobOutcome contract. It is injected
// into the queue so unit tests can swap in a fake and never spawn real agents.

import { loadConfig } from './config.js';
import { loadAgent } from '../commands/agent.js';
import {
  resolveExecution,
  applyCliDefaultModel,
  dispatchAgent,
} from './execution.js';
import { createAfCliDispatch } from './af-dispatch.js';
import { AfCliExecutor } from './executor.js';
import { createOrchestrator } from './orchestrator.js';
import type { JobExecutor, QueuedJob, JobOutcome } from './job-queue.js';

/**
 * Build the production JobExecutor. `cwd` is the project-local workspace root the
 * work runs in (resolved from the validated project, design §6). Collaborators are
 * injectable so this can be unit-tested without disk/network.
 */
export function createServiceExecutor(deps: {
  /** Project-local workspace directory the job runs in. */
  cwd: string;
} & Partial<{
  loadAgentFn: typeof loadAgent;
  dispatchFn: typeof dispatchAgent;
  loadConfigFn: typeof loadConfig;
}>): JobExecutor {
  const loadAgentFn = deps.loadAgentFn ?? loadAgent;
  const dispatchFn = deps.dispatchFn ?? dispatchAgent;
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;

  return async (job: QueuedJob): Promise<JobOutcome> => {
    switch (job.kind) {
      case 'agent':
        return runAgent(job, { cwd: deps.cwd, loadAgentFn, dispatchFn, loadConfigFn });
      case 'orchestration':
        return runOrchestration(job, { cwd: deps.cwd, loadConfigFn });
      case 'pipeline':
        // Pipeline run is driven through the CLI-equivalent engine. Wiring the
        // full sharedPhaseLoop requires a loaded task + pipeline def, which the
        // POST /jobs body does not carry in Stage A; the design routes pipeline
        // *control* (pause/resume) through the existing mechanism. A pipeline
        // run requested here is rejected as unsupported rather than silently
        // hanging, so nothing is left `running`.
        throw new Error(
          `pipeline run is not yet wired through POST /jobs; use the pipeline control routes for pause/resume`,
        );
      default:
        throw new Error(`unknown job kind '${(job as QueuedJob).kind}'`);
    }
  };
}

/** kind 'agent' → dispatchAgent (the same path af agent spawn / orchestration use). */
async function runAgent(
  job: QueuedJob,
  deps: {
    cwd: string;
    loadAgentFn: typeof loadAgent;
    dispatchFn: typeof dispatchAgent;
    loadConfigFn: typeof loadConfig;
  },
): Promise<JobOutcome> {
  const slug = job.role;
  if (!slug) {
    throw new Error(`agent job ${job.id} is missing a role (agent slug)`);
  }
  const agent = deps.loadAgentFn(slug);
  if (!agent) {
    throw new Error(`agent "${slug}" not found in registry (expected agents/${slug}.md)`);
  }

  const config = deps.loadConfigFn();
  const execCfg = resolveExecution(agent.meta.execution);
  execCfg.model = applyCliDefaultModel(execCfg, config.defaults?.model);

  const result = await deps.dispatchFn(execCfg, {
    systemPrompt: agent.content.trim(),
    taskPrompt: job.objective,
    maxTurns: agent.meta.maxTurns,
    tools: agent.meta.tools,
    cwd: deps.cwd,
  });

  return { status: 'completed', result: { output: result.output, backend: result.backend } };
}

/** kind 'orchestration' → the Orchestrator, built exactly as `af orchestrate` does. */
async function runOrchestration(
  job: QueuedJob,
  deps: { cwd: string; loadConfigFn: typeof loadConfig },
): Promise<JobOutcome> {
  const domain = job.role;
  if (!domain) {
    throw new Error(`orchestration job ${job.id} is missing a domain (role)`);
  }
  const config = deps.loadConfigFn();
  const dispatch = createAfCliDispatch({
    cliDefaultModel: config.defaults?.model,
    cwd: deps.cwd,
  });
  const orchestrator = createOrchestrator(new AfCliExecutor({ dispatch }));

  const domainsDir =
    typeof job.opts?.domainsDir === 'string' ? (job.opts.domainsDir as string) : undefined;
  const result = await orchestrator.run(domain, job.objective, { domainsDir });

  // Map the orchestration verdict onto a terminal status: an unapproved run is a
  // soft failure (the work ran but did not pass), distinct from a crash.
  const status = result.approved === false ? 'failed' : 'completed';
  return { status, result };
}
