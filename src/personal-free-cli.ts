import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { run, type Run } from './process.js';
import { buildPersonalFreeArtifact } from './personal-free-build.js';
import {
  deployPersonalFree,
  initPersonalFreeConfig,
  personalFreeStatePath,
  planPersonalFreeDeployment,
  readPersonalFreeConfig,
  rotatePersonalFreeRuntimeSecret,
} from './personal-free-deployment.js';
import { protectedDeploymentStateSchema } from './personal-free-config.js';
import { projectRoot } from './runtime-roots.js';

const defaultConfig = join(projectRoot, 'sql-apps.personal-free.json');

function usage(): string {
  return [
    'Usage:',
    '  sql-apps publish init --name <name> --location <region> [--environment prod] [--resource-group <name>]',
    '  sql-apps publish plan [--config <path>]',
    '  sql-apps publish deploy --approve <code> [--config <path>]',
    '  sql-apps publish invite-owner --provider <aad|github|google> --user <email-or-handle> [--config <path>]',
    '  sql-apps publish rotate-secret --approve <current-deployment-code> [--config <path>]',
    '  sql-apps publish status [--config <path>]',
    '',
    'This personal-project profile targets Static Web Apps Free, managed Functions, and the Azure SQL free offer.',
    'It is potentially $0 only while usage stays within current allowances, and Static Web Apps Free has no SLA.',
  ].join('\n');
}

function flags(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option near "${key ?? ''}"`);
    if (values.has(key)) throw new Error(`Duplicate option ${key}`);
    values.set(key, value);
  }
  return values;
}

function take(values: Map<string, string>, name: string, fallback?: string): string {
  const value = values.get(name) ?? fallback;
  values.delete(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function rejectUnknown(values: Map<string, string>): void {
  if (values.size) throw new Error(`Unknown option ${[...values.keys()][0]}`);
}

async function init(args: readonly string[], command: Run): Promise<string> {
  const values = flags(args);
  const name = take(values, '--name');
  const location = take(values, '--location');
  const environment = z.enum(['dev', 'test', 'prod']).parse(take(values, '--environment', 'prod'));
  const resourceGroup = take(values, '--resource-group', `${name}-${environment}`);
  const configPath = resolve(take(values, '--config', defaultConfig));
  rejectUnknown(values);
  const config = await initPersonalFreeConfig({
    resourceGroup,
    location,
    environment,
    name,
  }, command);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  return `Created ${configPath}. No Azure resources were changed.\nRun "sql-apps publish plan" to review the deployment.`;
}

async function plan(args: readonly string[]): Promise<string> {
  const values = flags(args);
  const configPath = resolve(take(values, '--config', defaultConfig));
  rejectUnknown(values);
  const config = await readPersonalFreeConfig(configPath);
  const artifact = join(projectRoot, '.sql-apps', 'deployments', `${config.name}-${config.environment}-plan`);
  const manifest = await buildPersonalFreeArtifact(projectRoot, artifact);
  const result = planPersonalFreeDeployment(config, manifest.sourceHash);
  return `${result.summary}\n\nApproval: ${result.approval}\nDeploy with: sql-apps publish deploy --approve ${result.approval} --config ${JSON.stringify(configPath)}`;
}

async function deploy(args: readonly string[], command: Run): Promise<string> {
  const values = flags(args);
  const approval = take(values, '--approve');
  const configPath = resolve(take(values, '--config', defaultConfig));
  rejectUnknown(values);
  const config = await readPersonalFreeConfig(configPath);
  const state = await deployPersonalFree(config, approval, command);
  return `Deployment stage: ${state.stage}\nApplication: https://${state.staticWebAppHostname}`;
}

async function inviteOwner(args: readonly string[], command: Run): Promise<string> {
  const values = flags(args);
  const provider = take(values, '--provider').toLowerCase();
  if (!['aad', 'github', 'google'].includes(provider)) throw new Error('--provider must be aad, github, or google');
  const user = take(values, '--user');
  const configPath = resolve(take(values, '--config', defaultConfig));
  rejectUnknown(values);
  const config = await readPersonalFreeConfig(configPath);
  const state = protectedDeploymentStateSchema.parse(JSON.parse(
    await readFile(personalFreeStatePath(config), 'utf8')));
  if (!state.staticWebAppName || !state.staticWebAppHostname) throw new Error('Deploy the application before inviting its owner');
  const invitation = await command('az', [
    'staticwebapp', 'users', 'invite',
    '--subscription', config.subscriptionId,
    '--resource-group', config.resourceGroup,
    '--name', state.staticWebAppName,
    '--authentication-provider', provider,
    '--user-details', user,
    '--roles', 'owner',
    '--domain', state.staticWebAppHostname,
    '--invitation-expiration-in-hours', '168',
    '--query', 'invitationUrl', '-o', 'tsv',
  ]);
  return `Owner invitation (expires in 7 days):\n${invitation.trim()}`;
}

async function status(args: readonly string[]): Promise<string> {
  const values = flags(args);
  const configPath = resolve(take(values, '--config', defaultConfig));
  rejectUnknown(values);
  const config = await readPersonalFreeConfig(configPath);
  try {
    const state = protectedDeploymentStateSchema.parse(JSON.parse(
      await readFile(personalFreeStatePath(config), 'utf8')));
    return [
      `Profile: ${config.profile}`,
      `Target: ${config.subscriptionId}/${config.resourceGroup}`,
      `Stage: ${state.stage}`,
      state.staticWebAppHostname ? `Application: https://${state.staticWebAppHostname}` : undefined,
      'Cost posture: potentially $0 within current allowances; personal-project tier; no Static Web Apps Free SLA.',
    ].filter(Boolean).join('\n');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'Stage: not started';
    throw error;
  }

}

async function rotateSecret(args: readonly string[], command: Run): Promise<string> {
  const values = flags(args);
  const approval = take(values, '--approve');
  const configPath = resolve(take(values, '--config', defaultConfig));
  rejectUnknown(values);
  const config = await readPersonalFreeConfig(configPath);
  const state = await rotatePersonalFreeRuntimeSecret(config, approval, command);
  return `Runtime secret rotated. Deployment stage: ${state.stage}`;
}

export async function main(
  args = process.argv.slice(2),
  log: (message: string) => void = console.log,
  command: Run = run,
): Promise<void> {
  const [action, ...rest] = args;
  if (!action || ['help', '--help', '-h'].includes(action)) {
    log(usage());
    return;
  }
  const handlers: Record<string, () => Promise<string>> = {
    init: () => init(rest, command),
    plan: () => plan(rest),
    deploy: () => deploy(rest, command),
    'invite-owner': () => inviteOwner(rest, command),
    'rotate-secret': () => rotateSecret(rest, command),
    status: () => status(rest),
  };
  const handler = handlers[action];
  if (!handler) throw new Error(`Unknown publish action "${action}".\n${usage()}`);
  log(await handler());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Personal-free publishing failed.');
    process.exitCode = 1;
  });
}
