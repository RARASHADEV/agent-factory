// src/lib/core/agent-sync.ts
// AF-60: Presentation-free core op for `af agent sync` (import agents from the
// upstream agent-platform).
//
// Extracted from src/commands/agent.ts so BOTH the CLI and the HTTP mutation route
// (POST /agents/sync) import agents through one code path — no console.*, no chalk,
// no process.exit inside the op. The CLI keeps its terminal formatting via the
// optional `onProgress` callback (so its per-agent lines are byte-identical); the
// HTTP route serializes the returned summary as JSON.
//
// Guardrails (mapped by the adapter):
//   - no upstream configured  → AgentSyncNotConfiguredError (HTTP 400)
//   - upstream HTTP error / unreachable → AgentSyncError (HTTP 502)
//
// The upstream fetch is the network leg; it lives here. Hermetic tests exercise
// the not-configured guardrail (never touches the network) and skip the live fetch.

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { AGENTS_DIR } from '../constants.js';
import { loadConfig } from '../config.js';
import { auditLog } from '../audit.js';

/** Raised when no upstream agent-platform URL is configured. */
export class AgentSyncNotConfiguredError extends Error {
  constructor() {
    super('No upstream URL configured in ~/.af/config.yaml');
    this.name = 'AgentSyncNotConfiguredError';
  }
}

/** Raised when the upstream agent-platform is unreachable or returns an error. */
export class AgentSyncError extends Error {
  constructor(
    message: string,
    /** True when the upstream could not be reached at all (ECONNREFUSED). */
    public readonly unreachable: boolean,
    public readonly upstreamUrl: string,
  ) {
    super(message);
    this.name = 'AgentSyncError';
  }
}

/** A per-agent progress event the CLI renders as it imports each agent. */
export interface AgentSyncProgress {
  slug: string;
  version?: number;
  model?: string;
}

/** Result of {@link syncAgents}. */
export interface AgentSyncResult {
  count: number;
  skipped: number;
  agents: string[];
}

function slugify(role: string): string {
  return role.toLowerCase().replace(/_/g, '-');
}

/**
 * Import agents from the upstream agent-platform into AGENTS_DIR. Mirrors
 * `af agent sync`. When `slug` is given, only that agent is fetched.
 *
 * @param onProgress optional callback invoked for each synced agent (CLI rendering).
 * @throws {AgentSyncNotConfiguredError} when no upstream URL is configured.
 * @throws {AgentSyncError}              on an upstream HTTP error / unreachable host.
 */
export async function syncAgents(
  slug?: string,
  onProgress?: (p: AgentSyncProgress) => void,
): Promise<AgentSyncResult> {
  const config = loadConfig();
  const upstream = config.agents?.upstream;

  if (!upstream?.url) {
    throw new AgentSyncNotConfiguredError();
  }

  // Ensure agents directory exists
  mkdirSync(AGENTS_DIR, { recursive: true });

  const url = slug ? `${upstream.url}/agents/${slug}` : `${upstream.url}/agents`;
  const headers: Record<string, string> = {};
  if (upstream.secret) {
    headers['X-Agent-Secret'] = upstream.secret;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err: any) {
    const unreachable = err?.code === 'ECONNREFUSED';
    throw new AgentSyncError(
      unreachable ? `Cannot reach agent-platform at ${upstream.url}` : `Sync failed: ${err?.message ?? String(err)}`,
      unreachable,
      upstream.url,
    );
  }

  if (!response.ok) {
    throw new AgentSyncError(`API returned ${response.status}: ${response.statusText}`, false, upstream.url);
  }

  const data = (await response.json()) as any;
  const agents = Array.isArray(data) ? data : [data];

  // If we got the list endpoint, we need to fetch each agent's detail because the
  // list doesn't include instruction fields.
  const needsDetail = Array.isArray(data) && agents.length > 0 && !agents[0].instructions;

  let count = 0;
  let skipped = 0;
  const syncedSlugs: string[] = [];

  for (const agent of agents) {
    if (!agent.isActive) {
      skipped++;
      continue;
    }

    let detail = agent;
    if (needsDetail) {
      const detailRes = await fetch(`${upstream.url}/agents/${agent.id}`, { headers });
      if (!detailRes.ok) {
        skipped++;
        continue;
      }
      detail = (await detailRes.json()) as any;
    }

    const agentSlug = slugify(detail.role || detail.name);
    const model = detail.defaultModel?.modelIdentifier;
    const disallowed = detail.disallowedTools ? JSON.parse(detail.disallowedTools) : [];

    const frontmatter: Record<string, unknown> = {
      slug: agentSlug,
      name: detail.name,
      role: detail.role,
      version: detail.version || 1,
    };
    if (model) frontmatter.model = model;
    if (detail.maxTurns) frontmatter.maxTurns = detail.maxTurns;
    if (detail.defaultEnvironment) frontmatter.environment = detail.defaultEnvironment;
    if (disallowed.length > 0) frontmatter.disallowedTools = disallowed;
    frontmatter.synced = new Date().toISOString();

    const sections: string[] = [];
    if (detail.instructions) sections.push(`# Instructions\n\n${detail.instructions}`);
    if (detail.responsibility) sections.push(`# Responsibility\n\n${detail.responsibility}`);
    if (detail.beforeStart) sections.push(`# Before Start\n\n${detail.beforeStart}`);
    if (detail.taskInstructions) sections.push(`# Task Instructions\n\n${detail.taskInstructions}`);
    if (detail.desiredOutput) sections.push(`# Desired Output\n\n${detail.desiredOutput}`);
    if (detail.whenFinished) sections.push(`# When Finished\n\n${detail.whenFinished}`);
    if (detail.constraints) sections.push(`# Constraints\n\n${detail.constraints}`);

    const body = sections.length > 0 ? sections.join('\n\n') : `# ${detail.name}\n\n_No instructions defined._\n`;
    const content = matter.stringify(`\n${body}\n`, frontmatter);

    writeFileSync(join(AGENTS_DIR, `${agentSlug}.md`), content);
    count++;
    syncedSlugs.push(agentSlug);
    onProgress?.({ slug: agentSlug, version: detail.version, model });
  }

  // Audit log — best-effort; use cwd .af as fallback (global op, no project required).
  try {
    const afPath = join(process.cwd(), '.af');
    auditLog(afPath, {
      event: 'agent.sync',
      actor: 'cli',
      detail: `Synced ${count} agent${count === 1 ? '' : 's'}`,
      meta: { agents: syncedSlugs },
    });
  } catch {}

  return { count, skipped, agents: syncedSlugs };
}
