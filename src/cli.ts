import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { run } from './process.js';
import { smoke } from './smoke.js';
import { deployStatic, setSecret, updateImage } from './maintenance.js';
import { buildArtifacts } from './artifacts.js';
import { assignApplicationRole, applicationRegistrationRole } from './role-based-identity.js';
import { roleBasedSmoke } from './role-based-smoke.js';
import { validateRoleBasedCloudSource } from './role-based-profile.js';
import { initDeploymentConfig, planDeployAll, unsetClientId, type InitOptions } from './azure-init.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  configureRedirect, delegatedScopeId, deploy, deploymentConfigHash, functionRoleId, parametersFile, preflight,
  publishSchema, readConfig, readState, saveJson, saveState, statePath, withDeploymentLock, provision,
  deploymentTemplatePath, rbacParametersFile, rbacTemplatePath, verifyRbacAssignments, type DeploymentState,
} from './deployment.js';

const [command, configPath = 'sql-apps.json', argument] = process.argv.slice(2);

function parseFlags(args: string[], allowed: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!key || !args[i]!.startsWith('--') || !allowed.includes(key) || key in flags || args[i + 1] === undefined) throw new Error(`Unknown, duplicate or empty option ${args[i]}; allowed: ${allowed.map(item => `--${item}`).join(' ')}`);
    flags[key] = args[i + 1];
  }
  return flags;
}
async function main() {
  if (command === 'help' || !command) {
    console.log('Usage: npm run azure -- <init|deploy-all|validate|artifacts|identity|plan|provision|rbac-plan|rbac-deploy|deploy|status|schema|static|redirect|smoke|gateway|functions|secret-set|role-based-assign|role-based-smoke> [config.json] [options]\nRequires a current build (after approval, consent-run build). Azure CLI, Bicep, .NET and SqlPackage are used directly.');
    console.log('New deployments: use maintained Azure Skills for onboarding, preparation, validation, deployment, cost and diagnostics. These commands deploy the role-based-data profile with private SQL, DAB managed-identity grants and live SQL Apps acceptance, and remain supported for existing SQL Apps deployments.');
    console.log('Role-based-data: use validate/artifacts/identity/plan/provision/deploy/status/schema with a role-based-data deployment configuration. role-based-assign <config> <user-or-group-object-id> explicitly assigns its application role; role-based-smoke <config> needs delegated tokens with and without the required role in SQL_APPS_USER_TOKEN / SQL_APPS_SECOND_USER_TOKEN. All cloud writes need operator approval; local simulations never deploy.');
    console.log('Shortest path: stay local for POCs. For cloud validation: az login, then init <new-config.json> --location <region> --resource-group <rg> --registry <name>.azurecr.io (read-only). This defaults to the scale-to-zero role-based-data profile; --profile foundation is an explicit paid full-stack opt-in. Review costs with the Azure Cost tooling before approving paid steps.');
    return;
  }
  if (command === 'init') {
    const flags = parseFlags(process.argv.slice(4), ['profile', 'location', 'resource-group', 'registry', 'environment', 'name']);
    if (process.argv.length < 4 || !configPath.endsWith('.json')) throw new Error('Usage: init <new-config.json> [--profile role-based-data|foundation] --location <region> --resource-group <name> --registry <name>.azurecr.io [--environment dev|test|prod] [--name <name>]. Defaults to role-based-data; foundation is the paid full-stack opt-in.');
    if (existsSync(resolve(configPath))) throw new Error(`${configPath} already exists; init never overwrites a configuration.`);
    for (const key of ['location', 'resource-group', 'registry']) if (!flags[key]) throw new Error(`init needs --${key}; tenant, subscription and SQL administrator come from az login.`);
    const config = await initDeploymentConfig({
      ...(flags.profile ? { profile: flags.profile as NonNullable<InitOptions['profile']> } : {}),
      location: flags.location!, resourceGroup: flags['resource-group']!,
      registryServer: flags.registry!, environment: flags.environment as InitOptions['environment'], name: flags.name,
    }, run);
    if (config.profile === 'role-based-data') await validateRoleBasedCloudSource({ profile: 'role-based-data', requiredRole: config.requiredRole!, readinessPath: config.readinessPath! });
    await saveJson(resolve(configPath), config);
    console.log(`Wrote ${configPath} for subscription ${config.subscriptionId} (tenant ${config.tenantId}); ${config.sqlAdminName} becomes the SQL administrator. Nothing was created in Azure.`);
    console.log(`Next (read-only): plan ${configPath} after identity, or deploy-all ${configPath} to review the paid steps.`);
    return;
  }
  if (command === 'deploy-all') {
    const flags = parseFlags(process.argv.slice(4), ['approve']);
    const load = async () => {
      const current = await readConfig(resolve(configPath));
      let state: DeploymentState | undefined;
      try { state = await readState(current); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      if (state && state.configHash !== await deploymentConfigHash(current)) {
        throw new Error('Deployment configuration or SQL/DAB source changed; review the saved deployment before resuming deploy-all.');
      }
      return planDeployAll(current, state?.stage);
    };
    const reviewed = await load();
    if (flags.approve !== reviewed.approval) {
      if (flags.approve) throw new Error('The configuration or remaining work changed since review; run deploy-all again and review the new list.');
      console.log(`Pending paid Azure steps for ${configPath}: ${reviewed.pending.join(' -> ')}`);
      console.log(`Not included: ${reviewed.excluded.join('; ')}.`);
      console.log('Review cost first with the Azure Cost tooling, and plan (what-if) once identity exists.');
      console.log(`After explicit approval: deploy-all ${configPath} --approve ${reviewed.approval}`);
      return;
    }
    for (const step of reviewed.pending) {
      if (!(await load()).pending.includes(step)) continue;
      console.log(`== ${step}`);
      const code = await new Promise<number | null>((done, reject) => spawn(process.execPath, [process.argv[1]!, step, configPath], { stdio: 'inherit' })
        .on('error', reject).on('exit', done));
      if (code !== 0) throw new Error(`${step} failed; fix the cause, then run deploy-all ${configPath} again to resume from the remaining steps.`);
      if (step === 'provision') {
        console.log(`Infrastructure is ready. An administrator must review rbac-plan ${configPath} and run rbac-deploy ${configPath}; then rerun deploy-all to continue with live-verified RBAC.`);
        return;
      }
    }
    console.log('deploy-all finished. Assign the application role (role-based-assign) and run smoke tests as separate decisions.');
    return;
  }
  if (!['validate', 'artifacts', 'identity', 'plan', 'provision', 'rbac-plan', 'rbac-deploy', 'deploy', 'status', 'schema', 'static', 'redirect', 'smoke', 'gateway', 'functions', 'secret-set', 'role-based-assign', 'role-based-smoke'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const config = await readConfig(resolve(configPath));
  if (config.profile === 'role-based-data') await validateRoleBasedCloudSource({
    profile: 'role-based-data', requiredRole: config.requiredRole!, readinessPath: config.readinessPath!,
  });
  if (command === 'role-based-assign') {
    if (!argument || process.argv.length !== 5) throw new Error('Provide exactly one authorized user/group object ID');
    await assignApplicationRole(config, argument, run);
    console.log('Application role assignment verified or created; acquire a fresh delegated access token and run role-based-smoke.');
    return;
  }
  if (command === 'validate') { console.log('Configuration valid'); return; }
  if (config.apiClientId === unsetClientId && command !== 'identity') throw new Error('apiClientId is not set yet; run identity (or deploy-all) first.');
  if (command === 'artifacts') {
    await withDeploymentLock(statePath(config), async () => {
      const pinned = await buildArtifacts(config, run);
      if (JSON.stringify(await readConfig(resolve(configPath))) !== JSON.stringify(config)) {
        throw new Error('Configuration changed during artifact builds; images were published but configuration was not overwritten');
      }
      await saveJson(resolve(configPath), pinned);
    });
    console.log(`${config.profile === 'role-based-data' ? 'Two' : 'Three'} images published to ACR; configuration atomically updated to immutable digests.`);
    return;
  }
  if (command === 'identity') {
    const account = z.object({ tenantId: z.string() }).parse(JSON.parse(await run('az', ['account', 'show', '-o', 'json'])));
    if (account.tenantId !== config.tenantId) throw new Error('Sign Azure CLI into the configured tenant before creating its application');
    const registration = z.object({ id: z.string().uuid(), appId: z.string().uuid() }).parse(JSON.parse(
      await run('az', ['ad', 'app', 'create', '--display-name', `${config.name}-${config.environment}`, '--sign-in-audience', 'AzureADMyOrg', '-o', 'json']),
    ));
    const path = resolve('.sql-apps', 'identity.json');
    await mkdir('.sql-apps', { recursive: true });
    await writeFile(path, JSON.stringify({
      identifierUris: [`api://${registration.appId}`],
      api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [{
        id: delegatedScopeId, value: 'access_as_user', type: 'User', isEnabled: true,
        adminConsentDisplayName: 'Access SQL Apps', adminConsentDescription: 'Access this application as the signed-in user.',
        userConsentDisplayName: 'Access SQL Apps', userConsentDescription: 'Access your application data.',
      }] },
      spa: { redirectUris: [] },
      appRoles: config.profile === 'role-based-data' ? [applicationRegistrationRole(config)] : [{
        id: functionRoleId, value: 'Function.Invoke', displayName: 'Invoke functions',
        description: 'Allow the gateway to invoke application functions.', allowedMemberTypes: ['Application'], isEnabled: true,
      }],
    }));
    await run('az', ['rest', '--method', 'PATCH', '--url', `https://graph.microsoft.com/v1.0/applications/${registration.id}`, '--body', `@${path}`, '-o', 'none']);
    await run('az', ['ad', 'sp', 'create', '--id', registration.appId, '-o', 'none']);
    if (config.apiClientId === unsetClientId) {
      await saveJson(resolve(configPath), { ...config, apiClientId: registration.appId });
      console.log(`Created app registration ${registration.appId} and saved it as apiClientId in ${configPath}.`);
    } else console.log(`Created app registration ${registration.appId}. Set apiClientId to this value in your configuration.`);
    return;
  }
  if (command === 'plan') {
    await preflight(config, run);
    console.log(await run('az', ['deployment', 'group', 'what-if', '--subscription', config.subscriptionId,
      '--resource-group', config.resourceGroup, '--template-file', deploymentTemplatePath(),
      '--parameters', `@${await parametersFile(config, true)}`]));
    return;
  }
  if (command === 'rbac-plan' || command === 'rbac-deploy') {
    const state = await readState(config);
    if (state.configHash !== await deploymentConfigHash(config)) {
      throw new Error('Saved deployment state does not match this configuration; restore the provisioned configuration or reprovision before changing Azure RBAC.');
    }
    const parameters = `@${await rbacParametersFile(config, state.outputs)}`;
    const common = ['--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
      '--template-file', rbacTemplatePath(), '--parameters', parameters];
    if (command === 'rbac-plan') {
      console.log(await run('az', ['deployment', 'group', 'what-if', ...common]));
      return;
    }
    await run('az', ['deployment', 'group', 'create', '--name', `${config.name}-${config.environment}-rbac`,
      ...common, '-o', 'none']);
    await verifyRbacAssignments(config, state.outputs, run);
    console.log('Privileged RBAC deployment completed and every required assignment was verified from live Azure state. The ordinary deployer can now run deploy.');
    return;
  }
  if (command === 'deploy') {
    await withDeploymentLock(statePath(config), async () => {
      const state = await deploy(config, run);
      console.log(`Runtime readiness passed: ${state.outputs.gatewayUrl}. Run authenticated acceptance before release.`);
    });
    return;
  }
  if (command === 'provision') {
    await withDeploymentLock(statePath(config), async () => {
      const state = await provision(config, run);
      await saveState(statePath(config), state);
      console.log(`Infrastructure available (saved stage: ${state.stage}). An administrator with roleAssignments/write must review rbac-plan ${configPath} and run rbac-deploy ${configPath}. After live RBAC verification, configure private runner connectivity to ${state.outputs.networkId}, then run deploy. Saved stages are historical, not live acceptance.`);
    });
    return;
  }
  const state = await readState(config);
  if (command === 'role-based-smoke') {
    const first = process.env.SQL_APPS_USER_TOKEN;
    const second = process.env.SQL_APPS_SECOND_USER_TOKEN;
    if (!first || !second) throw new Error('Set delegated authorized and valid tokens without the required role in the trusted process environment; do not paste tokens into chat');
    await roleBasedSmoke(config, state.outputs.gatewayUrl, first, second);
    console.log('Live authorized procedure succeeded; requests from valid users without the required role and anonymous callers were denied, including forged role headers. Browser save/reload remains separate acceptance.');
    return;
  }
  if (command === 'smoke' && config.profile === 'role-based-data') {
    throw new Error('Use role-based-smoke for role-based-data, not the foundation file/job smoke suite');
  }
  if (command === 'static') {
    await preflight(config, run, false);
    await withDeploymentLock(statePath(config), async () => {
      const pinned = await deployStatic(config, state, run);
      if (JSON.stringify(await readConfig(resolve(configPath))) !== JSON.stringify(config)) {
        throw new Error('Configuration changed during static deployment; runtime updated but configuration was not overwritten');
      }
      await saveJson(resolve(configPath), pinned);
    });
    console.log('Static assets deployed on the existing runtime digest; verify status and browser behavior.');
    return;
  }
  if (command === 'gateway' || command === 'functions') {
    await preflight(config, run);
    await withDeploymentLock(statePath(config), () => updateImage(command, config, state, run));
    console.log(`${command} image updated; run status and authenticated smoke to verify.`);
    return;
  }
  if (command === 'secret-set') {
    if (!argument || !process.env.SQL_APPS_SECRET_VALUE) throw new Error('Provide a secret name and set SQL_APPS_SECRET_VALUE in the trusted deployment process.');
    await withDeploymentLock(statePath(config), () => setSecret(argument, process.env.SQL_APPS_SECRET_VALUE!, config, state, run));
    console.log('Key Vault secret updated without persisting its value locally.');
    return;
  }
  if (command === 'smoke') {
    const first = process.env.SQL_APPS_USER_TOKEN;
    const second = process.env.SQL_APPS_SECOND_USER_TOKEN;
    if (!first || !second) throw new Error('Set SQL_APPS_USER_TOKEN and SQL_APPS_SECOND_USER_TOKEN for two users; tokens are not persisted.');
    await smoke(state.outputs.gatewayUrl, first, second, fetch, `https://${state.outputs.functionsName}.azurewebsites.net`);
    console.log('Authenticated two-user REST and GraphQL reads, files, function invocation, anonymous rejection, and fixture cleanup passed.');
    return;
  }
  if (command === 'status') {
    console.log(await run('az', ['containerapp', 'show', '--subscription', config.subscriptionId,
      '--resource-group', config.resourceGroup, '--name', state.outputs.gatewayName,
      '--query', '{provisioningState:properties.provisioningState,runningStatus:properties.runningStatus}', '-o', 'json']));
    const response = await fetch(new URL('/health/ready', state.outputs.gatewayUrl), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Readiness returned ${response.status}`);
    console.log(`Readiness passed. Last completed stage: ${state.stage}`);
    console.log(`SQL recovery: ${state.outputs.sqlBackupRetentionDays}-day point-in-time restore, ${state.outputs.sqlBackupRedundancy} backup storage redundancy. Audit events go to workspace ${state.outputs.sqlAuditWorkspaceName}. Verify a restore before relying on it.`);
    return;
  }
  if (command === 'schema') {
    await preflight(config, run);
    await withDeploymentLock(statePath(config), () => publishSchema(config, state.outputs, run));
    console.log('Schema published; destructive changes remain blocked.');
    return;
  }
  if (command === 'redirect') {
    await configureRedirect(config, state.outputs.gatewayUrl, run);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => {
  console.error(error instanceof z.ZodError ? `Configuration is invalid:\n${z.prettifyError(error)}` :
    error instanceof Error ? error.message : 'Deployment command failed');
  process.exitCode = 1;
});
