---
ticket: AF-8
title: Audit logging in AF CLI
type: feature
status: open
priority: high
complexity: medium
created: '2026-03-10'
updated: '2026-03-10'
assignee: ''
loka-ref: LOK-23
depends: []
---

# Audit logging in AF CLI

## Objective

Add structured audit logging to the AF CLI so every agent spawn, status check, and task transition is recorded with timestamp, actor, and outcome.

## Context

Currently AF operations leave no trace. When debugging agent runs or tracking who moved a task, there's no log to check. This is critical for delegation workflows where Ora dispatches work and needs to verify what happened.

## Acceptance
- [ ] Every `af agent spawn` writes an audit log entry (agent, prompt summary, output dir, timestamp)
- [ ] Every task status change writes an audit log entry (ticket, from → to, actor, timestamp)
- [ ] Log stored in `.af/audit.log` or `.af/audit/` (structured, parseable)
- [ ] `af log` command to view recent audit entries
- [ ] `af log <ticket>` to filter by ticket
- [ ] Log format is machine-readable (JSON lines or similar)

## Log
