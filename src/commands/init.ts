import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import { stringify as stringifyYaml } from 'yaml';
import matter from 'gray-matter';
import { AF_DIR, STATUSES, ENABLE_AF_12 } from '../lib/constants.js';
import { addProject, ensureGlobalConfig, loadConfig } from '../lib/config.js';
import { success, error, dim } from '../lib/format.js';
import { auditLog } from '../lib/audit.js';
import { LokaHttpClient } from '../lib/providers/loka-http-client.js';

interface InitOptions {
  name?: string;
}

export async function initCommand(prefix: string, options: InitOptions): Promise<void> {
  const projectDir = process.cwd();
  const afPath = join(projectDir, AF_DIR);

  if (existsSync(afPath)) {
    console.log(error(`Workspace already exists at ${afPath}`));
    process.exit(1);
  }

  const normalizedPrefix = prefix.toUpperCase();
  const projectName = options.name || basename(projectDir);
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

  // AF-12: Create project in Loka if configured (best-effort, never fails init)
  if (ENABLE_AF_12) {
    const config = loadConfig();
    if (config.loka?.url && config.loka?.apiKey) {
      try {
        const client = new LokaHttpClient({
          baseUrl: config.loka.url,
          apiKey: config.loka.apiKey,
        });
        await client.post('/projects', {
          name: projectName,
          prefix: normalizedPrefix,
          description: '',
        });
        console.log(dim('  Created project in Loka'));
      } catch (err: any) {
        console.log(dim(`  Warning: Could not create Loka project: ${err?.message ?? String(err)}`));
      }
    }
  }

  console.log(success(`Workspace initialized: ${afPath}`));
  console.log(dim(`  Project: ${projectName} (${normalizedPrefix})`));
  console.log(dim(`  Statuses: ${STATUSES.length} directories created`));
  console.log(dim(`  Registered in ~/.af/config.yaml`));
}
