import type { CreationCapability, CreationProgress, CapabilityState } from './creation-progress.mjs';
export function readCreationJson(path: string): Promise<unknown>;
export function writeCreationJson(path: string, value: unknown): Promise<void>;
export function creationSession(home: string): Promise<{ directory: string; snapshot: CreationProgress } | null>;
export function updateCreation(home: string, update: (value: CreationProgress) => CreationProgress | Promise<CreationProgress>): Promise<CreationProgress | null>;
export function creationBuild(home: string): Promise<string>;
export function recordCreationCapability(home: string, id: CreationCapability['id'], state: CapabilityState, proof?: string | null, diagnostic?: string | null): Promise<void>;
