# AF-26: Pipeline Run Command — Technical Design

> Pipeline Flow 4: End-to-end orchestration command that ties together AF-23 (result.json), AF-24 (pipeline definition), and AF-25 (artifact injection).

## 1. Overview

`af pipeline run <name> --task <ticket>` executes a multi-agent pipeline end-to-end. For each phase in topological order it:

1. Resolves artifacts from prior phases (AF-25)
2. Composes the agent system prompt (agent body + project + task + injected artifacts + context)
3. Spawns the agent via `spawn-runner.js` subprocess (reusing existing machinery)
4. Reads the agent's `result.json` (AF-23)
5. Evaluates the phase gate (new `gate-evaluator.ts`)
6. Either continues to the next phase or stops the pipeline

Pipeline progress is continuously written to `.af/output/<ticket>/pipeline-state.json` so that `af pipeline status` (AF-28) can observe it, and so a crashed pipeline leaves a forensic record.

This is the **integration ticket** for the series. Every building block already exists — AF-26 composes them.

## 2. Scope Boundaries

Prevents scope creep into AF-27/AF-28:

| Component | AF-26 (this ticket) | Deferred |
|-----------|---------------------|----------|
| Basic single-condition gate (field + operator + value, 9 operators from AF-24) | ✅ | — |
| Compound gates (`all`/`any`), retry, regex operator, richer failure reports | — | **AF-27** |
| `af pipeline status` command | — | **AF-28** (already shipped — AF-26 writes the state file in the shape AF-28 reads) |
| `af pipeline list` command | ✅ | — |
| Writing `pipeline-state.json` in AF-28-compatible format | ✅ | — |

## 3. Architecture

### Call graph

```
af pipeline run sdlc --task AF-30
  │
  ▼
src/commands/pipeline.ts::pipelineRunCommand
  │
  ├── loadPipeline(afPath, "sdlc")                     ← AF-24
  ├── resolveProject() + createProvider()              ← existing
  ├── provider.get("AF-30")                            ← existing
  ├── resolvePhaseOrder(pipeline)                      ← AF-24
  ├── buildInjectionContext(pipeline, ticket, ...)     ← AF-25
  ├── validateFromFlag(fromPhase, phaseOrder, ctx)     ← AF-26 new
  ├── provider.move(ticket, "in-progress")             ← existing
  ├── writePipelineState(output, initialState)         ← AF-26 new
  ├── auditLog("pipeline.start")                       ← AF-26 new event
  │
  ▼  for each phase in execution order:
  │   (skip if --from and phase is before startPhase)
  │
  ├── auditLog("pipeline.phase_start")
  ├── updatePipelineState(phase → running)
  ├── resolvePhaseInjections(phase, ctx)               ← AF-25
  ├── composeInjectionPrompt(resolved)                 ← AF-25
  ├── composeSystemPrompt(agent, project, task, inj, ctx)   ← AF-26 new
  ├── runPhaseSubprocess(config) → waits for close    ← AF-26 new (reuses spawn-runner.js)
  ├── loadPhaseResult(phase.name, ctx)                 ← AF-25
  ├── evaluateGate(phase.gate, resultJson)             ← AF-26 new (src/lib/gate-evaluator.ts)
  ├── updatePipelineState(phase → completed/failed, gate)
  │
  ├── gate PASS → auditLog("pipeline.phase_complete"), continue
  └── gate FAIL or spawn fail →
        auditLog("pipeline.phase_fail" + "pipeline.fail"),
        writePipelineState(final), exit 1
  │
  ▼  all phases done:
  └── auditLog("pipeline.complete"), writePipelineState(final), exit 0
```

### Prompt composition (per phase)

```
┌────────────────────────────────────────────┐
│ Agent instructions (agents/<slug>.md)       │  ← existing
├────────────────────────────────────────────┤
│ ---                                         │  ← existing separator
├────────────────────────────────────────────┤
│ ## Project   (from .af/project.md)          │  ← existing
├────────────────────────────────────────────┤
│ ## Task      (from .af/tasks/.../<tkt>.md)  │  ← existing
├────────────────────────────────────────────┤
│ ## Injected Artifacts                        │  ← AF-25 output, new in pipeline path
│   ### design_document                        │
│   > Source: design phase — …                 │
│   <contents>                                 │
├────────────────────────────────────────────┤
│ ## Context   (from .af/context/*.md)         │  ← existing
└────────────────────────────────────────────┘
```

Composition logic lives in `pipeline.ts`, not `agent.ts`, so the two paths stay independent.

## 4. Files

### New

| File | Purpose | Est. LOC |
|------|---------|----------|
| `src/commands/pipeline.ts` | `pipelineRunCommand`, `pipelineListCommand`, prompt composition, subprocess orchestration, plan printer | ~350 |
| `src/lib/gate-evaluator.ts` | `evaluateGate()` — single-condition check across 9 operators with dot-path field access | ~80 |
| `src/lib/pipeline-state.ts` | `PipelineState` type, `writePipelineState`, `readPipelineState`, state transition helpers | ~80 |
| `src/__tests__/gate-evaluator.test.ts` | Per-operator + dot-path + edge cases | ~150 |
| `src/__tests__/pipeline-state.test.ts` | File I/O + state transitions | ~80 |
| `src/__tests__/pipeline-command.test.ts` | Integration tests with mocked subprocess | ~150 |

### Modified

| File | Change |
|------|--------|
| `src/cli.ts` | Register `af pipeline` namespace with `run` + `list` subcommands |
| `src/lib/constants.ts` | Add `ENABLE_AF_26 = true` |
| `src/lib/audit.ts` | Extend `AuditEvent` union with `pipeline.start`, `pipeline.phase_start`, `pipeline.phase_complete`, `pipeline.phase_fail`, `pipeline.complete`, `pipeline.fail` |

### Not touched

- `src/spawn-runner.ts` — used as-is via subprocess
- `src/lib/sdk.ts` — unchanged
- `src/lib/pipeline.ts`, `src/lib/artifact-injector.ts`, `src/lib/result-schema.ts` — imported only

## 5. Data Model

### `src/lib/pipeline-state.ts`

```typescript
export type PipelineStatus = 'running' | 'completed' | 'failed';
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type GateResult = 'pass' | 'fail' | 'skipped';

export interface GateFailureRecord {
  field: string;
  operator: string;
  expected?: unknown;
  actual: unknown;
  message: string;
}

export interface PhaseState {
  agent: string;
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  gateResult?: GateResult;
  gateFailure?: GateFailureRecord;
  /** Path to this phase's output dir, for AF-28 convenience */
  outputDir?: string;
}

export interface PipelineState {
  pipeline: string;                       // e.g., "sdlc"
  ticket: string;                         // e.g., "AF-30"
  status: PipelineStatus;
  startedAt: string;
  completedAt?: string;
  currentPhase?: string;                  // only while status === 'running'
  phases: Record<string, PhaseState>;     // keyed by phase.name
  /** Any warnings encountered during injection, collected across all phases */
  warnings?: string[];
}

export function writePipelineState(outputDir: string, state: PipelineState): void;
export function readPipelineState(outputDir: string): PipelineState | null;
export function initPipelineState(pipeline: string, ticket: string, phases: PhaseDefinition[]): PipelineState;
```

State file path: `.af/output/<ticket>/pipeline-state.json`

Note: each phase's own output lives at `.af/output/<ticket>/<agent-slug>/` (AF-25's convention). The pipeline-state.json is a sibling to those phase directories.

### `src/lib/gate-evaluator.ts`

```typescript
import type { GateDefinition, GateOperator } from './pipeline.js';
import type { ResultSchema } from './result-schema.js';
import { getByDotPath } from './artifact-injector.js';

export interface GateEvaluationSuccess {
  passed: true;
}

export interface GateEvaluationFailure {
  passed: false;
  field: string;
  operator: GateOperator;
  expected?: unknown;
  actual: unknown;
  message: string;
}

export type GateEvaluationResult = GateEvaluationSuccess | GateEvaluationFailure;

/**
 * Evaluate a single-condition gate against a phase's result.json.
 *
 * - Dot-path field access (e.g., "metadata.pr_url" → resultJson.metadata.pr_url)
 * - Supports the 9 operators defined in AF-24: eq, neq, exists, not_exists,
 *   contains, gt, gte, lt, lte
 * - Never throws — always returns a result
 *
 * Phases without a gate pass automatically (caller short-circuits).
 */
export function evaluateGate(
  gate: GateDefinition,
  result: ResultSchema,
): GateEvaluationResult;
```

### Gate operator semantics (reference)

| Operator | Passes when | Value required |
|----------|-------------|----------------|
| `eq` | `actual === value` | yes |
| `neq` | `actual !== value` | yes |
| `exists` | `actual !== undefined && actual !== null` | no |
| `not_exists` | `actual === undefined \|\| actual === null` | no |
| `contains` | `String(actual).includes(String(value))` or `Array.isArray(actual) && actual.includes(value)` | yes |
| `gt` / `gte` / `lt` / `lte` | numeric compare; fails if either operand isn't a finite number | yes |

Failure message format: `Gate failed at <field>: expected <op> <value>, got <actual>`. For `exists` operators the message reads `Gate failed at <field>: expected field to exist, got <actual>` (mirrors for `not_exists`).

## 6. CLI Surface

```
af pipeline run <name> --task <ticket> [options]
  --task <ticket>        Required. Task to run the pipeline against.
  -p, --project <prefix> Project prefix (defaults to cwd)
  --dry-run              Print execution plan, don't spawn
  --from <phase>         Resume from <phase>. Earlier phases' result.json
                         files must already exist.

af pipeline list [options]
  -p, --project <prefix> Project prefix (defaults to cwd)
```

### CLI registration (in `src/cli.ts`)

```typescript
import { pipelineRunCommand, pipelineListCommand } from './commands/pipeline.js';

const pipeline = program
  .command('pipeline')
  .description('Pipeline management');

pipeline
  .command('run <name>')
  .description('Run a pipeline end-to-end on a task')
  .requiredOption('--task <ticket>', 'Task ticket to run the pipeline against')
  .option('-p, --project <prefix>', 'Project prefix')
  .option('--dry-run', 'Print execution plan without spawning agents')
  .option('--from <phase>', 'Resume from a specific phase')
  .action(pipelineRunCommand);

pipeline
  .command('list')
  .description('List available pipeline definitions')
  .option('-p, --project <prefix>', 'Project prefix')
  .action(pipelineListCommand);
```

## 7. Implementation Detail — `pipelineRunCommand`

Skeleton (not production code — guidance for the engineer):

```typescript
export async function pipelineRunCommand(
  name: string,
  options: { task: string; project?: string; dryRun?: boolean; from?: string },
): Promise<void> {
  if (!ENABLE_AF_26) { /* exit 1 with message */ }

  // 1. Resolve workspace + project
  const resolved = resolveOrExit(options.project);
  const { afPath, meta } = resolved;
  const projectDir = join(afPath, '..');

  // 2. Load pipeline
  let pipeline: PipelineDefinition;
  try {
    pipeline = loadPipeline(afPath, name);
  } catch (err) {
    console.log(error(err.message));
    const available = listPipelines(afPath);
    if (available.length > 0) {
      console.log(dim(`Available: ${available.join(', ')}`));
    }
    process.exit(1);
  }

  // 3. Resolve task
  const provider = createProvider(afPath, meta);
  const task = await provider.get(options.task.toUpperCase());
  if (!task) { /* error + exit */ }

  // 4. Plan
  const phaseOrder = resolvePhaseOrder(pipeline);
  const startIndex = options.from
    ? validateFromFlag(options.from, phaseOrder, task.ticket, afPath)
    : 0;

  // 5. Dry run?
  if (options.dryRun) {
    printExecutionPlan(pipeline, phaseOrder, startIndex, task.ticket, afPath, projectDir);
    return;
  }

  // 6. Init state + output dir
  const pipelineOutputDir = join(afPath, 'output', task.ticket);
  mkdirSync(pipelineOutputDir, { recursive: true });
  const state = initPipelineState(pipeline.name, task.ticket, phaseOrder);
  // Mark skipped phases (those before startIndex)
  for (let i = 0; i < startIndex; i++) {
    state.phases[phaseOrder[i].name].status = 'skipped';
  }
  writePipelineState(pipelineOutputDir, state);

  // 7. Task → in-progress (best-effort)
  try { await provider.move(task.ticket, 'in-progress'); } catch { /* log but continue */ }

  // 8. Audit pipeline.start
  auditLog(afPath, { event: 'pipeline.start', ticket: task.ticket, actor: 'cli',
    detail: `Pipeline ${name} started`, meta: { pipeline: name, phaseCount: phaseOrder.length } });

  // 9. Inject context
  const ctx = buildInjectionContext(pipeline, task.ticket, afPath, projectDir);
  const allWarnings: string[] = [];

  // 10. Phase loop
  for (let i = startIndex; i < phaseOrder.length; i++) {
    const phase = phaseOrder[i];
    const phaseStart = Date.now();

    state.currentPhase = phase.name;
    state.phases[phase.name].status = 'running';
    state.phases[phase.name].startedAt = new Date().toISOString();
    writePipelineState(pipelineOutputDir, state);
    auditLog(afPath, { event: 'pipeline.phase_start', ticket: task.ticket, agent: phase.agent,
      actor: 'cli', detail: `Phase ${phase.name} started`, meta: { phase: phase.name } });

    // 10a. Resolve injections
    const injResult = resolvePhaseInjections(phase, ctx);
    allWarnings.push(...injResult.warnings);
    if (injResult.warnings.length > 0) {
      for (const w of injResult.warnings) console.log(dim(`  [inject] ${w}`));
    }

    // 10b. Compose prompt
    const systemPrompt = composeSystemPrompt({
      agentSlug: phase.agent,
      projectDir, afPath, task,
      injections: injResult.resolved,
    });

    // 10c. Spawn (synchronous, not detached)
    const phaseOutputDir = join(pipelineOutputDir, phase.agent);
    mkdirSync(phaseOutputDir, { recursive: true });
    const spawnOk = await runPhaseSubprocess({
      systemPrompt, agentSlug: phase.agent, ticket: task.ticket,
      cwd: projectDir, outputDir: phaseOutputDir, afPath,
    });

    // 10d. Load result, evaluate gate
    const phaseResult = loadPhaseResult(phase.name, ctx);
    let gateEval: GateEvaluationResult | null = null;
    let phaseStatus: PhaseStatus = 'completed';

    if (!spawnOk || !phaseResult) {
      phaseStatus = 'failed';
    } else if (phase.gate) {
      gateEval = evaluateGate(phase.gate, phaseResult);
      if (!gateEval.passed) phaseStatus = 'failed';
    }

    const phaseDuration = Date.now() - phaseStart;
    const ps = state.phases[phase.name];
    ps.status = phaseStatus;
    ps.completedAt = new Date().toISOString();
    ps.durationMs = phaseDuration;
    ps.outputDir = relative(afPath, phaseOutputDir);
    if (gateEval) {
      ps.gateResult = gateEval.passed ? 'pass' : 'fail';
      if (!gateEval.passed) {
        ps.gateFailure = {
          field: gateEval.field, operator: gateEval.operator,
          expected: gateEval.expected, actual: gateEval.actual, message: gateEval.message,
        };
      }
    } else if (!phase.gate) {
      ps.gateResult = 'skipped';
    }
    state.currentPhase = undefined;
    writePipelineState(pipelineOutputDir, state);

    // 10e. Decide to continue or stop
    if (phaseStatus === 'failed') {
      auditLog(afPath, { event: 'pipeline.phase_fail', ticket: task.ticket, agent: phase.agent,
        actor: 'cli', detail: ps.gateFailure?.message ?? `Phase ${phase.name} failed`,
        meta: { phase: phase.name, reason: !spawnOk ? 'spawn_error' : (!phaseResult ? 'no_result_json' : 'gate_failure') } });
      state.status = 'failed';
      state.completedAt = new Date().toISOString();
      if (allWarnings.length > 0) state.warnings = allWarnings;
      writePipelineState(pipelineOutputDir, state);
      auditLog(afPath, { event: 'pipeline.fail', ticket: task.ticket, actor: 'cli',
        detail: `Pipeline ${name} failed at phase ${phase.name}`, meta: { phase: phase.name } });
      printFailureSummary(state, phase.name);
      process.exit(1);
    }

    auditLog(afPath, { event: 'pipeline.phase_complete', ticket: task.ticket, agent: phase.agent,
      actor: 'cli', detail: `Phase ${phase.name} completed`, meta: { phase: phase.name, durationMs: phaseDuration } });
  }

  // 11. Complete
  state.status = 'completed';
  state.completedAt = new Date().toISOString();
  if (allWarnings.length > 0) state.warnings = allWarnings;
  writePipelineState(pipelineOutputDir, state);
  auditLog(afPath, { event: 'pipeline.complete', ticket: task.ticket, actor: 'cli',
    detail: `Pipeline ${name} completed`, meta: { pipeline: name } });
  printSuccessSummary(state);
}
```

### `runPhaseSubprocess` — subprocess contract

```typescript
async function runPhaseSubprocess(args: {
  systemPrompt: string;
  agentSlug: string;
  ticket: string;
  cwd: string;
  outputDir: string;
  afPath: string;
}): Promise<boolean> {
  const agent = loadAgent(args.agentSlug);  // import from commands/agent.ts or duplicate
  if (!agent) return false;

  const config = loadConfig();

  const spawnConfig = {
    systemPrompt: args.systemPrompt,
    taskPrompt: 'Execute the task described in the system prompt. Follow all instructions, check off acceptance criteria as you complete them, and log your work.',
    model: agent.meta.model || config.defaults.model,
    maxTurns: agent.meta.maxTurns || config.defaults.max_turns,
    tools: agent.meta.tools || undefined,
    cwd: args.cwd,
    outputDir: args.outputDir,
    ticket: args.ticket,
    agentSlug: args.agentSlug,
    afPath: args.afPath,
  };

  const configFile = join(args.outputDir, 'config.json');
  writeFileSync(configFile, JSON.stringify(spawnConfig, null, 2));

  const runnerPath = join(import.meta.dirname, '..', 'spawn-runner.js');
  const logFile = join(args.outputDir, 'agent.log');
  const out = openSync(logFile, 'a');

  return new Promise<boolean>((resolve) => {
    const child = spawn('node', [runnerPath, configFile], {
      cwd: args.cwd,
      stdio: ['ignore', out, out],     // NOT detached — pipeline waits
      env: { ...process.env, CLAUDECODE: undefined },
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}
```

Note: `loadAgent` is currently a non-exported helper in `commands/agent.ts`. The engineer should export it (or duplicate the ~6-line helper in `pipeline.ts`). Exporting is cleaner.

### `composeSystemPrompt` — prompt assembly

Replicates `agentSpawnCommand`'s composition with a new optional section:

```typescript
function composeSystemPrompt(args: {
  agentSlug: string;
  projectDir: string;
  afPath: string;
  task: Task;
  injections: ResolvedInjection[];
}): string {
  const agent = loadAgent(args.agentSlug);
  const projectFile = join(args.afPath, 'project.md');
  const projectContent = existsSync(projectFile) ? readFileSync(projectFile, 'utf-8') : '';

  // Context dir
  const contextDir = join(args.afPath, 'context');
  let contextContent = '';
  if (existsSync(contextDir)) {
    const contextFiles = readdirSync(contextDir).filter(f => f.endsWith('.md'));
    for (const f of contextFiles) {
      contextContent += `\n--- ${f} ---\n${readFileSync(join(contextDir, f), 'utf-8')}\n`;
    }
  }

  const injectionSection = composeInjectionPrompt(args.injections);  // '' when empty

  return [
    agent.content.trim(),
    '',
    '---',
    '',
    '## Project',
    projectContent.trim(),
    '',
    '## Task',
    readFileSync(args.task.filePath!, 'utf-8').trim(),
    injectionSection ? `\n${injectionSection}` : '',
    contextContent ? `\n## Context\n${contextContent.trim()}` : '',
  ].filter(Boolean).join('\n');
}
```

### `--from` validation

```typescript
function validateFromFlag(
  fromPhase: string,
  phaseOrder: PhaseDefinition[],
  ticket: string,
  afPath: string,
): number {
  const idx = phaseOrder.findIndex(p => p.name === fromPhase);
  if (idx < 0) {
    const available = phaseOrder.map(p => p.name).join(', ');
    throw new Error(`--from: unknown phase "${fromPhase}" (available: ${available})`);
  }
  // Every earlier phase's result.json must exist
  for (let i = 0; i < idx; i++) {
    const phase = phaseOrder[i];
    const rp = join(afPath, 'output', ticket, phase.agent, 'result.json');
    if (!existsSync(rp)) {
      throw new Error(
        `--from ${fromPhase}: prior phase "${phase.name}" has no result.json at ${rp}. ` +
        `Run the earlier phases first, or start the pipeline from an earlier phase.`,
      );
    }
  }
  return idx;
}
```

## 8. Gate Evaluator — reference implementation

```typescript
export function evaluateGate(gate: GateDefinition, result: ResultSchema): GateEvaluationResult {
  const actual = getByDotPath(result as unknown as Record<string, unknown>, gate.field);

  const mkFail = (message: string): GateEvaluationFailure => ({
    passed: false, field: gate.field, operator: gate.operator,
    expected: gate.value, actual, message,
  });

  switch (gate.operator) {
    case 'exists':
      return actual !== undefined && actual !== null
        ? { passed: true }
        : mkFail(`Gate failed at ${gate.field}: expected field to exist, got ${JSON.stringify(actual)}`);
    case 'not_exists':
      return actual === undefined || actual === null
        ? { passed: true }
        : mkFail(`Gate failed at ${gate.field}: expected field to not exist, got ${JSON.stringify(actual)}`);
    case 'eq':
      return actual === gate.value
        ? { passed: true }
        : mkFail(`Gate failed at ${gate.field}: expected eq ${JSON.stringify(gate.value)}, got ${JSON.stringify(actual)}`);
    case 'neq':
      return actual !== gate.value
        ? { passed: true }
        : mkFail(`Gate failed at ${gate.field}: expected neq ${JSON.stringify(gate.value)}, got ${JSON.stringify(actual)}`);
    case 'contains': {
      const ok = Array.isArray(actual)
        ? actual.includes(gate.value)
        : typeof actual === 'string' && typeof gate.value !== 'undefined'
          ? actual.includes(String(gate.value))
          : false;
      return ok
        ? { passed: true }
        : mkFail(`Gate failed at ${gate.field}: expected to contain ${JSON.stringify(gate.value)}, got ${JSON.stringify(actual)}`);
    }
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = Number(actual), v = Number(gate.value);
      if (!Number.isFinite(a) || !Number.isFinite(v)) {
        return mkFail(`Gate failed at ${gate.field}: ${gate.operator} requires numeric operands, got actual=${JSON.stringify(actual)} value=${JSON.stringify(gate.value)}`);
      }
      const ok = gate.operator === 'gt'  ? a >  v
               : gate.operator === 'gte' ? a >= v
               : gate.operator === 'lt'  ? a <  v
               : /* lte */                 a <= v;
      return ok
        ? { passed: true }
        : mkFail(`Gate failed at ${gate.field}: expected ${gate.operator} ${v}, got ${a}`);
    }
  }
}
```

## 9. Worked example — `sdlc.yaml` on AF-30

Pipeline (existing `.af/pipelines/sdlc.yaml`):

```yaml
phases:
  - name: design
    agent: architect
    gate: { field: status, operator: eq, value: complete }
  - name: implement
    agent: engineer
    requires: [design]
    inject: [{ from: design, artifact: "docs/designs/{ticket}*.md", as: design_document }]
    gate: { field: metadata.pr_url, operator: exists }
  - name: verify
    agent: qa
    requires: [implement]
    inject:
      - { from: design, artifact: "docs/designs/{ticket}*.md", as: design_document }
      - { from: implement, artifact: metadata.pr_url, as: pr_to_review }
    gate: { field: metadata.verdict, operator: eq, value: PASS }
```

Flow when running `af pipeline run sdlc --task AF-30`:

1. **Phase `design`** — no injections, spawns `architect` → produces `docs/designs/AF-30-*.md` + `result.json` with `status: "complete"`. Gate `status eq complete` → PASS.
2. **Phase `implement`** — injects the design doc via file glob → spawns `engineer` → produces PR, writes `result.json` with `metadata.pr_url`. Gate `metadata.pr_url exists` → PASS.
3. **Phase `verify`** — injects design doc (file) + PR URL (dot-path from implement's result.json) → spawns `qa` → writes `result.json` with `metadata.verdict: "PASS"`. Gate `metadata.verdict eq PASS` → PASS.
4. Pipeline complete.

Filesystem after success:

```
.af/output/AF-30/
  pipeline-state.json                 (AF-26)
  architect/
    status.json, result.md, result.json, agent.log, config.json
  engineer/
    status.json, result.md, result.json, agent.log, config.json
  qa/
    status.json, result.md, result.json, agent.log, config.json
```

## 10. New audit events

Extend `AuditEvent` union in `src/lib/audit.ts`:

```typescript
export type AuditEvent =
  | /* existing events */
  | 'pipeline.start'
  | 'pipeline.phase_start'
  | 'pipeline.phase_complete'
  | 'pipeline.phase_fail'
  | 'pipeline.complete'
  | 'pipeline.fail';
```

Meta fields the runner should include:

| Event | Meta |
|-------|------|
| `pipeline.start` | `pipeline`, `phaseCount`, `from?` |
| `pipeline.phase_start` | `phase` |
| `pipeline.phase_complete` | `phase`, `durationMs`, `gateResult` |
| `pipeline.phase_fail` | `phase`, `reason` (one of `spawn_error`, `no_result_json`, `gate_failure`), `gateFailure?` |
| `pipeline.complete` | `pipeline`, `totalDurationMs` |
| `pipeline.fail` | `pipeline`, `phase`, `reason` |

## 11. Feature flag

Add to `src/lib/constants.ts`:

```typescript
/** AF-26: Pipeline run command. When false, `af pipeline run` refuses to execute. */
export const ENABLE_AF_26 = true;
```

Default `true` because the command namespace is net-new — no risk of breaking existing flows.

## 12. Error handling & exit codes

| Condition | Behavior | Exit |
|-----------|----------|------|
| Pipeline YAML missing/invalid | Print error + list available pipelines (`listPipelines`) | 1 |
| Task not found | Print error | 1 |
| Task is blocked | Refuse, ask user to unblock first (mirrors `agentSpawnCommand`) | 1 |
| Circular dependency in pipeline | Caught by `validatePipeline` inside `loadPipeline` | 1 |
| `--from <phase>` unknown | List available phases, exit | 1 |
| `--from <phase>` prior `result.json` missing | Print which phase, exit before spawning | 1 |
| Subprocess exits non-zero | Mark phase `failed`, record reason `spawn_error`, stop pipeline | 1 |
| Agent completed but `result.json` missing | Mark phase `failed`, record reason `no_result_json`, stop | 1 |
| Gate fails | Mark phase `failed`, record `gateFailure`, reason `gate_failure`, stop | 1 |
| All phases pass | Print summary, exit 0 | 0 |

## 13. Security

- **Pipeline name:** path-traversal guard already enforced by `loadPipeline` (rejects `/`, `\`, `..`)
- **Ticket:** validated by `provider.get()` — only returns tasks from the active project
- **`--from` phase name:** checked against `phaseOrder` — no filesystem implication beyond `.af/output/<ticket>/...` which is already project-scoped
- **Gate `value`:** compared only, never evaluated or executed
- **Subprocess env:** inherits `process.env` minus `CLAUDECODE`, same pattern as existing spawn path
- **Injected file content:** bounded by AF-25's 100KB-per-file / 200KB-total limits

## 14. Testing strategy

### Unit — `gate-evaluator.test.ts`

Per operator with:
- `eq` — pass/fail on string/number/boolean equality
- `neq` — pass/fail
- `exists` / `not_exists` — undefined, null, empty string, 0, false all covered
- `contains` — string substring, array membership, non-array/string actual
- `gt` / `gte` / `lt` / `lte` — numeric coercion; non-numeric operand → fail with clear message
- Dot-path field access — nested paths, missing paths, array indexing
- Failure message shape — contains field, operator, expected, actual

### Unit — `pipeline-state.test.ts`

- `writePipelineState` creates parent dir and writes valid JSON
- `readPipelineState` returns null when file missing
- `initPipelineState` produces all phases with `status: 'pending'`
- Round-trip write/read preserves all fields

### Integration — `pipeline-command.test.ts`

Using a `tmp` directory + mocked subprocess (`child_process.spawn` stubbed to immediately write result.json):

- `--dry-run` prints plan, does not spawn, does not write state
- `--from <phase>` fails cleanly when prior result.json absent
- Full pipeline run with stubbed phases:
  - All gates pass → state file has status `completed`, all phases `completed`, gate results `pass`
  - Middle phase gate fails → state file has status `failed`, later phases remain `pending`, `gateFailure` populated
  - Subprocess exits non-zero → phase status `failed`, reason recorded
- Audit events emitted in correct order

### Manual / smoke

The engineer should run at least one of these after the build:

- `af pipeline list` — lists `sdlc`
- `af pipeline run sdlc --task AF-30 --dry-run` — prints plan (AF-30 doesn't need to exist for dry-run of list; but for run it does; pick an open test ticket)
- Optionally, with `ENABLE_AF_26=false`, verify refusal message

## 14a. Output formatting (CLI UX)

Model after the existing `af agent status` / `af status` conventions. Use `heading()`, `success()`, `error()`, `dim()` from `src/lib/format.js` plus `chalk.bold` for phase names.

**Icons:** ✅ completed · ❌ failed · ⏸️ pending · ⏭️ skipped · 🔄 running

**Duration formatter:** helper local to `pipeline.ts` — `Xm Ys` for >60s, `Ys` otherwise.

### `printExecutionPlan(pipeline, phaseOrder, startIndex, ticket, afPath, projectDir)` — `--dry-run`

```
Pipeline: sdlc — AF-30
Phases: 3  (dry run — no agents will be spawned)

  1. design      architect
     gate: status eq "complete"

  2. implement   engineer        requires: design
     inject:
       - design_document  ← design phase  (file glob: docs/designs/AF-30*.md)
     gate: metadata.pr_url exists

  3. verify      qa              requires: implement
     inject:
       - design_document  ← design phase  (file glob: docs/designs/AF-30*.md)
       - pr_to_review     ← implement phase  (dot-path: metadata.pr_url)
     gate: metadata.verdict eq "PASS"
```

- Phase number + `chalk.bold(phase.name)` + agent slug on the header line.
- Secondary lines in `dim()`.
- If `--from <phase>` set: prefix phases before `startIndex` with `~` and append ` (skipped)`.
- For each inject: show label, source phase, and detected type (via `isFileGlobArtifact()`) with the expanded artifact string (use `expandTicketPlaceholder`).
- Gate line shows `<field> <operator> <value?>` — omit value for `exists`/`not_exists`.

### `printSuccessSummary(state)` — pipeline finished successfully

```
✓ Pipeline sdlc completed for AF-30 (14m 22s)

  ✅  design      architect   3m 12s   gate: pass
  ✅  implement   engineer    8m 47s   gate: pass
  ✅  verify      qa          2m 23s   gate: pass

  Output: .af/output/AF-30/
```

- Header line uses `success()`.
- Per-phase row: icon, bold phase name (padded), agent slug (dim), duration (dim), gate result.
- If any phase has `status === 'skipped'`, show ⏭️ and `skipped` instead of a duration.
- Total duration = `completedAt - startedAt`.
- Print the pipeline output directory at the bottom.

### `printFailureSummary(state, failedPhase)` — pipeline stopped

```
✗ Pipeline sdlc failed at phase "implement" for AF-30

  ✅  design      architect   3m 12s   gate: pass
  ❌  implement   engineer    8m 47s   gate: fail
       Gate failed at metadata.pr_url: expected field to exist, got undefined
  ⏸️   verify      qa          pending

  State: .af/output/AF-30/pipeline-state.json
  Log:   .af/output/AF-30/engineer/agent.log
```

- Header uses `error()`.
- Completed phases shown with their gate result.
- The failing phase shows its `gateFailure.message` (or `"spawn exited non-zero"` / `"result.json not written"` for the other two failure reasons — reason is on `PhaseState` via the audit meta).
- Later phases remain ⏸️ `pending`.
- Bottom lines point to the state file and the failing phase's log so the user can go investigate immediately.

## 15. File-by-file notes for the engineer

1. **`src/lib/gate-evaluator.ts`** — new. Import `getByDotPath` from `./artifact-injector.js` (already exported). Pure; no filesystem.
2. **`src/lib/pipeline-state.ts`** — new. Uses `fs.writeFileSync` / `readFileSync` / `existsSync`. `writePipelineState` writes pretty-printed JSON (2-space indent).
3. **`src/lib/audit.ts`** — only change is extending the `AuditEvent` union.
4. **`src/lib/constants.ts`** — add `ENABLE_AF_26 = true` under the AF-25 flag.
5. **`src/commands/agent.ts`** — export `loadAgent`, `AgentFile`, and `AgentMeta` (currently module-private). Three one-line changes. The current signature at `src/commands/agent.ts:34` is `function loadAgent(slug: string): AgentFile | null` — just add `export`.
6. **`src/commands/pipeline.ts`** — new. The bulk of the work. Imports:
   ```
   from './commands/agent.js'         — loadAgent (after export)
   from '../lib/config.js'            — loadConfig
   from '../lib/workspace.js'         — resolveProject
   from '../lib/provider-factory.js'  — createProvider
   from '../lib/pipeline.js'          — loadPipeline, listPipelines, resolvePhaseOrder, PhaseDefinition, PipelineDefinition
   from '../lib/artifact-injector.js' — buildInjectionContext, resolvePhaseInjections, composeInjectionPrompt, loadPhaseResult
   from '../lib/gate-evaluator.js'    — evaluateGate, GateEvaluationResult
   from '../lib/pipeline-state.js'    — writePipelineState, initPipelineState, PipelineState, PhaseStatus
   from '../lib/audit.js'             — auditLog
   from '../lib/format.js'            — heading, success, error, dim
   from '../lib/constants.js'         — ENABLE_AF_26
   node:child_process, node:fs, node:path
   ```
7. **`src/cli.ts`** — register the `pipeline` subcommand namespace.

### Conventions confirmed (clarifications from engineer review)

- **Subprocess env:** use `env: { ...process.env, CLAUDECODE: undefined }` (matches the 3 existing sites in `agent.ts`). Do **not** switch to `delete` — Node treats `undefined` values as "unset for the child," same effective behavior, and the codebase uses this pattern consistently.
- **Task type import:** `import type { Task } from '../lib/task-provider.js';` (ESM `.js` extension required).
- **Catch blocks:** new code should narrow with `const msg = err instanceof Error ? err.message : String(err);` rather than `catch (err: any)`. The existing `sync.ts` uses `any`; don't copy that pattern.

## 16. Dependencies

| Dependency | Type | Notes |
|-----------|------|-------|
| AF-23 (merged) | Import | `ResultSchema`, `result.json` format |
| AF-24 (merged) | Import | `loadPipeline`, `listPipelines`, `resolvePhaseOrder`, `GateDefinition`, `PhaseDefinition`, `PipelineDefinition`, `GateOperator` |
| AF-25 (PR #3 open) | Import | `buildInjectionContext`, `resolvePhaseInjections`, `composeInjectionPrompt`, `loadPhaseResult`, `getByDotPath` |
| `spawn-runner.js` (existing) | Subprocess contract | Config shape is already documented in that file |
| Node built-ins | `child_process.spawn`, `fs`, `path` | — |

**No new npm dependencies.**

**Merge order:** AF-25 PR #3 must merge before AF-26 can merge (otherwise compile will fail on missing exports).

## 17. Design decisions

### D1 — Reuse `spawn-runner.js` via subprocess (don't call `runAgent` inline)

spawn-runner already handles status.json, result.md/result.json, crash log, timeout, audit `spawn.*` events, and Loka activity posting. Reimplementing that inline would duplicate ~150 lines. The pipeline runner spawns the subprocess **non-detached** and awaits its close event. Subprocess overhead (~100ms × number of phases) is negligible.

### D2 — Prompt composition in `pipeline.ts`, not `agent.ts`

`agentSpawnCommand`'s prompt layout is `agent + project + task + context`. The pipeline needs to splice `## Injected Artifacts` between `## Task` and `## Context`. Rather than teach `agentSpawnCommand` about pipelines, `pipeline.ts` does its own composition (~20 lines of duplication). Keeps both paths independent and easy to reason about.

### D3 — Synchronous, not detached

The pipeline *is* the long-running process. If the user wants it in the background, they `nohup af pipeline run … &`. Observability is provided via `pipeline-state.json` (AF-28 reads it). No polling loop needed.

### D4 — Gate evaluator scoped to single condition (v1)

The 9 operators in AF-24's `GateDefinition` are enough for the `sdlc.yaml` pipeline and all plausible near-term pipelines. AF-27 layers compound gates (`all`/`any`), regex, and retry on top. By keeping AF-26 simple we get to a working pipeline runner faster; AF-27 doesn't require us to go back and refactor because the gate type stays compatible.

### D5 — Minimal task status transitions

On pipeline start: `→ in-progress`. Otherwise the pipeline is status-agnostic. The last agent (qa, deploymanager, etc.) already calls `af task move` in its own workflow. This keeps pipelines generic — a pipeline author doesn't have to encode "which phase moves the task to ready-for-qa" into YAML.

### D6 — Output directory keyed by agent slug (not phase name)

Matches AF-25's `loadPhaseResult()` convention: `.af/output/<ticket>/<agent-slug>/result.json`. Changing this to `<phase>-<agent>` would break AF-25 integration with zero benefit for v1. Known limitation: same agent in two phases collides. Documented under risks; v2 fix if ever needed.

### D7 — `--from` requires prior result.json files

Prevents silently running phases with empty injections. Hard-fails early with a clear message pointing the user to either run earlier phases first or pick an earlier `--from` value.

## 18. Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Same agent slug in multiple phases → output dir collision | Low | Precondition: distinct agent slugs per phase. Documented. v2 could key by `<phase>-<agent>`. |
| Pipeline runner crashes mid-run, leaving task as `in-progress` | Low | Acceptable for v1 — `pipeline-state.json` records last-known state; user or retry run recovers. Audit log records `pipeline.start` with no corresponding `pipeline.complete`/`fail`. |
| Agent produces synthetic `result.json` (didn't emit `result-json` block) | Medium | Gate evaluates against the synthetic — will typically fail (no metadata). Failure message is clear. Engineer should log a visible warning when `result._synthetic === true`. |
| Subprocess hangs (exceeds default 15m timeout) | Low | `spawn-runner.js` already has a timeout guard. Pipeline runner sees non-zero exit → marks failed. |
| Very large injected artifact exceeds prompt token limits | Low | AF-25's 100KB/200KB limits already mitigate. |

## 19. Implementation role

**ENGINEER** — TypeScript library + CLI. No frontend. No web.

## 20. Complexity

**Medium** (matches backlog estimate). Highest integration count in the series, but no net-new invention — every building block exists. Total net-new code is ~700 LOC split across three small library files and one command file, with unit + integration tests.
