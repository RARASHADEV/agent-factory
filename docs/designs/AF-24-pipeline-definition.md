# AF-24: Pipeline Definition Format — Technical Design

> Pipeline Flow 2: YAML schema, TypeScript types, loader, validator, and topological sort.

## 1. Overview

The pipeline orchestrator needs a declarative format to define multi-agent workflows. This task creates `src/lib/pipeline.ts` — the TypeScript types, YAML loader, schema validator, and phase ordering logic for pipeline definitions stored as `.af/pipelines/<name>.yaml` files.

**This module is pure data + validation.** It does not execute pipelines, evaluate gates, or inject artifacts. It provides the typed, validated data structures that AF-25 (artifact injection), AF-26 (pipeline runner), and AF-27 (gate evaluation) consume.

**Key design decisions:**
1. **No new dependencies** — reuses the `yaml` v2.7 package already in `package.json`
2. **Follow `config.ts` pattern** — same `parse` import, same sync file I/O, same error handling style
3. **Topological sort** — Kahn's algorithm for resolving phase execution order from `requires` DAG
4. **Strict validation** — reject early with descriptive errors rather than letting bad definitions propagate to runtime

## 2. Architecture

### Component diagram

```
.af/pipelines/
  ├── sdlc.yaml          ← pipeline definitions (user-authored or default)
  └── review-only.yaml

src/lib/pipeline.ts (NEW)
  ├── Types:
  │   ├── PipelineDefinition
  │   ├── PhaseDefinition
  │   ├── GateDefinition
  │   ├── InjectDefinition
  │   └── GateOperator (union type)
  │
  ├── Loading:
  │   ├── loadPipeline(afPath, name) → PipelineDefinition
  │   └── listPipelines(afPath) → string[]
  │
  ├── Validation:
  │   └── validatePipeline(raw) → { valid, data?, errors? }
  │
  └── Ordering:
      └── resolvePhaseOrder(pipeline) → PhaseDefinition[]
```

### Consumers (downstream tickets)

| Consumer | What it reads | AF ticket |
|----------|--------------|-----------|
| Artifact injector | `PhaseDefinition.inject[]` — from, artifact, as | AF-25 |
| Pipeline runner | `PipelineDefinition` — full structure, ordered phases | AF-26 |
| Gate evaluator | `GateDefinition` — field, operator, value | AF-27 |
| Pipeline status | `PipelineDefinition.name`, phase names | AF-28 |
| Pipeline CLI | `listPipelines()`, `loadPipeline()` | AF-26 |

## 3. Data Model — TypeScript Interfaces

```typescript
// src/lib/pipeline.ts

// --- Gate operators ---

export type GateOperator = 'eq' | 'neq' | 'exists' | 'not_exists' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

// --- Gate definition ---

export interface GateDefinition {
  /** Dot-path into result.json. E.g., "status", "metadata.pr_url", "metadata.verdict" */
  field: string;
  /** Comparison operator */
  operator: GateOperator;
  /** Expected value. Required for eq/neq/contains/gt/gte/lt/lte. Omit for exists/not_exists. */
  value?: string | number | boolean;
}

// --- Artifact injection ---

export interface InjectDefinition {
  /** Phase name to inject from (must be in `requires` or a transitive dependency) */
  from: string;
  /** What to inject. Either:
   *  - A file glob with {ticket} placeholder: "docs/designs/{ticket}*.md"
   *  - A dot-path into result.json: "metadata.pr_url"
   */
  artifact: string;
  /** Label for this injection in the composed prompt */
  as: string;
}

// --- Phase definition ---

export interface PhaseDefinition {
  /** Unique phase name (e.g., "design", "implement", "verify") */
  name: string;
  /** Agent slug to spawn (must exist in agents/ registry) */
  agent: string;
  /** Phase names that must complete before this phase runs */
  requires?: string[];
  /** Artifacts to inject from prior phases into this agent's prompt */
  inject?: InjectDefinition[];
  /** Gate condition — evaluated against result.json after agent completes */
  gate?: GateDefinition;
}

// --- Pipeline definition ---

export interface PipelineDefinition {
  /** Pipeline name (matches filename without .yaml extension) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Ordered list of phases (order in YAML is authoring order; execution order is topological) */
  phases: PhaseDefinition[];
}
```

### Field semantics

| Field | Required | Validated | Notes |
|-------|----------|-----------|-------|
| `name` | Yes | Non-empty string | Must match filename |
| `description` | No | String if present | For `af pipeline list` display |
| `phases` | Yes | Non-empty array | At least one phase |
| `phases[].name` | Yes | Unique across phases | Used as key for `requires`/`inject.from` references |
| `phases[].agent` | Yes | Non-empty string | Agent slug; existence check is optional (warn, don't reject) |
| `phases[].requires` | No | All refs resolve to existing phase names | Defines the DAG |
| `phases[].inject` | No | All `from` refs resolve to existing phase names | Artifact injection spec |
| `phases[].inject[].artifact` | Yes (if inject) | Non-empty string | Glob or dot-path |
| `phases[].inject[].as` | Yes (if inject) | Non-empty string | Prompt label |
| `phases[].gate` | No | Valid operator + value combo | If absent, phase always "passes" |
| `phases[].gate.field` | Yes (if gate) | Non-empty string | Dot-path into result.json |
| `phases[].gate.operator` | Yes (if gate) | One of `GateOperator` values | |
| `phases[].gate.value` | Conditional | Required for eq/neq/contains/gt/gte/lt/lte; must be absent for exists/not_exists | |

## 4. Implementation: Validation

### `validatePipeline(raw: unknown): PipelineValidationResult`

```typescript
export interface PipelineValidationSuccess {
  valid: true;
  data: PipelineDefinition;
}

export interface PipelineValidationFailure {
  valid: false;
  errors: string[];
}

export type PipelineValidationResult = PipelineValidationSuccess | PipelineValidationFailure;
```

### Validation checks (in order)

1. **Top-level structure**
   - `raw` is a non-null object
   - `raw.name` is a non-empty string
   - `raw.phases` is a non-empty array

2. **Phase-level checks** (for each phase):
   - `name` is a non-empty string
   - `agent` is a non-empty string
   - Phase name is unique (collect names in a Set; duplicate → error)

3. **Reference integrity** (after collecting all phase names):
   - Every `requires[]` entry references an existing phase name
   - Every `inject[].from` entry references an existing phase name
   - Every `inject[].from` entry is either in `requires[]` or is a transitive dependency of the current phase (warn if not in direct `requires` — the pipeline runner will need the prior phase's output to exist)

4. **Gate validation** (for each phase with a gate):
   - `field` is a non-empty string
   - `operator` is one of the allowed `GateOperator` values
   - Value-requiring operators (`eq`, `neq`, `contains`, `gt`, `gte`, `lt`, `lte`) have a `value` field
   - Existence operators (`exists`, `not_exists`) do NOT have a `value` field (warn if present — ignore it)

5. **Cycle detection**:
   - Build adjacency list from `requires`
   - Run topological sort (Kahn's algorithm)
   - If sort doesn't consume all nodes → cycle exists → error listing the involved phases

### Error message format

Errors are human-readable strings with context:

```
"phases[1].name: duplicate phase name 'design' (first defined at phases[0])"
"phases[2].requires: unknown phase 'build' (available: design, implement, verify)"
"phases[1].gate: operator 'eq' requires a 'value' field"
"phases: circular dependency detected involving: implement, verify"
```

## 5. Implementation: Loader

### `loadPipeline(afPath: string, name: string): PipelineDefinition`

```typescript
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const PIPELINES_DIR = 'pipelines';

export function loadPipeline(afPath: string, name: string): PipelineDefinition {
  // Path traversal guard
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid pipeline name "${name}" — must not contain path separators`);
  }

  const filePath = join(afPath, PIPELINES_DIR, `${name}.yaml`);

  if (!existsSync(filePath)) {
    throw new Error(`Pipeline "${name}" not found at ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e: any) {
    throw new Error(`Pipeline "${name}" has invalid YAML: ${e.message}`);
  }

  const result = validatePipeline(parsed);
  if (!result.valid) {
    throw new Error(
      `Pipeline "${name}" validation failed:\n  - ${result.errors.join('\n  - ')}`
    );
  }

  return result.data;
}
```

**Design choice: throw, don't return errors.** The loader is called by CLI commands and the pipeline runner — both want a valid `PipelineDefinition` or a clear error. The `validatePipeline()` function is exported separately for use cases that need the raw validation result.

### `listPipelines(afPath: string): string[]`

```typescript
export function listPipelines(afPath: string): string[] {
  const dir = join(afPath, PIPELINES_DIR);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => f.replace(/\.ya?ml$/, ''))
    .sort();
}
```

Returns pipeline names (without extension), sorted alphabetically. Returns empty array if the pipelines directory doesn't exist — no error.

## 6. Implementation: Topological Sort

### `resolvePhaseOrder(pipeline: PipelineDefinition): PhaseDefinition[]`

Returns phases in execution order (dependencies first). Uses Kahn's algorithm:

```typescript
export function resolvePhaseOrder(pipeline: PipelineDefinition): PhaseDefinition[] {
  const phases = pipeline.phases;
  const phaseMap = new Map<string, PhaseDefinition>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // from → [to]

  // Initialize
  for (const phase of phases) {
    phaseMap.set(phase.name, phase);
    inDegree.set(phase.name, 0);
    adjacency.set(phase.name, []);
  }

  // Build edges from requires
  for (const phase of phases) {
    for (const req of phase.requires ?? []) {
      adjacency.get(req)!.push(phase.name);
      inDegree.set(phase.name, (inDegree.get(phase.name) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: PhaseDefinition[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(phaseMap.get(name)!);

    for (const neighbor of adjacency.get(name) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // If sorted.length < phases.length, there's a cycle
  // (but validatePipeline already catches this — this is a safety net)
  if (sorted.length < phases.length) {
    const remaining = phases.filter(p => !sorted.includes(p)).map(p => p.name);
    throw new Error(`Circular dependency detected involving: ${remaining.join(', ')}`);
  }

  return sorted;
}
```

**Note:** When multiple phases have no dependencies (in-degree 0), they are returned in YAML authoring order (array insertion order from `queue`). This gives authors control over tie-breaking without needing an explicit `order` field. V1 executes sequentially regardless; if future versions add parallel execution, these independent phases could run concurrently.

## 7. Default Pipeline: `.af/pipelines/sdlc.yaml`

```yaml
name: sdlc
description: Full SDLC — design through verification

phases:
  - name: design
    agent: architect
    gate:
      field: status
      operator: eq
      value: complete

  - name: implement
    agent: engineer
    requires: [design]
    inject:
      - from: design
        artifact: "docs/designs/{ticket}*.md"
        as: design_document
    gate:
      field: metadata.pr_url
      operator: exists

  - name: verify
    agent: qa
    requires: [implement]
    inject:
      - from: design
        artifact: "docs/designs/{ticket}*.md"
        as: design_document
      - from: implement
        artifact: metadata.pr_url
        as: pr_to_review
    gate:
      field: metadata.verdict
      operator: eq
      value: PASS
```

This file should be created in the **project's** `.af/pipelines/` directory — not in the global `~/.af/`. Pipelines are project-specific. The `af init` command could seed this file (but that's outside AF-24 scope).

## 8. File Inventory

### New files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/lib/pipeline.ts` | Types, loader, validator, topo-sort | ~250 |
| `.af/pipelines/sdlc.yaml` | Default SDLC pipeline definition | ~30 |

### Modified files

None. This is a standalone module with no integration points yet — AF-26 will register the CLI commands and import from this module.

### No changes to

- `src/cli.ts` — no new CLI commands in AF-24 (AF-26 adds `af pipeline run/list/status`)
- `src/lib/constants.ts` — no feature flag needed (this module is inert until consumed)
- Agent prompts — no changes needed
- `src/spawn-runner.ts` — no changes needed

## 9. API Surface — Full Export List

```typescript
// --- Types ---
export type GateOperator = 'eq' | 'neq' | 'exists' | 'not_exists' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
export interface GateDefinition { field: string; operator: GateOperator; value?: string | number | boolean; }
export interface InjectDefinition { from: string; artifact: string; as: string; }
export interface PhaseDefinition { name: string; agent: string; requires?: string[]; inject?: InjectDefinition[]; gate?: GateDefinition; }
export interface PipelineDefinition { name: string; description?: string; phases: PhaseDefinition[]; }

// --- Validation ---
export interface PipelineValidationSuccess { valid: true; data: PipelineDefinition; }
export interface PipelineValidationFailure { valid: false; errors: string[]; }
export type PipelineValidationResult = PipelineValidationSuccess | PipelineValidationFailure;
export function validatePipeline(raw: unknown): PipelineValidationResult;

// --- Loading ---
export function loadPipeline(afPath: string, name: string): PipelineDefinition;
export function listPipelines(afPath: string): string[];

// --- Ordering ---
export function resolvePhaseOrder(pipeline: PipelineDefinition): PhaseDefinition[];
```

## 10. Error Handling

| Scenario | Behavior |
|----------|----------|
| Pipeline file doesn't exist | `loadPipeline` throws `Error("Pipeline 'X' not found at ...")` |
| Invalid YAML syntax | `loadPipeline` throws `Error("Pipeline 'X' has invalid YAML: ...")` |
| Validation fails | `loadPipeline` throws with all errors joined by newlines |
| No pipelines directory | `listPipelines` returns `[]` (no error) |
| Empty phases array | Validation error: `"phases: must contain at least one phase"` |
| Duplicate phase name | Validation error: `"phases[N].name: duplicate phase name 'X'"` |
| Dangling requires ref | Validation error: `"phases[N].requires: unknown phase 'X' (available: ...)"` |
| Dangling inject.from ref | Validation error: `"phases[N].inject[M].from: unknown phase 'X'"` |
| Circular dependency | Validation error: `"phases: circular dependency detected involving: X, Y"` |
| Invalid gate operator | Validation error: `"phases[N].gate.operator: invalid operator 'X' (expected: eq, neq, ...)"` |
| Missing gate value for eq/neq | Validation error: `"phases[N].gate: operator 'eq' requires a 'value' field"` |
| Unknown YAML fields (extra keys) | **Ignored** — forward compatibility. Don't reject unknown fields. |
| Path traversal in pipeline name | `loadPipeline` throws `Error("Invalid pipeline name ... must not contain path separators")` |

## 11. Design Decisions

### Why no feature flag?

AF-23 needed `ENABLE_AF_23` because it modifies runtime behavior (spawn-runner writes an extra file). AF-24 is a **pure library module** — it exports types and functions but nothing calls them until AF-26 integrates the pipeline commands. There's no runtime behavior to guard.

### Why throw from `loadPipeline` instead of returning errors?

Every caller wants a valid pipeline or needs to abort. Returning `{ valid, data?, errors? }` forces every call site to check and handle. The `validatePipeline()` function is exported separately for the rare case where callers want to inspect errors programmatically (e.g., a future `af pipeline validate` command).

### Why Kahn's algorithm for topo-sort?

1. Simple to implement (~25 lines)
2. Naturally detects cycles (sorted.length < total means cycle)
3. Stable — preserves YAML authoring order for ties (unlike DFS-based sort)
4. No recursion — no stack overflow risk on deep pipelines

### Why not validate agent slug existence?

The loader deliberately does NOT check whether `agent: architect` corresponds to a file in `agents/`. Reasons:
1. Agents may be synced later (`af agent sync`)
2. Pipeline definitions could be authored before agents are installed
3. The pipeline runner (AF-26) will check agent existence at spawn time — that's the right layer

The validator could emit a **warning** (not error) if a project's agents directory is available, but this is a nice-to-have for later.

### Why support both `.yaml` and `.yml` in `listPipelines`?

Convention varies across ecosystems. Accepting both costs nothing and prevents user confusion.

### Why `{ticket}` placeholder in artifact globs?

The pipeline definition is a template — the same `sdlc.yaml` is reused for every task. The `{ticket}` placeholder in artifact paths (e.g., `docs/designs/{ticket}*.md`) is resolved at runtime by the artifact injector (AF-25), not by this module. AF-24 treats it as an opaque string.

## 12. Relationship to AF-23 (ResultSchema)

The `GateDefinition.field` values (`"status"`, `"metadata.pr_url"`, `"metadata.verdict"`) correspond to fields in the `ResultSchema` interface from AF-23. The connection is:

```
Pipeline YAML (AF-24)          result.json (AF-23)
─────────────────────          ──────────────────
gate.field: "status"     →     { "status": "complete" }
gate.field: "metadata.pr_url" → { "metadata": { "pr_url": "..." } }
gate.operator: "eq"
gate.value: "complete"
```

AF-24 does not import from AF-23 — the dot-path resolution and value comparison are AF-27's responsibility. AF-24 only validates that the field/operator/value combination is structurally sound.

## 13. Testing Strategy

No test framework exists in the project. If the engineer adds tests, they should cover:

### Validation tests
- Valid minimal pipeline (name + one phase, no gate, no requires)
- Valid full pipeline (sdlc.yaml content)
- Missing `name` → error
- Missing `phases` → error
- Empty `phases` array → error
- Duplicate phase names → error
- Dangling `requires` ref → error
- Dangling `inject.from` ref → error
- Circular dependency (A requires B, B requires A) → error
- Invalid gate operator → error
- Missing gate value for `eq` → error
- Extra unknown fields → accepted (no error)

### Loader tests
- Load existing YAML file → valid PipelineDefinition
- Load non-existent file → throw with clear message
- Load invalid YAML syntax → throw with parse error

### Topo-sort tests
- Linear chain (A → B → C) → [A, B, C]
- Diamond (A → B, A → C, B → D, C → D) → A before D, B and C in authoring order
- Single phase (no requires) → [phase]
- Multiple independent phases → authoring order preserved

### Manual verification
- `loadPipeline(afPath, 'sdlc')` returns correct typed structure
- `listPipelines(afPath)` discovers sdlc.yaml
- `resolvePhaseOrder(sdlc)` returns [design, implement, verify]

## 14. Security Considerations

- **YAML parsing**: The `yaml` package (v2) is safe by default — no `!!js/function` or `!!python/object` tags. No risk of code execution from YAML.
- **File path**: Pipeline files are loaded from a known directory (`.af/pipelines/`). The `name` parameter is used to construct a filename — reject names containing `/`, `\`, or `..` to prevent path traversal (see loader pseudocode in section 5).
- **No user input at runtime**: Pipeline definitions are authored by humans or the planner agent, not by untrusted external input.

## 15. Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| `yaml` (v2.7) | Existing npm dep | Used for `parse()` — same as config.ts |
| `fs`, `path` | Node built-in | `readFileSync`, `existsSync`, `readdirSync`, `join` |
| AF-23 (`ResultSchema`) | Conceptual only | Gate fields reference result.json structure; no code import |
| AF-25, AF-26, AF-27 | Downstream consumers | Will import types and functions from this module |

## 16. Implementation Role

**ENGINEER** — pure TypeScript library module, one new file, one YAML definition, no frontend.

## 17. Complexity

**Low** — as estimated in the pipeline plan. Well-defined scope: types + loader + validator + topo-sort. No integration with existing code (standalone module). All patterns exist in the codebase (`config.ts` for YAML loading, `result-schema.ts` for validation).

## 18. Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| YAML format needs to change for AF-25/AF-26 needs | Medium | Schema is additive — extra fields are ignored. New required fields can be added with validation version check. |
| Topo-sort tie-breaking causes unexpected order | Low | Documented: YAML authoring order is preserved for ties. Authors control sequencing. |
| Pipeline definitions become complex (many phases) | Low | V1 targets 3-7 phases. Kahn's is O(V+E), no performance concern. |
| `inject.from` needs transitive dependency checking | Low | Validation warns but doesn't reject. AF-25 will handle resolution. |
