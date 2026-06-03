---
ticket: AF-4
title: Agent management commands
type: feature
status: released
priority: medium
complexity: medium
created: '2026-03-07'
updated: '2026-06-03'
depends:
  - AF-3
loka-ref: 3918cf26-8d82-48cc-8632-7fcf14ae6e06
---

# Agent management commands

> Foundational task — part of the original AF bootstrap (AF-1…AF-4). Released. Backfilled description for the record.

## Objective
Manage the agents that do the work: maintain a local registry of agent definitions, sync them from the agent-platform, inspect them, and spawn one against a task or a direct prompt.

## Context
The `af agent` command group (`src/commands/agent.ts`): `list` / `show` read the local registry (markdown agent files in `agents/` — frontmatter + prompt body), `sync` pulls definitions from the agent-platform API (`agents.upstream` in `~/.af/config.yaml`), and `spawn` runs an agent via the Claude Agent SDK wrapper (`src/lib/sdk.ts`) in either workspace mode (`--task`) or prompt mode (`--prompt`), with `--background` and `--dry-run`. This dispatch path is the engine later wrapped by orchestration (AF-42/45/46/48) and exposed over HTTP (AF-53).

## Acceptance
- [x] `af agent list|show|sync|spawn|status` (`src/commands/agent.ts`).
- [x] Agent definitions as markdown (frontmatter + prompt) in `agents/`.
- [x] `agent sync` pulls from the agent-platform upstream API.
- [x] `agent spawn` supports workspace (`--task`) and prompt (`--prompt`) modes via the SDK wrapper.

## Log
- [2026-06-03T12:00:00.000Z] architect: task.move | done → released | Bookkeeping: legacy `done` status is not in STATUSES; relabeled to `released` (foundational CLI work, long shipped). Not tracked in Loka.
- [2026-06-03T20:55:00.000Z] architect: spawn.complete | Backfilled description (Objective/Context/Acceptance) for the released foundational task; synced to Loka #67.
