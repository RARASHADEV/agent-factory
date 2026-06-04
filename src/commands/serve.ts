// src/commands/serve.ts
// AF-53: `af serve` — the authenticated AF HTTP service skeleton.
// Feature-flagged behind ENABLE_AF_53.
//
// Scope of AF-54 (this file): flag gate, config load + secret/bind resolution,
// fail-closed bind (Decision 4 / §14 R2), constant-time bearer auth on every
// request, and a single read route GET /health. The queue, SQLite layer, and
// the /jobs · /audit · query/mutation routes land in later tickets — the router
// and the withAuth wrapper below are the seams they mount onto.

import { createServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ENABLE_AF_53 } from '../lib/constants.js';
import { loadConfig } from '../lib/config.js';
import {
  resolveServiceConfig,
  resolveTailscaleIp,
  decideBind,
  type ResolvedServiceConfig,
} from '../lib/service-config.js';
import { isAuthorized } from '../lib/service-auth.js';
import { openServiceDb, type ServiceDb } from '../lib/service-db.js';
import { createJobService, type JobService } from '../lib/service-jobs.js';
import { wrapWithAudit, type RouteAuditMeta } from '../lib/service-audit.js';
import { error } from '../lib/format.js';
import { ProjectNotFoundError } from '../lib/core/errors.js';
import { listProjectsSummary } from '../lib/core/projects.js';
import { getProjectStatus } from '../lib/core/status.js';
import {
  listTasks,
  showTask,
  createTask,
  moveTask,
  assignTask,
  logTask,
} from '../lib/core/tasks.js';
import { listAgents, showAgent } from '../lib/core/agents.js';
import { listPipelineRuns, getPipelineRun } from '../lib/core/pipelines.js';
import { initProject, WorkspaceExistsError } from '../lib/core/init.js';
import { syncProject, SyncNotConfiguredError } from '../lib/core/sync.js';
import {
  syncAgents,
  AgentSyncNotConfiguredError,
  AgentSyncError,
} from '../lib/core/agent-sync.js';
import { takeBufferedBody } from '../lib/service-audit.js';
import { TaskNotFoundError, ValidationError } from '../lib/task-provider.js';
import type { TaskCreateInput } from '../lib/task-provider.js';

export interface ServeOptions {
  port?: number;
  /** Override bind address (also via AF_SERVICE_BIND). */
  bind?: string;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** A route handler: receives the request, response, and the resolved config. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ResolvedServiceConfig,
) => void | Promise<void>;

/**
 * Wrap a handler so every request is authenticated first (design §9: auth on
 * every route). Missing / wrong bearer → 401, handler never runs. Later tickets
 * mount their route handlers through this same wrapper.
 */
export function withAuth(handler: RouteHandler): RouteHandler {
  return (req, res, cfg) => {
    if (!isAuthorized(req.headers['authorization'], cfg.secret)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }
    return handler(req, res, cfg);
  };
}

// ── Route catalog (single source of truth) ───────────────────────────────────
//
// One declarative description of the whole API surface. Both the self-describing
// GET / discovery endpoint AND the startup banner render FROM this array, so the
// two can never drift. Each entry mirrors what a route does; add a route here and
// it shows up in both places. `params` documents query params; `body` documents
// required/notable request-body fields for the body-bearing routes.

export interface RouteDoc {
  method: string;
  path: string;
  plane: 'service' | 'execution' | 'query' | 'mutation';
  description: string;
  /** Notable query-string parameters, if any (e.g. `?status=`). */
  params?: string;
  /** Notable request-body fields for body-bearing routes (POST/PATCH). */
  body?: string;
}

/**
 * The canonical catalog of every route `af serve` exposes. Ordered service →
 * execution → query → mutation so the banner reads top-down. This is the source
 * of truth referenced by both `serviceIndex` (GET /) and `bannerLines`.
 */
export const ROUTE_CATALOG: readonly RouteDoc[] = [
  {
    method: 'GET',
    path: '/',
    plane: 'service',
    description: 'service discovery — this catalog of every route + live config',
  },
  {
    method: 'GET',
    path: '/health',
    plane: 'query',
    description: 'health / live queue counts / capacity',
  },
  // Execution plane (async — queue + callback).
  {
    method: 'POST',
    path: '/jobs',
    plane: 'execution',
    description: 'enqueue an execution job (async; 202 + queued, callback on finish)',
    body: 'kind (agent|orchestration|pipeline), project (PREFIX, e.g. "AF"), role/domain/name, objective, optional callback_url',
  },
  {
    method: 'GET',
    path: '/jobs/:id',
    plane: 'query',
    description: 'job registry row',
  },
  {
    method: 'GET',
    path: '/jobs',
    plane: 'query',
    description: 'list jobs',
    params: '?project=&status=',
  },
  {
    method: 'POST',
    path: '/jobs/:id/pause',
    plane: 'execution',
    description: 'pause a pipeline job',
  },
  {
    method: 'POST',
    path: '/jobs/:id/resume',
    plane: 'execution',
    description: 'resume a paused pipeline job',
  },
  {
    method: 'GET',
    path: '/audit',
    plane: 'query',
    description: 'cross-plane audit journal',
    params: '?since=&caller=&project=&plane=&op=&limit=',
  },
  // Query plane (read-only · synchronous · NEVER queued).
  {
    method: 'GET',
    path: '/projects',
    plane: 'query',
    description: 'project summary listing',
  },
  {
    method: 'GET',
    path: '/projects/:p/status',
    plane: 'query',
    description: 'status overview for one project',
  },
  {
    method: 'GET',
    path: '/projects/:p/tasks',
    plane: 'query',
    description: 'task listing for one project',
    params: '?status=',
  },
  {
    method: 'GET',
    path: '/tasks/:ticket',
    plane: 'query',
    description: 'one task (404 when unknown)',
  },
  {
    method: 'GET',
    path: '/agents',
    plane: 'query',
    description: 'agent registry listing',
  },
  {
    method: 'GET',
    path: '/agents/:slug',
    plane: 'query',
    description: 'one agent (404 when unknown)',
  },
  {
    method: 'GET',
    path: '/pipelines',
    plane: 'query',
    description: 'pipeline run listing',
  },
  {
    method: 'GET',
    path: '/pipelines/:ticket',
    plane: 'query',
    description: 'one pipeline run (404 when no run)',
  },
  // Mutation plane (writes · synchronous · NEVER queued).
  {
    method: 'POST',
    path: '/projects',
    plane: 'mutation',
    description: 'init a workspace',
    body: 'prefix (required), optional name, optional path (absolute project dir)',
  },
  {
    method: 'POST',
    path: '/projects/:p/tasks',
    plane: 'mutation',
    description: 'create a task',
    body: 'title (required), optional type/priority/complexity/assignee/due/description/design/ticket/depends[]',
  },
  {
    method: 'PATCH',
    path: '/tasks/:ticket',
    plane: 'mutation',
    description: 'move / assign / log a task',
    body: 'exactly one of status | assignee | log',
  },
  {
    method: 'POST',
    path: '/agents/sync',
    plane: 'mutation',
    description: 'import agents from the upstream platform',
    body: 'optional slug (sync one agent)',
  },
  {
    method: 'POST',
    path: '/sync',
    plane: 'mutation',
    description: 'synchronize a project with Loka',
    body: 'optional project (PREFIX), optional mode (push|pull|bidirectional)',
  },
];

/**
 * The service version, read from the package.json at the package root. At runtime
 * this file lives at <pkg>/dist/commands/serve.js, so package.json is two levels
 * up. Falls back to '0.0.0' if it cannot be read (never throws on the request path).
 */
export function serviceVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Build the GET / discovery document: the self-describing JSON catalog of the API
 * surface plus the live, resolved service config. One URL a consumer (human or
 * machine) can hit to learn how to call every service. Built FROM ROUTE_CATALOG so
 * it stays in lockstep with the banner.
 */
export function serviceIndex(cfg: ResolvedServiceConfig): Record<string, unknown> {
  return {
    service: 'af-serve',
    version: serviceVersion(),
    auth: 'Authorization: Bearer <secret> required on every route',
    capacity: {
      maxConcurrency: cfg.maxConcurrency,
      maxQueueDepth: cfg.maxQueueDepth,
    },
    notes: [
      "project is the registry PREFIX (e.g. 'AF'), not the directory name",
      'execution routes are async (queue+callback); query/mutation are synchronous',
    ],
    endpoints: ROUTE_CATALOG.map((r) => ({
      method: r.method,
      path: r.path,
      plane: r.plane,
      description: r.description,
      ...(r.params ? { params: r.params } : {}),
      ...(r.body ? { body: r.body } : {}),
    })),
  };
}

/** GET / → the service discovery document (auth + audit applied via `mount`). */
function makeServiceIndexRoute(): RouteHandler {
  return (_req, res, cfg) => {
    sendJson(res, 200, serviceIndex(cfg));
  };
}

/**
 * Render the startup banner body lines FROM the same ROUTE_CATALOG, so the banner
 * and GET / can never drift. Returns the per-route lines (without the leading
 * "listening on …" line, which depends on the resolved host/port).
 */
export function bannerLines(cfg: ResolvedServiceConfig): string[] {
  const lines = ROUTE_CATALOG.map((r) => {
    const suffix = r.params ? ` ${r.params}` : '';
    const sig = `${r.method.padEnd(5)}${r.path}${suffix}`;
    return `  ${sig.padEnd(40)} — ${r.description}`;
  });
  lines.push(`  Auth: Authorization: Bearer <secret> required on every route`);
  lines.push(`  Capacity: ${cfg.maxConcurrency} concurrent · queue backstop: ${cfg.maxQueueDepth}`);
  return lines;
}

// ── Routes (AF-54: /health · AF-56: /jobs · AF-69: /audit) ───────────────────

/**
 * GET /health → { ok, running, queued, capacity }. When the execution-plane
 * JobService is wired (AF-56), running/queued report the live queue counts;
 * without it (e.g. health-only unit tests) they fall back to 0.
 */
function makeHealthRoute(jobs?: JobService): RouteHandler {
  return (_req, res, cfg) => {
    sendJson(res, 200, {
      ok: true,
      running: jobs ? jobs.queue.runningCount() : 0,
      queued: jobs ? jobs.queue.queuedCount() : 0,
      capacity: cfg.maxConcurrency,
    });
  };
}

/**
 * GET /audit → the cross-plane audit journal (design §4). Read-only and UNQUEUED:
 * it returns immediately even while 20 jobs run (it never touches the queue), and
 * reads via WAL so it never blocks the single writer. Filters:
 *   ?since=&caller=&project=&plane=&op=&limit=
 */
function makeAuditRoute(db: ServiceDb): RouteHandler {
  return (req, res) => {
    const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const num = (v: string | null): number | undefined =>
      v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
    const str = (v: string | null): string | undefined =>
      v !== null && v !== '' ? v : undefined;

    const rows = db.listRequestLog({
      since: num(q.get('since')),
      caller: str(q.get('caller')),
      project: str(q.get('project')),
      plane: str(q.get('plane')),
      // `op` filters on the logical operation; map it onto the operation column.
      // (listRequestLog has no `operation` filter, so filter here for the param.)
      limit: num(q.get('limit')),
    });
    const op = str(q.get('op'));
    const filtered = op ? rows.filter((r) => r.operation === op) : rows;
    sendJson(res, 200, { entries: filtered.map(auditRowToJson) });
  };
}

/** request_log row → the JSON shape GET /audit returns (snake→camel, §7.2). */
function auditRowToJson(r: {
  id: string;
  receivedAt: number;
  caller: string | null;
  plane: string;
  method: string;
  path: string;
  operation: string | null;
  project: string | null;
  jobId: string | null;
  status: number | null;
  outcome: string | null;
  resultSummary: string | null;
  respondedAt: number | null;
}): Record<string, unknown> {
  return {
    id: r.id,
    receivedAt: r.receivedAt,
    caller: r.caller,
    plane: r.plane,
    method: r.method,
    path: r.path,
    operation: r.operation,
    project: r.project,
    jobId: r.jobId,
    status: r.status,
    outcome: r.outcome,
    resultSummary: r.resultSummary,
    respondedAt: r.respondedAt,
  };
}

// ── Query plane (AF-59: read-only · synchronous · NEVER queued) ──────────────
//
// Each handler is a thin adapter over an AF-58/AF-59 core read op: validate the
// path/query params, call the core op, serialize the structured result as JSON.
// NO business logic lives here. These routes never touch the job queue, so
// GET /projects answers immediately even while 20 jobs run (design test 6).
// They are mounted through `mount` so they inherit auth (401) + audit logging.
//
// Error mapping (§6 project guardrail): an unresolvable project → 400 (catch
// ProjectNotFoundError); an unknown ticket/slug/run → 404. Both responses are
// JSON `{ ok:false, error }`, matching the rest of the surface.

/** Decode a path segment, returning undefined for an empty/invalid one. */
function pathParam(raw: string): string {
  return decodeURIComponent(raw);
}

/**
 * Run a query handler, mapping core-op errors to HTTP. ProjectNotFoundError →
 * 400 (unknown project rejected, §6); any other throw bubbles to dispatch's 500.
 */
async function runQuery(
  res: ServerResponse,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    throw err;
  }
}

/** GET /projects → the project summary listing (mirrors `af projects`). */
const queryProjects: RouteHandler = (_req, res) =>
  runQuery(res, async () => {
    const data = await listProjectsSummary();
    sendJson(res, 200, data as unknown as Record<string, unknown>);
  });

/** GET /projects/:p/status → status overview for one project. */
function queryProjectStatus(prefix: string): RouteHandler {
  return (_req, res) =>
    runQuery(res, async () => {
      const data = await getProjectStatus(prefix);
      sendJson(res, 200, data as unknown as Record<string, unknown>);
    });
}

/** GET /projects/:p/tasks?status= → task listing for one project. */
function queryProjectTasks(prefix: string): RouteHandler {
  return (req, res) =>
    runQuery(res, async () => {
      const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const status = q.get('status');
      const query = status ? { status } : {};
      const data = await listTasks(query, prefix);
      sendJson(res, 200, data as unknown as Record<string, unknown>);
    });
}

/** GET /tasks/:ticket → one task (404 when the ticket does not exist). */
function queryTask(ticket: string): RouteHandler {
  return (_req, res) =>
    runQuery(res, async () => {
      const data = await showTask(ticket);
      if (!data) {
        sendJson(res, 404, { ok: false, error: `Task ${ticket} not found` });
        return;
      }
      sendJson(res, 200, data as unknown as Record<string, unknown>);
    });
}

/** GET /agents → the agent registry listing (mirrors `af agent list`). */
const queryAgents: RouteHandler = (_req, res) =>
  runQuery(res, () => {
    const data = listAgents();
    sendJson(res, 200, data as unknown as Record<string, unknown>);
  });

/** GET /agents/:slug → one agent (404 when the slug is unknown). */
function queryAgent(slug: string): RouteHandler {
  return (_req, res) =>
    runQuery(res, () => {
      const data = showAgent(slug);
      if (!data) {
        sendJson(res, 404, { ok: false, error: `Agent ${slug} not found` });
        return;
      }
      sendJson(res, 200, data as unknown as Record<string, unknown>);
    });
}

/** GET /pipelines → pipeline run listing (mirrors `af pipeline status`). */
const queryPipelines: RouteHandler = (_req, res) =>
  runQuery(res, () => {
    const data = listPipelineRuns();
    sendJson(res, 200, data as unknown as Record<string, unknown>);
  });

/** GET /pipelines/:ticket → one pipeline run (404 when no run exists). */
function queryPipeline(ticket: string): RouteHandler {
  return (_req, res) =>
    runQuery(res, () => {
      const data = getPipelineRun(ticket);
      if (!data) {
        sendJson(res, 404, { ok: false, error: `No pipeline run for ${ticket}` });
        return;
      }
      sendJson(res, 200, data as unknown as Record<string, unknown>);
    });
}

/**
 * Match a dynamic (id-bearing) query-plane route → a bound handler, or undefined.
 * The static query routes (GET /projects, /agents, /pipelines) live in
 * `buildRouter`; these carry a path parameter and are matched here.
 */
export function matchQueryRoute(method: string, path: string): RouteHandler | undefined {
  if (method !== 'GET') return undefined;

  let m = /^\/projects\/([^/]+)\/status$/.exec(path);
  if (m) return queryProjectStatus(pathParam(m[1]));

  m = /^\/projects\/([^/]+)\/tasks$/.exec(path);
  if (m) return queryProjectTasks(pathParam(m[1]));

  m = /^\/tasks\/([^/]+)$/.exec(path);
  if (m) return queryTask(pathParam(m[1]));

  m = /^\/agents\/([^/]+)$/.exec(path);
  if (m) return queryAgent(pathParam(m[1]));

  m = /^\/pipelines\/([^/]+)$/.exec(path);
  if (m) return queryPipeline(pathParam(m[1]));

  return undefined;
}

// ── Mutation plane (AF-60: writes · synchronous · NEVER queued) ──────────────
//
// Each handler is a thin adapter over an AF-58 core write op (createTask/moveTask/
// assignTask/logTask) or an AF-60 core maintenance op (initProject/syncProject/
// syncAgents). It parses + validates the body, calls the core op, and serializes
// the result as JSON. NO business logic lives here (design §3.1 invariant). These
// routes are synchronous: they never touch the job queue (§1 — mutations are not
// queued). They are mounted through `mount` so they inherit auth (401) + audit.
//
// Error mapping:
//   ProjectNotFoundError    → 400 (unknown project rejected, §6 guardrail)
//   WorkspaceExistsError    → 400 (duplicate init)
//   Sync/AgentSync-not-configured → 400
//   TaskNotFoundError       → 404 (unknown ticket)
//   ValidationError / bad body → 400
//   AgentSyncError (upstream) → 502
//   anything else           → bubbles to dispatch's 500

/** Pull the body the audit middleware already buffered (the stream is read once). */
function bodyOf(req: IncomingMessage): Record<string, unknown> {
  return takeBufferedBody(req) ?? {};
}

/**
 * Run a mutation handler, mapping core-op errors to HTTP status codes. Keeps the
 * per-handler bodies focused on the happy path; all error→status mapping is here.
 */
async function runMutation(
  res: ServerResponse,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    if (err instanceof WorkspaceExistsError) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    if (err instanceof SyncNotConfiguredError || err instanceof AgentSyncNotConfiguredError) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    if (err instanceof TaskNotFoundError) {
      sendJson(res, 404, { ok: false, error: err.message });
      return;
    }
    if (err instanceof ValidationError) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    if (err instanceof AgentSyncError) {
      sendJson(res, 502, { ok: false, error: err.message });
      return;
    }
    throw err;
  }
}

/** POST /projects { prefix, name? } → init a workspace (mirrors `af init`). */
const mutateInitProject: RouteHandler = (req, res) =>
  runMutation(res, async () => {
    const body = bodyOf(req);
    const prefix = typeof body.prefix === 'string' ? body.prefix.trim() : '';
    if (!prefix) {
      sendJson(res, 400, { ok: false, error: 'prefix is required' });
      return;
    }
    const name = typeof body.name === 'string' ? body.name : undefined;
    // projectDir is taken from `path` when supplied (absolute), else cwd. The HTTP
    // service runs on Hanuman; callers pass an absolute project directory.
    const projectDir = typeof body.path === 'string' && body.path.trim() ? body.path : undefined;
    const data = initProject({ prefix, name, projectDir });
    sendJson(res, 201, data as unknown as Record<string, unknown>);
  });

/** POST /projects/:p/tasks { title, … } → create a task (mirrors `af task create`). */
function mutateCreateTask(prefix: string): RouteHandler {
  return (req, res) =>
    runMutation(res, async () => {
      const body = bodyOf(req);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) {
        sendJson(res, 400, { ok: false, error: 'title is required' });
        return;
      }
      const input: TaskCreateInput = { title };
      // Optional string fields, passed through only when present + well-typed.
      for (const k of ['type', 'priority', 'complexity', 'assignee', 'due', 'description', 'design', 'ticket'] as const) {
        const v = body[k];
        if (typeof v === 'string') input[k] = v;
      }
      if (Array.isArray(body.depends)) {
        input.depends = (body.depends as unknown[]).filter((d): d is string => typeof d === 'string');
      }
      const data = await createTask(input, prefix);
      sendJson(res, 201, data as unknown as Record<string, unknown>);
    });
}

/**
 * PATCH /tasks/:ticket { status? | assignee? | log? } → move/assign/log.
 *
 * Field dispatch: exactly ONE of `status` / `assignee` / `log` may be present.
 *   - `status`   → moveTask(ticket, status)
 *   - `assignee` → assignTask(ticket, assignee)
 *   - `log`      → logTask(ticket, log)
 * Zero fields → 400 ("one of status|assignee|log required"); more than one → 400
 * ("exactly one of status|assignee|log per request"). This keeps each call a
 * single, attributable mutation rather than overloading one request.
 */
function mutatePatchTask(ticket: string): RouteHandler {
  return (req, res) =>
    runMutation(res, async () => {
      const body = bodyOf(req);
      const status = typeof body.status === 'string' ? body.status : undefined;
      const assignee = typeof body.assignee === 'string' ? body.assignee : undefined;
      const log = typeof body.log === 'string' ? body.log : undefined;

      const present = [status, assignee, log].filter((v) => v !== undefined).length;
      if (present === 0) {
        sendJson(res, 400, { ok: false, error: 'one of status|assignee|log is required' });
        return;
      }
      if (present > 1) {
        sendJson(res, 400, { ok: false, error: 'exactly one of status|assignee|log per request' });
        return;
      }

      if (status !== undefined) {
        const data = await moveTask(ticket, status);
        sendJson(res, 200, data as unknown as Record<string, unknown>);
        return;
      }
      if (assignee !== undefined) {
        const data = await assignTask(ticket, assignee);
        sendJson(res, 200, data as unknown as Record<string, unknown>);
        return;
      }
      const data = await logTask(ticket, log!);
      sendJson(res, 200, data as unknown as Record<string, unknown>);
    });
}

/** POST /agents/sync → import agents from the upstream platform (`af agent sync`). */
const mutateSyncAgents: RouteHandler = (req, res) =>
  runMutation(res, async () => {
    const body = bodyOf(req);
    const slug = typeof body.slug === 'string' && body.slug.trim() ? body.slug : undefined;
    const data = await syncAgents(slug);
    sendJson(res, 200, data as unknown as Record<string, unknown>);
  });

/** POST /sync { project, mode? } → synchronize a project with Loka (`af sync`). */
const mutateSync: RouteHandler = (req, res) =>
  runMutation(res, async () => {
    const body = bodyOf(req);
    const project = typeof body.project === 'string' && body.project.trim() ? body.project : undefined;
    const mode = typeof body.mode === 'string' ? (body.mode as 'push' | 'pull' | 'bidirectional') : undefined;
    if (mode && mode !== 'push' && mode !== 'pull' && mode !== 'bidirectional') {
      sendJson(res, 400, { ok: false, error: `invalid mode '${mode}' (push|pull|bidirectional)` });
      return;
    }
    const data = await syncProject({ project, mode });
    sendJson(res, 200, data as unknown as Record<string, unknown>);
  });

/**
 * Match a dynamic (id-bearing) mutation-plane route → a bound handler, or undefined.
 * The static mutation routes (POST /projects, POST /agents/sync, POST /sync) live in
 * `buildRouter`; these carry a path parameter and are matched here.
 */
export function matchMutationRoute(method: string, path: string): RouteHandler | undefined {
  if (method === 'POST') {
    const m = /^\/projects\/([^/]+)\/tasks$/.exec(path);
    if (m) return mutateCreateTask(pathParam(m[1]));
  }
  if (method === 'PATCH') {
    const m = /^\/tasks\/([^/]+)$/.exec(path);
    if (m) return mutatePatchTask(pathParam(m[1]));
  }
  return undefined;
}

/**
 * Compose the per-route middleware stack: audit OUTER, auth INNER. The §5.4
 * ordering needs log-first to run BEFORE auth so a rejected (401) attempt is still
 * journaled; the audit wrapper logs the arrival, then delegates to withAuth, whose
 * 401 (or the handler's response) is captured by the same wrapper as log-last.
 * When `db` is absent (health-only unit tests pre-AF-55) the stack is auth-only.
 */
function mount(db: ServiceDb | undefined, handler: RouteHandler, meta?: RouteAuditMeta): RouteHandler {
  const authed = withAuth(handler);
  return db ? wrapWithAudit(db, authed, meta) : authed;
}

/**
 * Build the router. Keyed by "METHOD path" for exact routes; the dynamic
 * /jobs/:id (and /pause|/resume) routes are matched in `dispatch`. Every entry is
 * mounted through `mount` (audit + auth), so the Stage B route tickets inherit
 * log-first/log-last automatically by registering their route here. When `db` is
 * provided the audit journal is written and GET /audit is mounted; when `jobs` (the
 * AF-56 execution plane) is provided the /jobs routes are mounted and /health
 * reports real queue counts.
 */
export function buildRouter(jobs?: JobService, db?: ServiceDb): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();
  // GET / — self-describing service discovery. Mounted through `mount` so it is
  // bearer-authed + audit-logged exactly like every other route (a 401 without
  // the secret); never unauthenticated.
  routes.set('GET /', mount(db, makeServiceIndexRoute()));
  routes.set('GET /health', mount(db, makeHealthRoute(jobs)));

  if (db) {
    routes.set('GET /audit', mount(db, makeAuditRoute(db)));
  }

  // Query plane (AF-59) — static read routes. Synchronous + unqueued: they never
  // touch `jobs`, so they answer immediately even while the queue is saturated.
  // Mounted through `mount` for auth + audit. The id-bearing query routes
  // (/projects/:p/*, /tasks/:ticket, /agents/:slug, /pipelines/:ticket) are matched
  // in `dispatch` via `matchQueryRoute`.
  routes.set('GET /projects', mount(db, queryProjects));
  routes.set('GET /agents', mount(db, queryAgents));
  routes.set('GET /pipelines', mount(db, queryPipelines));

  // Mutation plane (AF-60) — static write routes. Synchronous + unqueued: they
  // never touch `jobs`. Mounted through `mount` for auth + audit. The id-bearing
  // mutation routes (POST /projects/:p/tasks, PATCH /tasks/:ticket) are matched in
  // `dispatch` via `matchMutationRoute`.
  routes.set('POST /projects', mount(db, mutateInitProject));
  routes.set('POST /agents/sync', mount(db, mutateSyncAgents));
  routes.set('POST /sync', mount(db, mutateSync));

  if (jobs) {
    routes.set('POST /jobs', mount(db, (req, res) => jobs.handlePost(req, res)));
    routes.set(
      'GET /jobs',
      mount(db, (req, res) => {
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        jobs.handleList(res, query);
      }),
    );
  }
  return routes;
}

/** Match a dynamic /jobs route. Returns a bound handler or undefined. */
function matchJobRoute(
  jobs: JobService,
  method: string,
  path: string,
): RouteHandler | undefined {
  // /jobs/:id/pause | /jobs/:id/resume
  const ctrl = /^\/jobs\/([^/]+)\/(pause|resume)$/.exec(path);
  if (ctrl && method === 'POST') {
    const [, id, action] = ctrl;
    return (_req, res) => jobs.handleControl(res, decodeURIComponent(id), action as 'pause' | 'resume');
  }
  // /jobs/:id
  const one = /^\/jobs\/([^/]+)$/.exec(path);
  if (one && method === 'GET') {
    const [, id] = one;
    return (_req, res) => jobs.handleGetOne(res, decodeURIComponent(id));
  }
  return undefined;
}

/** Dispatch a request to the router, returning 404 for unknown routes. */
export async function dispatch(
  routes: Map<string, RouteHandler>,
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ResolvedServiceConfig,
  jobs?: JobService,
  db?: ServiceDb,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0];
  let handler = routes.get(`${method} ${path}`);
  // Dynamic /jobs/:id routes (only when the execution plane is wired). Mounted
  // through `mount` so they inherit the same audit + auth stack as static routes.
  if (!handler && jobs) {
    const dynamic = matchJobRoute(jobs, method, path);
    if (dynamic) handler = mount(db, dynamic);
  }
  // Dynamic query-plane routes (AF-59) — id-bearing read routes. Sync + unqueued;
  // mounted through `mount` for the same auth + audit stack.
  if (!handler) {
    const query = matchQueryRoute(method, path);
    if (query) handler = mount(db, query);
  }
  // Dynamic mutation-plane routes (AF-60) — id-bearing write routes (POST
  // /projects/:p/tasks, PATCH /tasks/:ticket). Sync + unqueued; same auth + audit.
  if (!handler) {
    const mutation = matchMutationRoute(method, path);
    if (mutation) handler = mount(db, mutation);
  }
  if (!handler) {
    // Still journal the 404 attempt (an attempt is an attempt, §5.4) — but do NOT
    // auth-gate it (an unknown route 404s for everyone, authed or not, preserving
    // the pre-AF-69 contract). Audit-wrap only so the unknown route is logged +
    // outcomed as 404/rejected.
    const notFound: RouteHandler = (_q, r) => sendJson(r, 404, { ok: false, error: 'Not found' });
    const wrapped = db ? wrapWithAudit(db, notFound) : notFound;
    await wrapped(req, res, cfg);
    return;
  }
  try {
    await handler(req, res, cfg);
  } catch (err: any) {
    process.stderr.write(`[serve] Unhandled error: ${err?.message ?? String(err)}\n`);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
  }
}

// ── Command entry ────────────────────────────────────────────────────────────

export async function serveCommand(options: ServeOptions): Promise<void> {
  // 1. Flag gate (checked once at entry, mirroring webhook/ENABLE_AF_12).
  //    Off → disabled notice, exit 0, no listener opened.
  if (!ENABLE_AF_53) {
    console.log('AF-53 service (af serve) is not enabled. Set ENABLE_AF_53=true in constants.ts to enable.');
    process.exit(0);
  }

  // 2. Resolve config (env overrides the `service` config block, §8).
  const config = loadConfig();
  const resolved = resolveServiceConfig(config.service);

  // CLI flags win over env/config for port and bind.
  if (options.port !== undefined) resolved.port = options.port;
  if (options.bind !== undefined) resolved.bind = options.bind;

  // 3. Secret is required — fail to start with a clear error if missing (§9).
  if (!resolved.secret) {
    console.log(error(
      'Service secret not configured. Set AF_SERVICE_SECRET, or add service.secret to ~/.af/config.yaml\n' +
      'Example:\n  service:\n    secret: <shared_secret>\n    port: 4150',
    ));
    process.exit(1);
  }

  // 4. Resolve bind address: explicit (config/env/flag) or the Tailscale IPv4.
  const bindAddress = resolved.bind ?? resolveTailscaleIp() ?? '';

  // 5. Fail-closed bind safety (Decision 4 / §14 R2): never silently fall back
  //    to 0.0.0.0 / a public interface. Refuse to start, bind nothing.
  const decision = decideBind(bindAddress, resolved.allowPublic);
  if (!decision.ok) {
    console.log(error(`Cannot start af serve: ${decision.reason}`));
    process.exit(1);
  }
  const host = decision.address;

  // 6. Open the SQLite store (AF-55): creates/opens cfg.db, enables WAL, applies
  //    the §7 schema. Then reconcile on boot so no in-flight job is silently lost
  //    across a restart — orphaned `running` rows become `failed` (re-dispatchable)
  //    and still-`queued` rows are reported for re-dispatch (the queue lands in AF-56).
  let db: ServiceDb;
  try {
    db = openServiceDb(resolved.db);
  } catch (err: any) {
    console.log(error(`Cannot open service database at ${resolved.db}: ${err?.message ?? String(err)}`));
    process.exit(1);
  }
  const reconciled = db.reconcileOnBoot();
  console.log(
    `Storage: ${resolved.db} (WAL) — reconcile: ${reconciled.requeued} queued re-dispatchable, ${reconciled.failed} orphaned running → failed`,
  );

  // AF-56: build the execution plane — the global concurrency queue + registry
  // wiring — and re-admit any rows reconcile left `queued` so dispatch survives a
  // restart (design test 5). The queue runs work through the existing dispatch
  // mechanisms (service-executor.ts) in each job's project-local workspace.
  const jobs = createJobService({
    db,
    capacity: resolved.maxConcurrency,
    maxQueueDepth: resolved.maxQueueDepth,
  });
  const readmitted = jobs.readmitQueued();
  if (readmitted > 0) {
    console.log(`Execution plane: re-admitted ${readmitted} queued job(s) into the in-process queue`);
  }

  // Retention (Decision 10): boot-time sweep + a daily timer. Default 0 = keep
  // everything; request_log is never pruned. The timer is unref'd so it never
  // keeps the process alive on its own.
  if (resolved.retentionDays > 0) {
    const pruned = db.pruneRetention(resolved.retentionDays);
    console.log(`Retention: ${resolved.retentionDays}d — pruned ${pruned} terminal job(s) on boot`);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    setInterval(() => {
      try {
        db.pruneRetention(resolved.retentionDays);
      } catch (err: any) {
        process.stderr.write(`[serve] retention sweep failed: ${err?.message ?? String(err)}\n`);
      }
    }, ONE_DAY_MS).unref();
  }

  // 7. Build the router (audit + auth wrapped) and the HTTP server.
  const routes = buildRouter(jobs, db);
  const server = createServer((req, res) => {
    void dispatch(routes, req, res, resolved, jobs, db);
  });

  // 8. Listen on the resolved tailnet/loopback address only.
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(resolved.port, host, () => resolve());
  });

  console.log(`af serve listening on http://${host}:${resolved.port}`);
  // Render the route lines FROM the shared ROUTE_CATALOG so the banner and GET /
  // can never drift (single source of truth).
  for (const line of bannerLines(resolved)) console.log(line);
  console.log(`Press Ctrl+C to stop.`);

  // 9. Graceful shutdown — close the DB connection before exit.
  const shutdown = () => {
    process.stdout.write('\nShutting down af serve...\n');
    try {
      db.close();
    } catch { /* best-effort */ }
    server.close(() => process.exit(0));
    setTimeout(() => {
      process.stderr.write('Forced exit after timeout.\n');
      process.exit(1);
    }, 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive until a signal arrives.
  await new Promise<never>(() => { /* run forever */ });
}
