import { ApiError, SqlAppsClient } from '../client.js';
import { parseBrowserConfig } from '../browser-config.js';
import { parseCurrentUser } from '../access.js';
import { prepareAuthentication, SessionExpiredError, type BrowserAuthentication } from './session.js';
import { renderAuthentication, authenticationErrorMessage, type AuthState } from './auth-view.js';

const element = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
};
const status = element('status');
const authElements = {
  login: element<HTMLButtonElement>('login'), logout: element<HTMLButtonElement>('logout'),
  retry: element<HTMLButtonElement>('auth-retry'), status: element('auth-status'), workspace: element('workspace'),
};
let authentication: BrowserAuthentication | undefined;
let authMode: 'local' | 'entra' | 'static-web-apps' = 'entra';
let authState: AuthState = { kind: 'signed-out' };
const canUseApp = () => authState.kind === 'authorized';
function showAuth(state: AuthState) {
  authState = state;
  renderAuthentication(authElements, authMode, state);
}
function clearWorkspace() {
  element('data-result').textContent = '';
}
function report(error: unknown): boolean {
  if (error instanceof SessionExpiredError || (error instanceof ApiError && error.status === 401)) {
    authentication?.forgetExpiredSession();
    clearWorkspace();
    showAuth({ kind: 'expired' });
  } else if (authState.kind === 'expired') {
    return false;
  } else if (!canUseApp()) {
    showAuth({ kind: 'unavailable', ...('name' in authState && authState.name ? { name: authState.name } : {}) });
  }
  status.textContent = authenticationErrorMessage(error, authMode);
  return true;
}
authElements.retry.onclick = () => location.reload();

async function main() {
  const response = await fetch('/auth/config', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new ApiError(response.status);
  const config = parseBrowserConfig(await response.json());
  authMode = config.mode;
  const notice = config.mode === 'entra' && config.localBackend
    ? 'Microsoft sign-in is real. Local DAB claims and backend services remain development simulations.'
    : '';
  element('auth-notice').textContent = notice;
  element('auth-notice').hidden = !notice;
  const auth = await prepareAuthentication(config);
  authentication = auth;
  authElements.login.onclick = () => {
    showAuth({ kind: 'signing-in' });
    void auth.signIn().catch(error => {
      showAuth({ kind: 'signed-out' });
      status.textContent = authenticationErrorMessage(error, authMode);
    });
  };
  authElements.logout.onclick = () => {
    const previous = authState;
    showAuth({ kind: 'signing-out' });
    void auth.signOut().catch(error => {
      if (authState.kind !== 'expired') showAuth(previous);
      report(error);
    });
  };
  const session = auth.session;
  if (!session) { showAuth({ kind: 'signed-out' }); return; }
  showAuth({ kind: 'checking', name: session.name });
  const client = new SqlAppsClient({ baseUrl: location.origin, getAccessToken: session.getAccessToken });
  if (config.mode === 'static-web-apps') {
    if (!session.authorized) { showAuth({ kind: 'forbidden', name: session.name }); return; }
  } else {
    const current = parseCurrentUser(await (await client.request('/auth/me')).json());
    if (!current.access.allowed) { showAuth({ kind: 'forbidden', name: session.name }); return; }
  }
  showAuth({ kind: 'authorized', name: session.name });
  const signedIn = `Signed in as ${session.name}`;
  status.textContent = signedIn;

  let busy = false;
  async function checkData() {
    if (busy || !canUseApp()) return;
    busy = true;
    element<HTMLButtonElement>('check-data').disabled = true;
    status.textContent = 'Checking data...';
    try {
      const rows = await client.readiness(config.readinessPath);
      if (!canUseApp()) return;
      element('data-result').textContent = JSON.stringify(rows, null, 2);
      status.textContent = signedIn;
    } catch (error) { report(error); }
    finally {
      busy = false;
      element<HTMLButtonElement>('check-data').disabled = false;
    }
  }
  element('check-data').onclick = () => { void checkData(); };
  await checkData();
}
void main().catch(report);
