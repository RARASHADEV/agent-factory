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
  /** Optional priority name overrides: AF name → Loka priority name */
  priorityMap?: Record<string, string>;
  /** Sync settings */
  sync?: {
    /** Default sync mode: push, pull, bidirectional. Default: push */
    defaultMode?: 'push' | 'pull' | 'bidirectional';
    /** Auto-post agent activity as Loka comments. Default: true */
    postActivity?: boolean;
  };
  /** Webhook listener settings */
  webhook?: {
    /** Shared secret for HMAC-SHA256 signature verification */
    secret: string;
    /** Port to listen on. Default: 4100 */
    port?: number;
  };
}

/**
 * AF-53: `af serve` HTTP service configuration (design §8).
 * Mirrors the `loka.webhook` block. Env vars override these values at boot
 * (AF_SERVICE_PORT, AF_SERVICE_BIND, AF_SERVICE_ALLOW_PUBLIC, AF_MAX_CONCURRENCY,
 * AF_SERVICE_SECRET, AF_SERVICE_DB). `secret` is required to start the service.
 */
export interface ServiceConfig {
  /** Bearer shared secret. Required to start; env AF_SERVICE_SECRET overrides. */
  secret?: string;
  /** Listen port. Default 4150 (Decision 4); env AF_SERVICE_PORT overrides. */
  port?: number;
  /**
   * Bind address. Defaults to the host Tailscale IPv4 resolved at boot
   * (`tailscale ip -4`); env AF_SERVICE_BIND overrides. Never 0.0.0.0.
   */
  bind?: string;
  /**
   * Escape hatch. When false (default), the service refuses to start if the
   * bind would resolve to 0.0.0.0 or a public interface; env AF_SERVICE_ALLOW_PUBLIC.
   */
  allowPublic?: boolean;
  /** Global worker concurrency cap. Default 20; env AF_MAX_CONCURRENCY overrides. */
  maxConcurrency?: number;
  /**
   * Queue-depth backstop (Decision 6). Default 500; env AF_MAX_QUEUE_DEPTH overrides.
   * When the number of waiting (not running) jobs reaches this ceiling, `POST /jobs`
   * returns 429 and enqueues nothing.
   */
  maxQueueDepth?: number;
  /**
   * SQLite database path (jobs + audit journal; built in a later ticket).
   * Default ~/.af/service.db; env AF_SERVICE_DB overrides.
   */
  db?: string;
  /**
   * Retention in days (Decision 10). 0 (default) = keep everything, never prune.
   * A positive value prunes only terminal `dispatch_jobs`/`job_events` older than
   * N days; `request_log` is never auto-pruned. Env AF_SERVICE_RETENTION_DAYS overrides.
   */
  retentionDays?: number;
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
  /** AF-53: `af serve` HTTP service configuration (design §8) */
  service?: ServiceConfig;
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
