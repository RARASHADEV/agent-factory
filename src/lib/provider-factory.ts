// src/lib/provider-factory.ts
// Factory that returns a TaskProvider based on configuration.

import { TaskProvider } from './task-provider.js';
import { FileProvider } from './providers/file-provider.js';
import { LokaProvider } from './providers/loka-provider.js';
import { loadConfig } from './config.js';
import { type ProjectMeta } from './workspace.js';

export type ProviderType = 'file' | 'loka';

/**
 * Create a TaskProvider for the given workspace.
 *
 * The backend is selected in this order:
 *   1. Explicit `type` argument
 *   2. `defaults.taskBackend` in ~/.af/config.yaml
 *   3. "file" (default)
 */
export function createProvider(
  afPath: string,
  projectMeta: ProjectMeta,
  type?: ProviderType,
): TaskProvider {
  const config = loadConfig();

  // Explicit override, or infer from config
  const backend = type ?? config.defaults.taskBackend ?? 'file';

  if (backend === 'loka') {
    const loka = config.loka;
    if (!loka?.url || !loka?.apiKey) {
      throw new Error('Loka backend requires loka.url and loka.apiKey in ~/.af/config.yaml');
    }
    return new LokaProvider(loka.url, loka.apiKey, projectMeta.prefix);
  }

  return new FileProvider(afPath, projectMeta);
}
