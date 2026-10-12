import { z } from 'zod';
import type { Run } from './process.js';

const guid = z.string().uuid().transform(value => value.toLowerCase());
export const demoTargetSchema = z.strictObject({
  profile: z.literal('public-demo'),
  securityPosture: z.enum(['starter', 'hardened']),
  tenantId: guid, subscriptionId: guid,
  resourceGroup: z.string().regex(/^[a-zA-Z0-9_().-]{1,90}$/).refine(value => !value.endsWith('.')),
  location: z.string().regex(/^[a-z][a-z0-9]{1,31}$/),
  staticWebAppLocation: z.string().regex(/^[a-z][a-z0-9]{1,31}$/).optional(),
});
export type DemoTarget = z.infer<typeof demoTargetSchema>;
type PreflightCode = 'TENANT_TOKEN_REQUIRED' | 'TOKEN_TENANT_MISMATCH' | 'TOKEN_EXPIRED' | 'TOKEN_FORMAT_INVALID' |
  'SUBSCRIPTION_TENANT_MISMATCH' | 'SUBSCRIPTION_NOT_ENABLED' | 'ARM_FORBIDDEN' | 'ARM_TOKEN_REJECTED' |
  'AZURE_POLICY_DENIED' | 'ARM_TRANSIENT_FAILURE' | 'ARM_TRANSPORT_FAILED' | 'ARM_RESOURCE_NOT_ACCESSIBLE' |
  'ARM_INVALID_RESPONSE' | 'PROVIDER_REGISTRATION_REQUIRED' | 'REGION_UNSUPPORTED' | 'WRITE_AUTHORIZATION_MISSING';
export class DemoPreflightError extends Error {
  readonly stage = 'azure-preflight';
  constructor(readonly code: PreflightCode, message: string) {
    super(message);
    this.name = 'DemoPreflightError';
  }
}
const baseProviders = {
  'Microsoft.App': ['managedEnvironments', 'containerApps'],
  'Microsoft.Sql': ['servers'],
  'Microsoft.Network': ['virtualNetworks'],
  'Microsoft.ContainerRegistry': ['registries'],
  'Microsoft.ManagedIdentity': ['userAssignedIdentities'],
  'Microsoft.Web': ['staticSites', 'staticSites/linkedBackends'],
} as const;

async function cacheEvidence(target: DemoTarget, runner: Run) {
  let text: string;
  try { text = await runner('az', ['account', 'list', '--all', '--output', 'json']); }
  catch {
    return { status: 'unavailable' as const, code: 'CACHE_DISCOVERY_FAILED',
      action: 'Cache discovery failed; independently test the selected tenant token and actual ARM access. Do not infer revoked access or require Graph.' };
  }
  let body: unknown;
  try { body = JSON.parse(text); }
  catch { return { status: 'unavailable' as const, code: 'CACHE_RESPONSE_INVALID', action: 'Review CLI cache discovery separately from actual ARM access.' }; }
  const parsed = z.array(z.object({ id: guid, tenantId: guid })).safeParse(body);
  if (!parsed.success) return { status: 'unavailable' as const, code: 'CACHE_RESPONSE_INVALID', action: 'Review CLI cache discovery separately from actual ARM access.' };
  const match = parsed.data.find(account => account.id === target.subscriptionId);
  return { status: match ? 'found' as const : 'not-found' as const,
    code: match && match.tenantId !== target.tenantId ? 'CACHE_TENANT_MISMATCH' : 'CACHE_DISCOVERY_COMPLETE',
    action: 'Cache evidence is not authoritative; this workflow does not refresh login or change global subscription defaults.' };
}

async function tenantToken(target: DemoTarget, runner: Run) {
  let text: string;
  try {
    text = await runner('az', ['account', 'get-access-token', '--tenant', target.tenantId,
      '--resource', 'https://management.azure.com/', '--output', 'json']);
  } catch {
    throw new DemoPreflightError('TENANT_TOKEN_REQUIRED',
      'Tenant-scoped CLI token acquisition failed. Review sign-in, expiration and conditional-access requirements for the selected tenant; this is not proof of revoked ARM access. Login/cache changes require approval.');
  }
  let body: unknown;
  try { body = JSON.parse(text); }
  catch { throw new DemoPreflightError('TOKEN_FORMAT_INVALID', 'CLI token response is not valid JSON; token contents were not logged.'); }
  const parsed = z.object({ accessToken: z.string().min(1), tenant: guid,
    expires_on: z.union([z.number().int().positive(), z.string().regex(/^[0-9]+$/).transform(Number)]) }).safeParse(body);
  if (!parsed.success) throw new DemoPreflightError('TOKEN_FORMAT_INVALID', 'CLI token metadata is invalid; a current CLI with UTC expires_on is required. Local-time expiresOn is not used.');
  if (parsed.data.tenant !== target.tenantId) throw new DemoPreflightError('TOKEN_TENANT_MISMATCH', 'CLI returned a token for another tenant; no ARM request was issued.');
  if (parsed.data.expires_on * 1000 <= Date.now() + 30_000) throw new DemoPreflightError('TOKEN_EXPIRED', 'Tenant token is expired or too close to expiration; renew it explicitly before retrying.');
  return parsed.data.accessToken;
}

function parse<T>(schema: z.ZodType<T>, body: unknown, operation: string): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new DemoPreflightError('ARM_INVALID_RESPONSE', `ARM ${operation} returned an invalid response; raw contents were not logged.`);
  return result.data;
}
const delay = (attempt: number) => new Promise(done => setTimeout(done, 100 * 2 ** attempt));
function transientTransport(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  const cause = error.cause;
  return cause instanceof Error && 'code' in cause &&
    ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(String(cause.code));
}
function actionMatches(pattern: string, action: string) {
  const expression = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${expression}$`, 'i').test(action);
}

export async function preflightDemo(input: unknown, runner: Run, fetcher: typeof fetch = fetch) {
  const target = demoTargetSchema.parse(input);
  const providers = target.securityPosture === 'hardened'
    ? { ...baseProviders, 'Microsoft.Authorization': ['roleAssignments'] as const }
    : baseProviders;
  const [cache, token] = await Promise.all([cacheEvidence(target, runner), tenantToken(target, runner)]);
  const subscriptionScope = `/subscriptions/${target.subscriptionId}`;
  const groupScope = `${subscriptionScope}/resourcegroups/${encodeURIComponent(target.resourceGroup)}`;
  const arm = async (path: string, version: string, allowMissing = false): Promise<unknown> => {
    const url = new URL(path, 'https://management.azure.com');
    url.searchParams.set('api-version', version);
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), redirect: 'error',
        });
      } catch (error) {
        if (transientTransport(error) && attempt < 2) { await delay(attempt); continue; }
        throw new DemoPreflightError(transientTransport(error) ? 'ARM_TRANSIENT_FAILURE' : 'ARM_TRANSPORT_FAILED',
          'The selected ARM endpoint could not be reached; inspect transport/TLS evidence separately from login or access.');
      }
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        if (attempt < 2) { await delay(attempt); continue; }
        throw new DemoPreflightError('ARM_TRANSIENT_FAILURE', `ARM remained unavailable after three attempts (${response.status}).`);
      }
      if (response.status === 404 && allowMissing) return null;
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new DemoPreflightError('ARM_INVALID_RESPONSE', `ARM returned non-JSON (${response.status}); raw contents were not logged.`); }
      if (!response.ok) {
        const failure = z.object({ error: z.object({ code: z.string() }) }).safeParse(body);
        if (failure.success && ['RequestDisallowedByPolicy', 'DenyAssignmentAuthorizationFailed'].includes(failure.data.error.code)) {
          throw new DemoPreflightError('AZURE_POLICY_DENIED', 'The selected tenant/resource scope explicitly denied this ARM operation by policy or deny assignment; login refresh is not a repair.');
        }
        if (response.status === 401) throw new DemoPreflightError('ARM_TOKEN_REJECTED', 'ARM rejected the tenant token; review tenant-scoped authentication, not Graph/cache discovery.');
        if (response.status === 403) throw new DemoPreflightError('ARM_FORBIDDEN', 'ARM access is forbidden at the selected scope; inspect RBAC/deny evidence separately from Graph permissions.');
        throw new DemoPreflightError('ARM_RESOURCE_NOT_ACCESSIBLE', `The explicit ARM target is not accessible (${response.status}); verify tenant, subscription and resource scope.`);
      }
      return body;
    }
    throw new DemoPreflightError('ARM_TRANSIENT_FAILURE', 'ARM retry limit reached.');
  };
  const list = async <T>(path: string, version: string, item: z.ZodType<T>): Promise<T[]> => {
    const expected = new URL(path, 'https://management.azure.com');
    expected.searchParams.set('api-version', version);
    let next: URL | undefined = expected;
    const visited = new Set<string>();
    const values: T[] = [];
    while (next) {
      if (visited.size >= 10 || visited.has(next.href) || next.origin !== expected.origin ||
          next.pathname.toLowerCase() !== expected.pathname.toLowerCase() || next.username || next.password || next.hash ||
          next.searchParams.get('api-version') !== version) {
        throw new DemoPreflightError('ARM_INVALID_RESPONSE', 'ARM pagination exceeded its bound, cycled or left the exact HTTPS resource scope; credentials were not forwarded.');
      }
      visited.add(next.href);
      const page: { value: T[]; nextLink?: string | null | undefined } = parse(z.object({ value: z.array(item), nextLink: z.string().nullable().optional() }),
        await arm(next.href, version), 'paginated list');
      values.push(...page.value);
      if (!page.nextLink) next = undefined;
      else {
        try { next = new URL(page.nextLink, next); }
        catch { throw new DemoPreflightError('ARM_INVALID_RESPONSE', 'ARM pagination URL is malformed; raw contents were not logged.'); }
        if (!next.searchParams.has('api-version')) next.searchParams.set('api-version', version);
      }
    }
    return values;
  };
  const subscription = parse(z.object({ subscriptionId: guid, tenantId: guid, state: z.string() }),
    await arm(subscriptionScope, '2022-12-01'), 'subscription');
  if (subscription.subscriptionId !== target.subscriptionId || subscription.tenantId !== target.tenantId) {
    throw new DemoPreflightError('SUBSCRIPTION_TENANT_MISMATCH', 'Authoritative ARM subscription/tenant does not match the explicit target.');
  }
  if (subscription.state !== 'Enabled') throw new DemoPreflightError('SUBSCRIPTION_NOT_ENABLED', 'The explicit ARM subscription is not enabled.');
  const [group, locations] = await Promise.all([
    arm(groupScope, '2024-03-01', true),
    list(`${subscriptionScope}/locations`, '2022-12-01', z.object({ name: z.string(), displayName: z.string() })),
  ]);
  if (group !== null) {
    const resource = parse(z.object({ id: z.string(), location: z.string() }), group, 'resource group');
    if (resource.id.toLowerCase() !== groupScope.toLowerCase()) throw new DemoPreflightError('ARM_INVALID_RESPONSE', 'ARM returned a different resource-group scope.');
  }
  const location = locations.find(item => item.name === target.location);
  if (!location) throw new DemoPreflightError('REGION_UNSUPPORTED', 'Selected region is not available to this subscription.');
  const staticWebAppLocation = locations.find(item => item.name === (target.staticWebAppLocation ?? target.location));
  if (!staticWebAppLocation) {
    throw new DemoPreflightError('REGION_UNSUPPORTED', 'Selected Static Web Apps region is not available to this subscription.');
  }
  const [permissions, availableProviders] = await Promise.all([
    list(`${group === null ? subscriptionScope : groupScope}/providers/Microsoft.Authorization/permissions`, '2022-04-01',
      z.object({ actions: z.array(z.string().max(256)), notActions: z.array(z.string().max(256)) })),
    Promise.all(Object.entries(providers).map(async ([namespace, types]) => {
      const provider = parse(z.object({ namespace: z.string(), registrationState: z.string(),
        resourceTypes: z.array(z.object({ resourceType: z.string(), locations: z.array(z.string()).optional() })) }),
      await arm(`${subscriptionScope}/providers/${namespace}`, '2021-04-01'), 'provider');
      if (provider.namespace !== namespace) throw new DemoPreflightError('ARM_INVALID_RESPONSE', 'ARM returned another provider namespace.');
      if (provider.registrationState !== 'Registered') throw new DemoPreflightError('PROVIDER_REGISTRATION_REQUIRED', `Provider ${namespace} needs explicit registration approval; it was not registered automatically.`);
      const providerLocation = namespace === 'Microsoft.Web' ? staticWebAppLocation : location;
      for (const type of types) {
        const resource = provider.resourceTypes.find(item => item.resourceType.toLowerCase() === type.toLowerCase());
        const normalize = (value: string) => value.replace(/[\s-]/g, '').toLowerCase();
        const requiresRegion = namespace !== 'Microsoft.Authorization' && type !== 'staticSites/linkedBackends';
        if (!resource || (requiresRegion &&
            !resource.locations?.some(value => normalize(value) === normalize(providerLocation.displayName) ||
              normalize(value) === (namespace === 'Microsoft.Web' ? target.staticWebAppLocation ?? target.location : target.location)))) {
          throw new DemoPreflightError('REGION_UNSUPPORTED', `${namespace}/${type} does not advertise the selected region; no alternate region was selected.`);
        }
      }
      return namespace;
    })),
  ]);
  const actions = ['Microsoft.Resources/deployments/write',
    ...Object.entries(providers).flatMap(([namespace, types]) => types.map(type => `${namespace}/${type}/write`)),
    'Microsoft.Sql/servers/databases/write', 'Microsoft.Sql/servers/administrators/write',
    'Microsoft.Sql/servers/virtualNetworkRules/write',
    'Microsoft.Sql/servers/firewallRules/write', 'Microsoft.Sql/servers/firewallRules/delete',
    'Microsoft.Network/virtualNetworks/subnets/write', 'Microsoft.Network/virtualNetworks/subnets/join/action',
    'Microsoft.Network/virtualNetworks/subnets/joinViaServiceEndpoint/action',
    'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action',
    'Microsoft.ContainerRegistry/registries/scheduleRun/action', 'Microsoft.ContainerRegistry/registries/runs/read',
    'Microsoft.ContainerRegistry/registries/listCredentials/action',
    'Microsoft.Web/staticSites/listSecrets/action',
    ...(group === null ? ['Microsoft.Resources/subscriptions/resourceGroups/write'] : [])];
  const missing = actions.filter(action => !permissions.some(permission =>
    permission.actions.some(pattern => actionMatches(pattern, action)) && !permission.notActions.some(pattern => actionMatches(pattern, action))));
  if (missing.length) throw new DemoPreflightError('WRITE_AUTHORIZATION_MISSING', `Effective scope permissions do not include: ${missing.join(', ')}. No resource operation was attempted.`);
  return {
    version: 1 as const, target, securityPosture: target.securityPosture, cache, arm: { status: 'verified' as const },
    resourceGroup: { status: group === null ? 'requires-approved-creation' as const : 'exists' as const },
    providers: availableProviders, authorization: { status: 'eligible-for-what-if' as const },
    policy: { status: 'not-yet-evaluated' as const,
      action: 'Approved target-specific what-if and deployment must evaluate policy, deny assignments, quotas and SQL settings; successful read/permission discovery does not prove deployment success.' },
    graph: { status: 'not-required-and-not-invoked' as const },
    costs: { status: 'not-evaluated' as const,
      action: 'Run the offline demo-cost review before what-if. Free SQL/compute grants do not remove registry or managed-network charges. Confirm target pricing and actual grant usage separately; this diagnostic grants no spending consent.' },
  };
}
