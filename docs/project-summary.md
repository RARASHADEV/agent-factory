# Agent Factory — Project Summary

## Vision

An LLM-native agentic framework where markdown files are the source of truth. Agents are defined as `.md` prompts, tasks are `.md` files with YAML frontmatter, and the filesystem replaces databases as the primary interface for LLM agents. A human-facing GUI provides overview and control, while a CLI engine does the actual work. Model-agnostic by design.

## Plan

### Phase 1: Define File Formats
Hand-write example `.md` files for agents, tasks, and conversations. Validate the formats by living with them before writing code.

### Phase 2: Build the CLI Engine (TypeScript/Node.js)
- `loka status` — scan `.tasks/` directories, parse frontmatter, print summary
- `loka run <agent> --task <file>` — compose prompt from agent `.md` + task `.md` + context, call LLM
- `loka task new|edit|list` — create/modify task `.md` files
- Execution delegated to Claude Code CLI or direct LLM SDK calls

### Phase 3: Use CLI for 1-2 Weeks
Discover pain points. Identify what needs a GUI (likely: overview, orchestration, multi-project status).

### Phase 4: Build GUI
Web UI on top of the CLI engine. Four screens: Command Center, Task View, Orchestration (DAG), Agent Chat.

### Phase 5: Sync Layer
Bidirectional sync between `.md` files and Loka Task Manager (Prisma/SQLite) so both systems reflect the same state.

## Architecture

```
┌─────────────────────────────────┐
│  Web GUI (for human)            │  Kanban, chat, orchestration views
├─────────────────────────────────┤
│  CLI Engine (TypeScript/Node)   │  loka run, loka status, loka task
├─────────────────────────────────┤
│  .md files (source of truth)    │  Agents, tasks, conversations, context
├─────────────────────────────────┤
│  Execution layer                │  Claude Code CLI / Anthropic SDK / Ollama
└─────────────────────────────────┘
```

### Storage Structure
```
project/
├── .agents/              # Agent definitions (system prompts as .md)
├── .tasks/               # Task files (.md with YAML frontmatter)
│   ├── active/
│   ├── backlog/
│   └── done/
├── .context/             # Shared knowledge files
├── .conversations/       # Chat history as .md files
└── src/                  # Actual codebase
```

### Task File Format
```markdown
---
ticket: ORA-157
status: active
priority: high
assignee: agni
depends: [ORA-156]
created: 2026-03-04
---

# Task title

## Objective
What needs to be done.

## Context
Relevant files, decisions, constraints.

## Log
- [timestamp] Agent: what was done
```

### Key Design Decisions
- **Dual-layer storage**: `.md` files for agents, Prisma/SQLite index for human UI
- **CLI is the engine, GUI is a consumer**: GUI calls CLI commands, never has its own logic
- **Model-agnostic**: LLM provider configured per agent or globally, swappable without format changes
- **Execution delegation**: Use Claude Code CLI for complex work, direct SDK for simple tasks
- **Composable prompts**: Agent `.md` can reference sub-prompts (role, tools, behavior) — pattern from Agent Zero

## Pros and Cons

### Pros
- Zero translation layers between task context and LLM — agent reads one file, has everything
- Git gives version control, branching, diffing, collaboration for free
- Human-readable AND machine-readable simultaneously
- Model-agnostic — file format doesn't care what reads it
- Builds on existing ecosystem (TypeScript, Node v24, existing Loka infrastructure)
- Agents (Agni, Garuda) can build and maintain the framework itself
- Small codebase — CLI is ~1000-1500 lines for v1

### Cons
- Bidirectional sync between `.md` files and database is hard — conflict resolution needed
- Filesystem doesn't scale past ~1000 tasks per project without indexing
- Agent output quality varies — needs validation that frontmatter stays well-formed
- Two systems to maintain (`.md` files + Loka Task Manager) until fully unified
- No existing execution sandbox — either delegate to Claude Code or build Docker isolation

## Next Steps

1. Create the project scaffold (this document)
2. Define and write 5 example task `.md` files by hand for oracle-bridge
3. Define 2-3 agent `.md` files (reuse existing soul prompts from Agni/Garuda)
4. Build minimal CLI: `loka status` + `loka run` (TypeScript, ~500 lines)
5. Test CLI against real tasks for 1-2 weeks
6. Evaluate: what's missing? What needs a GUI?
