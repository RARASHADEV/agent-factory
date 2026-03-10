The Technical Design Document for AF-8 has been created at `docs/designs/AF-8.md`.

## Design Summary

**AF-8: Audit Logging System** — A centralized, append-only JSONL audit trail for the AF CLI.

### Key decisions:
1. **Storage:** `.af/audit.log` per project, JSONL format (one JSON object per line)
2. **Events tracked:** `project.init`, `task.create`, `task.move`, `task.assign`, `spawn.start`, `spawn.complete`, `spawn.fail`, `spawn.status_check`, `agent.sync`
3. **CLI:** Single `af log [ticket]` command with `--lines`, `--event`, `--since`, `--json` options
4. **Core module:** `src/lib/audit.ts` with `auditLog()` (append) and `readAuditLog()` (query/filter)
5. **Hooks:** Each existing command gets a single `auditLog()` call — wrapped in try/catch so logging never breaks commands
6. **Background spawns:** `spawn-runner.ts` appends directly to audit.log on completion/failure
7. **No new dependencies** — uses existing `fs`, `path`, `chalk`

### Feature Flag: `ENABLE_AF_8` (default OFF)

### Implementation Role: **ENGINEER** (backend/CLI only)
### Complexity: **Medium**

Full design at `docs/designs/AF-8.md`.