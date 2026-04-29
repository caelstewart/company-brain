/**
 * Connector Config Loader.
 *
 * Reads JSON connector definition files from a directory and
 * creates ConfigurableConnector instances from them.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ConnectorDefinitionSchema, ConfigurableConnector } from './configurable.js';
import type { ConnectorDefinition } from './configurable.js';

/**
 * Load connector definitions from a directory of JSON files.
 * Returns ConfigurableConnector instances ready to register.
 * Skips files that fail to parse or validate.
 */
export async function loadConnectorsFromDir(dir: string): Promise<ConfigurableConnector[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const connectors: ConfigurableConnector[] = [];

  for (const entry of entries) {
    if (extname(entry) !== '.json') continue;

    try {
      const raw = await readFile(join(dir, entry), 'utf-8');
      const parsed = JSON.parse(raw);
      const result = ConnectorDefinitionSchema.safeParse(parsed);

      if (!result.success) {
        const issues = result.error.issues
          .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        console.warn(`[connectors] Skipping ${entry}: ${issues}`);
        continue;
      }

      connectors.push(new ConfigurableConnector(result.data));
    } catch (err) {
      console.warn(`[connectors] Skipping ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return connectors;
}

/**
 * Validate a connector definition object.
 * Returns the validated definition or throws with details.
 */
export function validateDefinition(raw: unknown): ConnectorDefinition {
  const result = ConnectorDefinitionSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid connector definition: ${issues}`);
  }
  return result.data;
}
