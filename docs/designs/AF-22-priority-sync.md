# AF-22: Sync Should Map Priority Labels Too

## Overview

When tasks are created or updated in AF, their priority is not propagated to Loka because `LokaProvider.resolvePriorityId()` always returns `null`. The priority mapping infrastructure (name maps, reverse maps) already exists and works correctly for **reading** priorities from Loka. The gap is in **writing** — the Loka API requires a `priorityId` UUID, not a name string, and the provider has no mechanism to resolve AF priority names to Loka priority UUIDs.

This design fixes priority sync in both directions by implementing priority ID resolution via the Loka API.

## Root Cause Analysis

1. **`resolvePriorityId()` is a stub** (loka-provider.ts:406-413) — always returns `null`
2. **`create()` path**: Sets `priorityId: null` in the POST body (line 293), so Loka uses its default (Medium)
3. **`update()` path**: Guards with `if (priorityId)` (line 323), so null means priority is never included in the PATCH body — updates are silently dropped
4. **Reading works fine**: `toTask()` correctly maps `priorityName` → AF priority via `reversePriorityMap`

## Architecture

No new components. This is a fix within the existing `LokaProvider` class.

### Components Affected
- `src/lib/providers/loka-provider.ts` — Implement `resolvePriorityId()`, add priority ID cache
- No changes needed to: sync-engine.ts, post-action-sync.ts, file-provider.ts, task-provider.ts, constants.ts

### Data Flow (After Fix)

```
AF create/update → LokaProvider.create()/update()
  → resolvePriorityId("high")
  → fetch /priorities from Loka API (cached after first call)
  → find entry where name matches priorityMap["high"] = "High"
  → return UUID → include priorityId in POST/PATCH body
```

## API Design

### Loka Priority Resolution

The Loka API exposes priority metadata. The provider needs to fetch and cache this data.

**Expected Loka API endpoint:** `GET /priorities`

**Expected response shape:**
```typescript
interface LokaPriority {
  id: string;       // UUID — this is what we need
  name: string;     // "Urgent", "High", "Medium", "Low", "None"
  color: string;
  position: number;
}
```

**Fallback strategy** if `/priorities` endpoint doesn't exist or returns unexpected data:
1. Try `GET /priorities` first
2. If that fails, extract priority metadata from existing task data — when listing tasks, cache the `priorityId` ↔ `priorityName` mapping from the first task seen with each priority level
3. If no mapping available, log a warning and skip priority update (current behavior, graceful degradation)

## Data Model

No database or file format changes required.

### New Internal State (LokaProvider)

Add a cached map for priority ID resolution:

```typescript
// AF priority name → Loka priority UUID
private priorityIdCache: Map<string, string> = new Map();
private priorityIdCacheLoaded = false;
```

## Implementation Notes

### 1. Implement `resolvePriorityId()` with Caching

Replace the stub with an actual implementation:

```typescript
private async resolvePriorityId(afName: string): Promise<string | null> {
  await this.loadPriorityIds();

  const lokaName = this.priorityMap.get(afName) ?? afName;
  return this.priorityIdCache.get(lokaName.toLowerCase()) ?? null;
}

private async loadPriorityIds(): Promise<void> {
  if (this.priorityIdCacheLoaded) return;
  this.priorityIdCacheLoaded = true; // Set early to avoid retry loops

  try {
    const priorities = await this.client.get<LokaPriority[]>('/priorities');
    if (priorities && Array.isArray(priorities)) {
      for (const p of priorities) {
        this.priorityIdCache.set(p.name.toLowerCase(), p.id);
      }
    }
  } catch {
    process.stderr.write('[loka] Warning: failed to load priorities, priority sync may not work\n');
  }
}
```

### 2. Add LokaPriority Interface

Add near the other Loka API shape interfaces at the top of loka-provider.ts:

```typescript
interface LokaPriority {
  id: string;
  name: string;
  color: string;
  position: number;
}
```

### 3. Fallback: Extract Priority IDs from Task Data

As an alternative/supplement to the `/priorities` endpoint, enrich the cache opportunistically when listing tasks:

In the `list()` method, after fetching tasks, cache any priority mappings seen:

```typescript
// Inside list(), after fetching allTasks:
for (const lt of allTasks) {
  if (lt.priorityId && lt.priorityName) {
    this.priorityIdCache.set(lt.priorityName.toLowerCase(), lt.priorityId);
  }
}
```

This ensures the cache is populated even if `/priorities` fails.

### 4. Fix the `create()` Method

The `create()` method should handle null `priorityId` gracefully. If `resolvePriorityId` returns null, try sending `priorityName` instead:

```typescript
// In create():
const priorityId = await this.resolvePriorityId(input.priority ?? 'medium');
if (priorityId) {
  body.priorityId = priorityId;
} else {
  // Fallback: some Loka API versions accept priorityName directly
  const lokaName = this.priorityMap.get(input.priority ?? 'medium');
  if (lokaName) body.priorityName = lokaName;
}
```

### 5. Fix the `update()` Method

The current guard `if (priorityId)` silently drops null. Apply the same fallback:

```typescript
if (input.priority !== undefined) {
  const priorityId = await this.resolvePriorityId(input.priority);
  if (priorityId) {
    body.priorityId = priorityId;
  } else {
    const lokaName = this.priorityMap.get(input.priority);
    if (lokaName) body.priorityName = lokaName;
  }
}
```

### 6. Ensure `ensureConfig()` Runs Before Priority Resolution

`resolvePriorityId()` depends on `this.priorityMap` being populated, which happens in `ensureConfig()`. Both `create()` and `update()` already call `ensureConfig()` first, so no change needed here.

### 7. Opportunistic Cache Population in `toTask()`

When converting Loka tasks to AF tasks (which happens during list/get), cache the priority ID:

```typescript
// In toTask():
if (lt.priorityId && lt.priorityName) {
  this.priorityIdCache.set(lt.priorityName.toLowerCase(), lt.priorityId);
  this.priorityIdCacheLoaded = true;
}
```

### Key Considerations

- **No new feature flag needed**: This is a bug fix within existing AF-12 sync functionality, not a new feature. The sync is already guarded by `ENABLE_AF_12`.
- **Backward compatible**: If priority resolution fails, behavior degrades to current (priority not sent), with a warning logged.
- **Performance**: Priority IDs are cached after first fetch. The `/priorities` call is made at most once per provider instance.
- **The sync-engine already handles priority correctly**: `hasContentDifference()`, `pushToLoka()`, and `pullToLocal()` all compare and sync priority fields. The only broken link is the Loka API write path in `LokaProvider`.
- **Post-action sync already works**: The `edit` action in `post-action-sync.ts` passes priority to `lokaProvider.update()`, which will now correctly resolve it.

## Testing Considerations

1. **Create task with non-default priority**: `af task create --priority high "Test"` → verify Loka shows "High"
2. **Update priority locally**: Edit task frontmatter priority → run `af sync --mode push` → verify Loka updates
3. **Update priority in Loka**: Change priority in Loka UI → run `af sync --mode pull` → verify local file updates
4. **Bidirectional sync**: Change priority on both sides → verify LWW resolves correctly
5. **Graceful degradation**: If `/priorities` endpoint is unavailable, verify warning is logged and sync continues without crashing
6. **All four AF priorities**: Test `critical` → Urgent, `high` → High, `medium` → Medium, `low` → Low

## Dependencies

- **Loka REST API**: Assumes `/priorities` endpoint exists returning priority metadata with `id` and `name` fields
- **AF-12**: Sync feature flag (already enabled)
- **No external library changes**

## Implementation Role

**ENGINEER** — This is a backend-only fix in the Loka provider. No UI, CLI, or frontend changes needed.

## Complexity

**Low-Medium** — The fix is localized to a single file (`loka-provider.ts`). The main risk is the Loka API shape for `/priorities` which should be verified.
