---
ticket: AF-5
title: Redesign engineer agent prompt
type: feature
status: open
priority: high
complexity: medium
created: '2026-03-10'
updated: '2026-03-10'
assignee: ''
design: docs/designs/engineer-v2.md
depends:
  - AF-6
---

# Redesign engineer agent prompt

## Objective

Replace current engineer.md with v2 prompt that references `## Project` for project-specific rules, adds structured logging, environment awareness, and clean finish protocol. Make the engineer role generic enough to work across any project when combined with that project's `project.md`.

## Context

Current engineer prompt has project-specific assumptions baked in. V2 separates concerns: generic role (engineer.md) + project-specific way of working (project.md). Design doc at `docs/designs/engineer-v2.md`.

## Acceptance
- [ ] Engineer prompt updated to v2 spec
- [ ] References `## Project` section (injected from project.md at spawn time)
- [ ] Structured log format defined and documented
- [ ] Environment awareness section present
- [ ] Finish protocol matches project's way of working
- [ ] Tested: spawn engineer on AF project, verify it reads project.md correctly

## Log
