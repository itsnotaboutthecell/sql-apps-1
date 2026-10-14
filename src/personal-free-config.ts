import { z } from 'zod';

const uuid = z.string().uuid();

export const personalFreeConfigSchema = z.strictObject({
  profile: z.literal('personal-free'),
  subscriptionId: uuid,
  tenantId: uuid,
  sqlAdministratorObjectId: uuid,
  sqlAdministratorName: z.string().min(1).max(128),
  resourceGroup: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.()-]{0,89}$/),
  location: z.string().regex(/^[a-z0-9]+$/),
  environment: z.enum(['dev', 'test', 'prod']),
  name: z.string().regex(/^[a-z][a-z0-9-]{2,19}$/),
});

export type PersonalFreeConfig = z.infer<typeof personalFreeConfigSchema>;

export const protectedDeploymentStateSchema = z.strictObject({
  approval: z.string().regex(/^[a-f0-9]{12}$/),
  stage: z.enum(['new', 'infrastructure', 'schema', 'runtime-user', 'application', 'ready']),
  sqlAdministratorPassword: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  runtimePassword: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  staticWebAppName: z.string().optional(),
  staticWebAppHostname: z.string().optional(),
  sqlServer: z.string().optional(),
});

export type ProtectedDeploymentState = z.infer<typeof protectedDeploymentStateSchema>;
