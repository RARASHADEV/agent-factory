/**
 * AF-43: Unit tests for domain-config.ts
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run: npx tsx --test src/__tests__/domain-config.test.ts
 *
 * Tests are hermetic: a temp agents dir is populated with stub agent files so
 * slug resolution is deterministic and independent of the real agents/ dir.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validateDomainConfig,
  parseDomainConfig,
  loadDomainConfig,
  listDomains,
  DomainConfigError,
} from '../lib/domain-config.js';

// --- Fixture: a temp agents dir with known slugs ---

let agentsDir: string;
let domainsDir: string;

const KNOWN_AGENTS = [
  'campaign-director',
  'market-researcher',
  'competitor-analyst',
  'audience-researcher',
  'content-writer',
  'reviewer',
];

before(() => {
  const base = mkdtempSync(join(tmpdir(), 'af43-'));
  agentsDir = join(base, 'agents');
  domainsDir = join(base, 'domains');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(domainsDir, { recursive: true });
  for (const slug of KNOWN_AGENTS) {
    writeFileSync(join(agentsDir, `${slug}.md`), `---\nslug: ${slug}\n---\n# ${slug}\n`);
  }
});

after(() => {
  // best-effort cleanup
  try {
    rmSync(join(agentsDir, '..'), { recursive: true, force: true });
  } catch {}
});

function validConfig(): Record<string, unknown> {
  return {
    domain: 'marketing',
    supervisor: {
      agent: 'campaign-director',
      goal: 'Turn a campaign objective into reviewed, publish-ready assets',
    },
    roster: [
      'market-researcher',
      'competitor-analyst',
      'audience-researcher',
      'content-writer',
      'reviewer',
    ],
    policy: {
      max_delegations: 12,
      roster_only: true,
      token_budget: 200000,
      timeout_seconds: 600,
      required_finalizers: ['reviewer'],
      max_revision_loops: 2,
      abort_on_no_progress: true,
      parallelizable: ['market-researcher', 'competitor-analyst', 'audience-researcher'],
    },
  };
}

// Run validateDomainConfig and capture the thrown DomainConfigError.
function expectErrors(input: unknown): string[] {
  try {
    validateDomainConfig(input, { agentsDir });
    assert.fail('expected validateDomainConfig to throw');
  } catch (err) {
    assert.ok(err instanceof DomainConfigError, `expected DomainConfigError, got ${err}`);
    return err.errors;
  }
}

// ============================================================
// Valid case
// ============================================================

describe('validateDomainConfig — valid', () => {
  it('accepts a fully-specified valid config', () => {
    const cfg = validateDomainConfig(validConfig(), { agentsDir });
    assert.equal(cfg.domain, 'marketing');
    assert.equal(cfg.supervisor.agent, 'campaign-director');
    assert.equal(cfg.supervisor.goal, 'Turn a campaign objective into reviewed, publish-ready assets');
    assert.equal(cfg.roster.length, 5);
    assert.equal(cfg.policy.max_delegations, 12);
    assert.deepEqual(cfg.policy.required_finalizers, ['reviewer']);
  });

  it('accepts a minimal config (empty policy, no goal)', () => {
    const cfg = validateDomainConfig(
      {
        domain: 'minimal',
        supervisor: { agent: 'campaign-director' },
        roster: ['content-writer'],
        policy: {},
      },
      { agentsDir },
    );
    assert.equal(cfg.domain, 'minimal');
    assert.equal(cfg.supervisor.goal, undefined);
    assert.deepEqual(cfg.policy, {});
  });
});

// ============================================================
// Invalid cases — one per failure mode
// ============================================================

describe('validateDomainConfig — invalid', () => {
  it('rejects a non-object input', () => {
    assert.throws(() => validateDomainConfig('nope', { agentsDir }), DomainConfigError);
    assert.throws(() => validateDomainConfig(null, { agentsDir }), DomainConfigError);
    assert.throws(() => validateDomainConfig([], { agentsDir }), DomainConfigError);
  });

  it('rejects missing/empty domain', () => {
    const cfg = validConfig();
    delete cfg.domain;
    assert.ok(expectErrors(cfg).some((e) => e.includes('domain')));

    const cfg2 = validConfig();
    cfg2.domain = '   ';
    assert.ok(expectErrors(cfg2).some((e) => e.includes('domain')));
  });

  it('rejects missing supervisor', () => {
    const cfg = validConfig();
    delete cfg.supervisor;
    assert.ok(expectErrors(cfg).some((e) => e.includes('supervisor')));
  });

  it('rejects supervisor.agent that does not resolve to an agent file', () => {
    const cfg = validConfig();
    cfg.supervisor = { agent: 'no-such-agent' };
    const errs = expectErrors(cfg);
    assert.ok(errs.some((e) => e.includes('supervisor.agent') && e.includes('no-such-agent')));
  });

  it('rejects non-string supervisor.goal', () => {
    const cfg = validConfig();
    cfg.supervisor = { agent: 'campaign-director', goal: 42 };
    assert.ok(expectErrors(cfg).some((e) => e.includes('supervisor.goal')));
  });

  it('rejects missing roster', () => {
    const cfg = validConfig();
    delete cfg.roster;
    assert.ok(expectErrors(cfg).some((e) => e.includes('roster')));
  });

  it('rejects empty roster', () => {
    const cfg = validConfig();
    cfg.roster = [];
    assert.ok(expectErrors(cfg).some((e) => e.includes('roster')));
  });

  it('rejects a roster slug that does not resolve to an agent file', () => {
    const cfg = validConfig();
    cfg.roster = ['content-writer', 'ghost-agent'];
    const errs = expectErrors(cfg);
    assert.ok(errs.some((e) => e.includes('roster[1]') && e.includes('ghost-agent')));
  });

  it('rejects non-string roster entries', () => {
    const cfg = validConfig();
    cfg.roster = ['content-writer', 7];
    assert.ok(expectErrors(cfg).some((e) => e.includes('roster')));
  });

  it('rejects missing policy', () => {
    const cfg = validConfig();
    delete cfg.policy;
    assert.ok(expectErrors(cfg).some((e) => e.includes('policy')));
  });

  it('rejects required_finalizers not in roster', () => {
    const cfg = validConfig();
    (cfg.policy as Record<string, unknown>).required_finalizers = ['campaign-director'];
    const errs = expectErrors(cfg);
    assert.ok(
      errs.some((e) => e.includes('required_finalizers') && e.includes('campaign-director')),
    );
  });

  it('rejects parallelizable not in roster', () => {
    const cfg = validConfig();
    (cfg.policy as Record<string, unknown>).parallelizable = ['campaign-director'];
    const errs = expectErrors(cfg);
    assert.ok(errs.some((e) => e.includes('parallelizable') && e.includes('campaign-director')));
  });

  it('rejects negative / non-numeric numeric policy fields', () => {
    const cfg = validConfig();
    (cfg.policy as Record<string, unknown>).max_delegations = -1;
    assert.ok(expectErrors(cfg).some((e) => e.includes('max_delegations')));

    const cfg2 = validConfig();
    (cfg2.policy as Record<string, unknown>).token_budget = 'lots';
    assert.ok(expectErrors(cfg2).some((e) => e.includes('token_budget')));
  });

  it('rejects non-boolean boolean policy fields', () => {
    const cfg = validConfig();
    (cfg.policy as Record<string, unknown>).roster_only = 'yes';
    assert.ok(expectErrors(cfg).some((e) => e.includes('roster_only')));
  });

  it('collects multiple errors at once', () => {
    const cfg = {
      domain: '',
      supervisor: { agent: 'no-such-agent' },
      roster: ['also-missing'],
      policy: { max_delegations: -5 },
    };
    const errs = expectErrors(cfg);
    assert.ok(errs.length >= 4, `expected >=4 errors, got ${errs.length}: ${errs.join('; ')}`);
  });
});

// ============================================================
// parseDomainConfig (YAML string)
// ============================================================

describe('parseDomainConfig', () => {
  it('parses a valid YAML config', () => {
    const yaml = `
domain: marketing
supervisor:
  agent: campaign-director
roster:
  - content-writer
  - reviewer
policy:
  required_finalizers: [reviewer]
`;
    const cfg = parseDomainConfig(yaml, { agentsDir });
    assert.equal(cfg.domain, 'marketing');
    assert.deepEqual(cfg.roster, ['content-writer', 'reviewer']);
  });

  it('throws on malformed YAML', () => {
    assert.throws(
      () => parseDomainConfig('domain: [unterminated', { agentsDir }),
      (err) => err instanceof DomainConfigError && /YAML parse error/.test(err.message),
    );
  });

  it('throws on empty input', () => {
    assert.throws(() => parseDomainConfig('', { agentsDir }), DomainConfigError);
  });
});

// ============================================================
// loadDomainConfig / listDomains (filesystem)
// ============================================================

describe('loadDomainConfig & listDomains', () => {
  it('loads a config file by name', () => {
    writeFileSync(
      join(domainsDir, 'support.yaml'),
      `domain: support\nsupervisor:\n  agent: campaign-director\nroster:\n  - reviewer\npolicy: {}\n`,
    );
    const cfg = loadDomainConfig('support', { agentsDir, domainsDir });
    assert.equal(cfg.domain, 'support');
  });

  it('throws a clear error when the file is missing', () => {
    assert.throws(
      () => loadDomainConfig('does-not-exist', { agentsDir, domainsDir }),
      (err) => err instanceof DomainConfigError && /not found/.test(err.message),
    );
  });

  it('lists domains in the directory', () => {
    const domains = listDomains(domainsDir);
    assert.ok(domains.includes('support'));
  });

  it('returns [] when the domains dir is absent', () => {
    assert.deepEqual(listDomains(join(domainsDir, 'nope')), []);
  });
});
