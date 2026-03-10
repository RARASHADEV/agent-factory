# project.md Template

Every AF-onboarded project gets a `project.md` in its `.af/` folder. Agents read this at spawn time — it tells them how the project works, how to finish tasks, and what rules apply.

All sections under `## Way of Working` are optional. Include only what applies to your project. Delete sections that don't apply.

---

## Frontmatter (required)

```yaml
---
id: <project-id>           # kebab-case, matches folder name
name: <Project Name>
prefix: <PREFIX>           # 2-4 uppercase letters (e.g. ORA, TBI, AF)
status: active
owner: brahma
created: '<YYYY-MM-DD>'
counter: 1                 # auto-incremented by af task new
stack: <tech, stack, here> # e.g. typescript, node, bun, sqlite, nextjs
---
```

---

## Body Sections

```markdown
# <Project Name>

<!-- One sentence describing what this project does -->

## Goals
<!-- Required. 1-3 sentences on what the project is trying to achieve. -->

## Way of Working

### Git
<!-- Required. -->
- Base branch: `main`
- Branch pattern: `<role>/<TICKET>`
<!-- Example: engineer/TBI-295 -->

### Design Documents
<!-- Optional. Include if tasks have design docs agents must read first. -->
- Location: `docs/designs/<TICKET>-<slug>.md`
- If a task has a `design:` field in frontmatter, read that file before implementing
- Do NOT start implementation without reading the design document (if one exists)

### Testing
<!-- Optional. Include your test command and policy. -->
- Command: `bun test <file>`
- Policy: run only test files related to changed code — not the full suite
- Full suite is CI's responsibility
- If no matching tests exist, proceed without tests

### Finishing
<!-- Required. How does a task get completed and handed off? -->
- Commit with ticket reference: `PREFIX-XX: description`
- Push branch and create PR: `gh pr create --base <base-branch>`
- Move task to next status
- Log completion in the task's `## Log` section

### Workflow
<!-- Optional. What status transitions happen after implementation? -->
After implementation → `ready-for-qa`
After QA pass → `done`
After QA fail → back to `in-progress`, fix, then → `ready-for-qa`

### PR Policy
<!-- Optional. Who merges? When? -->
- Create PR to base branch
- Do NOT merge — reviewer merges after approval
<!-- For self-merging projects:
- Merge after CI passes: `gh pr merge <PR> --merge`
-->

### Logging
<!-- Optional. Include if tasks have a ## Log section agents should update. -->
- Format: `- [YYYY-MM-DD HH:MM] role: action | notes`
- Append to `## Log` in the task file
- Log at minimum: started, key decisions, completed/blocked

### Feature Flags
<!-- Optional. Remove this section entirely if the project doesn't use feature flags. -->
- Add: `./scripts/feature-add.sh <TASK_ID>`
- Toggle: `./scripts/feature-toggle.sh <TASK_ID> off`
- Guard: wrap all new UI/routes/APIs with flag check
- Verify OFF before finishing: `grep ENABLE_<TASK_ID> src/config/flags.ts`

### Rules
<!-- Optional. Project-specific constraints agents must never violate. Examples:
- NEVER edit prod/bridge.ts — read-only production file
- NEVER run destructive SQL on oracle.db
- Use Bun runtime, not Node.js
- No frontend code — backend only
-->

## Decisions
<!-- Required (empty is fine). Agents append architectural decisions here. -->

## Notes
<!-- Optional. Anything else agents should know. -->
```

---

## Minimal Example

```yaml
---
id: my-project
name: My Project
prefix: MYP
status: active
owner: brahma
created: '2026-03-10'
counter: 1
stack: typescript, bun, sqlite
---
```

```markdown
# My Project

A CLI tool for doing X.

## Goals
- Do X efficiently
- Keep it simple and portable

## Way of Working

### Git
- Base branch: `main`
- Branch pattern: `engineer/<TICKET>`

### Testing
- Command: `bun test <file>`
- Policy: run only affected test files

### Finishing
- Commit: `MYP-XX: description`
- Push and PR: `gh pr create --base main`
- Move task to `ready-for-qa`

### Rules
- No external API dependencies — local-first

## Decisions

## Notes
```
