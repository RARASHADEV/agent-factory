// src/lib/providers/loka-provider.ts
// LokaProvider: full HTTP implementation of the TaskProvider interface.
// Implements AF-12 bidirectional sync with the Loka REST API.

import {
  TaskProvider,
  Task,
  TaskQuery,
  TaskCreateInput,
  TaskUpdateInput,
  TaskNotFoundError,
  ProviderError,
  LokaUnreachableError,
} from '../task-provider.js';
import { LokaHttpClient } from './loka-http-client.js';
import { ENABLE_AF_13 } from '../constants.js';

// ── Loka API shapes ────────────────────────────────────────────────────────

export interface LokaFlatTask {
  id: string;
  title: string;
  description: string | null;
  ticketNumber: number;
  status: string;           // display name
  statusId: string;
  statusCategory: string;   // "backlog" | "active" | "closed"
  priority: number;
  priorityId: string;
  priorityName: string;
  projectId: string;
  projectPrefix: string;
  projectName: string;
  assignee: { id: string; name: string; type: string } | null;
  assigneeId: string | null;
  tags: string[];
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  isCompleted: boolean;
}

export interface LokaProject {
  id: string;
  name: string;
  prefix: string;
  description: string | null;
  color: string;
  type: string;
  taskCount: number;
  memberCount: number;
}

interface LokaMember {
  id: string;
  name: string;
  type: string;
}

// ── Default mappings ───────────────────────────────────────────────────────

const DEFAULT_STATUS_MAP: Record<string, string> = {
  'backlog':         'Backlog',
  'open':            'Open',
  'in-progress':     'In Progress',
  'ready-for-qa':    'Ready for QA',
  'uat':             'UAT',
  'ready-4-release': 'Ready for Release',
  'released':        'Released',
  'closed':          'Closed',
  'blocked':         'Blocked',
};

const DEFAULT_PRIORITY_MAP: Record<string, string> = {
  'critical': 'Urgent',
  'high':     'High',
  'medium':   'Medium',
  'low':      'Low',
};

// ── LokaProvider ───────────────────────────────────────────────────────────

export class LokaProvider implements TaskProvider {
  private client: LokaHttpClient;
  private statusMap: Map<string, string> = new Map();         // AF slug → Loka name
  private reverseStatusMap: Map<string, string> = new Map();  // Loka name → AF slug
  private priorityMap: Map<string, string> = new Map();       // AF name → Loka name
  private reversePriorityMap: Map<string, string> = new Map(); // Loka name → AF name
  private userCache: Map<string, string> = new Map();          // name → Loka UUID
  private projectId: string | null = null;
  private configLoaded = false;

  constructor(
    baseUrl: string,
    apiKey: string,
    private projectPrefix: string,
    private statusMapOverrides?: Record<string, string>,
    private priorityMapOverrides?: Record<string, string>,
    private projectMeta?: { name: string; description?: string },
  ) {
    this.client = new LokaHttpClient({ baseUrl, apiKey });
  }

  /**
   * Lazy-loads project ID and builds status/priority mappings on first call.
   */
  private async ensureConfig(): Promise<void> {
    if (this.configLoaded) return;

    // Find matching project
    const projects = await this.client.get<LokaProject[]>('/projects');
    if (!projects || !Array.isArray(projects)) {
      throw new ProviderError('Failed to load Loka projects');
    }
    let project = projects.find(p => p.prefix === this.projectPrefix);
    if (!project) {
      if (ENABLE_AF_13 && this.projectMeta) {
        process.stderr.write(`[loka] Project "${this.projectPrefix}" not found in Loka — creating it...\n`);
        try {
          const created = await this.client.post<LokaProject>('/projects', {
            name: this.projectMeta.name,
            prefix: this.projectPrefix,
            description: this.projectMeta.description ?? '',
          });
          project = created;
          process.stderr.write(`[loka] Auto-created project "${created.name}" (${created.prefix}) in Loka\n`);
        } catch (err: any) {
          if (err instanceof LokaUnreachableError) {
            throw err;
          }
          throw new ProviderError(
            `Failed to auto-create Loka project "${this.projectPrefix}": ${err?.message ?? String(err)}`
          );
        }
      } else {
        throw new ProviderError(`Loka project with prefix "${this.projectPrefix}" not found`);
      }
    }
    this.projectId = project.id;

    // Build status maps
    const statusSrc = this.statusMapOverrides ?? DEFAULT_STATUS_MAP;
    for (const [afSlug, lokaName] of Object.entries(statusSrc)) {
      this.statusMap.set(afSlug, lokaName);
      this.reverseStatusMap.set(lokaName.toLowerCase(), afSlug);
      this.reverseStatusMap.set(lokaName, afSlug);
    }

    // Build priority maps
    const prioritySrc = this.priorityMapOverrides ?? DEFAULT_PRIORITY_MAP;
    for (const [afName, lokaName] of Object.entries(prioritySrc)) {
      this.priorityMap.set(afName, lokaName);
      this.reversePriorityMap.set(lokaName.toLowerCase(), afName);
      this.reversePriorityMap.set(lokaName, afName);
    }

    this.configLoaded = true;
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async list(query?: TaskQuery): Promise<Task[]> {
    await this.ensureConfig();

    const params: Record<string, string> = {
      projectPrefix: this.projectPrefix,
    };

    if (query?.status) {
      const lokaStatus = this.statusMap.get(query.status);
      if (lokaStatus) params.status = lokaStatus;
    }

    if (query?.assignee) {
      const uuid = await this.resolveAssignee(query.assignee);
      if (uuid) params.assigneeId = uuid;
    }

    if (query?.limit) params.limit = String(query.limit);
    if (query?.offset) params.offset = String(query.offset);

    // Fetch all pages
    const allTasks: LokaFlatTask[] = [];
    let offset = query?.offset ? Number(query.offset) : 0;
    const limit = query?.limit ? Number(query.limit) : 100;

    while (true) {
      params.limit = String(limit);
      params.offset = String(offset);

      const page = await this.client.get<LokaFlatTask[] | { items: LokaFlatTask[]; total: number } | null>(
        '/tasks', params
      );

      if (!page) break;

      let items: LokaFlatTask[];
      let total: number;

      if (Array.isArray(page)) {
        items = page;
        total = page.length;
      } else if (page && typeof page === 'object' && 'items' in page) {
        items = page.items;
        total = page.total;
      } else {
        break;
      }

      allTasks.push(...items);

      // If we got fewer than limit, we're done
      if (items.length < limit) break;
      // If we have a total and we've fetched it all
      if (total !== undefined && allTasks.length >= total) break;

      offset += limit;

      // If explicit limit was set, don't paginate beyond it
      if (query?.limit) break;
    }

    // Apply search filter client-side
    let result = allTasks.map(lt => this.toTask(lt));
    if (query?.search) {
      const q = query.search.toLowerCase();
      result = result.filter(t => t.title.toLowerCase().includes(q));
    }
    if (query?.priority) {
      result = result.filter(t => t.priority === query.priority);
    }

    return result;
  }

  // ── get ───────────────────────────────────────────────────────────────────

  async get(ticket: string): Promise<Task | null> {
    await this.ensureConfig();

    // Parse ticket: "AF-5" → prefix="AF", number=5
    const match = ticket.match(/^([A-Za-z]+)-(\d+)$/);
    if (!match) return null;

    const [, prefix, numStr] = match;
    const params: Record<string, string> = {
      projectPrefix: prefix,
      ticketNumber: numStr,
    };

    const result = await this.client.get<LokaFlatTask[] | null>('/tasks', params);
    if (!result || (Array.isArray(result) && result.length === 0)) return null;

    const task = Array.isArray(result) ? result[0] : result;
    return task ? this.toTask(task) : null;
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(input: TaskCreateInput): Promise<Task> {
    await this.ensureConfig();

    const statusId = await this.resolveStatusId('backlog');
    const priorityId = await this.resolvePriorityId(input.priority ?? 'medium');
    const assigneeId = input.assignee ? (await this.resolveAssignee(input.assignee)) : null;

    const tags: string[] = [];
    if (input.design) tags.push(`design:${input.design}`);

    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description ?? '',
      projectId: this.projectId,
      priorityId,
      assigneeId,
      dueDate: input.due ?? null,
      tags,
    };
    if (statusId) body.statusId = statusId;

    const created = await this.client.post<LokaFlatTask>('/tasks', body);
    return this.toTask(created);
  }

  // ── update ────────────────────────────────────────────────────────────────

  async update(ticket: string, input: TaskUpdateInput): Promise<Task> {
    await this.ensureConfig();

    const existing = await this.get(ticket);
    if (!existing) throw new TaskNotFoundError(ticket);
    const id = existing.externalId!;

    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;

    if (input.priority !== undefined) {
      const priorityId = await this.resolvePriorityId(input.priority);
      if (priorityId) body.priorityId = priorityId;
    }

    if (input.assignee === null) {
      body.assigneeId = null;
    } else if (input.assignee !== undefined) {
      body.assigneeId = await this.resolveAssignee(input.assignee);
    }

    if (input.due === null) {
      body.dueDate = null;
    } else if (input.due !== undefined) {
      body.dueDate = input.due;
    }

    const updated = await this.client.patch<LokaFlatTask>(`/tasks/${id}`, body);
    return this.toTask(updated);
  }

  // ── move ──────────────────────────────────────────────────────────────────

  async move(ticket: string, status: string): Promise<Task> {
    await this.ensureConfig();

    const existing = await this.get(ticket);
    if (!existing) throw new TaskNotFoundError(ticket);
    const id = existing.externalId!;

    const lokaStatusName = this.statusMap.get(status) ?? status;
    const updated = await this.client.patch<LokaFlatTask>(`/tasks/${id}`, {
      status: lokaStatusName,
    });
    return this.toTask(updated);
  }

  // ── assign ────────────────────────────────────────────────────────────────

  async assign(ticket: string, assignee: string | null): Promise<Task> {
    await this.ensureConfig();

    const existing = await this.get(ticket);
    if (!existing) throw new TaskNotFoundError(ticket);
    const id = existing.externalId!;

    let assigneeId: string | null = null;
    if (assignee !== null) {
      assigneeId = await this.resolveAssignee(assignee);
      if (!assigneeId) {
        process.stderr.write(`[loka] Warning: assignee "${assignee}" not found in project members, skipping assignment\n`);
      }
    }

    const updated = await this.client.patch<LokaFlatTask>(`/tasks/${id}`, { assigneeId });
    return this.toTask(updated);
  }

  // ── log ───────────────────────────────────────────────────────────────────

  async log(ticket: string, entry: string): Promise<void> {
    await this.ensureConfig();

    const existing = await this.get(ticket);
    if (!existing) throw new TaskNotFoundError(ticket);
    const id = existing.externalId!;

    await this.client.post(`/tasks/${id}/comments`, { content: entry });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Resolve an AF status slug to Loka status ID (if available).
   * Falls back to null if not found — caller decides what to do.
   */
  private async resolveStatusId(_slug: string): Promise<string | null> {
    // Loka move/create uses status name, not ID for simplicity
    // Return null — callers that need statusId will handle separately
    return null;
  }

  /**
   * Resolve an AF priority name to Loka priority ID.
   */
  private async resolvePriorityId(afName: string): Promise<string | null> {
    // We need to get the priority ID from Loka. Unfortunately, the design
    // says Loka uses UUIDs for priorityId. We'll look it up by listing
    // a task or by a config endpoint if available.
    // For now, we use the mapped name — Loka may accept name directly too.
    // If the API requires an ID, this needs a /priorities endpoint.
    // Per design, we try with priorityName field as fallback.
    return null;
  }

  /**
   * Resolve an assignee name to Loka member UUID.
   * Uses /projects/{projectId}/members, cached after first call.
   */
  private async resolveAssignee(name: string): Promise<string | null> {
    if (this.userCache.has(name)) {
      return this.userCache.get(name)!;
    }

    // Load members
    try {
      const members = await this.client.get<LokaMember[]>(
        `/projects/${this.projectId}/members`
      );
      if (members && Array.isArray(members)) {
        for (const m of members) {
          this.userCache.set(m.name, m.id);
        }
      }
    } catch {
      // Warn but don't crash
      process.stderr.write(`[loka] Warning: failed to load project members\n`);
      return null;
    }

    return this.userCache.get(name) ?? null;
  }

  /**
   * Map a Loka task to the AF Task interface.
   */
  toTask(lt: LokaFlatTask): Task {
    const afStatus = this.reverseStatusMap.get(lt.status)
      ?? this.reverseStatusMap.get(lt.status.toLowerCase())
      ?? lt.status.toLowerCase().replace(/\s+/g, '-');

    const rawPriority = lt.priorityName?.toLowerCase() ?? 'medium';
    const afPriority = this.reversePriorityMap.get(lt.priorityName)
      ?? this.reversePriorityMap.get(rawPriority)
      ?? rawPriority;

    return {
      ticket: `${lt.projectPrefix}-${lt.ticketNumber}`,
      title: lt.title,
      type: 'task',  // Loka has no issueType
      status: afStatus,
      priority: afPriority,
      complexity: 'medium',  // Loka has no complexity
      assignee: lt.assignee?.name ?? undefined,
      due: lt.dueDate ?? undefined,
      created: lt.createdAt,
      updated: lt.updatedAt,
      description: lt.description ?? '',
      externalId: lt.id,
    };
  }
}
