#!/usr/bin/env node
import { lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMMANDS = {
  build: 'dist/scripts/build-provenance.mjs',
  setup: 'dist/scripts/setup.mjs',
  'setup-check': 'dist/scripts/setup-check.mjs',
  guide: 'dist/scripts/guide.mjs',
  'workspace-check': 'dist/scripts/workspace-check.mjs',
  consent: 'dist/scripts/local-consent.mjs',
  local: 'dist/src/local-cli.js',
  publish: 'dist/src/personal-free-cli.js',
  check: 'dist/scripts/check-application.mjs',
};

const packageHome = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function help() {
  return [
    'Usage: sql-apps <command> [arguments]',
    '',
    `Commands: ${Object.keys(COMMANDS).join(', ')}`,
    '',
    '  publish  Primary personal-project Azure path (potentially $0 within allowances; no SLA)',
  ].join('\n');
}

async function commandTarget(command) {
  const relativeTarget = COMMANDS[command];
  if (!relativeTarget) throw new Error(`Unknown command "${command}". Run sql-apps --help.`);
  const target = resolve(packageHome, relativeTarget);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe command module: ${relativeTarget}`);
  return target;
}

async function runTarget(target, commandArgs, projectHome, load) {
  process.env.SQL_APPS_PROJECT_HOME = projectHome;
  process.env.SQL_APPS_TOOLING_HOME = packageHome;
  process.argv = [process.execPath, target, ...commandArgs];
  await load(pathToFileURL(target).href);
}

export async function dispatch(command, commandArgs, projectHome, load = specifier => import(specifier)) {
  await runTarget(await commandTarget(command), commandArgs, projectHome, load);
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const [command, ...commandArgs] = args;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    if (commandArgs.length) throw new Error('Help takes no arguments.');
    console.log(help());
    return;
  }
  const target = await commandTarget(command);
  const { findProjectHome } = await import('../dist/src/project-contract.mjs');
  const projectHome = await findProjectHome(cwd);
  process.chdir(projectHome);
  await runTarget(target, commandArgs, projectHome, specifier => import(specifier));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'SQL Apps command failed.');
    process.exitCode = 1;
  });
}
