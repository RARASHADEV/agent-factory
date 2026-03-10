# AF-8: Audit Logging System

## Overview

Add a centralized audit logging system to AF CLI. Every spawn, task transition, and status check is logged to a JSONL file at `.af/audit.log` (per-project). Two new CLI commands (`af log` and `af log <ticket>`) allow viewing the audit trail. Existing commands hook into a shared `auditLog()` function from `src/lib/audit.ts`.

The design is intentionally simple: append-only JSONL file, no rotation, no external dependencies. This aligns with AF's file-based workspace philosophy.

---

## Architecture

### Components

```
src/lib/audit.ts          — Core audit logger (append JSONL, query)
src/commands/log.ts        — CLI commands: af log, af log <ticket>
src/cli.ts                 — Register new log commands
src/commands/agent.ts      — Hook: spawn, status check
src/commands/task.ts       — Hook: move, assign, create
src/commands/init.ts       — Hook: project init
```

### Data Flow

```
[Any CLI command]
    ↓
auditLog(afPath, entry)          ← append one JSON line to .af/audit.log
    ↓
.af/audit.log                    ← JSONL file, one event per line

[af log / af log <ticket>]
    ↓
readAuditLog(afPath, filters?)   ← read + parse + filter JSONL
    ↓
formatted terminal output
```

### Storage Location

- **Per-project:** `<project-root>/.af/audit.log`
- Format: JSONL (one JSON object per line, newline-delimited)
- Encoding: UTF-8
- Append-only; no rotation in v1 (file stays small for typical projects)

---

## API Design

### Core Module: `src/lib/audit.ts`

```typescript
// --- Types ---

interface AuditEntry {
  timestamp: string;        // ISO 8601 (e.g. "2026-03-10T14:32:00.000Z")
  event: AuditEvent;        // Event type enum
  ticket?: string;          // Task ticket (e.g. "AF-8"), optional for non-task events
  agent?: string;           // Agent slug, if applicable
  actor: string;            // "cli" | agent slug | "system"
  detail: string;           // Human-readable description
  meta?: Record<string, unknown>; // Optional structured data
}

type AuditEvent =
  | 'project.init'
  | 'task.create'
  | 'task.move'
  | 'task.assign'
  | 'spawn.start'
  | 'spawn.complete'
  | 'spawn.fail'
  | 'spawn.status_check'
  | 'agent.sync';

// --- Functions ---

/**
 * Append a single audit entry to .af/audit.log.
 * Creates file if it doesn't exist. Synchronous (appendFileSync).
 */
function auditLog(afPath: string, entry: Omit<AuditEntry, 'timestamp'>): void;

/**
 * Read and optionally filter audit entries.
 * Returns entries in chronological order.
 */
function readAuditLog(
  afPath: string,
  filters?: {
    ticket?: string;
    event?: AuditEvent;
    since?: string;       // ISO date, entries >= this timestamp
    limit?: number;       // Max entries to return (from tail)
  }
): AuditEntry[];
```

### CLI Commands: `src/commands/log.ts`

#### `af log` — Show recent audit log

```
af log [options]

Options:
  -n, --lines <count>       Number of recent entries (default: 50)
  -e, --event <type>        Filter by event type
  --since <date>            Show entries since date (YYYY-MM-DD)
  -p, --project <prefix>   Project prefix (defaults to cwd)
  --json                    Output raw JSONL (for piping)
```

**Output (formatted, default):**

```
2026-03-10 14:32  task.create    AF-8   cli        Created task: Audit logging system
2026-03-10 14:35  task.move      AF-8   cli        open → in-progress
2026-03-10 14:36  spawn.start    AF-8   architect  Spawned architect on AF-8 (bg, pid:12345)
2026-03-10 14:38  spawn.complete AF-8   architect  Completed in 120s (success)
```

#### `af log <ticket>` — Show audit log for a specific ticket

```
af log <ticket> [options]

Options:
  -n, --lines <count>       Number of recent entries (default: 50)
  --json                    Output raw JSONL
  -p, --project <prefix>   Project prefix
```

**Output:** Same format, filtered to the given ticket.

---

## Data Model

### JSONL Record Schema

Each line in `.af/audit.log` is a self-contained JSON object:

```json
{"timestamp":"2026-03-10T14:32:00.000Z","event":"task.create","ticket":"AF-8","actor":"cli","detail":"Created task: Audit logging system","meta":{"type":"task","priority":"medium"}}
{"timestamp":"2026-03-10T14:35:00.000Z","event":"task.move","ticket":"AF-8","actor":"cli","detail":"open → in-progress","meta":{"from":"open","to":"in-progress"}}
{"timestamp":"2026-03-10T14:36:00.000Z","event":"spawn.start","ticket":"AF-8","agent":"architect","actor":"cli","detail":"Spawned architect on AF-8 (background)","meta":{"mode":"background","pid":12345}}
{"timestamp":"2026-03-10T14:38:00.000Z","event":"spawn.complete","ticket":"AF-8","agent":"architect","actor":"architect","detail":"Completed in 120s","meta":{"success":true,"durationMs":120000}}
```

### No Database Changes

This feature is entirely file-based. No schema migrations or external storage needed.

### Workspace Change

The `.af/` directory gains one new file:

```
.af/
├── project.md
├── tasks/
├── context/
├── output/
└── audit.log          ← NEW (JSONL)
```

---

## Implementation Notes

### 1. Logger Implementation (`src/lib/audit.ts`)

- Use `fs.appendFileSync()` for atomic-ish line appends (safe for single-process CLI)
- Each call appends `JSON.stringify(entry) + '\n'`
- Auto-add `timestamp: new Date().toISOString()` in `auditLog()`
- Create file on first write (no need to create during `af init`, though it's fine to do so)
- Reading: `readFileSync` → split by `\n` → filter empty → `JSON.parse` each line
- Wrap parse in try/catch per line to handle corrupted lines gracefully (skip + warn)

### 2. Hooking Into Existing Commands

Each existing command gets a single `auditLog()` call added. The hooks are:

| Command | Event | Detail | Meta |
|---------|-------|--------|------|
| `af init` | `project.init` | "Initialized project {name} ({prefix})" | `{ prefix }` |
| `af task create` | `task.create` | "Created task: {title}" | `{ type, priority, assignee? }` |
| `af task move` | `task.move` | "{fromStatus} → {toStatus}" | `{ from, to }` |
| `af task assign` | `task.assign` | "Assigned to {assignee}" | `{ previousAssignee? }` |
| `af agent spawn` (fg) | `spawn.start` | "Spawned {slug} on {ticket} (foreground)" | `{ mode: 'foreground' }` |
| `af agent spawn` (bg) | `spawn.start` | "Spawned {slug} on {ticket} (background)" | `{ mode: 'background', pid }` |
| `af agent spawn` (complete) | `spawn.complete` | "Completed in {duration}s" | `{ success, durationMs }` |
| `af agent spawn` (fail) | `spawn.fail` | "Failed: {error}" | `{ error }` |
| `af agent status` | `spawn.status_check` | "Checked status of {ticket}" | `{ status }` |
| `af agent sync` | `agent.sync` | "Synced {count} agents" | `{ agents: string[] }` |

**Important:** Audit logging must never cause command failure. Wrap all `auditLog()` calls in try/catch — if logging fails, print a warning and continue.

### 3. Command Registration in `cli.ts`

```typescript
// Add to cli.ts:
const log = program
  .command('log [ticket]')
  .description('View audit log')
  .option('-n, --lines <count>', 'Number of entries', '50')
  .option('-e, --event <type>', 'Filter by event type')
  .option('--since <date>', 'Show entries since date')
  .option('-p, --project <prefix>', 'Project prefix')
  .option('--json', 'Output raw JSONL')
  .action(logCommand);
```

The `[ticket]` optional positional argument handles both `af log` and `af log AF-8` in a single command definition.

### 4. Formatted Output

Use existing `chalk` patterns from `lib/format.ts`. Suggested column layout:

```
DATE       TIME   EVENT              TICKET  AGENT      DETAIL
2026-03-10 14:32  task.create        AF-8    -          Created task: Audit logging system
2026-03-10 14:35  task.move          AF-8    -          open → in-progress
2026-03-10 14:36  spawn.start        AF-8    architect  Spawned architect (background)
```

- Event type: color-coded (spawn.fail = red, spawn.complete = green, task.move = cyan)
- Ticket: bold
- Truncate detail if terminal is narrow

### 5. Background Spawn Logging

The `spawn-runner.ts` subprocess runs detached and cannot easily call `auditLog()` in the parent's workspace context. Two options:

**Recommended approach:** The spawn-runner already writes `status.json`. The `spawn.complete` / `spawn.fail` events should be logged when the user next runs `af agent status` (which reads status.json). Add logic to `agentStatusCommand`: if status.json shows completed/failed AND no corresponding audit entry exists, append the completion event.

**Alternative:** Pass `afPath` to spawn-runner via config.json and have it append directly to audit.log. This is simpler but couples the subprocess to the workspace format.

**Decision:** Use the alternative (direct append from spawn-runner). It's simpler, the subprocess already knows the project path (it's in `cwd`), and JSONL append is safe even from a detached process.

### 6. `.gitignore` Consideration

`audit.log` should be added to `.af/.gitignore` or the project's `.gitignore`. Audit logs are local runtime artifacts, not version-controlled content. Add this to `af init` scaffolding.

### 7. Error Handling

- `auditLog()`: Never throws. Catches all errors internally, logs warning to stderr.
- `readAuditLog()`: Returns `[]` if file doesn't exist. Skips malformed lines with stderr warning.
- `af log` command: Shows "No audit entries found." if log is empty/missing.

---

## Dependencies

- **No new npm packages required** — uses only `fs`, `path`, and existing `chalk`
- **Internal dependency on `lib/workspace.ts`** — uses `findWorkspace()` / `resolveProject()` to locate `.af/` path
- **No dependency on LOK-26 (TaskProvider)** — this is a standalone module. When TaskProvider lands, audit hooks can move into the provider layer, but the core `auditLog()` function remains the same.
- **Related ticket:** LOK-26 mentions a `log()` method on TaskProvider. This audit system is complementary — TaskProvider.log() could delegate to `auditLog()` in future.

---

## Feature Flag

- **Flag Name:** ENABLE_AF_8
- **Guard:** `af log` command registration in cli.ts, audit log writes in command hooks
- **Default:** OFF

Note: Since this is a CLI tool (not a web app), the feature flag is implemented as a check in code rather than a UI toggle. The flag can be a constant in `lib/constants.ts` or read from config. When OFF, `auditLog()` is a no-op and `af log` prints "Audit logging is not enabled."

---

## Implementation Role

**ENGINEER** — This is backend/CLI work only. No frontend components.

---

## Complexity Estimate

**Medium** — New module + hooks into ~6 existing commands + 1 new CLI command + spawn-runner integration. Straightforward file I/O, no complex logic.

---

## Summary of Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/lib/audit.ts` | **CREATE** | Core audit logger module |
| `src/commands/log.ts` | **CREATE** | `af log` command handler |
| `src/cli.ts` | **MODIFY** | Register `af log` command |
| `src/commands/task.ts` | **MODIFY** | Add audit hooks to create/move/assign |
| `src/commands/agent.ts` | **MODIFY** | Add audit hooks to spawn/status/sync |
| `src/commands/init.ts` | **MODIFY** | Add audit hook + .gitignore entry for audit.log |
| `src/spawn-runner.ts` | **MODIFY** | Add audit log on completion/failure |
| `src/lib/constants.ts` | **MODIFY** | Add ENABLE_AF_8 flag constant |

---

## COO Constraints (Ora)

These constraints override or narrow the design above. Engineers must follow them.

1. **Skip `af log` command for v1.** Do NOT implement `src/commands/log.ts` or register it in `cli.ts`. The JSONL file is human-readable — `cat .af/audit.log | jq` covers the need. Ship the logging hooks only. The pretty command can be added later as a follow-up ticket if we actually miss it.

2. **Scope reduction:** The deliverables are:
   - `src/lib/audit.ts` — core logger (`auditLog()` + `readAuditLog()`)
   - Hooks in `agent.ts`, `task.ts`, `init.ts`, `spawn-runner.ts`
   - Feature flag `ENABLE_AF_8` in constants
   - `.gitignore` entry for `audit.log`
   - That's it. No CLI command, no `log.ts`, no `cli.ts` registration for log.

3. **Why:** The per-task output dirs (`.af/output/<TICKET>/`) already log spawns. The centralized audit log adds value as a single timeline — but the query UI can wait until the log proves useful.
