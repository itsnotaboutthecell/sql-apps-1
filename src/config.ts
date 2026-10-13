import { z } from 'zod';
import { requiredRoleSchema, readinessPathSchema } from './role-based-profile.js';

const uuid = z.string().uuid();
const httpsOrigin = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'Cloud service URLs must use HTTPS' });
  }
  if (url.username || url.password) {
    context.addIssue({ code: 'custom', message: 'Cloud service URLs must not contain credentials' });
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'Cloud service URLs must be origins without a path, query, or fragment' });
  }
});
const image = z.string().regex(
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+(?::[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/,
  'Use a registry/repository with an explicit version or sha256 digest',
).refine(value => !value.endsWith(':latest'), 'Use an explicit version, not latest');

export const deploymentSchema = z.strictObject({
  profile: z.literal('role-based-data'),
  requiredRole: requiredRoleSchema,
  readinessPath: readinessPathSchema,
  subscriptionId: uuid,
  tenantId: uuid,
  apiClientId: uuid,
  sqlAdminObjectId: uuid,
  sqlAdminName: z.string().min(1).max(128),
  resourceGroup: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.()-]{0,89}$/),
  location: z.string().regex(/^[a-z0-9]+$/),
  environment: z.enum(['dev', 'test', 'prod']),
  name: z.string().regex(/^[a-z][a-z0-9-]{2,19}$/),
  gatewayImage: image,
  dabImage: image,
  // Configurations written by 0.1.x init carry an empty functionsImage; accept and ignore it.
  functionsImage: z.literal('').optional(),
  // SQL/DAB source fingerprint the pinned images were built from; artifacts writes it.
  imageSource: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  registryServer: z.string().regex(/^[a-z0-9]+\.azurecr\.io$/),
}).superRefine((config, context) => {
  for (const field of ['gatewayImage', 'dabImage'] as const) {
    if (!config[field].startsWith(`${config.registryServer}/`)) {
      context.addIssue({ code: 'custom', path: [field], message: 'Image must belong to the configured ACR' });
    }
  }
});

export type DeploymentConfig = z.infer<typeof deploymentSchema>;

export const runtimeSchema = z.strictObject({
  requiredRole: requiredRoleSchema,
  readinessPath: readinessPathSchema,
  tenantId: uuid,
  apiClientId: uuid,
  dabUrl: httpsOrigin,
  publicDirectory: z.string().min(1),
});

export type RuntimeConfig = z.infer<typeof runtimeSchema>;

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  return runtimeSchema.parse({
    requiredRole: env.SQL_APPS_REQUIRED_ROLE,
    readinessPath: env.SQL_APPS_READINESS_PATH,
    tenantId: env.AZURE_TENANT_ID,
    apiClientId: env.API_CLIENT_ID,
    dabUrl: env.DAB_URL,
    publicDirectory: env.PUBLIC_DIRECTORY ?? 'public',
  });
}

export function environmentKey(config: DeploymentConfig): string {
  return `${config.subscriptionId}/${config.resourceGroup}/${config.name}/${config.environment}`;
}

export function portFromEnvironment(value: string | undefined): number {
  return z.coerce.number().int().min(1).max(65535).parse(value ?? 8080);
}
