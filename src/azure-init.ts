import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { Run } from './process.js';
import { deploymentSchema, type DeploymentConfig } from './config.js';
import { readRoleBasedProfile } from './role-based-profile.js';

// Placeholder that `identity` replaces with the application registration it creates.
export const unsetClientId = '00000000-0000-0000-0000-000000000000';

export interface InitOptions {
  profile?: 'foundation' | 'role-based-data';
  location: string;
  resourceGroup: string;
  registryServer: string;
  environment?: 'dev' | 'test' | 'prod' | undefined;
  name?: string | undefined;
}

export function deploymentName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '');
  if (!/^[a-z][a-z0-9-]{2,}$/.test(normalized)) throw new Error('Could not derive a deployment name from application.json; pass --name <at least 3 lowercase letters, digits or hyphens>.');
  if (normalized.length <= 20) return normalized;
  const suffix = createHash('sha256').update(normalized).digest('hex').slice(0, 6);
  return `${normalized.slice(0, 13).replace(/-+$/, '')}-${suffix}`;
}

/** Reads Azure CLI's signed-in context and the application's own files; writes nothing to Azure. */
export async function initDeploymentConfig(options: InitOptions, run: Run, root = '.'): Promise<DeploymentConfig> {
  const profile = options.profile ?? 'role-based-data';
  const account = z.object({ id: z.string(), tenantId: z.string(), user: z.object({ name: z.string(), type: z.string() }) })
    .parse(JSON.parse(await run('az', ['account', 'show', '-o', 'json'])));
  if (account.user.type !== 'user') throw new Error('azure init needs a signed-in user (az login) to become the SQL administrator; service principals are not supported here.');
  const operator = (await run('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv'])).trim();
  let role: { requiredRole?: string; readinessPath?: string } = {};
  if (profile === 'role-based-data') {
    try { const profile = await readRoleBasedProfile(join(root, 'role-based-data.json')); role = { requiredRole: profile.requiredRole, readinessPath: profile.readinessPath }; }
    catch (error) { throw new Error(`Role-based deployment reads requiredRole and readinessPath from role-based-data.json: ${error instanceof Error ? error.message : error}`); }
  }
  const name = deploymentName(options.name ?? z.object({ name: z.string() }).parse(JSON.parse(await readFile(join(root, 'application.json'), 'utf8'))).name);
  const image = (part: string) => `${options.registryServer}/${name}-${part}:0.1.2`;
  return deploymentSchema.parse({
    profile, ...role,
    subscriptionId: account.id, tenantId: account.tenantId, apiClientId: unsetClientId,
    sqlAdminObjectId: operator, sqlAdminName: account.user.name,
    resourceGroup: options.resourceGroup, location: options.location, environment: options.environment ?? 'dev', name,
    gatewayImage: image('gateway'), dabImage: image('data'),
    functionsImage: profile === 'foundation' ? image('functions') : '',
    registryServer: options.registryServer,
  });
}

export const deploySteps = ['identity', 'artifacts', 'provision', 'deploy', 'status'] as const;
export type DeployStep = typeof deploySteps[number];

export interface DeployAllPlan { pending: DeployStep[]; approval: string; excluded: string[] }

/** Lists the steps still needed; the approval id changes whenever the config or the remaining work changes. */
export function planDeployAll(config: DeploymentConfig, stage: string | undefined): DeployAllPlan {
  const pinned = [config.gatewayImage, config.dabImage, config.functionsImage].filter(Boolean).every(image => image.includes('@sha256:'));
  const done: Record<DeployStep, boolean> = {
    identity: config.apiClientId !== unsetClientId,
    artifacts: pinned,
    provision: stage !== undefined,
    deploy: stage === 'ready',
    status: false,
  };
  const pending = deploySteps.filter(step => !done[step]);
  const approval = createHash('sha256').update(JSON.stringify({ config, pending })).digest('hex').slice(0, 12);
  return { pending, approval, excluded: [
    'rbac-plan / rbac-deploy: Azure resource-role assignment needs a separately authorized administrator after provisioning',
    'role-based-assign: assigning the application role names a person and stays a separate decision',
    'role-based-smoke / smoke: needs delegated user tokens',
    'deleting or changing existing resources outside this deployment',
  ] };
}
