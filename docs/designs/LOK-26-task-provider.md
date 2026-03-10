# LOK-26 — TaskProvider Abstraction Layer

**Ticket:** LOK-26
**Author:** Ora
**Date:** 2026-03-10
**Status:** Draft
**Depends on:** —
**Depended on by:** LOK-27 (Bidirectional Loka sync)

---

## Problem

AF's task operations are scattered across two files with no abstraction:

- **`workspace.ts`** — reads: `listTasks()`, `findTask()`, `loadProject()`
- **`commands/task.ts`** — writes: `taskCreateCommand()`, `taskMoveCommand()`, `taskAssignCommand()`

Both hit the filesystem directly. Every function reads/writes `.af/tasks/<status>/TICKET.md` files using `gray-matter`. There's no interface, no separation between storage logic and CLI concerns (console.log, process.exit, chalk formatting are mixed into the write path).

This means:
1. **No swappable backend** — can't route to Loka API without rewriting every command
2. **No programmatic use** — commands exit the process on errors, return void
3. **Agents can't use it** — spawn-runner.ts reimplements task reads instead of importing a clean API
4. **LOK-27 can't build on this** — sync needs to call both file and API backends through the same interface

## Solution

Extract a `TaskProvider` interface that both backends implement:

```
                    ┌────────────┐
                    │ CLI / Agent │
                    └─────┬──────┘
                          │ calls
                    ┌─────▼──────┐
                    │TaskProvider │  (interface)
                    └─────┬──────┘
                 ┌────────┼────────┐
                 │                 │
          ┌──────▼──────┐  ┌──────▼──────┐
          │ FileProvider │  │ LokaProvider │
          │ (.af/ files) │  │ (REST API)  │
          └─────────────┘  └─────────────┘
```

CLI commands become thin shells: parse args → call provider → format output.

---

## Interface

```typescript
// src/lib/task-provider.ts

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
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  assignee?: string | null;  // null to clear
  priority?: string;
  complexity?: string;
  due?: string | null;
  design?: string;
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
```

### Design decisions

**1. `string` statuses, not enums**

AF uses 9 statuses (`backlog`, `open`, `in-progress`, ...). Loka uses configurable statuses with UUIDs. The interface uses normalized slug strings. Each provider maps to its own representation:

- `FileProvider`: slug → directory name (already 1:1)
- `LokaProvider`: slug → UUID lookup via Loka's config endpoint, cached

**2. `Task` is a flat data object, not a model**

No methods. No lazy loading. The provider returns plain objects. Commands own formatting. Agents own logic. Nobody imports gray-matter except FileProvider.

**3. `async` everything**

FileProvider could be sync but the interface is async — LokaProvider hits HTTP. Uniform calling convention, no branching on backend type.

**4. `filePath` and `externalId` are optional, provider-specific**

FileProvider sets `filePath` (agents need it to modify task files directly). LokaProvider sets `externalId` (sync needs it for bidirectional mapping). The interface doesn't mandate either.

**5. `log()` is a first-class operation**

LOK-23 needs audit logging. Both providers need it: FileProvider appends to `## Log` in the markdown file, LokaProvider posts a comment via API. Making it part of the interface means commands and agents call the same method.

**6. `design` field**

Convention: tasks can point to a design doc path. FileProvider stores it in frontmatter. LokaProvider could store it as a tag or custom field. The interface supports it natively since we decided this is how tasks reference designs.

---

## FileProvider

Extracts the current logic from `workspace.ts` + `commands/task.ts` into a class.

```typescript
// src/lib/providers/file-provider.ts

import { TaskProvider, Task, TaskQuery, TaskCreateInput, TaskUpdateInput } from '../task-provider.js';

export class FileProvider implements TaskProvider {
  constructor(private afPath: string, private projectMeta: ProjectMeta) {}

  async list(query?: TaskQuery): Promise<Task[]> {
    // Current listTasks() logic from workspace.ts
    // Read .af/tasks/<status>/*.md, parse frontmatter, filter, return Task[]
  }

  async get(ticket: string): Promise<Task | null> {
    // Current findTask() logic from workspace.ts
    // Scan all status dirs for TICKET.md, parse, return Task
  }

  async create(input: TaskCreateInput): Promise<Task> {
    // Current taskCreateCommand() logic minus console.log/process.exit
    // Read counter, write file to backlog/, increment counter, return Task
  }

  async update(ticket: string, input: TaskUpdateInput): Promise<Task> {
    // Read file, update frontmatter fields, write back
    // New — currently only assign does in-place updates
  }

  async move(ticket: string, status: string): Promise<Task> {
    // Current taskMoveCommand() logic minus CLI concerns
    // Validate status, check acceptance criteria, move file, return Task
  }

  async assign(ticket: string, assignee: string | null): Promise<Task> {
    // Current taskAssignCommand() logic minus CLI concerns
    // Update frontmatter assignee field, return Task
  }

  async log(ticket: string, entry: string): Promise<void> {
    // Find task file, append timestamped line to ## Log section
    // Format: `- [ISO_TIMESTAMP] entry`
  }
}
```

**What changes from current code:**
- Logic moves from `commands/task.ts` → `providers/file-provider.ts`
- All console.log, chalk, process.exit removed — provider returns data or throws
- All functions return `Task` objects instead of void
- Validation errors become thrown Error objects (with descriptive messages)
- `commands/task.ts` becomes a thin shell: parse args → call provider → format + print

**What stays the same:**
- File format (YAML frontmatter + markdown body)
- Directory structure (`.af/tasks/<status>/TICKET.md`)
- gray-matter parsing
- Counter increment logic in project.md

---

## LokaProvider

New provider that talks to Loka's REST API.

```typescript
// src/lib/providers/loka-provider.ts

import { TaskProvider, Task, TaskQuery, TaskCreateInput, TaskUpdateInput } from '../task-provider.js';

export class LokaProvider implements TaskProvider {
  private statusMap: Map<string, string>;   // slug → UUID
  private priorityMap: Map<string, string>; // name → UUID
  private configLoaded = false;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private projectPrefix: string,
  ) {}

  /** Lazy-load status and priority mappings from Loka config */
  private async ensureConfig(): Promise<void> {
    if (this.configLoaded) return;
    // GET /api/v1/config/statuses → build slug→UUID map
    // GET /api/v1/config/priorities → build name→UUID map
    this.configLoaded = true;
  }

  async list(query?: TaskQuery): Promise<Task[]> {
    await this.ensureConfig();
    // GET /api/v1/tasks?projectPrefix=XX&...
    // Map FlatTask[] → Task[]
  }

  async get(ticket: string): Promise<Task | null> {
    await this.ensureConfig();
    // Parse ticket "AF-5" → prefix "AF", number 5
    // GET /api/v1/tasks?projectPrefix=AF&ticketNumber=5 (or search)
    // Map FlatTask → Task
  }

  async create(input: TaskCreateInput): Promise<Task> {
    await this.ensureConfig();
    // POST /api/v1/tasks with mapped fields
    // Map response → Task
  }

  async update(ticket: string, input: TaskUpdateInput): Promise<Task> {
    await this.ensureConfig();
    // Resolve ticket → Loka UUID
    // PATCH /api/v1/tasks/:id
  }

  async move(ticket: string, status: string): Promise<Task> {
    await this.ensureConfig();
    // Resolve status slug → UUID
    // PATCH /api/v1/tasks/:id { statusId }
  }

  async assign(ticket: string, assignee: string | null): Promise<Task> {
    await this.ensureConfig();
    // Resolve assignee name → Loka user UUID
    // PATCH /api/v1/tasks/:id { assigneeId }
  }

  async log(ticket: string, entry: string): Promise<void> {
    // POST /api/v1/tasks/:id/comments { content: entry, model: "AF" }
    // Maps to Loka's comment system
  }
}
```

### Field mapping

| AF (Task) | Loka (FlatTask) | Direction | Notes |
|-----------|-----------------|-----------|-------|
| `ticket` | `projectPrefix + "-" + ticketNumber` | both | Computed |
| `title` | `title` | both | Direct |
| `type` | `issueType` | both | Name lookup |
| `status` | `status` (via `statusId`) | both | Slug ↔ UUID mapping |
| `priority` | `priorityName` (via `priorityId`) | both | Name ↔ UUID mapping |
| `complexity` | — | AF only | No Loka equivalent, stored in tags or ignored |
| `assignee` | `assignee.name` (via `assigneeId`) | both | Name ↔ UUID mapping |
| `depends` | — | AF only | No Loka equivalent, stored in description or tags |
| `due` | `dueDate` | both | Date format normalization |
| `created` | `createdAt` | both | ISO date |
| `updated` | `updatedAt` | both | ISO date |
| `description` | `description` | both | Markdown body |
| `design` | tag or description link | AF → Loka | Convention: `[design:/path/to/doc.md]` in description |
| `filePath` | — | AF only | Not sent to Loka |
| `externalId` | `id` | Loka only | Loka UUID |

### Status mapping

AF and Loka don't share status names. A mapping config is needed:

```typescript
// Default mapping — overridable in .af/config.yaml
const STATUS_MAP: Record<string, string> = {
  // AF slug → Loka status name
  'backlog':           'Backlog',
  'open':              'Open',
  'in-progress':       'In Progress',
  'ready-for-qa':      'Ready for QA',
  'uat':               'UAT',
  'ready-4-release':   'Ready for Release',
  'released':          'Released',
  'closed':            'Closed',
  'blocked':           'Blocked',
};
```

This lives in config, not code. If a Loka instance has different status names, the user edits the mapping.

---

## Provider Factory

```typescript
// src/lib/provider-factory.ts

import { TaskProvider } from './task-provider.js';
import { FileProvider } from './providers/file-provider.js';
import { LokaProvider } from './providers/loka-provider.js';
import { loadConfig } from './config.js';

export type ProviderType = 'file' | 'loka';

export function createProvider(
  afPath: string,
  projectMeta: ProjectMeta,
  type?: ProviderType,
): TaskProvider {
  const config = loadConfig();

  // Explicit override, or infer from config
  const backend = type ?? config.defaults?.taskBackend ?? 'file';

  if (backend === 'loka') {
    const loka = config.loka;
    if (!loka?.url || !loka?.apiKey) {
      throw new Error('Loka backend requires loka.url and loka.apiKey in ~/.af/config.yaml');
    }
    return new LokaProvider(loka.url, loka.apiKey, projectMeta.prefix);
  }

  return new FileProvider(afPath, projectMeta);
}
```

Config extension in `~/.af/config.yaml`:

```yaml
defaults:
  model: sonnet
  max_turns: 50
  taskBackend: file          # "file" or "loka" — default "file"

loka:
  url: http://192.168.86.200:3333/api/v1
  apiKey: ora_d9228e36ef594d4490c8489d75f24cbe
  statusMap:                 # optional overrides
    backlog: Backlog
    in-progress: In Progress
```

---

## Refactored command layer

`commands/task.ts` becomes a thin formatting shell:

```typescript
// BEFORE (current):
export function taskCreateCommand(title: string, options: TaskCreateOptions): void {
  const { afPath, meta } = resolveOrExit(options.project);
  // ... 40 lines of file manipulation, counter logic, validation ...
  console.log(success(`Created ${ticket}: ${title}`));
}

// AFTER:
export async function taskCreateCommand(title: string, options: TaskCreateOptions): Promise<void> {
  const { afPath, meta } = resolveOrExit(options.project);
  const provider = createProvider(afPath, meta);

  try {
    const task = await provider.create({
      title,
      type: options.type,
      priority: options.priority,
      complexity: options.complexity,
      assignee: options.assignee,
      depends: options.depends?.split(',').map(s => s.trim()),
      due: options.due,
    });
    console.log(success(`Created ${task.ticket}: ${task.title}`));
    console.log(dim(`  Type: ${task.type}  Priority: ${task.priority}  Complexity: ${task.complexity}`));
  } catch (err: any) {
    console.log(error(err.message));
    process.exit(1);
  }
}
```

Same pattern for list, show, move, assign. Each shrinks from 20-40 lines to 5-15 lines.

---

## Impact on agent spawning

`commands/agent.ts` currently calls `findTask()` from workspace.ts directly. After refactor:

```typescript
// In agentSpawnCommand():
const provider = createProvider(afPath, projectMeta);
const task = await provider.get(options.task!.toUpperCase());
if (!task) { /* error */ }

// After agent completes:
await provider.log(task.ticket, `${slug}: completed | Agent session finished.`);
```

Agents that modify task files directly (checking acceptance criteria) still need `task.filePath` — which FileProvider provides. When running against LokaProvider, agents would need a different mechanism (PATCH the task description). This is a LOK-27 concern, not LOK-26.

---

## Error handling

Providers throw typed errors, commands catch and format:

```typescript
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
```

---

## File structure after refactor

```
src/lib/
├── task-provider.ts           # Interface + Task type + error types
├── provider-factory.ts        # createProvider()
├── providers/
│   ├── file-provider.ts       # FileProvider (extracted from workspace.ts + task.ts)
│   └── loka-provider.ts       # LokaProvider (new, LOK-27 builds on this)
├── workspace.ts               # SLIMMED: only findWorkspace(), loadProject(), listProjects(), resolveProject()
├── config.ts                  # Extended with loka config section
├── constants.ts               # Unchanged
└── format.ts                  # Unchanged

src/commands/
├── task.ts                    # SLIMMED: thin formatting shell over provider
├── agent.ts                   # Updated: uses provider.get() + provider.log()
├── init.ts                    # Unchanged
├── status.ts                  # Updated: uses provider.list()
└── projects.ts                # Unchanged
```

---

## Build order

1. **Create `task-provider.ts`** — interface, Task type, error types
2. **Create `providers/file-provider.ts`** — extract from workspace.ts + task.ts
3. **Refactor `commands/task.ts`** — thin shell calling FileProvider
4. **Refactor `commands/agent.ts`** — use provider.get() and provider.log()
5. **Refactor `commands/status.ts`** — use provider.list()
6. **Create `provider-factory.ts`** — factory with config-driven backend selection
7. **Slim `workspace.ts`** — remove task functions (now in FileProvider)
8. **Create stub `providers/loka-provider.ts`** — interface + TODO, actual HTTP calls are LOK-27 scope
9. **Extend `config.ts`** — add loka section to config types
10. **Test** — `af task list`, `af task create`, `af task move`, `af task assign`, `af agent spawn`

Steps 1-7 are LOK-26 scope (pure refactor, no new features, no behavior change).
Steps 8-9 are scaffolding for LOK-27.
Step 10 validates nothing broke.

---

## Out of scope

- **Bidirectional sync logic** → LOK-27
- **Conflict resolution** → LOK-27
- **WebSocket event consumption** → LOK-27
- **Loka API implementation** (only stub) → LOK-27
- **Agent file modification pattern** (checking AC via filePath) → LOK-27

---

## Open questions

1. **Should LokaProvider be a stub or fully implemented in LOK-26?**
   Recommendation: stub only. LOK-27 fills it in. LOK-26 is a clean refactor, not a feature.

2. **Cross-project provider?**
   Currently `resolveProject()` returns one project at a time. LOK-25 (`af status --all`) needs to iterate projects. The factory creates one provider per project — LOK-25 would loop over projects and create a provider for each. No interface change needed.

3. **Should `log()` use a structured format?**
   Current AF convention is `- [timestamp] agent: action | notes`. Could be a typed object instead. Recommendation: keep it as a string for now — the format is for human readability in markdown files. LokaProvider maps the string to a comment body.
