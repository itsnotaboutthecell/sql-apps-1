import { PublicClientApplication, InteractionRequiredAuthError, type AccountInfo, type Configuration } from '@azure/msal-browser';
import { authRedirectPath, type BrowserConfig } from '../browser-config.js';

export interface BrowserSession {
  name: string;
  authorized?: boolean;
  getAccessToken: () => Promise<string>;
}

export interface BrowserAuthentication {
  session: BrowserSession | undefined;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  forgetExpiredSession(): void;
}

export interface SessionHost {
  origin: string;
  fetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  reload: () => void;
  navigate?: (path: string) => void;
}

export interface MsalClient {
  initialize(): Promise<void>;
  handleRedirectPromise(): Promise<{ account: AccountInfo | null } | null>;
  getAllAccounts(): AccountInfo[];
  getActiveAccount(): AccountInfo | null;
  setActiveAccount(account: AccountInfo | null): void;
  loginRedirect(options: { scopes: string[]; prompt: 'select_account' }): Promise<void>;
  logoutRedirect(options: { postLogoutRedirectUri: string; account?: AccountInfo }): Promise<void>;
  acquireTokenSilent(options: { account: AccountInfo; scopes: string[] }): Promise<{ accessToken: string }>;
  acquireTokenRedirect(options: { account: AccountInfo; scopes: string[] }): Promise<void>;
}

export class SessionExpiredError extends Error {
  override name = 'SessionExpiredError';
}

export const localSessionKey = 'sql-apps.local-session';

function browserHost(): SessionHost {
  return {
    origin: location.origin, fetch: (url, options) => fetch(url, options),
    storage: sessionStorage, reload: () => location.reload(),
  };
}

export async function createPreviewSession(userId?: string, host: SessionHost = browserHost()): Promise<void> {
  const previous = host.storage.getItem(localSessionKey);
  const response = await host.fetch('/local/session', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(previous ? { authorization: `Bearer ${previous}` } : {}) },
    body: JSON.stringify(userId === undefined ? { preview: true } : { user: userId }),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Test account sign-in failed (${response.status})`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
    throw new Error('Test account session response is invalid');
  }
  host.storage.setItem(localSessionKey, body.token);
}

export async function prepareAuthentication(
  config: BrowserConfig,
  host: SessionHost = browserHost(),
  createMsal: (configuration: Configuration) => MsalClient = options => new PublicClientApplication(options),
): Promise<BrowserAuthentication> {
  if (config.mode === 'local') {
    const token = host.storage.getItem(localSessionKey);
    return {
      session: token ? {
        name: 'Test user',
        getAccessToken: async () => {
          if (host.storage.getItem(localSessionKey) !== token) throw new SessionExpiredError('Test account session has ended');
          return token;
        },
      } : undefined,
      signIn: async () => { await createPreviewSession(undefined, host); host.reload(); },
      signOut: async () => {
        const current = host.storage.getItem(localSessionKey);
        const response = await host.fetch('/local/session', {
          method: 'DELETE', headers: current ? { authorization: `Bearer ${current}` } : {},
          redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Test account sign-out failed (${response.status})`);
        host.storage.removeItem(localSessionKey);
        host.reload();
      },
      forgetExpiredSession: () => host.storage.removeItem(localSessionKey),
    };
  }

  host.storage.removeItem(localSessionKey);
  if (config.mode === 'static-web-apps') {
    const response = await host.fetch('/.auth/me', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Static Web Apps session check failed (${response.status})`);
    const body: unknown = await response.json();
    const principal = body && typeof body === 'object' && 'clientPrincipal' in body ? body.clientPrincipal : undefined;
    const parsed = principal && typeof principal === 'object' &&
      'userDetails' in principal && typeof principal.userDetails === 'string' &&
      'userRoles' in principal && Array.isArray(principal.userRoles) &&
      principal.userRoles.every(role => typeof role === 'string')
      ? { name: principal.userDetails, roles: principal.userRoles as string[] }
      : undefined;
    const navigate = host.navigate ?? (path => { globalThis.location.href = path; });
    return {
      session: parsed ? {
        name: parsed.name,
        authorized: parsed.roles.includes('owner'),
        getAccessToken: async () => 'static-web-apps-platform-session',
      } : undefined,
      signIn: async () => navigate(`/.auth/login/${config.provider}?post_login_redirect_uri=/`),
      signOut: async () => navigate('/.auth/logout?post_logout_redirect_uri=/'),
      forgetExpiredSession: () => {},
    };
  }

  const msal = createMsal({
    auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: new URL(authRedirectPath, host.origin).href },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await msal.initialize();
  const redirect = await msal.handleRedirectPromise();
  const accounts = msal.getAllAccounts();
  const account = redirect?.account ?? msal.getActiveAccount() ?? (accounts.length === 1 ? accounts[0] : undefined);
  if (account) msal.setActiveAccount(account);
  return {
    session: account ? {
      name: account.username,
      getAccessToken: async () => {
        try {
          return (await msal.acquireTokenSilent({ account, scopes: [config.scope] })).accessToken;
        } catch (error) {
          if (error instanceof InteractionRequiredAuthError) {
            await msal.acquireTokenRedirect({ account, scopes: [config.scope] });
            throw new SessionExpiredError('Continue Microsoft sign-in to renew your session');
          }
          throw error;
        }
      },
    } : undefined,
    signIn: () => msal.loginRedirect({ scopes: [config.scope], prompt: 'select_account' }),
    signOut: () => msal.logoutRedirect({ postLogoutRedirectUri: host.origin, ...(account ? { account } : {}) }),
    forgetExpiredSession: () => msal.setActiveAccount(null),
  };
}
