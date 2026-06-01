/**
 * AF-48: Concrete AfCliDispatch — the glue between orchestration and execution.
 *
 * Spec: docs/designs/AF-48.md §3, §4.
 *
 * The orchestration engine (AF-46) talks to execution only through the
 * AfCliDispatch surface declared in executor.ts. This module builds the
 * production implementation of that surface: it resolves an agent slug to its
 * `execution` frontmatter and hands the run off to dispatchAgent (AF-42), which
 * owns ALL backend/model routing.
 *
 * Crucially this module adds NO routing logic of its own. It only:
 *   1. loads the agent file (frontmatter + body),
 *   2. resolves + normalizes its execution config,
 *   3. applies the CLI default model per applyCliDefaultModel's rules,
 *   4. composes the system/task prompts, and
 *   5. calls dispatchAgent, passing the reported `backend` straight through so
 *      the orchestrator can attribute it per step (AF-FIX-A6).
 *
 * Collaborators (`loadAgent`, `dispatchAgent`) are injected with real defaults so
 * the glue is unit-testable with no disk reads and no network — mirroring how
 * AfCliExecutor/StubExecutor and dispatchLocal's fetchImpl already do DI.
 */

import { loadAgent as realLoadAgent } from '../commands/agent.js';
import {
  resolveExecution,
  applyCliDefaultModel,
  dispatchAgent,
} from './execution.js';
import type { AgentInput } from './executor.js';

export interface AfCliDispatchOptions {
  /** CLI default model (e.g. config.defaults.model). Applied per applyCliDefaultModel rules. */
  cliDefaultModel?: string;
  /** Working directory passed to the Claude backend path. */
  cwd?: string;
  /** DI seams for tests — default to the real implementations. */
  loadAgentFn?: typeof realLoadAgent;
  dispatchFn?: typeof dispatchAgent;
}

/** Build the concrete AfCliDispatch the production AfCliExecutor binds to. */
export function createAfCliDispatch(opts: AfCliDispatchOptions = {}) {
  const loadAgentFn = opts.loadAgentFn ?? realLoadAgent;
  const dispatchFn = opts.dispatchFn ?? dispatchAgent;

  return async (agentId: string, input: AgentInput) => {
    const agent = loadAgentFn(agentId);
    if (!agent) {
      throw new Error(
        `orchestrate: agent "${agentId}" not found in registry ` +
          `(expected agents/${agentId}.md). Run \`af agent sync\` or check the domain roster.`,
      );
    }

    // Routing lives in AF CLI (execution.ts). We only resolve + hand off.
    const execCfg = resolveExecution(agent.meta.execution);
    execCfg.model = applyCliDefaultModel(execCfg, opts.cliDefaultModel);

    const systemPrompt = agent.content.trim();
    const taskPrompt = composeTaskPrompt(input);

    const result = await dispatchFn(execCfg, {
      systemPrompt,
      taskPrompt,
      maxTurns: agent.meta.maxTurns,
      tools: agent.meta.tools,
      cwd: input.cwd ?? opts.cwd,
      // timeoutMs intentionally omitted → dispatchAgent/process guard defaults apply.
    });

    // Pass backend through so the orchestrator records it per step (AF-FIX-A6).
    return { output: result.output, usage: result.usage, backend: result.backend };
  };
}

/** Render an AgentInput into a single task prompt. */
export function composeTaskPrompt(input: AgentInput): string {
  const parts = [input.objective.trim()];
  if (input.context !== undefined && input.context !== null) {
    parts.push('', '## Context', '```json', JSON.stringify(input.context, null, 2), '```');
  }
  return parts.join('\n');
}
