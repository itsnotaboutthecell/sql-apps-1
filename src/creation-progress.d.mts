export type CapabilityState = 'pending' | 'running' | 'verified' | 'blocked' | 'failed' | 'stale';
export interface CreationCapability {
  id: 'data' | 'data-access' | 'services' | 'application';
  state: CapabilityState; checkedAt: string | null; build: string | null;
  proof: string | null; diagnostic: string | null;
}
export interface CreationAcceptance {
  kind: 'browser-workflow' | 'design-review'; build: string;
  observedAt: string; artifacts: string[]; digest: string;
}
export interface CreationProgress {
  version: 1; sessionId: string; home: string; name: string; publicOrigin: string;
  gatewayOrigin: string; workspaceId: string; build: string | null; sequence: number;
  capabilities: CreationCapability[]; workflow: CreationAcceptance | null; design: CreationAcceptance | null;
}
export const capabilityIds: CreationCapability['id'][];
export function fingerprint(value: unknown): string;
export function initialProgress(value: Pick<CreationProgress, 'home' | 'name' | 'publicOrigin' | 'gatewayOrigin' | 'workspaceId'>): CreationProgress;
export function validateProgress(value: unknown): CreationProgress;
export function completion(value: CreationProgress): { usable: boolean; ready: boolean; blockers: string[] };
export function changeBuild(value: CreationProgress, build: string | null): CreationProgress;
export function capabilityResult(value: CreationProgress, id: CreationCapability['id'], state: CapabilityState, proof?: string | null, diagnostic?: string | null): CreationProgress;
