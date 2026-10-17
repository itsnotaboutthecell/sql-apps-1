export type SqlTarget =
  | { version: 1; provider: 'container'; container: string }
  | { version: 1; provider: 'azure'; server: string; database: string; subscriptionId: string; tenantId: string; resourceGroup: string }
  | { version: 1; provider: 'express'; instance: string; server: '127.0.0.1'; port: number; database: string };
export type SqlProvider = SqlTarget['provider'];
export interface SqlRoute {
  provider: SqlProvider;
  availability: 'ready' | 'action-required' | 'unavailable' | 'unknown';
  code: string;
  nextAction?: string;
}
export const sqlProviders: readonly SqlProvider[];
export function validateSqlTarget(value: unknown): SqlTarget;
export function sqlTargetFingerprint(target: SqlTarget): string;
export function readSqlTargetFile(path: string): Promise<unknown>;
export function readSqlTarget(root: string, fallbackContainer: string): Promise<SqlTarget>;
export function resolveSqlTarget(root: string, fallbackContainer: string, options?: { sqlTarget?: string; sqlProvider?: SqlProvider; container?: string }): Promise<SqlTarget>;
export function recommendSqlRoutes(evidence: SqlRoute[], selected?: SqlProvider): {
  routes: SqlRoute[]; recommended?: SqlProvider; selectionRequired: boolean; scope: string;
};
