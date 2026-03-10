// src/lib/providers/loka-provider.ts
// LokaProvider stub — scaffolding for LOK-27.
// HTTP implementation is out of scope for LOK-26.

import {
  TaskProvider,
  Task,
  TaskQuery,
  TaskCreateInput,
  TaskUpdateInput,
  ProviderError,
} from '../task-provider.js';

export class LokaProvider implements TaskProvider {
  // TODO(LOK-27): Lazy-load status and priority mappings from Loka config
  private statusMap: Map<string, string> = new Map();   // AF slug → Loka UUID
  private priorityMap: Map<string, string> = new Map(); // AF name → Loka UUID
  private configLoaded = false;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private projectPrefix: string,
  ) {}

  /** TODO(LOK-27): Lazy-load status and priority mappings from Loka config endpoint */
  private async ensureConfig(): Promise<void> {
    if (this.configLoaded) return;
    // GET /api/v1/config/statuses → build slug→UUID map
    // GET /api/v1/config/priorities → build name→UUID map
    this.configLoaded = true;
  }

  async list(_query?: TaskQuery): Promise<Task[]> {
    // TODO(LOK-27): GET /api/v1/tasks?projectPrefix=XX&...
    throw new ProviderError('LokaProvider not yet implemented (LOK-27)');
  }

  async get(_ticket: string): Promise<Task | null> {
    // TODO(LOK-27): GET /api/v1/tasks?projectPrefix=AF&ticketNumber=N
    throw new ProviderError('LokaProvider not yet implemented (LOK-27)');
  }

  async create(_input: TaskCreateInput): Promise<Task> {
    // TODO(LOK-27): POST /api/v1/tasks
    throw new ProviderError('LokaProvider not yet implemented (LOK-27)');
  }

  async update(_ticket: string, _input: TaskUpdateInput): Promise<Task> {
    // TODO(LOK-27): PATCH /api/v1/tasks/:id
    throw new ProviderError('LokaProvider not yet implemented (LOK-27)');
  }

  async move(_ticket: string, _status: string): Promise<Task> {
    // TODO(LOK-27): Resolve status slug → UUID, PATCH /api/v1/tasks/:id { statusId }
    throw new ProviderError('LokaProvider not yet implemented (LOK-27)');
  }

  async assign(_ticket: string, _assignee: string | null): Promise<Task> {
    // TODO(LOK-27): Resolve assignee name → Loka user UUID, PATCH /api/v1/tasks/:id
    throw new ProviderError('LokaProvider not yet implemented (LOK-27)');
  }

  async log(_ticket: string, _entry: string): Promise<void> {
    // TODO(LOK-27): POST /api/v1/tasks/:id/comments { content: entry, model: "AF" }
    throw new ProviderError('LokaProvider not yet implemented (LOK-27)');
  }
}
