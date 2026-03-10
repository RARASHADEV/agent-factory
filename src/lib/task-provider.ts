// src/lib/task-provider.ts
// TaskProvider interface + Task type + error types

export interface TaskQuery {
  status?: string;
  assignee?: string;
  priority?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface TaskCreateInput {
  title: string;
  type?: string;         // bug, feature, task, etc.
  priority?: string;     // critical, high, medium, low
  complexity?: string;   // low, medium, high
  assignee?: string;     // agent slug or user identifier
  depends?: string[];    // ticket references
  due?: string;          // YYYY-MM-DD
  description?: string;  // markdown body
  design?: string;       // path to design doc (relative to project root)
  ticket?: string;       // preserve existing ticket number (e.g. during sync)
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  assignee?: string | null;  // null to clear
  priority?: string;
  complexity?: string;
  due?: string | null;
  design?: string;
  lokaRef?: string;          // Set the loka-ref link to Loka UUID
}

export interface Task {
  ticket: string;         // "AF-5"
  title: string;
  type: string;
  status: string;         // normalized slug: "backlog", "in-progress", etc.
  priority: string;       // normalized: "critical", "high", "medium", "low"
  complexity: string;
  assignee?: string;
  depends?: string[];
  due?: string;
  created: string;        // ISO date
  updated: string;        // ISO date
  description: string;    // markdown body (without frontmatter)
  design?: string;        // path to design doc
  filePath?: string;      // only set by FileProvider
  externalId?: string;    // only set by LokaProvider (Loka UUID)
  lokaRef?: string;       // Loka UUID, stored as "loka-ref" in frontmatter
}

export interface TaskProvider {
  /** List tasks with optional filtering */
  list(query?: TaskQuery): Promise<Task[]>;

  /** Get a single task by ticket number (e.g., "AF-5") */
  get(ticket: string): Promise<Task | null>;

  /** Create a new task. Returns the created task with ticket assigned. */
  create(input: TaskCreateInput): Promise<Task>;

  /** Update task fields. Returns updated task. */
  update(ticket: string, input: TaskUpdateInput): Promise<Task>;

  /** Move task to a new status. Returns updated task. */
  move(ticket: string, status: string): Promise<Task>;

  /** Assign task to an agent/user. Pass null to unassign. */
  assign(ticket: string, assignee: string | null): Promise<Task>;

  /** Append a log entry to the task's ## Log section */
  log(ticket: string, entry: string): Promise<void>;
}

// ── Error types ──────────────────────────────────────────────────────────────

export class TaskNotFoundError extends Error {
  constructor(ticket: string) {
    super(`Task ${ticket} not found`);
    this.name = 'TaskNotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ProviderError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class LokaUnreachableError extends ProviderError {
  constructor(message = 'Loka API is unreachable') {
    super(message);
    this.name = 'LokaUnreachableError';
  }
}
