import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GLOBAL_CONFIG, GLOBAL_DIR, AGENTS_DIR } from './constants.js';

export interface ProjectEntry {
  path: string;
  prefix: string;
}

export interface LokaConfig {
  url: string;
  apiKey: string;
  /** Optional status name overrides: AF slug → Loka status name */
  statusMap?: Record<string, string>;
}

export interface GlobalConfig {
  defaults: {
    model: string;
    max_turns: number;
    /** "file" (default) or "loka" — selects the TaskProvider backend */
    taskBackend?: 'file' | 'loka';
  };
  projects: ProjectEntry[];
  agents: {
    path: string;
    upstream?: {
      url: string;
      secret?: string;
    };
  };
  sdk: {
    cli: string;
  };
  /** Loka backend configuration (required when defaults.taskBackend = "loka") */
  loka?: LokaConfig;
}

const DEFAULT_CONFIG: GlobalConfig = {
  defaults: {
    model: 'sonnet',
    max_turns: 50,
  },
  projects: [],
  agents: {
    path: AGENTS_DIR,
    upstream: {
      url: 'http://100.109.246.119:5003/api',
    },
  },
  sdk: {
    cli: 'claude',
  },
};

export function loadConfig(): GlobalConfig {
  if (!existsSync(GLOBAL_CONFIG)) {
    return DEFAULT_CONFIG;
  }
  const raw = readFileSync(GLOBAL_CONFIG, 'utf-8');
  const parsed = parseYaml(raw) as Partial<GlobalConfig>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function saveConfig(config: GlobalConfig): void {
  const dir = dirname(GLOBAL_CONFIG);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(GLOBAL_CONFIG, stringifyYaml(config), 'utf-8');
}

export function ensureGlobalConfig(): GlobalConfig {
  if (!existsSync(GLOBAL_DIR)) {
    mkdirSync(GLOBAL_DIR, { recursive: true });
  }
  if (!existsSync(GLOBAL_CONFIG)) {
    saveConfig(DEFAULT_CONFIG);
  }
  return loadConfig();
}

export function addProject(prefix: string, path: string): void {
  const config = ensureGlobalConfig();
  const existing = config.projects.find(p => p.prefix === prefix);
  if (existing) {
    existing.path = path;
  } else {
    config.projects.push({ path, prefix });
  }
  saveConfig(config);
}
