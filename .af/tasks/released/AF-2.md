---
ticket: AF-2
title: Core libraries
type: feature
status: released
priority: high
complexity: medium
created: '2026-03-07'
updated: '2026-06-03'
loka-ref: 1be3b38b-0194-4ee9-b669-686df503b310
---

# Core libraries

> Foundational task — part of the original AF bootstrap (AF-1…AF-4). Released. Backfilled description for the record.

## Objective
Provide the shared library layer the CLI commands sit on, so logic lives in one place and commands stay thin: config, workspace/project resolution, the markdown task-file format, status constants, and output formatting.

## Context
The `src/lib/` layer. Config loader (`config.ts`), workspace/project resolution (`workspace.ts`), the gray-matter frontmatter + markdown task format read/written by `providers/file-provider.ts`, canonical status list and feature-flag constants (`constants.ts`), and console formatting helpers (`format.ts`). These modules are the seam the later HTTP service (AF-53) reuses via the "one engine, thin adapters" principle.

## Acceptance
- [x] Config load/save/ensure + project registry (`src/lib/config.ts`).
- [x] Project + workspace resolution (`src/lib/workspace.ts`).
- [x] Markdown task format (frontmatter + body) via gray-matter (`src/lib/providers/file-provider.ts`).
- [x] Shared status constants and formatting helpers (`src/lib/constants.ts`, `src/lib/format.ts`).

## Log
- [2026-06-03T12:00:00.000Z] architect: task.move | done → released | Bookkeeping: legacy `done` status is not in STATUSES; relabeled to `released` (foundational CLI work, long shipped). Not tracked in Loka.
- [2026-06-03T20:55:00.000Z] architect: spawn.complete | Backfilled description (Objective/Context/Acceptance) for the released foundational task; synced to Loka #65.
