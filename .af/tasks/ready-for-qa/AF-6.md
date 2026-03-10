---
ticket: AF-6
title: Create project.md template
type: feature
status: ready-for-qa
priority: high
complexity: low
created: '2026-03-10'
updated: '2026-03-10'
assignee: ''
design: docs/designs/AF-6-project-md-template.md
---

# Create project.md template

## Objective

Finalize and ship the enriched project.md template. Every AF-onboarded project gets a `project.md` in its `.af/` folder that describes goals, way of working (git, testing, deployment, finish protocol), tech stack, and references. Agents read this at spawn time.

## Context

Draft template at `docs/designs/project-md-template.md`. Sections are optional — projects include only what applies. This is what makes the generic engineer/architect roles work per-project.

## Acceptance
- [x] Template finalized (all optional sections documented)
- [x] AF's own `.af/project.md` updated to match template
- [x] At least one other project onboarded with the template (ORA or TBI)
- [x] Spawn-runner confirms it injects `## Project` into agent prompt

## Log
- [2026-03-10 14:45] engineer: started AF-6 implementation
- [2026-03-10 14:50] engineer: finalized docs/designs/project-md-template.md — added stack frontmatter, renamed sections (Finishing, Rules), removed duplicate examples, kept one minimal example with HTML comment guidance
- [2026-03-10 14:52] engineer: updated .af/project.md for agent-factory — added stack field, Goals, Way of Working (Git, Design Documents, Testing, Finishing, Rules), Decisions
- [2026-03-10 14:54] engineer: created /home/vanara/projects/oracle-bridge/.af/project.md — full ORA onboarding with rules from CLAUDE.md; committed and pushed to main
- [2026-03-10 14:55] engineer: updated src/commands/init.ts — af init now scaffolds full template with stack field, Way of Working stubs (Git, Testing, Finishing, Rules), HTML comment guidance; built and verified output
- [2026-03-10 14:56] engineer: verified spawn-runner — agent.ts lines 336-338 reads project.md, lines 357-358 injects under ## Project; no code change needed
- [2026-03-10 14:57] engineer: completed AF-6 — all acceptance criteria met
