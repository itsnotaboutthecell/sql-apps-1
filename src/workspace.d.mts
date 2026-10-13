export type PortState = 'free' | 'occupied' | 'unknown';
export interface WorkspaceDescriptor {
  version: 1;
  home: string;
  id: string;
  mode: 'isolated' | 'legacy';
  basePort: number | null;
}
export interface WorkspaceRuntime {
  home: string;
  id: string;
  mode: 'isolated' | 'legacy' | 'legacy-unselected';
  defaultSql: string;
  sqlContainer: string;
  database: string;
  login: string;
  ownsSqlName: boolean;
  stateDirectory: string;
  ports: { gateway: number; data: number; sql: number | null };
  origins: { app: string; data: string };
  names: { data: string; sqlNetwork: string; sqlState: string; dataConfig: string };
  labels: string[];
}
export function workspaceFile(root?: string): string;
export function readWorkspace(root?: string): WorkspaceDescriptor | null;
export function describeWorkspace(root: string, selection: number | 'legacy'): WorkspaceDescriptor;
export function runtimeFor(container?: string, root?: string, proposed?: WorkspaceDescriptor): WorkspaceRuntime;
export function portState(port: number): Promise<PortState>;
export function proposeWorkspace(root?: string, probe?: (port: number) => Promise<PortState>): Promise<{
  selected?: WorkspaceDescriptor;
  descriptor?: WorkspaceDescriptor;
  conflicts?: { name: string; port: number; state: PortState }[];
  alternative?: WorkspaceDescriptor | null;
  nextAction?: string;
  scope: string;
}>;
export function initializeWorkspace(root: string | undefined, selection: number | 'legacy',
  probe?: (port: number) => Promise<PortState>): Promise<WorkspaceRuntime>;
