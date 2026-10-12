import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const projectRoot = resolve(process.env.SQL_APPS_PROJECT_HOME ?? process.cwd());
export const toolingRoot = resolve(process.env.SQL_APPS_TOOLING_HOME ?? projectRoot);
export const toolingAssetsRoot = existsSync(join(toolingRoot, 'assets', 'runtime-contract.json'))
  ? join(toolingRoot, 'assets')
  : toolingRoot;
export const projectPath = (...parts: string[]) => join(projectRoot, ...parts);
export const toolingAsset = (...parts: string[]) => join(toolingAssetsRoot, ...parts);
