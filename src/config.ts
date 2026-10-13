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
  profile: z.enum(['foundation', 'role-based-data']),
  requiredRole: requiredRoleSchema.optional(),
  readinessPath: readinessPathSchema.optional(),
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
  functionsImage: z.union([image, z.literal('')]).default(''),
  registryServer: z.string().regex(/^[a-z0-9]+\.azurecr\.io$/),
}).superRefine((config, context) => {
  if (config.profile === 'role-based-data') {
    if (!config.requiredRole || !config.readinessPath || config.functionsImage) {
      context.addIssue({ code: 'custom', message: 'Role-based-data requires requiredRole/readinessPath and excludes functionsImage' });
    }
  } else if (!config.functionsImage || config.requiredRole || config.readinessPath) {
    context.addIssue({ code: 'custom', message: 'Foundation requires functionsImage and does not select role-based-data settings' });
  }
  for (const field of ['gatewayImage', 'dabImage', 'functionsImage'] as const) {
    if (config[field] && !config[field].startsWith(`${config.registryServer}/`)) {
      context.addIssue({ code: 'custom', path: [field], message: 'Image must belong to the configured ACR' });
    }
  }
});

export type DeploymentConfig = z.infer<typeof deploymentSchema>;

export const runtimeSchema = z.strictObject({
  profile: z.enum(['foundation', 'role-based-data']).optional(),
  requiredRole: requiredRoleSchema.optional(),
  readinessPath: readinessPathSchema.optional(),
  tenantId: uuid,
  apiClientId: uuid,
  dabUrl: httpsOrigin,
  blobAccountUrl: httpsOrigin,
  blobContainer: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  functionsUrl: httpsOrigin,
  publicDirectory: z.string().min(1),
}).superRefine((config, context) => {
  if (config.profile === 'role-based-data' && (!config.requiredRole || !config.readinessPath)) {
    context.addIssue({ code: 'custom', message: 'Role-based-data runtime requires requiredRole and readinessPath' });
  }
  if (config.profile !== 'role-based-data' && (config.requiredRole || config.readinessPath)) {
    context.addIssue({ code: 'custom', message: 'Role-based settings require the role-based-data profile' });
  }
});

export type RuntimeConfig = z.infer<typeof runtimeSchema>;

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  return runtimeSchema.parse({
    profile: env.SQL_APPS_PROFILE,
    requiredRole: env.SQL_APPS_REQUIRED_ROLE,
    readinessPath: env.SQL_APPS_READINESS_PATH,
    tenantId: env.AZURE_TENANT_ID,
    apiClientId: env.API_CLIENT_ID,
    dabUrl: env.DAB_URL,
    blobAccountUrl: env.BLOB_ACCOUNT_URL ?? (env.SQL_APPS_PROFILE === 'role-based-data' ? 'https://unconfigured.invalid' : undefined),
    blobContainer: env.BLOB_CONTAINER ?? (env.SQL_APPS_PROFILE === 'role-based-data' ? 'files' : undefined),
    functionsUrl: env.FUNCTIONS_URL ?? (env.SQL_APPS_PROFILE === 'role-based-data' ? 'https://unconfigured.invalid' : undefined),
    publicDirectory: env.PUBLIC_DIRECTORY ?? 'public',
  });
}

export function environmentKey(config: DeploymentConfig): string {
  return `${config.subscriptionId}/${config.resourceGroup}/${config.name}/${config.environment}`;
}

export function portFromEnvironment(value: string | undefined): number {
  return z.coerce.number().int().min(1).max(65535).parse(value ?? 8080);
}
