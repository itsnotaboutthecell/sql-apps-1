import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { z } from 'zod';
import { demoPublicationSchema, type DemoPublicationConfig } from './demo-publication.js';
import type { Run } from './process.js';

const guid = z.string().uuid().transform(value => value.toLowerCase());

export const demoInitOptionsSchema = z.strictObject({
  subscriptionId: guid,
  resourceGroup: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.()-]{0,89}$/),
  location: z.string().regex(/^[a-z0-9]+$/),
  staticWebAppLocation: z.string().regex(/^[a-z0-9]+$/),
  selectedApplication: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  selectedArtifact: z.string().min(1),
  owner: z.string().trim().min(1).max(256),
});
export type DemoInitOptions = z.input<typeof demoInitOptionsSchema>;

const accountSchema = z.strictObject({ id: guid, tenantId: guid });
const tokenSchema = z.object({ accessToken: z.string().min(1) });
const claimsSchema = z.object({
  oid: guid,
  name: z.string().trim().min(1).optional(),
  preferred_username: z.string().trim().min(1).optional(),
}).refine(claims => claims.name !== undefined || claims.preferred_username !== undefined, {
  message: 'ARM token identity claims require name or preferred_username',
});
const ipSchema = z.strictObject({ ip: z.string() });

function decodeClaims(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('ARM access token must be a JWT with exactly 3 parts');
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new Error('ARM access token claims are not valid base64url JSON');
  }
  const claims = claimsSchema.safeParse(body);
  if (!claims.success) throw new Error('ARM access token identity claims are invalid');
  return claims.data;
}

async function discoverPublicIpv4(fetcher: typeof fetch): Promise<string> {
  const response = await fetcher('https://api.ipify.org?format=json', {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Public IPv4 discovery failed with HTTP ${response.status}`);
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error('Public IPv4 discovery returned malformed JSON');
  }
  const parsed = ipSchema.safeParse(body);
  if (!parsed.success) throw new Error('Public IPv4 discovery returned a malformed IPv4 response');
  const octets = parsed.data.ip.split('.').map(Number);
  const [first = -1, second = -1] = octets;
  const nonPublic = first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  if (isIP(parsed.data.ip) !== 4 || nonPublic) {
    throw new Error('Public IPv4 discovery did not return a valid public IPv4 address');
  }
  return parsed.data.ip;
}

/** Discovers account and operator context without creating or changing Azure resources. */
export async function initDemoPublication(
  input: DemoInitOptions,
  runner: Run,
  fetcher: typeof fetch = fetch,
  newId: () => string = randomUUID,
): Promise<DemoPublicationConfig> {
  const options = demoInitOptionsSchema.parse(input);
  const account = accountSchema.parse(JSON.parse(await runner('az', [
    'account', 'show', '--subscription', options.subscriptionId,
    '--query', '{id:id,tenantId:tenantId}', '-o', 'json',
  ])));
  if (account.id !== options.subscriptionId) {
    throw new Error('Azure CLI account context does not match the exact requested subscription');
  }
  const token = tokenSchema.parse(JSON.parse(await runner('az', [
    'account', 'get-access-token', '--subscription', options.subscriptionId,
    '--resource', 'https://management.azure.com/', '-o', 'json',
  ], { sensitiveOutput: true })));
  const claims = decodeClaims(token.accessToken);
  const schemaRunnerIp = await discoverPublicIpv4(fetcher);
  const deploymentId = guid.parse(newId());
  const tokenPart = deploymentId.replaceAll('-', '').slice(0, 12);
  const short = deploymentId.slice(0, 8);
  const registryServer = `sqlappsdemo${tokenPart}.azurecr.io`;

  return demoPublicationSchema.parse({
    version: 1,
    profile: 'public-demo',
    securityPosture: 'starter',
    hosting: 'static-web-apps',
    name: 'sqlapps',
    subscriptionId: options.subscriptionId,
    tenantId: account.tenantId,
    resourceGroup: options.resourceGroup,
    location: options.location,
    staticWebAppLocation: options.staticWebAppLocation,
    deploymentId,
    applicationName: `sqlapps-${short}-web`,
    staticWebAppName: `sqlapps-${short}-static`,
    registryServer,
    gatewayImage: `${registryServer}/sqlapps-${options.selectedApplication}-api:${short}`,
    dabImage: `${registryServer}/sqlapps-${options.selectedApplication}-dab:${short}`,
    selectedApplication: options.selectedApplication,
    selectedArtifact: resolve(options.selectedArtifact),
    sqlAdminObjectId: claims.oid,
    sqlAdminName: claims.name ?? claims.preferred_username,
    schemaRunnerIp,
    cost: { intent: 'review-paid-costs', acknowledgeFixedCharges: true },
    sqlBillingMode: 'free-paused',
    sqlSku: { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 },
    sqlMaxSizeBytes: 32 * 1024 ** 3,
    sqlBackupRedundancy: 'Local',
    tags: { environment: 'synthetic-demo', owner: options.owner },
  });
}
