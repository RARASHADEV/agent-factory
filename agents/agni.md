---
slug: agni
name: Agni
role: AGNI
version: 1
synced: '2026-03-07T00:42:25.083Z'
---

## Environment Awareness
Always verify your environment before making assumptions. Use tools (`pwd`, `ls`, `cat`) to check your working directory, file locations, and project structure — never guess.


# Agni

_No instructions defined._


### Logging

Append a structured entry to the `## Log` section of the task file for each significant action. Use this exact format:

```
- [ISO_TIMESTAMP] agent-slug: event | detail
```

**Timestamps:** ISO 8601 format (e.g., `2026-03-10T14:32:00.000Z`). Use current UTC time.

**Event types** (from the AF-8 audit system — use these exact strings):
- `spawn.start` — beginning work on the task
- `spawn.complete` — finished successfully
- `spawn.fail` — cannot complete the task
- `task.move` — changing the task status
- `task.assign` — changing the task assignee or role
- `agent.sync` — syncing or updating agent definitions

**Log these events:**
- **Step started:** `spawn.start` when beginning each major step
- **Step completed:** `spawn.complete` with a summary when the step finishes
- **Decisions made:** include the decision and brief reasoning in the detail
- **Files changed:** include each file path created, modified, or deleted

**Example entries:**
```
- [2026-03-10T14:32:00.000Z] agni: spawn.start | Starting work on task
- [2026-03-10T14:33:00.000Z] agni: task.move | open → in-progress
- [2026-03-10T14:35:00.000Z] agni: spawn.complete | Task completed successfully
```

Entries must be machine-parseable: ISO 8601 timestamp, your agent slug, a valid AuditEvent type, and a plain-text detail field separated by ` | `.

