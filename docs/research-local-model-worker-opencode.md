# Local Model Worker via OpenCode — Research & Plan

**Date:** 2026-05-22
**Status:** Research / not yet implemented
**Author:** Discussion between user and architect agent

---

## Why this exists

`agent-factory` currently calls Claude exclusively via `@anthropic-ai/claude-agent-sdk`
(see `src/lib/sdk.ts`). Hanuman already runs Ollama with several capable local
models (Qwen3 35B A3B, Qwen3 32B, DeepSeek R1 32B, Mistral Small 3.2, Llama 3.1).
Goal: be able to route any agent task to either Claude or a local model, with
full tool-call support, without rewriting the platform.

---

## Architecture recap

Two projects, two roles:

| Project | Role |
|---|---|
| `agent-platform` (port 5003) | DB + REST API. Stores agents, models, executions. **Does not call any LLM.** |
| `agent-factory` (this repo) | The worker. Polls agent-platform, runs the agent loop. **This is where the LLM is called.** |

So "going local" only requires changes to `agent-factory`. The platform just needs new rows in its `Model` table.

---

## Why not LiteLLM (the proxy approach)

LiteLLM translates Anthropic-API format → Ollama OpenAI format. It exists for
the situation where you have Anthropic-SDK code you can't rewrite. We are
*choosing* the architecture, so we don't need that hack. Skip it.

---

## Why not LangChain

LangChain is a library for **building** agents from scratch — not a translator
or a drop-in. To use it we'd have to throw away the Claude SDK wrapper, rebuild
the agent loop, **and re-implement every tool** (Read/Write/Edit/Bash/Glob/Grep/
WebFetch). 1–2 day rewrite with no gain over picking a ready-made agent.

---

## Why OpenCode

OpenCode (sst/opencode) is a model-agnostic terminal coding agent that:

- Speaks Ollama natively (OpenAI-compatible endpoint)
- Ships with the standard tools (Read/Write/Edit/Bash/Glob/Grep/WebFetch)
- Has a headless `opencode run` mode designed for scripting
- Has MCP support if we want to add more tools later
- Is TypeScript-based, matching this repo's stack

Alternatives considered: Goose (best for embedding, but Python/Rust),
Codex CLI (single Rust binary, OpenAI-backed), Aider (mature but
human-pair-programmer oriented, less worker-shaped).

OpenCode won on **TS-native + headless ergonomics + closest feel to Claude
Code SDK**.

---

## What's already set up on Hanuman

As of 2026-05-22:

- **OpenCode** installed at `~/projects/opencode/` (v1.15.7, via `npm i opencode-ai`)
- **Alias** in `~/.bashrc`:
  ```bash
  alias opencode='~/projects/opencode/node_modules/.bin/opencode'
  ```
- **Config** at `~/.config/opencode/opencode.json` pointing at
  `http://localhost:11434/v1` with all 7 local models registered
- **Verified working**: `opencode run --model ollama/qwen3:32b "..."` executes
  the Bash tool successfully end-to-end (smoke test passed)

CLI usage:
```bash
opencode                                        # TUI
opencode run "task..."                          # one-shot, default model
opencode run --model ollama/qwen3:32b "task"    # pick model per run
opencode models                                  # list all available
```

---

## Implementation plan for agent-factory

### 1. Add an OpenCode runner alongside the Claude runner

In `src/lib/sdk.ts`, keep the existing `runViaClaudeSDK` (rename the current
`runAgent` body) and add a sibling:

```ts
async function runViaOpenCode(
  systemPrompt: string,
  taskPrompt: string,
  options: RunAgentOptions,
): Promise<AgentResult> {
  const start = Date.now();
  const fullPrompt = `${systemPrompt}\n\n---\n\n${taskPrompt}`;
  const opencodeBin = process.env.OPENCODE_BIN
    || `${process.env.HOME}/projects/opencode/node_modules/.bin/opencode`;

  const result = await execFile(opencodeBin, [
    'run',
    '--model', options.model!,
    fullPrompt,
  ], {
    cwd: options.cwd || process.cwd(),
    maxBuffer: 50 * 1024 * 1024,
    timeout: (options.maxTurns || 50) * 60_000,
  });

  return {
    result: result.stdout,
    durationMs: Date.now() - start,
    numTurns: 0,        // OpenCode doesn't expose turn count via CLI today
    success: true,
  };
}
```

### 2. Add a router at the top of `runAgent`

```ts
export async function runAgent(systemPrompt, taskPrompt, options = {}) {
  const model = options.model || 'sonnet';
  const forced = process.env.WORKER_BACKEND; // 'claude' | 'opencode' | undefined

  if (forced === 'opencode') return runViaOpenCode(...);
  if (forced === 'claude')   return runViaClaudeSDK(...);

  // Per-task routing by model identifier
  if (model.startsWith('ollama/') || model.includes(':')) {
    return runViaOpenCode(systemPrompt, taskPrompt, options);
  }
  return runViaClaudeSDK(systemPrompt, taskPrompt, options);
}
```

### 3. Seed Ollama models in agent-platform

Add rows to the `Model` table:

| name | modelIdentifier | complexity |
|---|---|---|
| Qwen 3.6 35B A3B (Local) | `ollama/qwen3.6:35b-a3b-q8_0` | high |
| Qwen 3 32B (Local) | `ollama/qwen3:32b` | medium |
| DeepSeek R1 32B (Local) | `ollama/deepseek-r1:32b` | high |
| Mistral Small 3.2 (Local) | `ollama/mistral-small3.2:24b-instruct-2506-q8_0` | medium |
| Llama 3.1 8B (Local) | `ollama/llama3.1:8b` | low |

### 4. Assign per-agent defaults (the real value)

Hybrid routing is the point — not full local replacement.

| Agent role | Suggested model | Why |
|---|---|---|
| Architect, Researcher, Trusted Advisor | Claude Sonnet/Opus | High-stakes reasoning |
| Engineer, Frontend Engineer | Claude Sonnet | Quality matters on real code |
| QA, Documentalist, Content Writer | `ollama/qwen3.6:35b-a3b-q8_0` | Acceptable quality, free |
| Workflow Manager, Deploy Manager | `ollama/qwen3:32b` | Mostly orchestration |
| Experimental / batch | Local anything | Burn unlimited tokens guilt-free |

Set via each agent's `defaultModel` in the platform UI.

---

## How to switch (three levels)

1. **Per task** — set `modelOverride` on the execution. Highest priority.
2. **Per agent** — set the agent's `defaultModel`. Applies to all that agent's tasks.
3. **Global** — `WORKER_BACKEND=opencode` (or `=claude`) env var on the worker.
   Sledgehammer for testing or outages.

The existing `ModelService.resolveModel()` (in agent-platform) already implements
priority chain: task override → agent default → standard → fallback. No changes
needed there.

---

## Trade-offs to remember

### Benefits
- **Cost** — free local tokens. Single biggest win for batch / experimental work.
- **Privacy** — code stays on Hanuman.
- **No rate limits** — only GPU limits.
- **Offline capable.**
- **Vendor independence.**

### Costs
- **Quality gap** on hard tasks (debugging, complex refactors). Qwen3 35B is
  decent but not Claude 4 Sonnet.
- **Speed** — local inference is GPU-bound; Claude API is often faster end-to-end.
- **Less polished error recovery** — Claude SDK has years of stuck-loop / malformed-
  tool-call handling that OpenCode is still building.
- **Maintenance** — Ollama, model, and OpenCode upgrades are on us.

### Mitigation
Use the hybrid routing table above. Don't go all-in on local — route only the
tasks where local is "good enough" and keep Claude for the rest.

---

## Estimated effort

- New `runViaOpenCode` function: ~30 lines
- Router in `runAgent`: ~5 lines
- Seed Ollama models in DB: a few rows / one seed script update
- Per-agent defaults: UI clicks, ~10 minutes
- **Total:** ~1 hour, fully reversible (router falls through to Claude when model
  identifier doesn't match Ollama pattern)

---

## Open questions / things to verify when implementing

1. Does `opencode run` reliably exit non-zero on tool-call failures? (For
   error detection in the worker.)
2. Can we capture turn count / token usage from OpenCode for metrics? (Currently
   stubbed as `numTurns: 0` in the plan above.)
3. How does OpenCode handle the `cwd` for multi-file edits? Verify it respects
   `--cwd` or run-time chdir.
4. Disallowed tools — does OpenCode support a CLI flag, or only config-file?
   (Affects governance fields on the `Agent` model.)
5. Long-running tasks — does OpenCode have its own timeout, or only inherits
   from the child-process timeout we set?

---

## References

- OpenCode: https://opencode.ai
- This repo's current Claude wrapper: `src/lib/sdk.ts`
- agent-platform model schema: `~/projects/agent-platform/prisma/schema.prisma`
- agent-platform model resolver: `~/projects/agent-platform/src/services/modelService.ts`
- Existing `claude-local` bash function in `~/.bashrc` (the user's earlier
  attempt at pointing Claude Code itself at Ollama — kept for reference but
  superseded by this plan)
