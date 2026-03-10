The design document is complete. Here's the summary:

---

## AF-5 Technical Design — Summary

**Full design at `docs/designs/AF-5.md`**

### What
Replace `agents/engineer.md` (v15, TBI-specific hardcoded prompt) with the generic v2 prompt (v16) from `docs/designs/engineer-v2.md`.

### Key Design Decision: How V2 References `## Project`
The spawn runner (`src/commands/agent.ts:352-363`) already injects `project.md` content under a `## Project` heading in the composed system prompt. The v2 engineer prompt references this in **5 places** — Instructions, Before Start (steps 1 & 2), Task Instructions, and Constraints — using phrasing like "read the project's Way of Working (in the `## Project` section below)" and generic placeholders like `<base-branch>` that the agent resolves from `## Project` at runtime.

### Implementation
- **Single file replacement:** Copy `docs/designs/engineer-v2.md` → `agents/engineer.md`, bump version 15→16, remove `synced` field
- **No runtime code changes** — spawn runner injection already works (validated by AF-6)
- **Complexity:** Low (~30 min)

### Validation
- Dry-run spawn: `af agent spawn engineer --task AF-5 --dry-run`
- Grep for zero hardcoded project refs (`develop`, `task-finish.sh`, `TBI`)

### Implementation Role: **ENGINEER**