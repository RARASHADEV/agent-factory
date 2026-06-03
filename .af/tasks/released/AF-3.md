---
ticket: AF-3
title: Task CRUD commands
type: feature
status: released
priority: high
complexity: medium
created: '2026-03-07'
updated: '2026-06-03'
depends:
  - AF-1
  - AF-2
loka-ref: 4f3dd196-64a2-43ca-9245-b0f9b3b0cbd5
---

# Task CRUD commands

> Foundational task — part of the original AF bootstrap (AF-1…AF-4). Released. Backfilled description for the record.

## Objective
Give agents and humans a complete task lifecycle from the CLI: create, list, show, move between statuses, assign, and log — all over markdown task files as the source of truth.

## Context
The `af task` command group (`src/commands/task.ts`) over the `TaskProvider` interface (`src/lib/task-provider.ts`), with the file-backed implementation in `src/lib/providers/file-provider.ts`. Tasks are markdown files under `.af/tasks/<status>/` — frontmatter (ticket, title, type, status, priority, depends, …) plus a body (Objective/Context/Acceptance/Log). Moving a task relocates its file between status directories. This is the contract every later sync (AF-12 Loka) and the HTTP service (AF-53) build on.

## Acceptance
- [x] `af task create|list|show|move|assign|log` (`src/commands/task.ts`).
- [x] File-based `TaskProvider` with per-status directories (`src/lib/providers/file-provider.ts`).
- [x] Per-project ticket numbering via `project.md` counter.
- [x] `depends` and structured frontmatter supported.

## Log
- [2026-06-03T12:00:00.000Z] architect: task.move | done → released | Bookkeeping: legacy `done` status is not in STATUSES; relabeled to `released` (foundational CLI work, long shipped). Not tracked in Loka.
- [2026-06-03T20:55:00.000Z] architect: spawn.complete | Backfilled description (Objective/Context/Acceptance) for the released foundational task; synced to Loka #66.
