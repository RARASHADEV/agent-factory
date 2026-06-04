// src/lib/core/agents.ts
// AF-59: Presentation-free core read ops for the `agent` command family.
//
// Returns structured data only — no console.*, no chalk, no process.exit. The CLI
// (src/commands/agent.ts) formats the result for the terminal; the HTTP query plane
// (AF-59) serializes the SAME data as JSON. Both read from the agent registry
// (markdown files under AGENTS_DIR) so behaviour can never drift.
//
// The CLI's `agentListCommand` / `agentShowCommand` keep their presentation logic;
// these helpers expose the underlying registry read in a presentation-free form.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { AGENTS_DIR } from '../constants.js';
import type { AgentFile, AgentMeta } from '../../commands/agent.js';

/** Result of {@link listAgents}. */
export interface AgentListResult {
  agents: AgentFile[];
}

/** Result of {@link showAgent}. */
export interface AgentShowResult {
  agent: AgentFile;
  /** Raw markdown file content (frontmatter + body). */
  raw: string;
}

/**
 * List every agent in the registry (markdown files under AGENTS_DIR).
 * Mirrors `af agent list`. Returns an empty array when the registry is absent.
 */
export function listAgents(): AgentListResult {
  if (!existsSync(AGENTS_DIR)) return { agents: [] };
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
  const agents: AgentFile[] = files.map((f) => {
    const filePath = join(AGENTS_DIR, f);
    const raw = readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);
    return { meta: data as AgentMeta, content, filePath };
  });
  return { agents };
}

/**
 * Fetch a single agent by slug. Mirrors `af agent show`.
 *
 * @returns null if the agent does not exist in the registry.
 */
export function showAgent(slug: string): AgentShowResult | null {
  const filePath = join(AGENTS_DIR, `${slug}.md`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  return { agent: { meta: data as AgentMeta, content, filePath }, raw };
}
