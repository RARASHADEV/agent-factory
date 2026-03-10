import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import matter from 'gray-matter';
import { AF_DIR } from './constants.js';
import { loadConfig, type ProjectEntry } from './config.js';

export interface ProjectMeta {
  id: string;
  name: string;
  prefix: string;
  status: string;
  owner: string;
  created: string;
  counter: number;
  origin?: string;
  stack?: string;
  [key: string]: unknown;
}

export interface ProjectInfo {
  entry: ProjectEntry;
  meta: ProjectMeta;
  afPath: string;
}

/**
 * Find the .af/ directory — either in cwd or a specified project path.
 */
export function findWorkspace(projectPath?: string): string | null {
  const dir = projectPath ? resolve(projectPath) : process.cwd();
  const afPath = join(dir, AF_DIR);
  return existsSync(afPath) ? afPath : null;
}

/**
 * Load project.md metadata from a workspace.
 */
export function loadProject(afPath: string): ProjectMeta | null {
  const projectFile = join(afPath, 'project.md');
  if (!existsSync(projectFile)) return null;
  const raw = readFileSync(projectFile, 'utf-8');
  const { data } = matter(raw);
  return data as ProjectMeta;
}

/**
 * List all registered projects with their metadata.
 */
export function listProjects(): ProjectInfo[] {
  const config = loadConfig();
  const projects: ProjectInfo[] = [];

  for (const entry of config.projects) {
    const resolvedPath = entry.path.replace(/^~/, process.env.HOME || '');
    const afPath = join(resolvedPath, AF_DIR);
    const meta = loadProject(afPath);
    if (meta) {
      projects.push({ entry, meta, afPath });
    }
  }

  return projects;
}

/**
 * Resolve a project by prefix or use cwd.
 */
export function resolveProject(prefix?: string): { afPath: string; meta: ProjectMeta } | null {
  if (prefix) {
    const projects = listProjects();
    const match = projects.find(p => p.meta.prefix === prefix.toUpperCase() || p.entry.prefix === prefix.toUpperCase());
    if (match) return { afPath: match.afPath, meta: match.meta };
    return null;
  }

  const afPath = findWorkspace();
  if (!afPath) return null;
  const meta = loadProject(afPath);
  if (!meta) return null;
  return { afPath, meta };
}
