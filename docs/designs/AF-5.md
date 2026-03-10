# AF-5: Redesign Engineer Agent Prompt (V2) — Design

## Overview

Replace the current `agents/engineer.md` (v15) with a generic v2 prompt (v16) that derives all project-specific behavior from the injected `## Project` section rather than hardcoding it. The v2 prompt already exists as a draft at `docs/designs/engineer-v2.md` and is ready to become the live agent file.

**Core principle:** The engineer role is project-agnostic. Project-specific rules (git flow, testing policy, finishing steps, feature flags, PR policy) live in `project.md` and are injected at spawn time under `## Project`.

## Architecture

### Prompt Composition (already implemented)

The spawn runner at `src/commands/agent.ts` (lines 352–363) composes the system prompt as:

```
[agent.content]          ← engineer.md body (generic role instructions)
---
## Project               ← project.md content (project-specific rules)
[projectContent]
## Task                  ← task file content (ticket details)
[taskContent]
## Context               ← optional context files
[contextContent]
```

The v2 engineer prompt is designed to reference `## Project` by name. When the agent reads its own system prompt, it finds the project's Way of Working under that heading.

### How V2 References `## Project`

The v2 prompt references the injected `## Project` section in **five places**:

1. **`# Instructions`** — "read the project's Way of Working (in the `## Project` section below)"
2. **`# Before Start` step 1** — "Read `## Project` below — understand this project's git flow, branch pattern, and base branch"
3. **`# Before Start` step 2** — Git commands use `<base-branch>` and `<branch-pattern>` placeholders that the agent resolves by reading `## Project`
4. **`# Task Instructions`** — "Follow any project-specific rules from `## Project`"
5. **`# Constraints`** — "Follow all project-specific rules listed in `## Project`"

The `# When Finished` section uses generic phrasing ("per the project's testing policy", "per the project's PR policy", "per the project's workflow") — the agent reads the specific values from `## Project` at runtime.

### What Changes

| File | Action | Details |
|------|--------|---------|
| `agents/engineer.md` | **Replace content** | Overwrite v15 body with v2 body from `docs/designs/engineer-v2.md` |
| `agents/engineer.md` | **Update frontmatter** | version: 15 → 16, remove `synced` field (local edit, not synced) |
| No other files | — | No runtime code changes needed |

## API Design

No API changes. The spawn runner already handles injection correctly.

## Data Model

No data model changes. The only file modified is `agents/engineer.md` (markdown, not a data store).

### Frontmatter Changes

```yaml
# Before (v15)
---
slug: engineer
name: Engineer
role: ENGINEER
version: 15
maxTurns: 150
disallowedTools:
  - AskUserQuestion
synced: '2026-03-07T00:42:25.265Z'
---

# After (v16)
---
slug: engineer
name: Engineer
role: ENGINEER
version: 16
maxTurns: 150
disallowedTools:
  - AskUserQuestion
---
```

## Implementation Notes

### 1. The v2 prompt is already written

The full v2 content lives at `docs/designs/engineer-v2.md`. The implementation is essentially:
- Copy the content of `docs/designs/engineer-v2.md` into `agents/engineer.md`, replacing everything.

### 2. Key differences from v15

| Aspect | v15 (current) | v16 (target) |
|--------|---------------|--------------|
| Git flow | Hardcoded: `develop` branch, `engineer/<TICKET>` pattern | Generic: reads from `## Project` → Way of Working → Git |
| Testing | Hardcoded: TBI-specific policy, "run only affected tests" | Generic: "per project's testing policy" |
| Finishing | Hardcoded: `./scripts/task-finish.sh`, merge PR, deploy pipeline | Generic: commit, push, create PR, move task — all per project's policy |
| Feature flags | Hardcoded: TBI-295 protocol with `feature-add.sh` | Removed — lives in project.md if the project uses feature flags |
| Role scope | Backend-only ("do not modify frontend code") | Generic ("implement functionality per design") |
| Logging | Not structured | "Log your work in the task file" + "append completion entry to ## Log" |

### 3. What the engineer reads at runtime

When spawned on a project (e.g., Agent Factory), the composed prompt will contain:

```
[v2 engineer instructions — generic]
---
## Project
---
id: agent-factory
name: Agent Factory
...
stack: typescript, node, claude-sdk
---

# Agent Factory
...
## Way of Working
### Git
- Base branch: `main`
- Branch pattern: `engineer/<TICKET>`
### Testing
- Command: `npm test`
- Policy: run only test files related to changed code
### Finishing
- Commit: `AF-XX: description`
- Push branch and create PR: `gh pr create --base main`
- Move task to `ready-for-qa`
...

## Task
[task file content]
```

The engineer reads `## Project` to find `main` as the base branch, `engineer/<TICKET>` as the branch pattern, etc. — no hardcoding needed.

### 4. Design doc reference in task

The task's `design:` field points to `docs/designs/engineer-v2.md`. The v2 prompt's "Before Start" step 4 instructs the engineer to read this file. For AF-5, the design doc IS the deliverable — so the engineer reads it, then copies it into `agents/engineer.md`.

### 5. Validation

After replacing the file:

1. **Content check:** `agents/engineer.md` body matches `docs/designs/engineer-v2.md` body exactly
2. **Version check:** frontmatter shows `version: 16`
3. **No hardcoded project refs:** grep for `develop`, `task-finish.sh`, `TBI`, `feature-add.sh` — should return zero matches
4. **Dry-run spawn:** `af agent spawn engineer --task AF-5 --dry-run` — verify composed prompt shows `## Project` with AF's Way of Working content
5. **References check:** Verify the string `## Project` appears in the prompt body (confirming the agent knows where to look)

## Dependencies

- **AF-6 (complete):** project.md template is finalized and AF's own project.md is populated with Way of Working sections. This is a prerequisite — without it, `## Project` would be injected with an empty/barebones project.md.
- **No runtime code changes:** The spawn runner already injects project.md correctly.
- **No external dependencies.**

## Implementation Role

**ENGINEER** — This is a single-file content replacement. No frontend work.

## Complexity

**Low.** Replace one markdown file's content with already-written content. Verify with dry-run. ~30 minutes of work.

## Risks

- **None significant.** The v2 prompt is already drafted and reviewed. The spawn runner injection is already implemented and tested (AF-6 validated this).
- **Minor risk:** Other projects with incomplete project.md files will get a less-useful `## Project` section. This is by design — projects must fill in their project.md (AF-6's purpose).
