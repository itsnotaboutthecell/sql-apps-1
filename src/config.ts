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

export function portFromEnvironment(value: string | undefined): number {
  return z.coerce.number().int().min(1).max(65535).parse(value ?? 8080);
}
