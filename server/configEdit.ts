import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigSchema, loadConfig } from './config';
import type { LoadedConfig } from './config';

export class ConfigInputError extends Error {}

/**
 * Applies `mutate` to the raw JSON of config/dashboard.config.json, checks the result against the schema, writes it
 * atomically and reloads. Keys the mutation does not touch keep their values and order.
 */
export function editConfig(rootDir: string, mutate: (raw: Record<string, unknown>) => void): LoadedConfig {
  const path = resolve(rootDir, 'config', 'dashboard.config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mutate(raw);
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigInputError(`Config would become invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return loadConfig(rootDir);
}
