import type { CreationProgress } from './creation-progress.mjs';
export function loopbackFetch(input: string | URL, options?: RequestInit): Promise<Response>;
export interface CreationProbeSurface {
  id: string; kind: 'rest' | 'graphql' | 'mcp' | 'openapi'; path: string;
  state: 'verified' | 'failed'; query?: string | null; preview: boolean;
}
export interface CreationProbeProgress {
  identity: unknown; access: boolean; services: boolean; application?: boolean;
  surfaces: CreationProbeSurface[]; diagnostic?: string | null;
}
export function probeCreationGateway(snapshot: CreationProgress, fetcher?: typeof loopbackFetch,
  onProgress?: (progress: CreationProbeProgress) => void | Promise<void>): Promise<{
  identity: unknown; access: boolean; services: boolean; application?: boolean; diagnostic?: string | null;
  surfaces: CreationProbeSurface[];
}>;
