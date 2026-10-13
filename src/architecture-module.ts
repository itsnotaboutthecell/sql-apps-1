import { z } from 'zod';

const nameSchema = z.string()
  .regex(/^[a-z][a-z0-9-]{1,63}$/);
const uniqueNames = (minimum = 0) => z.array(nameSchema)
  .min(minimum)
  .refine(values => new Set(values).size === values.length, 'Names must be unique');

export const architectureModuleSchema = z.strictObject({
  id: nameSchema,
  version: z.number().int().positive(),
  surface: z.number().int().nonnegative(),
  provides: uniqueNames(1),
  requiresCapabilities: uniqueNames(),
  requiresModules: uniqueNames(),
  incompatibleModules: uniqueNames(),
  guarantees: uniqueNames(),
  resources: z.array(z.strictObject({
    type: z.string().trim().min(1),
    sku: z.string().trim().min(1).optional(),
    purpose: z.string().trim().min(1),
  })),
  acceptanceChecks: uniqueNames(1),
  growthTransitions: uniqueNames(),
});

export type ArchitectureModule = z.infer<typeof architectureModuleSchema>;
export type ArchitectureModuleCatalog = Map<string, ArchitectureModule>;

export function validateModuleCatalog(input: readonly unknown[]): ArchitectureModuleCatalog {
  const modules = z.array(architectureModuleSchema).parse(input);
  const byId = new Map<string, ArchitectureModule>();

  for (const module of modules) {
    if (byId.has(module.id)) throw new Error(`Duplicate module ID: ${module.id}`);
    byId.set(module.id, module);
  }

  const catalog = new Map([...byId.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0));

  for (const module of catalog.values()) {
    validateReferences(catalog, module, module.requiresModules, 'required module');
    validateReferences(catalog, module, module.incompatibleModules, 'incompatible module');
    validateReferences(catalog, module, module.growthTransitions, 'growth transition');

    const incompatible = new Set(module.incompatibleModules);
    const conflict = module.requiresModules.find(id => incompatible.has(id));
    if (conflict) {
      throw new Error(`Module ${module.id} both requires and rejects module ${conflict}`);
    }
  }

  detectRequiredModuleCycles(catalog);
  return catalog;
}

function validateReferences(
  catalog: ArchitectureModuleCatalog,
  module: ArchitectureModule,
  references: string[],
  kind: string,
): void {
  const unknown = references.find(id => !catalog.has(id));
  if (unknown) throw new Error(`Module ${module.id} references unknown ${kind}: ${unknown}`);
}

function detectRequiredModuleCycles(catalog: ArchitectureModuleCatalog): void {
  const visited = new Set<string>();
  const path: string[] = [];
  const active = new Map<string, number>();

  const visit = (id: string): void => {
    const cycleStart = active.get(id);
    if (cycleStart !== undefined) {
      throw new Error(`Required-module dependency cycle: ${[...path.slice(cycleStart), id].join(' -> ')}`);
    }
    if (visited.has(id)) return;

    active.set(id, path.length);
    path.push(id);
    const module = catalog.get(id);
    if (!module) throw new Error(`Unknown module during dependency traversal: ${id}`);
    for (const requiredId of module.requiresModules) visit(requiredId);
    path.pop();
    active.delete(id);
    visited.add(id);
  };

  for (const id of catalog.keys()) visit(id);
}
