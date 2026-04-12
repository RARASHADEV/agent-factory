# AF-23: Structured Agent Output — Technical Design

> Pipeline Flow 1: `result.json` schema, extraction, and agent prompt updates.

## 1. Overview

Agents currently produce freeform `result.md` files. The upcoming pipeline orchestrator (AF-25 through AF-28) needs machine-readable output to evaluate gates, inject artifacts, and route work between phases. This task introduces a `result.json` file written alongside `result.md` after every agent spawn completes.

**Approach:** Define a `ResultSchema` TypeScript interface + runtime validator. After an agent finishes, `spawn-runner.ts` scans `result.md` for a sentinel-marked JSON block. If found and valid, it writes `result.json`. If not found, it synthesizes a minimal result from `status.json`. Three agent prompts (architect, engineer, QA) are updated to emit the structured block.

**Key design decision:** Use a sentinel code-fence marker ` ```result-json ` instead of generic ` ```json ` to avoid ambiguity with other JSON blocks agents routinely produce (API examples, config samples, etc.).

## 2. Architecture

### Components

```
spawn-runner.ts (modified)
  │
  ├── After runAgent() completes and result.md is written:
  │   │
  │   ├── extractResultJson(resultText)     ← new, from result-schema.ts
  │   │     │
  │   │     ├── scan for ```result-json fenced block
  │   │     ├── parse JSON
  │   │     ├── validate against ResultSchema
  │   │     └── return { valid, data?, errors? }
  │   │
  │   ├── if valid → write result.json (extracted)
  │   ├── if invalid/missing → synthesizeResult(status) → write result.json (synthetic)
  │   │
  │   └── audit log: include result.json path in spawn.complete meta
  │
  └── Feature flag: ENABLE_AF_23 in constants.ts (default: true)

src/lib/result-schema.ts (new)
  ├── ResultSchema interface
  ├── validateResult() — runtime validator
  ├── extractResultJson() — fenced-block extractor
  └── synthesizeResult() — fallback builder

agents/architect.md (modified) — add result-json instruction to "When Finished"
agents/engineer.md  (modified) — add result-json instruction to "When Finished"
agents/qa.md        (modified) — add result-json instruction to "When Finished"
```

### Data flow

```
Agent runs → writes result.md (may contain ```result-json block)
                 │
spawn-runner.ts reads result.md
                 │
        ┌────────┴────────┐
        │                 │
  block found        block NOT found
        │                 │
  parse + validate   synthesizeResult()
        │                 │
   ┌────┴────┐            │
 valid    invalid         │
   │        │             │
   │    synthesize +      │
   │    warn to stderr    │
   │        │             │
   └────────┴─────────────┘
            │
     write result.json
```

## 3. Data Model — ResultSchema

### Interface

```typescript
// src/lib/result-schema.ts

export type ResultStatus = 'complete' | 'partial' | 'failed' | 'blocked';

export interface ResultArtifact {
  type: string;       // e.g., "design_document", "pull_request", "qa_verdict"
  path: string;       // relative file path or URL
}

export interface ResultSchema {
  status: ResultStatus;
  summary: string;                          // one-line human-readable summary
  artifacts: ResultArtifact[];              // files/URLs the agent produced
  next_role?: string;                       // e.g., "ENGINEER", "QA"
  blockers?: string[];                      // what prevented completion
  metadata?: Record<string, unknown>;       // agent-specific structured data
  _synthetic?: boolean;                     // true = system-generated, not agent-produced
}
```

### Field semantics

| Field | Required | Used by | Notes |
|-------|----------|---------|-------|
| `status` | Yes | Gate evaluator (AF-27) | Gate conditions like `field: status, operator: eq, value: complete` |
| `summary` | Yes | Pipeline status (AF-28), audit log | Human-readable, ≤200 chars |
| `artifacts` | Yes (can be `[]`) | Artifact injector (AF-25) | Each has `type` (for matching in pipeline YAML `inject.artifact`) and `path` |
| `next_role` | No | Pipeline runner (AF-26) | Informational — pipeline YAML is authoritative for phase ordering |
| `blockers` | No | Gate evaluator (AF-27) | Non-empty blockers + status=blocked → gate fails |
| `metadata` | No | Gate evaluator (AF-27) | Role-specific. E.g., `{ pr_url: "..." }`, `{ verdict: "PASS" }` |
| `_synthetic` | No | Gate evaluator (AF-27) | When `true`, gate should apply lenient evaluation or flag for human review |

### Validation rules

The runtime validator checks:
1. `status` is one of the four allowed values
2. `summary` is a non-empty string
3. `artifacts` is an array; each element has string `type` and `path`
4. `next_role`, if present, is a string
5. `blockers`, if present, is an array of strings
6. `metadata`, if present, is a plain object

No new dependencies. Hand-rolled validator — returns `{ valid: true, data: ResultSchema }` or `{ valid: false, errors: string[] }`.

## 4. Implementation: `src/lib/result-schema.ts` (new file)

### Exports

```typescript
// --- Types ---
export type ResultStatus = 'complete' | 'partial' | 'failed' | 'blocked';
export interface ResultArtifact { type: string; path: string; }
export interface ResultSchema { /* as defined above */ }

// --- Validation ---
export interface ValidationSuccess { valid: true; data: ResultSchema; }
export interface ValidationFailure { valid: false; errors: string[]; }
export type ValidationResult = ValidationSuccess | ValidationFailure;

export function validateResult(input: unknown): ValidationResult;

// --- Extraction ---
export function extractResultJson(resultText: string): ValidationResult | null;
//   Returns null if no ```result-json block found.
//   Returns ValidationResult if block found (may still be invalid).

// --- Synthesis ---
export function synthesizeResult(status: {
  status: string;
  success?: boolean;
  agent?: string;
  ticket?: string;
}): ResultSchema;
```

### Extraction logic (pseudocode)

```typescript
function extractResultJson(resultText: string): ValidationResult | null {
  // 1. Find the LAST ```result-json ... ``` block in the text.
  //    Use a regex: /```result-json\s*\n([\s\S]*?)```/g
  //    Take the last match (agents may revise their output).
  const matches = [...resultText.matchAll(/```result-json\s*\n([\s\S]*?)```/g)];
  if (matches.length === 0) return null;

  const jsonStr = matches[matches.length - 1][1].trim();

  // 2. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { valid: false, errors: [`JSON parse error: ${e.message}`] };
  }

  // 3. Validate against schema
  return validateResult(parsed);
}
```

**Why take the last match:** Agents may include an earlier draft or example in their reasoning. The final block in the output is the definitive one.

### Synthesis logic (pseudocode)

```typescript
function synthesizeResult(status): ResultSchema {
  return {
    status: status.success ? 'complete' : (status.status === 'failed' ? 'failed' : 'partial'),
    summary: `Agent ${status.agent || 'unknown'} finished on ${status.ticket || 'unknown task'} (no structured output)`,
    artifacts: [],
    _synthetic: true,
  };
}
```

## 5. Implementation: `spawn-runner.ts` modifications

### Change location

After line 127 (`writeFileSync(statusFile, JSON.stringify(status, null, 2));`) in the success path — after `result.md` is written and `status.json` is updated.

### Pseudocode

```typescript
import { extractResultJson, synthesizeResult } from './lib/result-schema.js';
import { ENABLE_AF_23 } from './lib/constants.js';

// ... inside the success path, after writing result.md and status.json:

if (ENABLE_AF_23) {
  const resultJsonFile = join(config.outputDir, 'result.json');
  const resultText = result.result || '';

  const extraction = extractResultJson(resultText);

  let resultData: ResultSchema;
  if (extraction && extraction.valid) {
    resultData = extraction.data;
  } else {
    // Log why extraction failed (for debugging agent prompt compliance)
    if (extraction && !extraction.valid) {
      console.warn(`[result-json] Extraction found block but validation failed: ${extraction.errors.join(', ')}`);
    }
    resultData = synthesizeResult({
      status: status.status,
      success: result.success,
      agent: config.agentSlug,
      ticket: config.ticket,
    });
  }

  writeFileSync(resultJsonFile, JSON.stringify(resultData, null, 2));
}
```

### Also in the failure path

When the agent fails (catch block), synthesize a failed result:

```typescript
if (ENABLE_AF_23) {
  const resultJsonFile = join(config.outputDir, 'result.json');
  const failedResult = synthesizeResult({
    status: 'failed',
    success: false,
    agent: config.agentSlug,
    ticket: config.ticket,
  });
  failedResult.blockers = [err.message];
  writeFileSync(resultJsonFile, JSON.stringify(failedResult, null, 2));
}
```

### Audit log enhancement

In the `spawn.complete` audit entry's `meta`, add `resultJsonPath` and `resultSynthetic`:

```typescript
meta: {
  success: result.success,
  durationMs: result.durationMs,
  resultJsonPath: resultJsonFile,          // new
  resultSynthetic: resultData._synthetic,  // new
},
```

## 6. Implementation: Feature Flag

### `src/lib/constants.ts` — add:

```typescript
/** AF-23: Structured result.json output. When false, spawn-runner skips result.json extraction/writing. */
export const ENABLE_AF_23 = true;
```

Default `true` because this is purely additive — writes an extra file with no behavioral change to existing flows. Can be toggled to `false` if result.json extraction causes unexpected issues.

## 7. Implementation: Agent Prompt Updates

### Instruction block (shared preamble)

Each agent gets the following instruction appended to their **"When Finished"** section. The instruction is identical except for the role-specific example.

#### Shared instruction text:

```markdown
### Structured Result Output

After completing your work, include a structured result block at the END of your final response.
Use the `result-json` code fence — this is how the pipeline system identifies your machine-readable output.

Required fields:
- `status`: `"complete"` | `"partial"` | `"failed"` | `"blocked"`
- `summary`: One sentence describing what you accomplished
- `artifacts`: Array of `{ "type": "<type>", "path": "<path>" }` for each file you produced
- `metadata`: (optional) Role-specific structured data

<role-specific example here>

Place this block as the LAST thing in your output. Do not put any text after it.
```

### Architect-specific example

Append to `agents/architect.md` in the `# When Finished` section, after item 3:

````markdown
### Structured Result Output

After completing your work, include a structured result block at the END of your final response.
Use the `result-json` code fence — this is how the pipeline system identifies your machine-readable output.

Required fields:
- `status`: `"complete"` | `"partial"` | `"failed"` | `"blocked"`
- `summary`: One sentence describing what you accomplished
- `artifacts`: Array of `{ "type": "<type>", "path": "<path>" }` for each file you produced
- `metadata`: (optional) Role-specific structured data

Example for architect:
```result-json
{
  "status": "complete",
  "summary": "Designed webhook listener with HMAC auth and retry logic",
  "artifacts": [
    { "type": "design_document", "path": "docs/designs/AF-30-webhook.md" }
  ],
  "next_role": "ENGINEER",
  "metadata": {
    "complexity": "medium",
    "implementation_role": "ENGINEER"
  }
}
```

Place this block as the LAST thing in your output. Do not put any text after it.
````

### Engineer-specific example

Append to `agents/engineer.md` in the `# When Finished` section, after item 7:

````markdown
### Structured Result Output

After completing your work, include a structured result block at the END of your final response.
Use the `result-json` code fence — this is how the pipeline system identifies your machine-readable output.

Required fields:
- `status`: `"complete"` | `"partial"` | `"failed"` | `"blocked"`
- `summary`: One sentence describing what you accomplished
- `artifacts`: Array of `{ "type": "<type>", "path": "<path>" }` for each file you produced
- `metadata`: (optional) Must include `pr_url` if a PR was created

Example for engineer:
```result-json
{
  "status": "complete",
  "summary": "Implemented webhook listener with HMAC validation and retry queue",
  "artifacts": [
    { "type": "source_code", "path": "src/lib/webhook-handler.ts" },
    { "type": "source_code", "path": "src/commands/webhook.ts" },
    { "type": "test", "path": "src/__tests__/webhook-handler.test.ts" }
  ],
  "next_role": "QA",
  "metadata": {
    "pr_url": "https://github.com/org/repo/pull/42",
    "branch": "engineer/AF-30",
    "files_changed": 5
  }
}
```

Place this block as the LAST thing in your output. Do not put any text after it.
````

### QA-specific example

Append to `agents/qa.md` in the `# When Finished` section, after item 3:

````markdown
### Structured Result Output

After completing your work, include a structured result block at the END of your final response.
Use the `result-json` code fence — this is how the pipeline system identifies your machine-readable output.

Required fields:
- `status`: `"complete"` | `"partial"` | `"failed"` | `"blocked"`
- `summary`: One sentence describing your QA verdict
- `artifacts`: Array of `{ "type": "<type>", "path": "<path>" }` for each file you produced
- `metadata`: Must include `verdict` (`"PASS"` | `"FAIL"` | `"PARTIAL"`)

Example for QA:
```result-json
{
  "status": "complete",
  "summary": "QA passed — all acceptance criteria met, 42 tests passing",
  "artifacts": [
    { "type": "qa_verdict", "path": ".af/output/AF-30/AF-30-qa-verdict.md" }
  ],
  "next_role": "DEPLOYMANAGER",
  "metadata": {
    "verdict": "PASS",
    "tests_total": 42,
    "tests_passed": 42,
    "tests_failed": 0,
    "issues_found": 0
  }
}
```

If QA fails, set `status` to `"failed"` and `metadata.verdict` to `"FAIL"`:
```result-json
{
  "status": "failed",
  "summary": "QA failed — 3 critical issues found, 2 acceptance criteria not met",
  "artifacts": [
    { "type": "qa_verdict", "path": ".af/output/AF-30/AF-30-qa-verdict.md" }
  ],
  "next_role": "ENGINEER",
  "blockers": [
    "Missing input validation on /api/webhooks endpoint",
    "No error handling for HMAC verification failure"
  ],
  "metadata": {
    "verdict": "FAIL",
    "tests_total": 42,
    "tests_passed": 40,
    "tests_failed": 2,
    "issues_found": 3
  }
}
```

Place this block as the LAST thing in your output. Do not put any text after it.
````

## 8. File Inventory

### New files

| File | Purpose |
|------|---------|
| `src/lib/result-schema.ts` | `ResultSchema` interface, `validateResult()`, `extractResultJson()`, `synthesizeResult()` |

### Modified files

| File | Change |
|------|--------|
| `src/spawn-runner.ts` | Import result-schema; after agent completion, extract or synthesize result.json; write to output dir |
| `src/lib/constants.ts` | Add `ENABLE_AF_23 = true` feature flag |
| `agents/architect.md` | Append "Structured Result Output" instruction to "When Finished" section |
| `agents/engineer.md` | Append "Structured Result Output" instruction to "When Finished" section |
| `agents/qa.md` | Append "Structured Result Output" instruction to "When Finished" section |

### Output dir after this change

```
.af/output/<TICKET>/
  ├── config.json      (existing — spawn config)
  ├── status.json      (existing — pid, status, timestamps)
  ├── result.md        (existing — freeform agent output)
  ├── result.json      (NEW — structured, machine-readable)
  ├── agent.log        (existing — stdout/stderr)
  └── crash.log        (existing — only on crash)
```

## 9. Error Handling

| Scenario | Behavior |
|----------|----------|
| No `result-json` block in result.md | Synthesize minimal result.json with `_synthetic: true` |
| JSON parse error in extracted block | Warn to stderr, synthesize instead |
| Schema validation fails (e.g., missing `status`) | Warn to stderr with validation errors, synthesize instead |
| Multiple `result-json` blocks | Use the **last** one (agent may have revised) |
| Agent crashes (catch block in spawn-runner) | Write synthetic result.json with `status: "failed"` and `blockers` |
| `ENABLE_AF_23` is false | Skip all result.json logic — no file written |
| `writeFileSync` fails for result.json | Catch and warn to stderr — do not crash the runner |

## 10. Backward Compatibility

- `result.md` is written exactly as before, in the same location, with the same content
- `status.json` is written exactly as before — no fields added or removed
- `result.json` is a new additional file — nothing reads it until AF-25+
- Agent prompts gain new instructions but their existing behavior is unchanged
- Feature flag allows instant rollback

## 11. Security Considerations

- **No user input in file paths**: `result.json` path is derived from `config.outputDir` (set by CLI, not by agent)
- **JSON injection**: The extracted JSON is parsed and re-serialized via `JSON.stringify()` before writing — no raw pass-through
- **Agent-controlled metadata**: The `metadata` field is agent-authored. Downstream consumers (gate evaluator) must treat it as untrusted and validate specific fields they need
- **No secrets**: ResultSchema contains file paths and status info — no credentials or tokens

## 12. Testing Strategy

Since the project has no test framework yet (`npm test` — none currently), verification is manual:

1. **Spawn architect with `--background`** on a test task → check that `.af/output/<ticket>/architect/result.json` exists and contains valid structured data
2. **Spawn with an agent that does NOT emit result-json** → verify synthetic result.json is written with `_synthetic: true`
3. **Feature flag off** → set `ENABLE_AF_23 = false`, spawn → verify no result.json is written
4. **Malformed JSON** → manually edit a result.md to contain a broken `result-json` block → run extraction → verify fallback to synthetic

If the engineer adds unit tests (encouraged), they should cover:
- `validateResult()` with valid input, missing fields, wrong types
- `extractResultJson()` with zero blocks, one block, multiple blocks, malformed JSON
- `synthesizeResult()` with various status inputs

## 13. Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| None (external) | — | No new npm packages |
| `src/lib/sdk.ts` | Read | Uses `AgentResult` return type (no changes needed) |
| `src/lib/audit.ts` | Read | Audit entries enhanced with result.json metadata |
| AF-25 (artifact injection) | Downstream | Will read `result.json` to resolve artifact paths |
| AF-27 (gate evaluation) | Downstream | Will read `result.json` to evaluate pass/fail conditions |

## 14. Implementation Role

**ENGINEER** — this is backend-only TypeScript work (new module, spawn-runner modification, agent markdown edits).

## 15. Complexity

**Medium** — as estimated in the ticket. One new file, one modified runtime file, three agent prompt edits. The extraction logic has edge cases but is straightforward regex + JSON parse + validate.

## 16. Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Agents ignore the `result-json` instruction | Medium | Synthetic fallback ensures result.json always exists; pipeline can still function with degraded confidence |
| Agents emit `result-json` block mid-output (not at end) | Low | Extraction takes the *last* match, so even mid-output blocks are handled |
| Regex doesn't match due to whitespace/formatting quirks | Low | Regex is permissive (`\s*\n`); engineer should test with real agent output |
| Future agents produce very large metadata objects | Low | No size limit enforced in v1; can add in follow-up if needed |
