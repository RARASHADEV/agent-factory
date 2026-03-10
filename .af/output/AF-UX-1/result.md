The report has been written to `/home/vanara/projects/oracle-bridge/result.md`. Here's a summary of what's covered:

---

## Report Summary: 22 Concrete UX Issues Across 6 Categories

**Category 1 — Command Structure & Discovery**
- Inconsistent subcommand patterns across `/model`, `/voice`, `/memory`, `/journal` — no clear rule for when to use positional args vs verb prefixes
- 26+ aliases with no tiered help system (one wall of text)
- Missing parse-time input validation (bad formats reach the DB before being caught)
- `/agents` returns a hardcoded placeholder — dead command erodes trust

**Category 2 — Output Formatting**
- 8+ emoji for status in list contexts → replace with plain status words (`running`, `queued`, `done`, `failed`) for scannability
- `/memory stats` mixes visual weights — critical data buries in same hierarchy as secondary data
- `/model` buries the current model in a symmetric list with health info
- `/dispatch` gives one message then silence for up to 10 minutes

**Category 3 — Error Handling (most critical)**
- No error taxonomy: a typo looks identical to a network failure
- **Phase commands (`/phase`, `/phase-back`) have zero confirmation** — one accidental command can overwrite production oracle.db
- Dispatch timeout silently drops jobs with no user notification
- Voice failure message mentions Ollama (wrong system entirely)

**Category 4 — Configuration Onboarding**
- 20+ required env vars fail with raw TypeScript stack traces instead of human-readable validation errors
- No `.env.example` file in the repo
- Boolean feature flags silently ignore `1`, `yes`, `on` — only `"true"` works

**Category 5 — Spawn Workflow Visibility**
- `/dispatch-status` doesn't show turn progress (step N/maxTurns already tracked internally)
- Detached AF agents (v7.11.0) have no recovery UI — crashed agents are invisible to users
- `/workflow` shows flat status lists, not the DAG structure already stored in the DB

**Category 6 — Documentation/Code Divergence**
- The "don't run agent-lieutenant/src/main.ts directly" warning is CLAUDE.md text, not a runtime guard — should exit with a clear error message
- ORACLE_VERSION bump has no automated gate despite being explicitly called out as dangerous