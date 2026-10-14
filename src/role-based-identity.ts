import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { DeploymentConfig } from './config.js';
import { deploymentSchema } from './config.js';
import { unsetClientId } from './azure-init.js';
import type { Run } from './process.js';
import { saveJson, applicationRoleId, delegatedScopeId } from './deployment.js';

const identityRecoverySchema = z.strictObject({
  subscriptionId: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  environment: z.string(),
  objectId: z.string().uuid(),
  appId: z.string().uuid(),
});

export async function ensureApplicationIdentity(
  config: DeploymentConfig,
  configPath: string,
  run: Run,
  projectRoot = resolve('.'),
): Promise<DeploymentConfig> {
  if (config.apiClientId !== unsetClientId) throw new Error('Configuration already has an apiClientId; identity will not replace it');
  const account = z.object({ tenantId: z.string() }).parse(JSON.parse(
    await run('az', ['account', 'show', '-o', 'json']),
  ));
  if (account.tenantId !== config.tenantId) throw new Error('Sign Azure CLI into the configured tenant before creating its application');

  const directory = join(projectRoot, '.sql-apps');
  const recoveryPath = join(directory, `identity-${config.name}-${config.environment}.recovery.json`);
  let recovery: z.infer<typeof identityRecoverySchema> | undefined;
  try {
    recovery = identityRecoverySchema.parse(JSON.parse(await readFile(recoveryPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (recovery && (
    recovery.subscriptionId !== config.subscriptionId || recovery.tenantId !== config.tenantId ||
    recovery.name !== config.name || recovery.environment !== config.environment
  )) {
    throw new Error(`Identity recovery state at ${recoveryPath} belongs to a different deployment`);
  }
  if (!recovery) {
    const registration = z.object({ id: z.string().uuid(), appId: z.string().uuid() }).parse(JSON.parse(
      await run('az', ['ad', 'app', 'create', '--display-name', `${config.name}-${config.environment}`,
        '--sign-in-audience', 'AzureADMyOrg', '-o', 'json']),
    ));
    recovery = {
      subscriptionId: config.subscriptionId, tenantId: config.tenantId, name: config.name,
      environment: config.environment, objectId: registration.id, appId: registration.appId,
    };
    await saveJson(recoveryPath, recovery);
  }

  const bodyPath = join(directory, `identity-${config.name}-${config.environment}.json`);
  await saveJson(bodyPath, {
    identifierUris: [`api://${recovery.appId}`],
    api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [{
      id: delegatedScopeId, value: 'access_as_user', type: 'User', isEnabled: true,
      adminConsentDisplayName: 'Access SQL Apps', adminConsentDescription: 'Access this application as the signed-in user.',
      userConsentDisplayName: 'Access SQL Apps', userConsentDescription: 'Access your application data.',
    }] },
    spa: { redirectUris: [] },
    appRoles: [applicationRegistrationRole(config)],
  });
  await run('az', ['rest', '--method', 'PATCH', '--url',
    `https://graph.microsoft.com/v1.0/applications/${recovery.objectId}`, '--body', `@${bodyPath}`, '-o', 'none']);
  const servicePrincipalCount = z.coerce.number().int().min(0).parse((await run('az', [
    'ad', 'sp', 'list', '--filter', `appId eq '${recovery.appId}'`, '--query', 'length(@)', '-o', 'tsv',
  ])).trim() || '0');
  if (servicePrincipalCount === 0) {
    await run('az', ['ad', 'sp', 'create', '--id', recovery.appId, '-o', 'none']);
  } else if (servicePrincipalCount !== 1) {
    throw new Error(`Expected one service principal for application ${recovery.appId}, found ${servicePrincipalCount}`);
  }

  const current = deploymentSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  if (current.apiClientId !== unsetClientId) {
    throw new Error('Configuration changed during identity creation; the recovery record was retained');
  }
  const updated = { ...current, apiClientId: recovery.appId };
  await saveJson(configPath, updated);
  await unlink(recoveryPath);
  return updated;
}

export async function assignApplicationRole(config: DeploymentConfig, principal: string, run: Run): Promise<void> {
  if (config.profile !== 'role-based-data') throw new Error('Application role assignment requires the role-based-data profile');
  const principalId = z.string().uuid().parse(principal);
  const tenant = z.object({ tenantId: z.string() }).parse(JSON.parse(await run('az', ['account', 'show', '-o', 'json'])));
  if (tenant.tenantId !== config.tenantId) throw new Error('Sign into the configured tenant before application role assignment');
  const service = z.object({ id: z.string().uuid(), appRoles: z.array(z.object({
    id: z.string().uuid(), value: z.string(), isEnabled: z.boolean(), allowedMemberTypes: z.array(z.string()),
  })) }).parse(JSON.parse(await run('az', ['ad', 'sp', 'show', '--id', config.apiClientId, '-o', 'json'])));
  const role = service.appRoles.find(value => value.value === config.requiredRole && value.isEnabled &&
    value.allowedMemberTypes.includes('User'));
  if (!role) throw new Error('The enabled human application role is missing from this service principal');
  const assignmentsUrl = `https://graph.microsoft.com/v1.0/servicePrincipals/${service.id}/appRoleAssignedTo`;
  let url: string | undefined = assignmentsUrl;
  const visited = new Set<string>();
  while (url) {
    if ((url !== assignmentsUrl && !url.startsWith(`${assignmentsUrl}?`)) || visited.has(url)) {
      throw new Error('Invalid or repeated application role assignment continuation URL');
    }
    visited.add(url);
    const page = z.object({ value: z.array(z.object({
      principalId: z.string(), appRoleId: z.string(), resourceId: z.string(),
    })), '@odata.nextLink': z.string().optional() }).parse(JSON.parse(
      await run('az', ['rest', '--method', 'GET', '--url', url, '-o', 'json']),
    ));
    if (page.value.some(item => item.principalId === principalId && item.appRoleId === role.id && item.resourceId === service.id)) return;
    url = page['@odata.nextLink'];
  }
  await mkdir('.sql-apps', { recursive: true });
  const path = resolve('.sql-apps', `role-assignment-${principalId}.json`);
  await saveJson(path, { principalId, resourceId: service.id, appRoleId: role.id });
  await run('az', ['rest', '--method', 'POST', '--url', assignmentsUrl, '--body', `@${path}`, '-o', 'none']);
}

export function applicationRegistrationRole(config: DeploymentConfig) {
  return {
    id: applicationRoleId, value: config.requiredRole, displayName: 'Application user',
    description: 'Allow users assigned this role to use this data application.',
    allowedMemberTypes: ['User'], isEnabled: true,
  };
}
