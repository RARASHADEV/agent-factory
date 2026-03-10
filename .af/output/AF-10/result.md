The design document is written. Here's a summary:

---

## AF-10 Design Summary

**Full design at `docs/designs/AF-10.md`**

### Key Decisions

1. **Project discovery**: Use the existing `~/.af/config.yaml` project registry (populated by `af init`). No new `projects.json` file or filesystem scanning needed — `listProjects()` already does this.

2. **CLI interface**: `af status --all` (or `-a`). Mutually exclusive with `--project`.

3. **Output format**: Colored summary table using `cli-table3` (already a dependency, unused) with columns: Project, Open, In-Progress, Blocked, Done, Total. Followed by a blocked items section listing individual blocked tasks across all projects.

4. **Status bucketing**: 9 statuses → 4 display columns (Open = backlog+open, In-Progress = in-progress+ready-for-qa+uat+ready-4-release, Blocked, Done = released+closed).

### Files to Modify
- `src/cli.ts` — Add `--all`/`-a` option
- `src/commands/status.ts` — New `statusAllProjects()` function + option handling
- `src/lib/format.ts` — Optional table formatting helper

### Implementation Role: **ENGINEER**
### Complexity: **Medium**