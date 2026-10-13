import { createHash } from 'node:crypto';
import { z } from 'zod';

export const capabilitySchema = z.enum([
  'static-web',
  'server-rendered',
  'application-api',
  'visitor-sessions',
  'entra-auth',
  'files',
  'background-jobs',
  'operational-observability',
]);
export type ArchitectureCapability = z.infer<typeof capabilitySchema>;

export const guaranteeSchema = z.enum([
  'synthetic-data-only',
  'same-origin-browser',
  'authenticated-users',
  'private-data-path',
  'operational-investigation',
]);
export type ArchitectureGuarantee = z.infer<typeof guaranteeSchema>;

export const applicationBriefSchema = z.strictObject({
  version: z.literal(1),
  audience: z.enum(['private', 'invited', 'organization', 'public']),
  access: z.enum(['anonymous', 'visitor-session', 'entra']),
  frontend: z.enum(['static', 'server-rendered']),
  api: z.enum(['dab-only', 'application']),
  data: z.enum(['synthetic', 'real']),
  files: z.boolean(),
  backgroundWork: z.boolean(),
  availability: z.enum(['proof-of-concept', 'shared-preview', 'relied-upon']),
  observability: z.enum(['basic', 'operational']),
  growthPriority: z.enum(['simplest-start', 'continuity', 'stronger-isolation']),
  acceptanceActions: z.array(z.string().trim().min(1).max(256)).min(1).max(20),
}).superRefine((brief, context) => {
  if (brief.access === 'anonymous' && brief.data === 'real') {
    context.addIssue({
      code: 'custom',
      path: ['data'],
      message: 'Anonymous access is limited to synthetic data',
    });
  }
  if (brief.frontend === 'server-rendered' && brief.api === 'dab-only') {
    context.addIssue({
      code: 'custom',
      path: ['api'],
      message: 'Server-rendered applications require application API logic',
    });
  }
});
export type ApplicationBrief = z.infer<typeof applicationBriefSchema>;

const unique = <T extends z.ZodType<string>>(item: T) =>
  z.array(item).min(1).refine(values => new Set(values).size === values.length, 'Values must be unique');

export const architectureIntentSchema = z.strictObject({
  version: z.literal(1),
  briefFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: unique(capabilitySchema),
  guarantees: z.array(guaranteeSchema)
    .refine(values => new Set(values).size === values.length, 'Values must be unique'),
  optimization: z.literal('simplest-validated-start'),
  growth: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/))
    .refine(values => new Set(values).size === values.length, 'Values must be unique'),
});
export type ArchitectureIntent = z.infer<typeof architectureIntentSchema>;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function briefFingerprint(input: ApplicationBrief): string {
  const brief = applicationBriefSchema.parse(input);
  return createHash('sha256').update(canonical(brief)).digest('hex');
}
