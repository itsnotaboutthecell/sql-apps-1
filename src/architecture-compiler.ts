import { createHash } from 'node:crypto';
import {
  architectureCatalog,
  mandatoryArchitectureModules,
} from './architecture-catalog.js';
import {
  architectureIntentSchema,
  canonical,
} from './architecture-contract.js';
import type {
  ReadonlyArchitectureModule,
  ReadonlyArchitectureModuleCatalog,
} from './architecture-module.js';

export interface CompiledArchitectureResource {
  type: string;
  sku?: string;
  purpose: string;
  module: string;
}

export interface CompiledArchitecturePlan {
  version: 1;
  briefFingerprint: string;
  optimization: 'simplest-validated-start';
  mandatoryCore: string[];
  modules: string[];
  resources: CompiledArchitectureResource[];
  guarantees: string[];
  acceptanceChecks: string[];
  growth: string[];
  limitations: string[];
  authorized: false;
  deployable: false;
  approval: string;
}

type PlanWithoutApproval = Omit<CompiledArchitecturePlan, 'approval'>;

interface SearchFailure {
  unsupported?: string;
  incompatibility?: string;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function compileArchitecture(
  input: unknown,
  catalog: ReadonlyArchitectureModuleCatalog = architectureCatalog,
): CompiledArchitecturePlan {
  const parsed = architectureIntentSchema.parse(input);
  const requestedCapabilities = [...parsed.capabilities].sort(compareText);
  const requestedGuarantees = [...parsed.guarantees].sort(compareText);
  const requestedGrowth = [...parsed.growth].sort(compareText);
  const providers = indexProviders(catalog);
  const failures: SearchFailure = {};
  const complete: Set<string>[] = [];
  const visited = new Set<string>();

  const initial = closeRequiredModules(
    new Set<string>(),
    mandatoryArchitectureModules,
    catalog,
  );

  const search = (selected: Set<string>): void => {
    const stateKey = [...selected].sort(compareText).join('\0');
    if (visited.has(stateKey)) return;
    visited.add(stateKey);

    const requiredCapabilities = new Set<string>(requestedCapabilities);
    for (const id of selected) {
      const module = requireModule(catalog, id);
      for (const capability of module.requiresCapabilities) {
        requiredCapabilities.add(capability);
      }
    }

    const missing = [...requiredCapabilities]
      .filter(capability => !providesCapability(selected, capability, catalog))
      .sort(compareText)[0];
    if (missing === undefined) {
      complete.push(selected);
      return;
    }

    const candidates = providers.get(missing) ?? [];
    if (candidates.length === 0) {
      failures.unsupported ??= missing;
      return;
    }

    for (const candidate of candidates) {
      try {
        search(closeRequiredModules(new Set(selected), [candidate.id], catalog));
      } catch (error) {
        if (error instanceof Error) failures.incompatibility ??= error.message;
        else throw error;
      }
    }
  };

  search(initial);

  if (complete.length === 0) {
    if (failures.unsupported !== undefined) {
      throw new Error(`No supported module provides ${failures.unsupported}`);
    }
    throw new Error(failures.incompatibility ?? 'No complete compatible architecture composition exists');
  }

  complete.sort((left, right) => compareCompositions(left, right, catalog));
  const selectedIds = [...requireSelection(complete[0])].sort(compareText);
  const selectedModules = selectedIds.map(id => requireModule(catalog, id));
  const withoutApproval: PlanWithoutApproval = {
    version: 1,
    briefFingerprint: parsed.briefFingerprint,
    optimization: 'simplest-validated-start',
    mandatoryCore: [...mandatoryArchitectureModules],
    modules: selectedIds,
    resources: compileResources(selectedModules),
    guarantees: sortedUnique([
      ...requestedGuarantees,
      ...selectedModules.flatMap(module => module.guarantees),
    ]),
    acceptanceChecks: sortedUnique(
      selectedModules.flatMap(module => module.acceptanceChecks),
    ),
    growth: sortedUnique([
      ...requestedGrowth,
      ...selectedModules.flatMap(module => module.growthTransitions),
    ]),
    limitations: [
      'Azure eligibility unverified',
      'Costs not quoted',
      'Modules metadata-only and review-only',
      'No Azure writes authorized',
    ],
    authorized: false,
    deployable: false,
  };

  return {
    ...withoutApproval,
    approval: createHash('sha256')
      .update(canonical(withoutApproval))
      .digest('hex')
      .slice(0, 12),
  };
}

function indexProviders(
  catalog: ReadonlyArchitectureModuleCatalog,
): Map<string, ReadonlyArchitectureModule[]> {
  const providers = new Map<string, ReadonlyArchitectureModule[]>();
  for (const module of catalog.values()) {
    for (const capability of module.provides) {
      const entries = providers.get(capability) ?? [];
      entries.push(module);
      providers.set(capability, entries);
    }
  }
  for (const entries of providers.values()) {
    entries.sort((left, right) => compareText(left.id, right.id));
  }
  return providers;
}

function closeRequiredModules(
  selected: Set<string>,
  roots: readonly string[],
  catalog: ReadonlyArchitectureModuleCatalog,
): Set<string> {
  const add = (id: string): void => {
    if (selected.has(id)) return;
    const module = requireModule(catalog, id);
    for (const selectedId of selected) {
      const existing = requireModule(catalog, selectedId);
      if (
        module.incompatibleModules.includes(selectedId)
        || existing.incompatibleModules.includes(id)
      ) {
        const pair = [id, selectedId].sort(compareText);
        throw new Error(`Incompatible modules: ${pair[0]} and ${pair[1]}`);
      }
    }
    selected.add(id);
    for (const requiredId of [...module.requiresModules].sort(compareText)) add(requiredId);
  };

  for (const id of [...roots].sort(compareText)) add(id);
  return selected;
}

function providesCapability(
  selected: ReadonlySet<string>,
  capability: string,
  catalog: ReadonlyArchitectureModuleCatalog,
): boolean {
  for (const id of selected) {
    if (requireModule(catalog, id).provides.includes(capability)) return true;
  }
  return false;
}

function compareCompositions(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  catalog: ReadonlyArchitectureModuleCatalog,
): number {
  if (left.size !== right.size) return left.size - right.size;
  const leftSurface = compositionSurface(left, catalog);
  const rightSurface = compositionSurface(right, catalog);
  if (leftSurface !== rightSurface) return leftSurface - rightSurface;
  return compareText(
    [...left].sort(compareText).join(','),
    [...right].sort(compareText).join(','),
  );
}

function compositionSurface(
  selected: ReadonlySet<string>,
  catalog: ReadonlyArchitectureModuleCatalog,
): number {
  let surface = 0;
  for (const id of selected) surface += requireModule(catalog, id).surface;
  return surface;
}

function compileResources(
  modules: readonly ReadonlyArchitectureModule[],
): CompiledArchitectureResource[] {
  const resources = new Map<string, CompiledArchitectureResource>();
  for (const module of modules) {
    for (const resource of module.resources) {
      const key = canonical({
        type: resource.type,
        sku: resource.sku,
        purpose: resource.purpose,
      });
      if (!resources.has(key)) {
        resources.set(key, {
          type: resource.type,
          ...(resource.sku === undefined ? {} : { sku: resource.sku }),
          purpose: resource.purpose,
          module: module.id,
        });
      }
    }
  }
  return [...resources.values()].sort((left, right) => compareText(
    [left.type, left.sku ?? '', left.purpose, left.module].join('\0'),
    [right.type, right.sku ?? '', right.purpose, right.module].join('\0'),
  ));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function requireModule(
  catalog: ReadonlyArchitectureModuleCatalog,
  id: string,
): ReadonlyArchitectureModule {
  const module = catalog.get(id);
  if (!module) throw new Error(`Architecture catalog is missing required module ${id}`);
  return module;
}

function requireSelection(
  selection: Set<string> | undefined,
): Set<string> {
  if (!selection) throw new Error('No complete architecture composition exists');
  return selection;
}
