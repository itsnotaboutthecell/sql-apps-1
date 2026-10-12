import { join, resolve } from 'node:path';

export const projectRoot = resolve(process.env.SQL_APPS_PROJECT_HOME ?? process.cwd());
export const toolingRoot = resolve(process.env.SQL_APPS_TOOLING_HOME ?? projectRoot);
export const projectPath = (...parts: string[]) => join(projectRoot, ...parts);
export const toolingAsset = (...parts: string[]) => join(toolingRoot, 'assets', ...parts);
