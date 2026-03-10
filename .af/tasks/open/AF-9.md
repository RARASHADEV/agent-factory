---
ticket: AF-9
title: Agent prompt updates — log instructions
type: feature
status: open
priority: high
complexity: low
created: '2026-03-10'
updated: '2026-03-10'
assignee: ''
loka-ref: LOK-24
depends:
  - AF-5
---

# Agent prompt updates — log instructions

## Objective

Update all agent role prompts (engineer, researcher, architect, qa, etc.) to include structured logging instructions so agents produce consistent, parseable output during their runs.

## Context

Agents currently produce freeform output. When reviewing results or debugging failures, there's no consistent format. Agents should log what they're doing in a structured way that AF can parse for audit trails (AF-8) and status reporting.

## Acceptance
- [ ] All agent prompts include a "Logging" section with format instructions
- [ ] Agents log: step started, step completed, decisions made, files changed
- [ ] Log format aligns with AF-8 audit log format
- [ ] Tested: spawn engineer and researcher, verify logs are parseable

## Log

- [2026-03-10T15:30:00.000Z] engineer: spawn.start | Starting implementation of AF-9: adding Logging sections to all agent prompts
- [2026-03-10T15:30:05.000Z] engineer: task.move | open → in-progress
- [2026-03-10T15:31:00.000Z] engineer: spawn.start | Read AF-8 design (docs/designs/AF-8.md) and audit.ts for AuditEvent types
- [2026-03-10T15:32:00.000Z] engineer: spawn.start | Modified: agents/engineer.md — added ### Logging section
- [2026-03-10T15:32:10.000Z] engineer: spawn.start | Modified: agents/architect.md — added ### Logging section
- [2026-03-10T15:32:20.000Z] engineer: spawn.start | Modified: agents/changemanager.md — added ### Logging section
- [2026-03-10T15:32:30.000Z] engineer: spawn.start | Modified: agents/content-writer.md — added ### Logging section
- [2026-03-10T15:32:40.000Z] engineer: spawn.start | Modified: agents/deploymanager.md — added ### Logging section
- [2026-03-10T15:32:50.000Z] engineer: spawn.start | Modified: agents/devops-engineer.md — added ### Logging section
- [2026-03-10T15:33:00.000Z] engineer: spawn.start | Modified: agents/documentalist.md — added ### Logging section
- [2026-03-10T15:33:10.000Z] engineer: spawn.start | Modified: agents/frontend-engineer.md — added ### Logging section
- [2026-03-10T15:33:20.000Z] engineer: spawn.start | Modified: agents/agni.md — added ### Logging section (stub agent)
- [2026-03-10T15:33:30.000Z] engineer: spawn.start | Modified: agents/garuda.md — added ### Logging section (stub agent)
- [2026-03-10T15:33:40.000Z] engineer: spawn.start | Modified: agents/oracle.md — added ### Logging section (stub agent)
- [2026-03-10T15:33:50.000Z] engineer: spawn.start | Modified: agents/ora-architect.md — added ### Logging section
- [2026-03-10T15:34:00.000Z] engineer: spawn.start | Modified: agents/ora-engineer.md — added ### Logging section
- [2026-03-10T15:34:10.000Z] engineer: spawn.start | Modified: agents/planner.md — added ### Logging section
- [2026-03-10T15:34:20.000Z] engineer: spawn.start | Modified: agents/product-analyst.md — added ### Logging section
- [2026-03-10T15:34:30.000Z] engineer: spawn.start | Modified: agents/qa.md — added ### Logging section
- [2026-03-10T15:34:40.000Z] engineer: spawn.start | Modified: agents/releasemanager.md — added ### Logging section
- [2026-03-10T15:34:50.000Z] engineer: spawn.start | Modified: agents/researcher.md — added ### Logging section
- [2026-03-10T15:35:00.000Z] engineer: spawn.start | Modified: agents/security-officer.md — added ### Logging section
- [2026-03-10T15:35:10.000Z] engineer: spawn.start | Modified: agents/team-leader.md — added ### Logging section
- [2026-03-10T15:35:20.000Z] engineer: spawn.start | Modified: agents/trusted-advisor.md — added ### Logging section
- [2026-03-10T15:35:30.000Z] engineer: spawn.start | Modified: agents/ux-designer.md — added ### Logging section
- [2026-03-10T15:35:40.000Z] engineer: spawn.start | Modified: agents/workflow-manager.md — added ### Logging section
- [2026-03-10T15:36:00.000Z] engineer: spawn.complete | All 23 agent files updated with ### Logging section, PR created
