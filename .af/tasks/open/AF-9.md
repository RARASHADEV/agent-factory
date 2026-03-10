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
