import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo, type Configuration } from '@azure/msal-browser';
import { authRedirectPath, type BrowserConfig } from '../src/browser-config.js';
import { ApiError } from '../src/client.js';
import { createPreviewSession, localSessionKey, prepareAuthentication, SessionExpiredError,
  type MsalClient, type SessionHost } from '../src/web/session.js';
import { authenticationErrorMessage, renderAuthentication, type AuthElements, type AuthState } from '../src/web/auth-view.js';

const previewConfig = { mode: 'local', readinessPath: '/api/AppReady' } satisfies BrowserConfig;
const staticWebAppsConfig = {
  mode: 'static-web-apps', provider: 'aad', readinessPath: '/api/AppReady',
} satisfies BrowserConfig;
const entraConfig = {
  mode: 'entra', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  scope: 'api://bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/access_as_user',
  readinessPath: '/api/AppReady',
} satisfies BrowserConfig;
const previewToken = 'A'.repeat(43);
const account: AccountInfo = {
  homeAccountId: 'home', environment: 'login.microsoftonline.com', tenantId: entraConfig.tenantId,
  username: 'person@example.invalid', localAccountId: 'local',
};

function sessionHost(fetcher: typeof fetch = async () => { throw new Error('Unexpected local endpoint request'); }) {
  const values = new Map<string, string>();
  let reloads = 0;
  const host: SessionHost = {
    origin: 'http://127.0.0.1:30000', fetch: fetcher,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
    reload: () => { reloads++; },
  };
  return { host, values, reloads: () => reloads };
}

class TestMsalClient implements MsalClient {
  accounts: AccountInfo[] = [account];
  activeAccount: AccountInfo | null = null;
  redirect: { account: AccountInfo | null } | null = null;
  initializeError: Error | undefined;
  loginError: Error | undefined;
  silentError: Error | undefined;
  tokenRedirectError: Error | undefined;
  calls: string[] = [];
  loginRequests: { scopes: string[]; prompt: 'select_account' }[] = [];
  logoutRequests: { postLogoutRedirectUri: string; account?: AccountInfo }[] = [];
  silentRequests: { account: AccountInfo; scopes: string[] }[] = [];
  tokenRedirectRequests: { account: AccountInfo; scopes: string[] }[] = [];
  async initialize() {
    this.calls.push('initialize');
    if (this.initializeError) throw this.initializeError;
  }

  async handleRedirectPromise() { this.calls.push('redirect'); return this.redirect; }
  getAllAccounts() { return this.accounts; }
  getActiveAccount() { return this.activeAccount; }
  setActiveAccount(value: AccountInfo | null) { this.activeAccount = value; }
  async loginRedirect(options: { scopes: string[]; prompt: 'select_account' }) {
    this.loginRequests.push(options);
    if (this.loginError) throw this.loginError;
  }

  async logoutRedirect(options: { postLogoutRedirectUri: string; account?: AccountInfo }) {
    this.logoutRequests.push(options);
  }
  async acquireTokenSilent(options: { account: AccountInfo; scopes: string[] }) {
    this.silentRequests.push(options);
    if (this.silentError) throw this.silentError;
    return { accessToken: 'signed-test-access-token' };
  }
  async acquireTokenRedirect(options: { account: AccountInfo; scopes: string[] }) {
    this.tokenRedirectRequests.push(options);
    if (this.tokenRedirectError) throw this.tokenRedirectError;
  }
}

test('Static Web Apps authentication uses the platform session and requires the invited owner role', async () => {
  const navigations: string[] = [];
  const fixture = sessionHost(async url => {
    assert.equal(String(url), '/.auth/me');
    return Response.json({
      clientPrincipal: {
        identityProvider: 'aad',
        userId: 'provider-id',
        userDetails: 'owner@example.invalid',
        userRoles: ['anonymous', 'authenticated', 'owner'],
      },
    });
  });
  fixture.host.navigate = path => { navigations.push(path); };
  const authentication = await prepareAuthentication(staticWebAppsConfig, fixture.host);
  assert.equal(authentication.session?.name, 'owner@example.invalid');
  assert.equal(authentication.session?.authorized, true);
  assert.equal(await authentication.session?.getAccessToken(), 'static-web-apps-platform-session');
  await authentication.signIn();
  await authentication.signOut();
  assert.deepEqual(navigations, [
    '/.auth/login/aad?post_login_redirect_uri=/',
    '/.auth/logout?post_logout_redirect_uri=/',
  ]);
});

test('Static Web Apps keeps a signed-in nonowner visible but unauthorized', async () => {
  const fixture = sessionHost(async () => Response.json({
    clientPrincipal: {
      userDetails: 'reader@example.invalid',
      userRoles: ['anonymous', 'authenticated'],
    },
  }));
  const authentication = await prepareAuthentication(staticWebAppsConfig, fixture.host);
  assert.equal(authentication.session?.authorized, false);
});

test('local test account has an explicit sign-in and sign-out lifecycle without product personas', async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const fixture = sessionHost(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return options.method === 'POST' ? Response.json({ token: previewToken }) : new Response(null, { status: 204 });
  });
  const authentication = await prepareAuthentication(previewConfig, fixture.host);
  assert.equal(authentication.session, undefined);
  assert.equal(requests.length, 0);
  await authentication.signIn();
  assert.equal(fixture.values.get(localSessionKey), previewToken);
  assert.equal(fixture.reloads(), 1);
  assert.equal(requests[0]!.url, '/local/session');
  assert.equal(requests[0]!.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0]!.options.body)), { preview: true });
  assert.equal(new Headers(requests[0]!.options.headers).get('content-type'), 'application/json');
  assert.equal(new Headers(requests[0]!.options.headers).get('authorization'), null);
  assert.equal(requests[0]!.options.redirect, 'error');
  assert.ok(requests[0]!.options.signal);
  const active = await prepareAuthentication(previewConfig, fixture.host);
  assert.ok(active.session);
  assert.equal(active.session.name, 'Test user');
  assert.equal(await active.session.getAccessToken(), previewToken);
  assert.equal(requests.length, 1);
  await active.signOut();
  assert.equal(requests[1]!.url, '/local/session');
  assert.equal(requests[1]!.options.method, 'DELETE');
  assert.equal(new Headers(requests[1]!.options.headers).get('authorization'), `Bearer ${previewToken}`);
  assert.equal(requests[1]!.options.redirect, 'error');
  assert.ok(requests[1]!.options.signal);
  assert.equal(fixture.values.has(localSessionKey), false);
  assert.equal(fixture.reloads(), 2);
  await assert.rejects(active.session.getAccessToken(), SessionExpiredError);
});

test('developer preview session selection rotates the existing bearer only after a valid response', async () => {
  const fixture = sessionHost(async (url, options) => {
    assert.equal(String(url), '/local/session');
    assert.equal(options?.method, 'POST');
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${previewToken}`);
    assert.deepEqual(JSON.parse(String(options?.body)), { user: 'development-user-id' });
    return Response.json({ token: 'B'.repeat(43) });
  });
  fixture.values.set(localSessionKey, previewToken);
  await createPreviewSession('development-user-id', fixture.host);
  assert.equal(fixture.values.get(localSessionKey), 'B'.repeat(43));
  assert.equal(fixture.reloads(), 0);
});

for (const scenario of [
  { name: 'backend failure', response: () => new Response(null, { status: 503 }),
    message: /Test account sign-in failed \(503\)/ },
  { name: 'short token', response: () => Response.json({ token: 'short' }), message: /response is invalid/ },
  { name: 'invalid token alphabet', response: () => Response.json({ token: '!'.repeat(43) }), message: /response is invalid/ },
  { name: 'missing token', response: () => Response.json({}), message: /response is invalid/ },
  { name: 'nonstring token', response: () => Response.json({ token: 43 }), message: /response is invalid/ },
  { name: 'null response', response: () => Response.json(null), message: /response is invalid/ },
]) {
  test(`opening local preview rejects ${scenario.name} without persisting a session`, async () => {
    const fixture = sessionHost(async () => scenario.response());
    await assert.rejects(createPreviewSession(undefined, fixture.host), scenario.message);
    assert.equal(fixture.values.has(localSessionKey), false);
    assert.equal(fixture.reloads(), 0);
  });
}

test('failed preview replacement preserves the previous stored session', async () => {
  const fixture = sessionHost(async () => new Response(null, { status: 503 }));
  fixture.values.set(localSessionKey, previewToken);
  await assert.rejects(createPreviewSession(undefined, fixture.host), /Test account sign-in failed \(503\)/);
  assert.equal(fixture.values.get(localSessionKey), previewToken);
  assert.equal(fixture.reloads(), 0);
});

test('failed preview DELETE reports failure without pretending to sign out', async () => {
  const fixture = sessionHost(async (_url, options) => {
    assert.equal(options?.method, 'DELETE');
    return new Response(null, { status: 503 });
  });
  fixture.values.set(localSessionKey, previewToken);
  const authentication = await prepareAuthentication(previewConfig, fixture.host);
  assert.ok(authentication.session);
  await assert.rejects(authentication.signOut(), /503/);
  assert.equal(fixture.values.get(localSessionKey), previewToken);
  assert.equal(await authentication.session.getAccessToken(), previewToken);
  assert.equal(fixture.reloads(), 0);
});

test('expired or replaced local sessions cannot reuse the captured preview token', async () => {
  const fixture = sessionHost();
  fixture.values.set(localSessionKey, previewToken);
  const authentication = await prepareAuthentication(previewConfig, fixture.host);
  assert.ok(authentication.session);
  fixture.values.set(localSessionKey, 'B'.repeat(43));
  await assert.rejects(authentication.session.getAccessToken(), SessionExpiredError);
  authentication.forgetExpiredSession();
  assert.equal(fixture.values.has(localSessionKey), false);
  await assert.rejects(authentication.session.getAccessToken(), SessionExpiredError);
  assert.equal(fixture.reloads(), 0);
});

test('real sign-in initializes scoped MSAL with the dedicated callback and never uses preview endpoints', async () => {
  const fixture = sessionHost();
  fixture.values.set(localSessionKey, previewToken);
  const msal = new TestMsalClient();
  let configuration: Configuration | undefined;
  const authentication = await prepareAuthentication(entraConfig, fixture.host, (options: Configuration) => {
    configuration = options;
    return msal;
  });
  assert.ok(configuration);
  assert.deepEqual(configuration.auth, {
    clientId: entraConfig.clientId, authority: `https://login.microsoftonline.com/${entraConfig.tenantId}`,
    redirectUri: new URL(authRedirectPath, fixture.host.origin).href,
  });
  assert.deepEqual(configuration.cache, { cacheLocation: 'sessionStorage' });
  assert.deepEqual(msal.calls, ['initialize', 'redirect']);
  assert.equal(fixture.values.has(localSessionKey), false);
  assert.equal(msal.activeAccount, account);
  assert.ok(authentication.session);
  assert.equal(authentication.session.name, account.username);
  assert.equal(await authentication.session.getAccessToken(), 'signed-test-access-token');
  assert.deepEqual(msal.silentRequests, [{ account, scopes: [entraConfig.scope] }]);
  await authentication.signIn();
  assert.deepEqual(msal.loginRequests, [{ scopes: [entraConfig.scope], prompt: 'select_account' }]);
  await authentication.signOut();
  assert.deepEqual(msal.logoutRequests, [{ postLogoutRedirectUri: fixture.host.origin, account }]);
  authentication.forgetExpiredSession();
  assert.equal(msal.activeAccount, null);
  assert.equal(fixture.values.size, 0);
  assert.equal(fixture.reloads(), 0);
});

test('real sign-in without a cached account stays signed out and offers explicit account selection', async () => {
  const fixture = sessionHost();
  fixture.values.set(localSessionKey, previewToken);
  const msal = new TestMsalClient();
  msal.accounts = [];
  const authentication = await prepareAuthentication(entraConfig, fixture.host, () => msal);
  assert.equal(authentication.session, undefined);
  await authentication.signIn();
  assert.deepEqual(msal.loginRequests, [{ scopes: [entraConfig.scope], prompt: 'select_account' }]);
  await authentication.signOut();
  assert.deepEqual(msal.logoutRequests, [{ postLogoutRedirectUri: fixture.host.origin }]);
  assert.equal(fixture.values.size, 0);
});

test('multiple cached Microsoft accounts are not selected arbitrarily', async () => {
  const msal = new TestMsalClient();
  msal.accounts.push({ ...account, homeAccountId: 'other-home', username: 'other@example.invalid' });
  const authentication = await prepareAuthentication(entraConfig, sessionHost().host, () => msal);
  assert.equal(authentication.session, undefined);
  assert.equal(msal.activeAccount, null);
  assert.deepEqual(msal.silentRequests, []);
});

test('the active Microsoft account takes priority over cached account order', async () => {
  const msal = new TestMsalClient();
  const active = { ...account, homeAccountId: 'active-home', username: 'active@example.invalid' };
  msal.accounts.push(active);
  msal.activeAccount = active;
  const authentication = await prepareAuthentication(entraConfig, sessionHost().host, () => msal);
  assert.equal(authentication.session?.name, active.username);
  assert.equal(msal.activeAccount, active);
});

test('the redirect Microsoft account takes priority over an existing active account', async () => {
  const msal = new TestMsalClient();
  const redirected = { ...account, homeAccountId: 'redirect-home', username: 'redirect@example.invalid' };
  msal.activeAccount = account;
  msal.redirect = { account: redirected };
  const authentication = await prepareAuthentication(entraConfig, sessionHost().host, () => msal);
  assert.equal(authentication.session?.name, redirected.username);
  assert.equal(msal.activeAccount, redirected);
});

test('MSAL initialization failures reject without creating a preview fallback', async () => {
  const fixture = sessionHost();
  fixture.values.set(localSessionKey, previewToken);
  const msal = new TestMsalClient();
  msal.initializeError = new Error('MSAL initialization failed');
  await assert.rejects(prepareAuthentication(entraConfig, fixture.host, () => msal), msal.initializeError);
  assert.deepEqual(msal.calls, ['initialize']);
  assert.equal(fixture.values.size, 0);
});

test('canceled Microsoft login rejects without creating a preview fallback', async () => {
  const fixture = sessionHost();
  const msal = new TestMsalClient();
  msal.accounts = [];
  msal.loginError = new Error('Microsoft login canceled');
  const authentication = await prepareAuthentication(entraConfig, fixture.host, () => msal);
  await assert.rejects(authentication.signIn(), msal.loginError);
  assert.equal(authentication.session, undefined);
  assert.equal(fixture.values.size, 0);
});

test('interactive renewal redirects for the same account and then expires the current session', async () => {
  const fixture = sessionHost();
  const msal = new TestMsalClient();
  msal.silentError = new InteractionRequiredAuthError('interaction_required', 'test-correlation-id');
  const authentication = await prepareAuthentication(entraConfig, fixture.host, () => msal);
  assert.ok(authentication.session);
  await assert.rejects(authentication.session.getAccessToken(),
    error => error instanceof SessionExpiredError && /Continue Microsoft sign-in/.test(error.message));
  assert.deepEqual(msal.tokenRedirectRequests, [{ account, scopes: [entraConfig.scope] }]);
  assert.equal(fixture.values.size, 0);
});

test('noninteractive MSAL token failures propagate without starting a redirect or preview', async () => {
  const fixture = sessionHost();
  const msal = new TestMsalClient();
  msal.silentError = new Error('Silent token request failed');
  const authentication = await prepareAuthentication(entraConfig, fixture.host, () => msal);
  assert.ok(authentication.session);
  await assert.rejects(authentication.session.getAccessToken(), msal.silentError);
  assert.deepEqual(msal.tokenRedirectRequests, []);
  assert.equal(fixture.values.size, 0);
});

test('failed interactive renewal propagates its error without creating a preview', async () => {
  const fixture = sessionHost();
  const msal = new TestMsalClient();
  msal.silentError = new InteractionRequiredAuthError('interaction_required', 'test-correlation-id');
  msal.tokenRedirectError = new Error('Microsoft renewal canceled');
  const authentication = await prepareAuthentication(entraConfig, fixture.host, () => msal);
  assert.ok(authentication.session);
  await assert.rejects(authentication.session.getAccessToken(), msal.tokenRedirectError);
  assert.equal(fixture.values.size, 0);
});

function authElements(): AuthElements {
  return {
    login: { hidden: false, disabled: false, textContent: null },
    logout: { hidden: false, disabled: false, textContent: null },
    retry: { hidden: false, disabled: false },
    status: { textContent: null }, workspace: { hidden: false },
  };
}

const states: { state: AuthState; login: boolean; logout: boolean; retry: boolean; busy: boolean; status: string }[] = [
  { state: { kind: 'signed-out' }, login: true, logout: false, retry: false, busy: false,
    status: 'Sign in to use this application.' },
  { state: { kind: 'signing-in' }, login: true, logout: false, retry: false, busy: true,
    status: 'Starting Microsoft sign-in...' },
  { state: { kind: 'signing-out' }, login: false, logout: true, retry: false, busy: true, status: 'Signing out...' },
  { state: { kind: 'checking', name: account.username }, login: false, logout: false, retry: false, busy: true,
    status: 'Checking application access...' },
  { state: { kind: 'authorized', name: account.username }, login: false, logout: true, retry: false, busy: false,
    status: `Signed in as ${account.username}` },
  { state: { kind: 'forbidden', name: account.username }, login: false, logout: true, retry: false, busy: false,
    status: `Signed in as ${account.username}. You do not have access to this app. Ask the app owner for access.` },
  { state: { kind: 'expired' }, login: true, logout: false, retry: false, busy: false,
    status: 'Your session expired. Sign in again.' },
  { state: { kind: 'unavailable' }, login: false, logout: false, retry: true, busy: false,
    status: 'Application access could not be confirmed. Try again.' },
  { state: { kind: 'unavailable', name: account.username }, login: false, logout: true, retry: true, busy: false,
    status: 'Application access could not be confirmed. Try again.' },
];

for (const scenario of states) {
  test(`account view renders ${scenario.state.kind}${'name' in scenario.state ? ' with an account' : ''}`, () => {
    const elements = authElements();
    renderAuthentication(elements, 'entra', scenario.state);
    assert.equal(elements.login.hidden, !scenario.login);
    assert.equal(elements.logout.hidden, !scenario.logout);
    assert.equal(elements.retry.hidden, !scenario.retry);
    for (const control of [elements.login, elements.logout, elements.retry]) assert.equal(control.disabled, scenario.busy);
    assert.equal(elements.workspace.hidden, scenario.state.kind !== 'authorized');
    assert.equal(elements.login.textContent, 'Sign in with Microsoft');
    assert.equal(elements.logout.textContent, 'Sign out');
    assert.equal(elements.status.textContent, scenario.status);
  });
}

test('local account view uses test-account language without preview branding or product personas', () => {
  const elements = authElements();
  const messages = {
    'signed-out': 'Sign in to use this application. This local session uses a test account.',
    'signing-in': 'Signing in...',
    'signing-out': 'Signing out...',
    checking: 'Checking application access...',
    authorized: 'Signed in as Test user',
    forbidden: 'Signed in as Test user. Your account does not have access to this app.',
    expired: 'Your test session expired. Sign in again.',
    unavailable: 'Application access could not be confirmed. Try again.',
  };
  for (const { state } of states) {
    const localState = 'name' in state ? { ...state, name: 'Test user' } : state;
    renderAuthentication(elements, 'local', localState);
    assert.equal(elements.login.textContent, 'Sign in');
    assert.equal(elements.logout.textContent, 'Sign out');
    assert.equal(elements.status.textContent, messages[state.kind]);
    assert.equal(elements.workspace.hidden, state.kind !== 'authorized');
    assert.doesNotMatch([
      elements.login.textContent, elements.logout.textContent, elements.status.textContent,
    ].join(' '), /preview/i);
    assert.doesNotMatch(elements.status.textContent ?? '', /Alice|Bob/);
  }
});

test('authentication errors distinguish expiry, forbidden actions and backend unavailability', () => {
  for (const error of [new SessionExpiredError('Ended'), new ApiError(401)]) {
    assert.equal(authenticationErrorMessage(error), 'Your session expired. Sign in again.');
    assert.equal(authenticationErrorMessage(error, 'local'), 'Your test session expired. Sign in again.');
  }
  for (const mode of ['local', 'entra'] as const) {
    assert.equal(authenticationErrorMessage(new ApiError(403), mode), 'This action is not permitted for the current session.');
    assert.doesNotMatch(authenticationErrorMessage(new ApiError(403), mode), /expired/i);
    assert.equal(authenticationErrorMessage(new ApiError(503), mode), 'Backend service is unavailable (503). Try again.');
  }
  assert.equal(authenticationErrorMessage(new Error('Explicit failure')), 'Explicit failure');
  assert.equal(authenticationErrorMessage(undefined), 'Operation failed');
});

function browserElement() {
  return {
    hidden: false, disabled: false, textContent: '',
    onclick: null as (() => void) | null,
  };
}

function browserGlobal(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

const settleBrowser = () => new Promise<void>(resolve => setImmediate(resolve));
type BrowserResponse = Response | Error | Promise<Response>;
let browserImport = 0;
const readinessRows = [{ ready: 1 }];

async function browserApp(
  t: TestContext, mode: 'local' | 'entra', initialResponses: [string, BrowserResponse][] = [], withSession = true,
) {
  const elements = new Map<string, ReturnType<typeof browserElement>>();
  const element = (id: string) => {
    let value = elements.get(id);
    if (!value) { value = browserElement(); elements.set(id, value); }
    return value;
  };
  const windowHost = { addEventListener: (_event: string, stop: () => void) => { t.after(stop); } };
  const msal = new TestMsalClient();
  if (!withSession) msal.accounts = [];
  if (mode === 'entra') {
    for (const method of ['initialize', 'handleRedirectPromise', 'getAllAccounts', 'getActiveAccount', 'setActiveAccount',
      'loginRedirect', 'logoutRedirect', 'acquireTokenSilent', 'acquireTokenRedirect'] as const) {
      t.mock.method(PublicClientApplication.prototype, method,
        (...args: unknown[]) => Reflect.apply(msal[method], msal, args));
    }
  }
  const config: BrowserConfig = mode === 'local' ? previewConfig : entraConfig;
  const responses = new Map(initialResponses);
  const requests: string[] = [];
  const fixture = sessionHost(async input => {
    const url = new URL(String(input), 'http://127.0.0.1:30000');
    const path = url.pathname;
    const requestUrl = path + url.search;
    requests.push(requestUrl);
    // Keep MSAL construction in Node mode; only the provider methods above are mocked.
    if (path === '/auth/me') Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: windowHost });
    const response = responses.get(requestUrl) ?? responses.get(path);
    if (response instanceof Error) throw response;
    if (response) return response;
    if (path === '/auth/config') return Response.json(config);
    if (path === '/auth/me') return Response.json({ oid: 'browser-user', tenantId: 'browser-tenant', access: { allowed: true } });
    if (path === config.readinessPath) return Response.json({ value: readinessRows });
    throw new Error(`Unexpected browser request: ${requestUrl}`);
  });
  if (withSession) fixture.values.set(localSessionKey, previewToken);
  browserGlobal(t, 'location', { origin: fixture.host.origin, reload: fixture.host.reload });
  browserGlobal(t, 'sessionStorage', fixture.host.storage);
  browserGlobal(t, 'window', mode === 'local' ? windowHost : undefined);
  browserGlobal(t, 'BroadcastChannel', undefined);
  browserGlobal(t, 'document', { getElementById: element, visibilityState: 'visible' });
  t.mock.method(globalThis, 'fetch', fixture.host.fetch);
  await import(`../src/web/app.js?browser-test=${++browserImport}`);
  await settleBrowser();
  return { element, responses, requests, values: fixture.values, msal };
}

function pendingBrowserResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function checkData(app: Awaited<ReturnType<typeof browserApp>>) {
  app.element('check-data').onclick!();
  await settleBrowser();
}

function assertExpiredBrowser(app: Awaited<ReturnType<typeof browserApp>>, mode: 'local' | 'entra') {
  const message = mode === 'local' ? 'Your test session expired. Sign in again.' : 'Your session expired. Sign in again.';
  assert.equal(app.element('auth-status').textContent, message);
  assert.equal(app.element('status').textContent, message);
  assert.equal(app.element('login').hidden, false);
  assert.equal(app.element('login').disabled, false);
  assert.equal(app.element('auth-retry').hidden, true);
  assert.equal(app.element('logout').hidden, true);
  assert.equal(app.element('workspace').hidden, true);
  assert.equal(app.element('data-result').textContent, '');
  assert.equal(app.values.has(localSessionKey), false);
  if (mode === 'local') return;
  assert.equal(app.msal.activeAccount, null);
}

const browserFailures = [
  { name: '503', response: () => new Response(null, { status: 503 }), message: 'Backend service is unavailable (503). Try again.' },
  { name: '403', response: () => new Response(null, { status: 403 }), message: 'This action is not permitted for the current session.' },
  { name: 'network error', response: () => new TypeError('Browser request failed'), message: 'Browser request failed' },
];

test('local test-account mode does not show a developer warning in the product header', async t => {
  const app = await browserApp(t, 'local');
  assert.equal(app.element('auth-notice').hidden, true);
  assert.equal(app.element('auth-notice').textContent, '');
});

test('local Entra mode keeps the simulated-backend notice in the product header', async t => {
  const app = await browserApp(t, 'entra', [[
    '/auth/config',
    Response.json({ ...entraConfig, localBackend: true }),
  ]]);
  assert.equal(app.element('auth-notice').hidden, false);
  assert.equal(app.element('auth-notice').textContent,
    'Microsoft sign-in is real. Local DAB claims and backend services remain development simulations.');
});

for (const mode of ['local', 'entra'] as const) {
  const signedIn = mode === 'local' ? 'Signed in as Test user' : `Signed in as ${account.username}`;

  test(`${mode} authorized browser checks the readiness procedure once and shows its rows`, async t => {
    const app = await browserApp(t, mode);
    assert.deepEqual(app.requests, ['/auth/config', '/auth/me', '/api/AppReady']);
    assert.equal(app.element('workspace').hidden, false);
    assert.equal(app.element('status').textContent, signedIn);
    assert.equal(app.element('data-result').textContent, JSON.stringify(readinessRows, null, 2));
    assert.equal(app.element('check-data').disabled, false);
    await checkData(app);
    assert.deepEqual(app.requests.slice(3), ['/api/AppReady']);
  });

  test(`${mode} browser ignores repeated data checks while one is pending`, async t => {
    const app = await browserApp(t, mode);
    const pending = pendingBrowserResponse();
    t.after(() => pending.resolve(Response.json({ value: [] })));
    app.responses.set('/api/AppReady', pending.promise);
    await checkData(app);
    assert.equal(app.element('check-data').disabled, true);
    assert.equal(app.element('status').textContent, 'Checking data...');
    await checkData(app);
    assert.deepEqual(app.requests.slice(3), ['/api/AppReady']);
    pending.resolve(Response.json({ value: [] }));
    await settleBrowser();
    assert.equal(app.element('check-data').disabled, false);
    assert.equal(app.element('data-result').textContent, '[]');
  });

  for (const failure of [
    { name: '401', response: () => new Response(null, { status: 401 }) },
    { name: 'session expiry', response: () => new SessionExpiredError('Session ended') },
  ]) {
    test(`${mode} browser expires the session and clears data after a data ${failure.name}`, async t => {
      const app = await browserApp(t, mode);
      app.responses.set('/api/AppReady', failure.response());
      await checkData(app);
      assertExpiredBrowser(app, mode);
      const requests = app.requests.length;
      await checkData(app);
      assert.equal(app.requests.length, requests, 'expired sessions must not check data again');
    });
  }

  for (const failure of browserFailures) {
    test(`${mode} authorized browser reports data ${failure.name} without losing the account or workspace`, async t => {
      const app = await browserApp(t, mode);
      const accountStatus = app.element('auth-status').textContent;
      app.responses.set('/api/AppReady', failure.response());
      await checkData(app);
      assert.equal(app.element('auth-status').textContent, accountStatus);
      assert.equal(app.element('status').textContent, failure.message);
      assert.equal(app.element('workspace').hidden, false);
      assert.equal(app.element('login').hidden, true);
      assert.equal(app.element('logout').hidden, false);
      assert.equal(app.element('auth-retry').hidden, true);
      assert.equal(app.element('check-data').disabled, false);
      if (mode === 'local') assert.equal(app.values.has(localSessionKey), true);
      else assert.equal(app.msal.activeAccount, account);
    });

    for (const path of ['/auth/config', '/auth/me']) {
      test(`${mode} browser shows retry for ${path} ${failure.name} instead of expiry`, async t => {
        const app = await browserApp(t, mode, [[path, failure.response()]]);
        assert.equal(app.element('auth-status').textContent, 'Application access could not be confirmed. Try again.');
        assert.equal(app.element('status').textContent, failure.message);
        assert.equal(app.element('workspace').hidden, true);
        assert.equal(app.element('login').hidden, true);
        assert.equal(app.element('auth-retry').hidden, false);
        assert.equal(app.element('auth-retry').disabled, false);
        assert.equal(app.element('logout').hidden, path === '/auth/config');
        assert.deepEqual(app.requests, path === '/auth/config' ? ['/auth/config'] : ['/auth/config', '/auth/me']);
      });
    }
  }

  test(`${mode} browser preserves access denial without offering an availability retry`, async t => {
    const app = await browserApp(t, mode, [['/auth/me', Response.json({
      oid: 'browser-user', tenantId: 'browser-tenant', access: { allowed: false, requiredRole: 'app-user' },
    })]]);
    assert.equal(app.element('auth-status').textContent, mode === 'local'
      ? 'Signed in as Test user. Your account does not have access to this app.'
      : `Signed in as ${account.username}. You do not have access to this app. Ask the app owner for access.`);
    assert.equal(app.element('workspace').hidden, true);
    assert.equal(app.element('logout').hidden, false);
    assert.equal(app.element('login').hidden, true);
    assert.equal(app.element('auth-retry').hidden, true);
    assert.deepEqual(app.requests, ['/auth/config', '/auth/me']);
  });

  test(`${mode} browser reports sign-out failure while restoring the authorized account`, async t => {
    const app = await browserApp(t, mode);
    const accountStatus = app.element('auth-status').textContent;
    if (mode === 'local') app.responses.set('/local/session', new Response(null, { status: 503 }));
    else t.mock.method(app.msal, 'logoutRedirect', async () => { throw new Error('Microsoft sign-out failed'); });
    app.element('logout').onclick!();
    await settleBrowser();
    assert.equal(app.element('auth-status').textContent, accountStatus);
    assert.equal(app.element('workspace').hidden, false);
    assert.equal(app.element('logout').hidden, false);
    assert.equal(app.element('logout').disabled, false);
    assert.equal(app.element('auth-retry').hidden, true);
    assert.equal(app.element('status').textContent, mode === 'local'
      ? 'Test account sign-out failed (503)' : 'Microsoft sign-out failed');
    if (mode === 'local') assert.equal(app.values.has(localSessionKey), true);
    else assert.equal(app.msal.activeAccount, account);
  });

  test(`${mode} browser preserves expired recovery when a pending sign-out failure arrives after expiry`, async t => {
    const app = await browserApp(t, mode);
    const data = pendingBrowserResponse();
    const signOut = pendingBrowserResponse();
    t.after(() => { data.resolve(new Response(null, { status: 401 })); signOut.resolve(new Response(null, { status: 503 })); });
    app.responses.set('/api/AppReady', data.promise);
    if (mode === 'local') app.responses.set('/local/session', signOut.promise);
    else t.mock.method(app.msal, 'logoutRedirect', async () => { await signOut.promise; });
    await checkData(app);
    app.element('logout').onclick!();
    await settleBrowser();
    assert.equal(app.element('auth-status').textContent, 'Signing out...');
    data.resolve(new Response(null, { status: 401 }));
    await settleBrowser();
    assertExpiredBrowser(app, mode);
    if (mode === 'local') signOut.resolve(new Response(null, { status: 503 }));
    else signOut.reject(new Error('Microsoft sign-out failed'));
    await settleBrowser();
    assertExpiredBrowser(app, mode);
  });
}

test('browser restores signed-out recovery after Microsoft login cancellation', async t => {
  const app = await browserApp(t, 'entra', [], false);
  app.msal.loginError = new Error('Microsoft login canceled');
  app.element('login').onclick!();
  await settleBrowser();
  assert.equal(app.element('auth-status').textContent, 'Sign in to use this application.');
  assert.equal(app.element('status').textContent, 'Microsoft login canceled');
  assert.equal(app.element('login').hidden, false);
  assert.equal(app.element('login').disabled, false);
  assert.equal(app.element('logout').hidden, true);
  assert.equal(app.element('auth-retry').hidden, true);
  assert.equal(app.element('workspace').hidden, true);
  assert.equal(app.values.has(localSessionKey), false);
  assert.deepEqual(app.requests, ['/auth/config']);
});

test('product markup exposes semantic account lifecycle controls without a development persona selector', async () => {
  const html = await readFile('public/index.html', 'utf8');
  assert.match(html, /<section aria-label="Account and application access">/);
  assert.match(html, /id="auth-notice" hidden/);
  assert.match(html, /id="login" hidden>Sign in with Microsoft</);
  assert.match(html, /id="auth-retry" hidden>Try again</);
  assert.match(html, /id="auth-status" role="status" aria-live="polite"/);
  assert.match(html, /id="check-data">Check data</);
  assert.match(html, /id="status" role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /development-user|select-user|local-identity|Alice|Bob|load-more-files|id="jobs"/);
});
