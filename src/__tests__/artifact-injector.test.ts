/**
 * AF-25: Unit tests for artifact-injector.ts
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run: npx tsx --test src/__tests__/artifact-injector.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import type { InjectDefinition, PhaseDefinition, PipelineDefinition } from '../lib/pipeline.js';
import type { ResultSchema } from '../lib/result-schema.js';
import {
  isFileGlobArtifact,
  expandTicketPlaceholder,
  getByDotPath,
  resolveFileGlob,
  resolveDotPath,
  loadPhaseResult,
  resolveInjection,
  resolvePhaseInjections,
  composeInjectionPrompt,
  buildInjectionContext,
  type InjectionContext,
  type ResolvedInjection,
} from '../lib/artifact-injector.js';

// ============================================================
// Helpers
// ============================================================

const TMP_DIR = join(process.cwd(), '.af-test-artifact-injector');
const PROJECT_DIR = join(TMP_DIR, 'project');
const AF_PATH = join(PROJECT_DIR, '.af');

function makeContext(overrides?: Partial<InjectionContext>): InjectionContext {
  return {
    ticket: 'AF-30',
    afPath: AF_PATH,
    projectDir: PROJECT_DIR,
    phaseAgentMap: new Map([
      ['design', 'architect'],
      ['implement', 'engineer'],
      ['verify', 'qa'],
    ]),
    ...overrides,
  };
}

function makeResultJson(overrides?: Partial<ResultSchema>): ResultSchema {
  return {
    status: 'complete',
    summary: 'Design complete',
    artifacts: [{ type: 'design_document', path: 'docs/designs/AF-30-webhook.md' }],
    metadata: { pr_url: 'https://github.com/org/repo/pull/42' },
    ...overrides,
  };
}

function writeResultJson(phaseName: string, agentSlug: string, result: ResultSchema): void {
  const dir = join(AF_PATH, 'output', 'AF-30', agentSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result), 'utf-8');
}

// ============================================================
// Setup / Teardown
// ============================================================

function setup() {
  mkdirSync(PROJECT_DIR, { recursive: true });
  mkdirSync(AF_PATH, { recursive: true });
}

function teardown() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

// ============================================================
// isFileGlobArtifact
// ============================================================

describe('isFileGlobArtifact', () => {
  it('returns true for paths with /', () => {
    assert.equal(isFileGlobArtifact('docs/designs/{ticket}*.md'), true);
    assert.equal(isFileGlobArtifact('some/path.md'), true);
  });

  it('returns true for patterns with *', () => {
    assert.equal(isFileGlobArtifact('*.md'), true);
  });

  it('returns true for patterns with {ticket}', () => {
    assert.equal(isFileGlobArtifact('{ticket}-report.md'), true);
  });

  it('returns false for dot-path strings', () => {
    assert.equal(isFileGlobArtifact('metadata.pr_url'), false);
    assert.equal(isFileGlobArtifact('status'), false);
  });

  it('returns true when multiple indicators present', () => {
    assert.equal(isFileGlobArtifact('docs/designs/{ticket}*.md'), true);
  });
});

// ============================================================
// expandTicketPlaceholder
// ============================================================

describe('expandTicketPlaceholder', () => {
  it('replaces {ticket} with the ticket string', () => {
    assert.equal(
      expandTicketPlaceholder('docs/{ticket}*.md', 'AF-30'),
      'docs/AF-30*.md',
    );
  });

  it('returns unchanged string when no placeholder present', () => {
    assert.equal(
      expandTicketPlaceholder('no-placeholder.md', 'AF-30'),
      'no-placeholder.md',
    );
  });

  it('replaces multiple occurrences', () => {
    assert.equal(
      expandTicketPlaceholder('{ticket}-{ticket}.md', 'AF-30'),
      'AF-30-AF-30.md',
    );
  });
});

// ============================================================
// getByDotPath
// ============================================================

describe('getByDotPath', () => {
  it('resolves top-level key', () => {
    assert.equal(getByDotPath({ status: 'complete' }, 'status'), 'complete');
  });

  it('resolves nested key', () => {
    assert.equal(
      getByDotPath({ metadata: { pr_url: 'http://example.com' } }, 'metadata.pr_url'),
      'http://example.com',
    );
  });

  it('returns undefined for missing path', () => {
    assert.equal(getByDotPath({}, 'metadata.pr_url'), undefined);
  });

  it('returns undefined when traversing through null', () => {
    assert.equal(getByDotPath({ a: null }, 'a.b'), undefined);
  });

  it('resolves deep paths (3+ levels)', () => {
    assert.equal(getByDotPath({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
  });

  it('returns undefined when traversing through a primitive', () => {
    assert.equal(getByDotPath({ a: 'string' }, 'a.b'), undefined);
  });

  it('returns the object itself for nested objects', () => {
    const nested = { x: 1 };
    assert.deepEqual(getByDotPath({ a: nested }, 'a'), nested);
  });
});

// ============================================================
// resolveFileGlob
// ============================================================

describe('resolveFileGlob', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('resolves a single matching file', () => {
    const designDir = join(PROJECT_DIR, 'docs', 'designs');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'AF-30-webhook.md'), '# Design', 'utf-8');

    const result = resolveFileGlob('docs/designs/{ticket}*.md', makeContext());
    assert.ok(result);
    assert.equal(result.content, '# Design');
    assert.deepEqual(result.paths, ['docs/designs/AF-30-webhook.md']);
  });

  it('resolves multiple matching files joined with separator', () => {
    const designDir = join(PROJECT_DIR, 'docs', 'designs');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'AF-30-api.md'), '# API', 'utf-8');
    writeFileSync(join(designDir, 'AF-30-webhook.md'), '# Webhook', 'utf-8');

    const result = resolveFileGlob('docs/designs/{ticket}*.md', makeContext());
    assert.ok(result);
    assert.equal(result.paths.length, 2);
    assert.ok(result.content.includes('# API'));
    assert.ok(result.content.includes('# Webhook'));
    assert.ok(result.content.includes('\n\n---\n\n'));
  });

  it('returns null when no files match', () => {
    const designDir = join(PROJECT_DIR, 'docs', 'designs');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'AF-99-other.md'), '# Other', 'utf-8');

    const result = resolveFileGlob('docs/designs/{ticket}*.md', makeContext());
    assert.equal(result, null);
  });

  it('returns null when directory does not exist', () => {
    const result = resolveFileGlob('nonexistent/dir/{ticket}*.md', makeContext());
    assert.equal(result, null);
  });

  it('skips files over the size limit', () => {
    const designDir = join(PROJECT_DIR, 'docs', 'designs');
    mkdirSync(designDir, { recursive: true });

    // Write a file over 100KB
    const largeContent = 'x'.repeat(101 * 1024);
    writeFileSync(join(designDir, 'AF-30-large.md'), largeContent, 'utf-8');

    // Write a small file that should still match
    writeFileSync(join(designDir, 'AF-30-small.md'), '# Small', 'utf-8');

    const result = resolveFileGlob('docs/designs/{ticket}*.md', makeContext());
    assert.ok(result);
    assert.equal(result.paths.length, 1);
    assert.deepEqual(result.paths, ['docs/designs/AF-30-small.md']);
  });

  it('supports ? wildcard', () => {
    const dir = join(PROJECT_DIR, 'docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AF-30.md'), '# Match', 'utf-8');
    writeFileSync(join(dir, 'AF-3X.md'), '# No match', 'utf-8');

    const result = resolveFileGlob('docs/AF-3?.md', makeContext());
    assert.ok(result);
    assert.equal(result.paths.length, 2); // both match AF-3?.md
  });

  it('skips directories in matches', () => {
    const dir = join(PROJECT_DIR, 'docs', 'designs');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'AF-30-subdir.md'), { recursive: true }); // directory, not file
    writeFileSync(join(dir, 'AF-30-real.md'), '# Real', 'utf-8');

    const result = resolveFileGlob('docs/designs/{ticket}*.md', makeContext());
    assert.ok(result);
    assert.equal(result.paths.length, 1);
    assert.deepEqual(result.paths, ['docs/designs/AF-30-real.md']);
  });
});

// ============================================================
// resolveDotPath
// ============================================================

describe('resolveDotPath', () => {
  it('returns string value as-is', () => {
    const result = resolveDotPath('status', makeResultJson());
    assert.equal(result, 'complete');
  });

  it('returns nested string value', () => {
    const result = resolveDotPath('metadata.pr_url', makeResultJson());
    assert.equal(result, 'https://github.com/org/repo/pull/42');
  });

  it('returns number as String()', () => {
    const rj = makeResultJson({ metadata: { count: 7 } });
    const result = resolveDotPath('metadata.count', rj);
    assert.equal(result, '7');
  });

  it('returns boolean as String()', () => {
    const rj = makeResultJson({ metadata: { passed: true } });
    const result = resolveDotPath('metadata.passed', rj);
    assert.equal(result, 'true');
  });

  it('returns object as JSON', () => {
    const rj = makeResultJson({ metadata: { details: { a: 1, b: 2 } } });
    const result = resolveDotPath('metadata.details', rj);
    assert.equal(result, JSON.stringify({ a: 1, b: 2 }, null, 2));
  });

  it('returns array as JSON', () => {
    const rj = makeResultJson({ metadata: { items: [1, 2, 3] } });
    const result = resolveDotPath('metadata.items', rj);
    assert.equal(result, JSON.stringify([1, 2, 3], null, 2));
  });

  it('returns null for missing path', () => {
    const result = resolveDotPath('metadata.nonexistent', makeResultJson());
    assert.equal(result, null);
  });

  it('returns null for null value', () => {
    const rj = makeResultJson({ metadata: { empty: null } });
    const result = resolveDotPath('metadata.empty', rj);
    assert.equal(result, null);
  });
});

// ============================================================
// loadPhaseResult
// ============================================================

describe('loadPhaseResult', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('loads result.json for a known phase', () => {
    const rj = makeResultJson();
    writeResultJson('design', 'architect', rj);

    const result = loadPhaseResult('design', makeContext());
    assert.ok(result);
    assert.equal(result.status, 'complete');
    assert.equal(result.summary, 'Design complete');
  });

  it('returns null for unknown phase', () => {
    const result = loadPhaseResult('nonexistent', makeContext());
    assert.equal(result, null);
  });

  it('returns null when result.json does not exist', () => {
    const result = loadPhaseResult('design', makeContext());
    assert.equal(result, null);
  });

  it('returns null for malformed JSON', () => {
    const dir = join(AF_PATH, 'output', 'AF-30', 'architect');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.json'), '{ broken json', 'utf-8');

    const result = loadPhaseResult('design', makeContext());
    assert.equal(result, null);
  });
});

// ============================================================
// resolveInjection
// ============================================================

describe('resolveInjection', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('resolves a file-glob injection', () => {
    const designDir = join(PROJECT_DIR, 'docs', 'designs');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'AF-30-webhook.md'), '# Design Content', 'utf-8');

    const inject: InjectDefinition = {
      from: 'design',
      artifact: 'docs/designs/{ticket}*.md',
      as: 'design_document',
    };

    const { resolved, warnings } = resolveInjection(inject, makeContext());
    assert.ok(resolved);
    assert.equal(resolved.label, 'design_document');
    assert.equal(resolved.content, '# Design Content');
    assert.ok(resolved.source.includes('design phase'));
    assert.ok(resolved.source.includes('AF-30-webhook.md'));
    assert.equal(warnings.length, 0);
  });

  it('warns when file-glob matches nothing', () => {
    const designDir = join(PROJECT_DIR, 'docs', 'designs');
    mkdirSync(designDir, { recursive: true });

    const inject: InjectDefinition = {
      from: 'design',
      artifact: 'docs/designs/{ticket}*.md',
      as: 'design_document',
    };

    const { resolved, warnings } = resolveInjection(inject, makeContext());
    assert.equal(resolved, null);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('no files matched glob'));
    assert.ok(warnings[0].includes('AF-30'));
  });

  it('resolves a dot-path injection', () => {
    writeResultJson('implement', 'engineer', makeResultJson());

    const inject: InjectDefinition = {
      from: 'implement',
      artifact: 'metadata.pr_url',
      as: 'pr_to_review',
    };

    const { resolved, warnings } = resolveInjection(inject, makeContext());
    assert.ok(resolved);
    assert.equal(resolved.label, 'pr_to_review');
    assert.equal(resolved.content, 'https://github.com/org/repo/pull/42');
    assert.equal(resolved.source, 'implement phase — metadata.pr_url');
    assert.equal(warnings.length, 0);
  });

  it('warns when result.json is missing for dot-path', () => {
    const inject: InjectDefinition = {
      from: 'implement',
      artifact: 'metadata.pr_url',
      as: 'pr_to_review',
    };

    const { resolved, warnings } = resolveInjection(inject, makeContext());
    assert.equal(resolved, null);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('result.json not found'));
  });

  it('warns when dot-path does not exist in result.json', () => {
    writeResultJson('implement', 'engineer', makeResultJson({ metadata: {} }));

    const inject: InjectDefinition = {
      from: 'implement',
      artifact: 'metadata.pr_url',
      as: 'pr_to_review',
    };

    const { resolved, warnings } = resolveInjection(inject, makeContext());
    assert.equal(resolved, null);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('dot-path'));
    assert.ok(warnings[0].includes('not found in result.json'));
  });
});

// ============================================================
// resolvePhaseInjections
// ============================================================

describe('resolvePhaseInjections', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty result for phase with no inject', () => {
    const phase: PhaseDefinition = { name: 'design', agent: 'architect' };
    const { resolved, warnings } = resolvePhaseInjections(phase, makeContext());
    assert.equal(resolved.length, 0);
    assert.equal(warnings.length, 0);
  });

  it('returns empty result for phase with empty inject array', () => {
    const phase: PhaseDefinition = { name: 'design', agent: 'architect', inject: [] };
    const { resolved, warnings } = resolvePhaseInjections(phase, makeContext());
    assert.equal(resolved.length, 0);
    assert.equal(warnings.length, 0);
  });

  it('resolves one successful injection', () => {
    writeResultJson('implement', 'engineer', makeResultJson());

    const phase: PhaseDefinition = {
      name: 'verify',
      agent: 'qa',
      requires: ['implement'],
      inject: [
        { from: 'implement', artifact: 'metadata.pr_url', as: 'pr_to_review' },
      ],
    };

    const { resolved, warnings } = resolvePhaseInjections(phase, makeContext());
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].label, 'pr_to_review');
    assert.equal(warnings.length, 0);
  });

  it('handles mixed success and failure', () => {
    // Only implement has a result.json, design does not
    writeResultJson('implement', 'engineer', makeResultJson());

    const phase: PhaseDefinition = {
      name: 'verify',
      agent: 'qa',
      requires: ['design', 'implement'],
      inject: [
        { from: 'design', artifact: 'docs/designs/{ticket}*.md', as: 'design_document' },
        { from: 'implement', artifact: 'metadata.pr_url', as: 'pr_to_review' },
      ],
    };

    const { resolved, warnings } = resolvePhaseInjections(phase, makeContext());
    assert.equal(resolved.length, 1); // only pr_url resolved
    assert.equal(resolved[0].label, 'pr_to_review');
    assert.equal(warnings.length, 1); // design glob failed
  });

  it('collects warnings from all failed injections', () => {
    const phase: PhaseDefinition = {
      name: 'verify',
      agent: 'qa',
      requires: ['design', 'implement'],
      inject: [
        { from: 'design', artifact: 'docs/designs/{ticket}*.md', as: 'design_document' },
        { from: 'implement', artifact: 'metadata.pr_url', as: 'pr_to_review' },
      ],
    };

    const { resolved, warnings } = resolvePhaseInjections(phase, makeContext());
    assert.equal(resolved.length, 0);
    assert.equal(warnings.length, 2);
  });

  it('resolves both file-glob and dot-path in same phase', () => {
    // Set up design file
    const designDir = join(PROJECT_DIR, 'docs', 'designs');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'AF-30-webhook.md'), '# Design', 'utf-8');

    // Set up implement result.json
    writeResultJson('implement', 'engineer', makeResultJson());

    const phase: PhaseDefinition = {
      name: 'verify',
      agent: 'qa',
      requires: ['design', 'implement'],
      inject: [
        { from: 'design', artifact: 'docs/designs/{ticket}*.md', as: 'design_document' },
        { from: 'implement', artifact: 'metadata.pr_url', as: 'pr_to_review' },
      ],
    };

    const { resolved, warnings } = resolvePhaseInjections(phase, makeContext());
    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].label, 'design_document');
    assert.equal(resolved[1].label, 'pr_to_review');
    assert.equal(warnings.length, 0);
  });
});

// ============================================================
// composeInjectionPrompt
// ============================================================

describe('composeInjectionPrompt', () => {
  it('returns empty string for empty array', () => {
    assert.equal(composeInjectionPrompt([]), '');
  });

  it('composes single injection', () => {
    const resolved: ResolvedInjection[] = [
      {
        label: 'design_document',
        content: '# My Design\n\nSome content.',
        source: 'design phase — docs/designs/AF-30.md',
      },
    ];

    const prompt = composeInjectionPrompt(resolved);
    assert.ok(prompt.startsWith('## Injected Artifacts'));
    assert.ok(prompt.includes('### design_document'));
    assert.ok(prompt.includes('> Source: design phase — docs/designs/AF-30.md'));
    assert.ok(prompt.includes('# My Design'));
    assert.ok(prompt.includes('Some content.'));
  });

  it('composes multiple injections', () => {
    const resolved: ResolvedInjection[] = [
      {
        label: 'design_document',
        content: '# Design',
        source: 'design phase — docs/designs/AF-30.md',
      },
      {
        label: 'pr_to_review',
        content: 'https://github.com/org/repo/pull/42',
        source: 'implement phase — metadata.pr_url',
      },
    ];

    const prompt = composeInjectionPrompt(resolved);
    assert.ok(prompt.includes('### design_document'));
    assert.ok(prompt.includes('### pr_to_review'));
    assert.ok(prompt.includes('# Design'));
    assert.ok(prompt.includes('https://github.com/org/repo/pull/42'));
  });

  it('preserves markdown formatting in content', () => {
    const resolved: ResolvedInjection[] = [
      {
        label: 'doc',
        content: '## Heading\n\n- bullet 1\n- bullet 2\n\n```ts\nconst x = 1;\n```',
        source: 'test phase — test.md',
      },
    ];

    const prompt = composeInjectionPrompt(resolved);
    assert.ok(prompt.includes('## Heading'));
    assert.ok(prompt.includes('- bullet 1'));
    assert.ok(prompt.includes('```ts'));
  });
});

// ============================================================
// buildInjectionContext
// ============================================================

describe('buildInjectionContext', () => {
  it('builds context from pipeline definition', () => {
    const pipeline: PipelineDefinition = {
      name: 'sdlc',
      phases: [
        { name: 'design', agent: 'architect' },
        { name: 'implement', agent: 'engineer', requires: ['design'] },
        { name: 'verify', agent: 'qa', requires: ['implement'] },
      ],
    };

    const ctx = buildInjectionContext(pipeline, 'AF-30', '/project/.af', '/project');
    assert.equal(ctx.ticket, 'AF-30');
    assert.equal(ctx.afPath, '/project/.af');
    assert.equal(ctx.projectDir, '/project');
    assert.equal(ctx.phaseAgentMap.get('design'), 'architect');
    assert.equal(ctx.phaseAgentMap.get('implement'), 'engineer');
    assert.equal(ctx.phaseAgentMap.get('verify'), 'qa');
    assert.equal(ctx.phaseAgentMap.size, 3);
  });
});
