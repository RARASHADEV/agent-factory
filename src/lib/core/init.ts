// src/lib/core/init.ts
// AF-60: Presentation-free core op for `af init` (project workspace creation).
//
// Extracted from src/commands/init.ts so BOTH the CLI and the HTTP mutation
// route (POST /projects) create a workspace through one code path — no console.*,
// no chalk, no process.exit inside the op. The CLI keeps its own formatting and
// the (best-effort) Loka project-creation leg, which is network I/O and therefore
// NOT part of this presentation-free core (keeps the lift small and hermetic).
//
// On a duplicate workspace the op throws WorkspaceExistsError; the CLI maps it to
// its existing message + exit(1), the HTTP route maps it to 400.

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';
import { AF_DIR, STATUSES } from '../constants.js';
import { addProject, ensureGlobalConfig } from '../config.js';
import { auditLog } from '../audit.js';

/** Raised when an `.af/` workspace already exists at the target directory. */
export class WorkspaceExistsError extends Error {
  constructor(public readonly afPath: string) {
    super(`Workspace already exists at ${afPath}`);
    this.name = 'WorkspaceExistsError';
  }
}

/** Result of {@link initProject}. */
export interface InitProjectResult {
  prefix: string;
  name: string;
  afPath: string;
  /** Number of status directories created. */
  statuses: number;
}

export interface InitProjectInput {
  prefix: string;
  /** Project display name; defaults to the basename of the project directory. */
  name?: string;
  /** Project directory the workspace is created under; defaults to process.cwd(). */
  projectDir?: string;
}

/**
 * Initialize an AF workspace: create `.af/` (task status dirs + context),
 * write `project.md`, register the project in the global config, and write an
 * audit entry. Mirrors `af init` minus the (network) Loka leg.
 *
 * @throws {WorkspaceExistsError} if `.af/` already exists at the target dir.
 */
export function initProject(input: InitProjectInput): InitProjectResult {
  const projectDir = input.projectDir ?? process.cwd();
  const afPath = join(projectDir, AF_DIR);

  if (existsSync(afPath)) {
    throw new WorkspaceExistsError(afPath);
  }

  const normalizedPrefix = input.prefix.toUpperCase();
  const projectName = input.name || basename(projectDir);
  const today = new Date().toISOString().split('T')[0];

  // Create .af/ structure
  mkdirSync(afPath, { recursive: true });

  // Create status directories
  const tasksDir = join(afPath, 'tasks');
  for (const status of STATUSES) {
    mkdirSync(join(tasksDir, status), { recursive: true });
  }

  // Create context directory
  mkdirSync(join(afPath, 'context'), { recursive: true });

  // Create project.md
  const projectMeta = {
    id: basename(projectDir),
    name: projectName,
    prefix: normalizedPrefix,
    status: 'active',
    owner: 'brahma',
    created: today,
    counter: 1,
    stack: '',
  };

  const projectBody = `
# ${projectName}

<!-- One sentence describing what this project does -->

## Goals
<!-- 1-3 sentences on what this project is trying to achieve -->

## Way of Working

### Git
- Base branch: \`main\`
- Branch pattern: \`engineer/<TICKET>\`

### Testing
<!-- Command to run tests; policy for which tests to run -->
- Command: \`npm test <file>\`
- Policy: run only test files related to changed code — not the full suite

### Finishing
<!-- How a task gets completed and handed off -->
- Commit: \`${normalizedPrefix}-XX: description\`
- Push and PR: \`gh pr create --base main\`
- Move task to \`ready-for-qa\`
- Log completion in the task's \`## Log\` section

### Rules
<!-- Project-specific constraints agents must never violate -->
<!-- Examples:
- NEVER edit prod/bridge.ts — read-only production file
- Use Bun runtime, not Node.js
- No frontend code — backend only
-->

<!-- Optional sections: Design Documents, Workflow, PR Policy, Logging, Feature Flags -->
<!-- Add them from docs/designs/project-md-template.md as needed -->

## Decisions
<!-- Agents append architectural decisions here -->

## Notes
`;

  const projectContent = matter.stringify(projectBody, projectMeta);
  writeFileSync(join(afPath, 'project.md'), projectContent);

  // Register in global config
  ensureGlobalConfig();
  const path = projectDir.replace(process.env.HOME || '', '~');
  addProject(normalizedPrefix, path);

  // Add audit.log to .gitignore inside .af/
  const gitignorePath = join(afPath, '.gitignore');
  writeFileSync(gitignorePath, 'audit.log\n', 'utf-8');

  try {
    auditLog(afPath, {
      event: 'project.init',
      actor: 'cli',
      detail: `Initialized project ${projectName} (${normalizedPrefix})`,
      meta: { prefix: normalizedPrefix },
    });
  } catch {}

  return { prefix: normalizedPrefix, name: projectName, afPath, statuses: STATUSES.length };
}
