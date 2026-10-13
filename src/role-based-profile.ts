import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readSqlSources, roleBasedDabProblem, roleBasedProcedureProblem, roleBasedProfileProblem } from './role-based-rules.mjs';
import { projectPath, projectRoot } from './runtime-roots.js';

const reservedRoles = ['anonymous', 'authenticated', 'Function.Invoke', 'processor'];

export const requiredRoleSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/)
  .refine(value => !reservedRoles.some(role => role.toLowerCase() === value.toLowerCase()),
    'Choose a dedicated human application role');
export const readinessPathSchema = z.string().regex(/^\/api\/[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const roleBasedProfileSchema = z.strictObject({
  profile: z.literal('role-based-data'),
  requiredRole: requiredRoleSchema,
  readinessPath: readinessPathSchema,
});
export type RoleBasedProfile = z.infer<typeof roleBasedProfileSchema>;

export async function readRoleBasedProfile(path = projectPath('role-based-data.json')): Promise<RoleBasedProfile> {
  return parseRoleBasedProfile(JSON.parse(await readFile(path, 'utf8')));
}

export function parseRoleBasedProfile(input: unknown): RoleBasedProfile {
  const problem = roleBasedProfileProblem(input);
  if (problem) throw new Error(problem);
  return roleBasedProfileSchema.parse(input);
}

export function validateRoleBasedDab(input: unknown, profile: RoleBasedProfile): void {
  const problem = roleBasedDabProblem(input, profile);
  if (problem) throw new Error(problem);
  const config = z.object({
    autoentities: z.never().optional(),
    entities: z.record(z.string(), z.object({
      source: z.object({ type: z.literal('stored-procedure'), object: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/) }),
      rest: z.union([z.boolean(), z.object({ enabled: z.boolean(), path: z.string().optional(),
        methods: z.array(z.enum(['get', 'post'])).optional() })]),
      permissions: z.array(z.object({ role: z.string(), actions: z.array(z.literal('execute')).min(1) })).min(1),
    })).refine(entities => Object.keys(entities).length > 0, 'Define authorized procedures'),
  }).parse(input);
  for (const [name, entity] of Object.entries(config.entities)) {
    if (name === 'FileJob' || entity.permissions.some(permission => permission.role !== profile.requiredRole)) {
      throw new Error('Role-based-data DAB entities must expose only approved authorized procedures, not foundation or anonymous roles');
    }
  }
  const ready = Object.entries(config.entities).find(([name, entity]) =>
    `/api/${typeof entity.rest === 'object' && entity.rest.path ? entity.rest.path : name}` === profile.readinessPath &&
    typeof entity.rest === 'object' && entity.rest.enabled && entity.rest.methods?.includes('get'));
  if (!ready) throw new Error('Role-based-data readinessPath must identify an enabled read-only REST readiness procedure');
}

export function roleBasedProcedureGrants(input: unknown, profile: RoleBasedProfile, user: string): string {
  validateRoleBasedDab(input, profile);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(user)) throw new Error('Invalid authorized SQL principal');
  const entities = z.object({ entities: z.record(z.string(), z.object({
    source: z.object({ object: z.string() }),
  })) }).parse(input).entities;
  return [...new Set(Object.values(entities).map(entity => entity.source.object))].map(object => {
    const [schema, name] = object.split('.');
    return `GRANT EXECUTE ON OBJECT::[${schema}].[${name}] TO [${user}];\nGRANT VIEW DEFINITION ON OBJECT::[${schema}].[${name}] TO [${user}];`;
  }).join('\n');
}

export function validateRoleBasedCloudDab(input: unknown, profile: RoleBasedProfile): void {
  validateRoleBasedDab(input, profile);
  z.object({ runtime: z.object({
    rest: z.object({ enabled: z.literal(true), path: z.literal('/api') }),
    host: z.object({ mode: z.literal('production'), authentication: z.object({
      provider: z.literal('AzureAD'),
      jwt: z.object({ audience: z.literal("@env('API_CLIENT_ID')"), issuer: z.literal("@env('ENTRA_ISSUER')") }),
    }) }),
  }) }).parse(input);
}

export async function validateRoleBasedCloudSource(profile: RoleBasedProfile, root = '.'): Promise<void> {
  const localPath = join(root, 'role-based-data.json');
  const local = await readFile(localPath, 'utf8').then(text => parseRoleBasedProfile(JSON.parse(text)),
    (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (local) {
    for (const key of ['requiredRole', 'readinessPath'] as const) {
      if (local[key] !== profile[key]) {
        throw new Error(`Azure configuration ${key} '${profile[key]}' does not match '${local[key]}' in role-based-data.json; ` +
          'copy requiredRole and readinessPath from role-based-data.json into the Azure configuration.');
      }
    }
  }
  const dab: unknown = JSON.parse(await readFile(join(root, 'dab', 'dab-config.json'), 'utf8'));
  validateRoleBasedCloudDab(dab, profile);
  const procedureProblem = roleBasedProcedureProblem(dab, await readSqlSources(root));
  if (procedureProblem) throw new Error(`${procedureProblem} Add each procedure to the SQL project under sql/ before building artifacts.`);
}

export async function roleBasedSchemaFingerprint(root = projectRoot): Promise<string> {
  const hash = createHash('sha256').update(await readFile(join(root, 'dab', 'dab-config.json')));
  async function add(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('Role-based schema inputs must not be symlinks');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['obj', 'bin'].includes(entry.name)) await add(path);
      } else if (/\.(sql|sqlproj)$/.test(entry.name)) {
        hash.update(relative(root, path)).update('\0').update(await readFile(path)).update('\0');
      }
    }
  }
  await add(join(root, 'sql'));
  return hash.digest('hex');
}
