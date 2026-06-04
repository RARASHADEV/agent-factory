import { join } from 'path';
import { AF_DIR, ENABLE_AF_12 } from '../lib/constants.js';
import { loadConfig } from '../lib/config.js';
import { success, error, dim } from '../lib/format.js';
import { LokaHttpClient } from '../lib/providers/loka-http-client.js';
import { initProject, WorkspaceExistsError } from '../lib/core/init.js';

interface InitOptions {
  name?: string;
}

export async function initCommand(prefix: string, options: InitOptions): Promise<void> {
  const projectDir = process.cwd();
  const afPath = join(projectDir, AF_DIR);

  // Create the workspace via the shared core op (presentation-free). The CLI keeps
  // its console formatting + the best-effort Loka leg below.
  let result;
  try {
    result = initProject({ prefix, name: options.name, projectDir });
  } catch (err) {
    if (err instanceof WorkspaceExistsError) {
      console.log(error(err.message));
      process.exit(1);
    }
    throw err;
  }
  const { name: projectName, prefix: normalizedPrefix, statuses } = result;

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
  console.log(dim(`  Statuses: ${statuses} directories created`));
  console.log(dim(`  Registered in ~/.af/config.yaml`));
}
