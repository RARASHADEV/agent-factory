# AF-13: Auto-create project in Loka when syncing

## Overview

When `af sync` runs and the Loka project doesn't exist yet, auto-create it using metadata from `project.md` instead of throwing a `ProviderError`. This closes the gap where `af init` tries once silently and `af sync` assumes it worked.

**Implementation Role:** ENGINEER

## Architecture

The change touches two files:

1. **`src/lib/providers/loka-provider.ts`** — Modify `ensureConfig()` to auto-create instead of throwing
2. **`src/lib/providers/loka-http-client.ts`** — Add a `createProject()` convenience method (optional but cleaner)

No new files needed. No new dependencies.

### Flow

```
ensureConfig()
  → GET /projects
  → find by prefix
  → NOT FOUND?
      → load project.md metadata (already available via constructor args or passed in)
      → POST /projects { name, prefix, description }
      → log: "[loka] Auto-created project <PREFIX> in Loka"
      → use returned project.id
  → FOUND? → use project.id (existing behavior)
  → Loka unreachable? → throw LokaUnreachableError (existing behavior, no change)
```

## API Design

### Loka endpoint to call

**`POST /projects`** — already used by `af init` (init.ts lines 125-129).

Request body:
```json
{
  "name": "Agent Factory",
  "prefix": "AF",
  "description": "CLI tool for spawning and managing AI agents across projects."
}
```

Response: a `LokaProject` object (id, name, prefix, description, color, type, taskCount, memberCount).

### Data mapping from project.md

| project.md field | Loka create payload field |
|---|---|
| `meta.name` | `name` |
| `meta.prefix` | `prefix` |
| Body content (first paragraph or full markdown body) | `description` |

**Note:** The `LokaProvider` constructor already receives `projectPrefix`. The sync command already has `meta` (a `ProjectMeta` object with `name`, `prefix`, etc.) but doesn't pass it to the provider. We need to make the project metadata available to `LokaProvider.ensureConfig()`.

## Implementation Notes

### Option A (recommended): Pass project metadata to LokaProvider constructor

Add optional `projectMeta` parameter to `LokaProvider` constructor:

```typescript
constructor(
  baseUrl: string,
  apiKey: string,
  private projectPrefix: string,
  private statusMapOverrides?: Record<string, string>,
  private priorityMapOverrides?: Record<string, string>,
  private projectMeta?: { name: string; description?: string },
)
```

Then in `ensureConfig()`, replace the throw with:

```typescript
// Current code (line 113-114):
if (!project) {
  throw new ProviderError(`Loka project with prefix "${this.projectPrefix}" not found`);
}

// New code:
if (!project) {
  if (!this.projectMeta) {
    throw new ProviderError(`Loka project with prefix "${this.projectPrefix}" not found and no project metadata available for auto-creation`);
  }

  process.stderr.write(`[loka] Project "${this.projectPrefix}" not found in Loka — creating it...\n`);

  try {
    const created = await this.client.post<LokaProject>('/projects', {
      name: this.projectMeta.name,
      prefix: this.projectPrefix,
      description: this.projectMeta.description ?? '',
    });
    project = created;
    process.stderr.write(`[loka] Auto-created project "${created.name}" (${created.prefix}) in Loka\n`);
  } catch (err: any) {
    if (err instanceof LokaUnreachableError) {
      throw err; // Let network errors bubble up
    }
    throw new ProviderError(
      `Failed to auto-create Loka project "${this.projectPrefix}": ${err?.message ?? String(err)}`
    );
  }
}
```

### Update sync.ts to pass metadata

In `sync.ts` (line 83-89), update the `LokaProvider` construction:

```typescript
const lokaProvider = new LokaProvider(
  config.loka.url,
  config.loka.apiKey,
  meta.prefix,
  config.loka.statusMap,
  config.loka.priorityMap,
  { name: meta.name, description: '' },  // NEW: pass project metadata
);
```

For the description, the `ProjectMeta` interface doesn't have a `description` field in frontmatter. The description lives in the markdown body. Two options:
- Pass empty string (matches what `af init` does today — line 128 of init.ts)
- Parse the body from project.md

**Recommendation:** Pass empty string to match existing `af init` behavior. Keep it simple.

### Error handling strategy

| Scenario | Behavior |
|---|---|
| Project exists in Loka | No change — use existing project.id |
| Project doesn't exist, auto-create succeeds | Log creation, proceed with sync |
| Project doesn't exist, Loka unreachable | Throw `LokaUnreachableError` (clear message) |
| Project doesn't exist, create returns 4xx | Throw `ProviderError` with create error detail |
| Project doesn't exist, no `projectMeta` passed | Throw `ProviderError` explaining auto-creation not possible |
| `af init` best-effort creation | Unchanged — still uses `LokaHttpClient.post` directly |

### Logging

Use `process.stderr.write` with `[loka]` prefix, consistent with existing patterns (see line 325, 391 of loka-provider.ts). This satisfies the acceptance criterion of "logged visibly (not silent)".

### Idempotency

If the project was already created (e.g., by `af init` or manually in Loka), the `GET /projects` call finds it by prefix and the auto-create path is never entered. No risk of duplicates.

If two concurrent syncs race, the second `POST /projects` may get a 409 Conflict or similar. The error handling wraps this in a `ProviderError`. This edge case is acceptable for a CLI tool.

## Dependencies

- **AF-12** (Loka sync) — must be merged first (task declares `depends: AF-12`)
- No new npm packages
- No database changes

## Feature Flag

- **Flag Name:** ENABLE_AF_13
- **Guard:** The auto-create logic in `ensureConfig()`. When OFF, the original `throw new ProviderError(...)` behavior is preserved.
- **Default:** OFF
- **Location:** Add to `src/lib/constants.ts` alongside existing flags.

Implementation: wrap the auto-create block in `if (ENABLE_AF_13)` — if disabled, throw as before.

## Complexity

**Small** — ~30 lines of new code across 2-3 files (loka-provider.ts, sync.ts, constants.ts). No new abstractions, no schema changes.

## Checklist for engineer

- [ ] Add `ENABLE_AF_13 = false` to `src/lib/constants.ts`
- [ ] Add optional `projectMeta` param to `LokaProvider` constructor
- [ ] Modify `ensureConfig()` to auto-create when project not found (guarded by flag)
- [ ] Import `LokaUnreachableError` in loka-provider.ts if not already imported
- [ ] Update `sync.ts` to pass `{ name: meta.name, description: '' }` to LokaProvider
- [ ] Verify `af init` still works unchanged
- [ ] Add stderr logging for auto-creation
