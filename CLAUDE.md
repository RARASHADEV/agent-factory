# Agent Factory

CLI tool for spawning and managing AI agents across projects.

## Stack

TypeScript, Node.js, Claude Agent SDK

## Commands

- `npm run build` — compile TypeScript (`src/` → `dist/`)
- `npm run dev` — watch mode
- `npx tsc --noEmit` — type check without emitting
- `npx tsx --test src/__tests__/*.test.ts` — run tests

## Deploy (local CLI)

After merging to master:

- [ ] `git checkout master && git pull origin master`
- [ ] `npm run build`
- [ ] Verify: `node dist/cli.js --help`

No server, no CI. Rebuild = deployed.

## Conventions

- Agents: markdown files in `agents/` (frontmatter + prompt)
- Tasks: markdown files in `.af/tasks/<status>/`
- Feature flags: `ENABLE_AF_XX` in `src/lib/constants.ts`
- Commits: `AF-XX: description`
- Branches: `engineer/AF-XX`
- PRs: `gh pr create --base master`
