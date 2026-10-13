export const authRedirectPath = '/auth/redirect.html';

/** The signed-in status page calls readinessPath, the application's read-only DAB procedure. */
export type BrowserConfig =
  | { mode: 'entra'; tenantId: string; clientId: string; scope: string; localBackend?: boolean; readinessPath: string }
  | { mode: 'local'; readinessPath: string };

export function parseBrowserConfig(value: unknown): BrowserConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid browser configuration');
  const readinessPath = 'readinessPath' in value ? value.readinessPath : undefined;
  if (typeof readinessPath !== 'string' || !/^\/api\/[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(readinessPath)) {
    throw new Error('Invalid browser readiness path');
  }
  if ('mode' in value && value.mode === 'local') return { mode: 'local', readinessPath };
  if ('mode' in value && value.mode === 'entra' && 'tenantId' in value && typeof value.tenantId === 'string' && value.tenantId &&
      'clientId' in value && typeof value.clientId === 'string' && value.clientId &&
      'scope' in value && typeof value.scope === 'string' && value.scope) {
    const localBackend = 'localBackend' in value ? value.localBackend : undefined;
    if ('localBackend' in value && typeof localBackend !== 'boolean') throw new Error('Invalid local backend configuration');
    return { mode: 'entra', tenantId: value.tenantId, clientId: value.clientId, scope: value.scope,
      ...(typeof localBackend === 'boolean' ? { localBackend } : {}), readinessPath };
  }
  throw new Error('Invalid browser authentication configuration');
}