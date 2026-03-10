# AF-6: Create project.md Template — Design

## Summary

Finalize the project.md template, update `af init` scaffolding, and onboard AF's own project.md as the reference implementation.

## What Exists Today

1. **Draft template** at `docs/designs/project-md-template.md` — comprehensive, 200 lines with ORA and TBI examples
2. **`af init`** (`src/commands/init.ts`) scaffolds a barebones project.md (Goals, Decisions, Notes — no Way of Working)
3. **Spawn runner** already injects project.md under `## Project` in the agent's system prompt (see `src/commands/agent.ts:187-192`)
4. **Two live projects** with real content: ora-v2 (rich), MKT (empty). AF's own project.md is the barebones scaffold

## Deliverables

### 1. Finalize the Template

Clean up `docs/designs/project-md-template.md`. Final template structure:

```
# Frontmatter (required)
id, name, prefix, status, owner, created, counter, stack

# Body sections
## Goals              ← required (1-3 sentences)
## Way of Working     ← required (at least one subsection)
  ### Git             ← required (base branch, branch pattern)
  ### Design Documents ← optional (location, read-before-build rule)
  ### Testing         ← optional (command, policy)
  ### Finishing       ← required (commit format, what happens next)
  ### Workflow        ← optional (status transitions)
  ### PR Policy       ← optional (merge rules)
  ### Logging         ← optional (format)
  ### Feature Flags   ← optional (only if project uses them)
  ### Rules           ← optional (project-specific constraints)
## Decisions          ← required (empty is fine, agents append here)
## Notes              ← optional
```

**Key changes from current draft:**
- Add `stack` to frontmatter (agents use it for tech decisions)
- Rename `### Project-Specific Rules` → `### Rules` (shorter)
- Rename `### Finishing a Task` → `### Finishing` (shorter)
- Remove the full ORA/TBI examples from the template file — keep ONE minimal inline example
- Add HTML comments as placeholder guidance in each section

### 2. Update `af init` Scaffolding

Currently `src/commands/init.ts` (line 49-52) writes:

```typescript
const projectContent = matter.stringify(
  `\n# ${projectName}\n\n## Goals\n\n## Decisions\n\n## Notes\n`,
  projectMeta
);
```

**After AF-6**, it writes the full template with:
- `stack` field in frontmatter (empty string, user fills in)
- `## Way of Working` section with subsection placeholders
- HTML comments guiding what to fill in
- User deletes sections that don't apply

The scaffold should be practical, not overwhelming — include Git, Testing, Finishing, and Rules as stubs. The others (Feature Flags, PR Policy, etc.) are mentioned in a comment but not scaffolded.

### 3. Onboard AF's Own project.md

Update `/home/vanara/projects/agent-factory/.af/project.md` to be the reference implementation:

```yaml
---
id: agent-factory
name: Agent Factory
prefix: AF
status: active
owner: brahma
created: '2026-03-07'
counter: 12
stack: typescript, node, claude-sdk
---
```

```markdown
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

### Testing
- Command: `npm test` (none currently — add as needed)
- Policy: run related tests only

### Finishing
- Commit: `AF-XX: description`
- Push branch, create PR: `gh pr create --base main`
- Move task to `ready-for-qa`

### Rules
- Agents are markdown files in `agents/` — frontmatter + prompt body
- Tasks are markdown files in `.af/tasks/<status>/` — frontmatter + description
- No database, no external API deps for core CLI

## Decisions
- [2026-03-07] File-based task tracking (not Loka) for portability
- [2026-03-10] project.md is the contract between AF and agents

## Notes
```

## Validation

The spawn runner at `src/commands/agent.ts` already reads project.md and injects it. No code change needed — just verify a spawned agent sees the content.

**Test:** `af agent spawn engineer --task AF-5 --dry-run` — verify `## Project` section contains the Way of Working content.

If `--dry-run` doesn't exist, verify by reading the spawn logic in `src/commands/agent.ts` and confirming the `projectContent` variable includes the new sections.

## Acceptance Criteria

| Criteria | How to verify |
|----------|--------------|
| Template finalized | `docs/designs/project-md-template.md` is clean, single template, no duplicate examples |
| AF's own project.md updated | `.af/project.md` matches the reference implementation above |
| `af init` scaffolds full template | Run `af init TEST --name "Test Project"` in a temp dir, verify output |
| Spawn-runner confirms injection | Read `src/commands/agent.ts` — verify projectContent is injected into prompt |

## Complexity

Low. No new runtime code beyond updating `init.ts` scaffolding and writing markdown. ~2 hours of work.

## Files to Touch

- `docs/designs/project-md-template.md` — rewrite (finalize)
- `src/commands/init.ts` — update scaffold content (lines 39-52)
- `.af/project.md` — rewrite (reference implementation)
