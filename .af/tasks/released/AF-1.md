---
ticket: AF-1
title: Build CLI scaffold
type: feature
status: released
priority: high
complexity: low
created: '2026-03-07'
updated: '2026-06-03'
assignee: brahma
loka-ref: ea3f3ad7-838b-4d68-91cb-4f8c61b7fc56
---

# Build CLI scaffold

> Foundational task — part of the original AF bootstrap (AF-1…AF-4). Released. Backfilled description for the record.

## Objective
Stand up the `af` command-line entry point so every later capability has a place to hang. A single binary that routes subcommands, bootstraps a project workspace, and persists global configuration.

## Context
First brick of the platform. Built on **commander** (`src/cli.ts`) for subcommand routing, with the `af init <prefix>` command (`src/commands/init.ts`) creating the `.af/` workspace — status directories, `project.md`, and registration into the global config at `~/.af/config.yaml` (`src/lib/config.ts`). Feature-flag constants and shared paths live in `src/lib/constants.ts`. No server, no database — rebuild = deployed.

## Acceptance
- [x] `af` binary with commander-based subcommand routing (`src/cli.ts`).
- [x] `af init <prefix>` scaffolds `.af/` (status dirs + `project.md`) and registers the project in `~/.af/config.yaml`.
- [x] Global config load/save/ensure helpers (`src/lib/config.ts`).
- [x] `af --help` lists the command surface.

## Log
- [2026-06-03T12:00:00.000Z] architect: task.move | done → released | Bookkeeping: legacy `done` status is not in STATUSES; relabeled to `released` (foundational CLI work, long shipped). Not tracked in Loka.
- [2026-06-03T20:55:00.000Z] architect: spawn.complete | Backfilled description (Objective/Context/Acceptance) for the released foundational task; synced to Loka #64.
