/**
 * AF-23: Unit tests for result-schema.ts
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run: npx tsx src/__tests__/result-schema.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateResult,
  extractResultJson,
  synthesizeResult,
  type ResultSchema,
  type ValidationResult,
} from '../lib/result-schema.js';

// ============================================================
// validateResult
// ============================================================

describe('validateResult', () => {
  it('accepts a valid complete result', () => {
    const input = {
      status: 'complete',
      summary: 'Did the thing',
      artifacts: [{ type: 'design_document', path: 'docs/designs/AF-1.md' }],
      next_role: 'ENGINEER',
      metadata: { pr_url: 'https://github.com/org/repo/pull/1' },
    };
    const result = validateResult(input);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.status, 'complete');
      assert.equal(result.data.artifacts.length, 1);
    }
  });

  it('accepts a minimal valid result (empty artifacts)', () => {
    const input = {
      status: 'failed',
      summary: 'Something broke',
      artifacts: [],
    };
    const result = validateResult(input);
    assert.equal(result.valid, true);
  });

  it('accepts all four valid statuses', () => {
    for (const status of ['complete', 'partial', 'failed', 'blocked']) {
      const input = { status, summary: 'test', artifacts: [] };
      const result = validateResult(input);
      assert.equal(result.valid, true, `status "${status}" should be valid`);
    }
  });

  it('rejects invalid status', () => {
    const input = { status: 'done', summary: 'test', artifacts: [] };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('status')));
    }
  });

  it('rejects missing status', () => {
    const input = { summary: 'test', artifacts: [] };
    const result = validateResult(input);
    assert.equal(result.valid, false);
  });

  it('rejects empty summary', () => {
    const input = { status: 'complete', summary: '', artifacts: [] };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('summary')));
    }
  });

  it('rejects missing summary', () => {
    const input = { status: 'complete', artifacts: [] };
    const result = validateResult(input);
    assert.equal(result.valid, false);
  });

  it('rejects non-array artifacts', () => {
    const input = { status: 'complete', summary: 'test', artifacts: 'not-array' };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('artifacts')));
    }
  });

  it('rejects artifact with missing type', () => {
    const input = { status: 'complete', summary: 'test', artifacts: [{ path: 'foo' }] };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('artifacts[0].type')));
    }
  });

  it('rejects artifact with missing path', () => {
    const input = { status: 'complete', summary: 'test', artifacts: [{ type: 'doc' }] };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('artifacts[0].path')));
    }
  });

  it('rejects non-string next_role', () => {
    const input = { status: 'complete', summary: 'test', artifacts: [], next_role: 123 };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('next_role')));
    }
  });

  it('rejects non-array blockers', () => {
    const input = { status: 'blocked', summary: 'test', artifacts: [], blockers: 'a string' };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('blockers')));
    }
  });

  it('rejects non-string items in blockers', () => {
    const input = { status: 'blocked', summary: 'test', artifacts: [], blockers: [42] };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('blockers[0]')));
    }
  });

  it('rejects array metadata', () => {
    const input = { status: 'complete', summary: 'test', artifacts: [], metadata: [1, 2] };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('metadata')));
    }
  });

  it('rejects null input', () => {
    const result = validateResult(null);
    assert.equal(result.valid, false);
  });

  it('rejects array input', () => {
    const result = validateResult([]);
    assert.equal(result.valid, false);
  });

  it('rejects string input', () => {
    const result = validateResult('hello');
    assert.equal(result.valid, false);
  });

  it('collects multiple errors', () => {
    const input = { status: 'invalid', summary: '', artifacts: 'nope' };
    const result = validateResult(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.length >= 3, `Expected at least 3 errors, got ${result.errors.length}`);
    }
  });
});

// ============================================================
// extractResultJson
// ============================================================

describe('extractResultJson', () => {
  it('returns null when no result-json block found', () => {
    const text = 'Some markdown without any JSON blocks';
    assert.equal(extractResultJson(text), null);
  });

  it('returns null for regular json blocks (not result-json)', () => {
    const text = '```json\n{"status": "complete"}\n```';
    assert.equal(extractResultJson(text), null);
  });

  it('extracts a valid result-json block', () => {
    const text = `Some preamble text.

\`\`\`result-json
{
  "status": "complete",
  "summary": "Did the thing",
  "artifacts": [{ "type": "doc", "path": "foo.md" }]
}
\`\`\``;
    const result = extractResultJson(text);
    assert.notEqual(result, null);
    assert.equal(result!.valid, true);
    if (result!.valid) {
      assert.equal(result!.data.status, 'complete');
      assert.equal(result!.data.summary, 'Did the thing');
    }
  });

  it('takes the LAST result-json block when multiple exist', () => {
    const text = `Draft:
\`\`\`result-json
{
  "status": "partial",
  "summary": "Draft output",
  "artifacts": []
}
\`\`\`

Final version:
\`\`\`result-json
{
  "status": "complete",
  "summary": "Final output",
  "artifacts": [{ "type": "src", "path": "src/app.ts" }]
}
\`\`\``;
    const result = extractResultJson(text);
    assert.notEqual(result, null);
    assert.equal(result!.valid, true);
    if (result!.valid) {
      assert.equal(result!.data.status, 'complete');
      assert.equal(result!.data.summary, 'Final output');
    }
  });

  it('returns validation failure for malformed JSON', () => {
    const text = `\`\`\`result-json
{ not valid json }
\`\`\``;
    const result = extractResultJson(text);
    assert.notEqual(result, null);
    assert.equal(result!.valid, false);
    if (!result!.valid) {
      assert.ok(result!.errors.some(e => e.includes('JSON parse error')));
    }
  });

  it('returns validation failure for valid JSON but invalid schema', () => {
    const text = `\`\`\`result-json
{
  "status": "invalid_status",
  "summary": "test",
  "artifacts": []
}
\`\`\``;
    const result = extractResultJson(text);
    assert.notEqual(result, null);
    assert.equal(result!.valid, false);
    if (!result!.valid) {
      assert.ok(result!.errors.some(e => e.includes('status')));
    }
  });

  it('handles block with extra whitespace after fence marker', () => {
    const text = `\`\`\`result-json
{
  "status": "complete",
  "summary": "Works with whitespace",
  "artifacts": []
}
\`\`\``;
    const result = extractResultJson(text);
    assert.notEqual(result, null);
    assert.equal(result!.valid, true);
  });

  it('ignores result-json blocks embedded in other code fences', () => {
    // Only direct ```result-json should match
    const text = 'No result-json blocks here, just mentioning the word result-json.';
    assert.equal(extractResultJson(text), null);
  });
});

// ============================================================
// synthesizeResult
// ============================================================

describe('synthesizeResult', () => {
  it('produces complete status for success=true', () => {
    const result = synthesizeResult({ status: 'completed', success: true, agent: 'architect', ticket: 'AF-1' });
    assert.equal(result.status, 'complete');
    assert.equal(result._synthetic, true);
    assert.ok(result.summary.includes('architect'));
    assert.ok(result.summary.includes('AF-1'));
    assert.deepEqual(result.artifacts, []);
  });

  it('produces failed status for status=failed', () => {
    const result = synthesizeResult({ status: 'failed', success: false, agent: 'engineer', ticket: 'AF-2' });
    assert.equal(result.status, 'failed');
    assert.equal(result._synthetic, true);
  });

  it('produces partial status for non-failed, non-success', () => {
    const result = synthesizeResult({ status: 'completed', success: false, agent: 'qa', ticket: 'AF-3' });
    assert.equal(result.status, 'partial');
    assert.equal(result._synthetic, true);
  });

  it('handles missing agent and ticket gracefully', () => {
    const result = synthesizeResult({ status: 'completed', success: true });
    assert.ok(result.summary.includes('unknown'));
    assert.equal(result._synthetic, true);
  });

  it('always sets _synthetic to true', () => {
    const result = synthesizeResult({ status: 'completed', success: true });
    assert.equal(result._synthetic, true);
  });

  it('always produces empty artifacts array', () => {
    const result = synthesizeResult({ status: 'completed', success: true });
    assert.deepEqual(result.artifacts, []);
  });
});
