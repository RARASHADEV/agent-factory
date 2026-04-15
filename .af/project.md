---
id: agent-factory
name: Agent Factory
prefix: AF
status: active
owner: brahma
created: '2026-03-07'
counter: 36
stack: 'typescript, node, claude-sdk'
---

# Agent Factory

CLI tool for spawning and managing AI agents across projects.

## Goals
- Generic agent dispatch: any project, any role, one CLI
- Project-specific behavior via project.md, not hardcoded prompts
- Task tracking with markdown files, not external services

## Way of Working

### Git
- Base branch: `main`
- Branch pattern: `engineer/<TICKET>`

### Design Documents
- Location: `docs/designs/<TICKET>-<slug>.md`
- If a task has a `design:` field in frontmatter, read that file before implementing
- Do NOT start implementation without reading the design document (if one exists)

### Testing
- Command: `npm test` (none currently — add as needed)
- Policy: run only test files related to changed code

### Finishing
- Commit: `AF-XX: description`
- Push branch and create PR: `gh pr create --base main`
- Move task to `ready-for-qa`
- Log completion in the task's `## Log` section

### Rules
- Agents are markdown files in `agents/` — frontmatter + prompt body
- Tasks are markdown files in `.af/tasks/<status>/` — frontmatter + description
- No database, no external API deps for core CLI
- Do not modify the web/ subdirectory — it has its own git repo

## Decisions
- [2026-03-07] File-based task tracking (not Loka) for portability
- [2026-03-10] project.md is the contract between AF and agents

## Notes
