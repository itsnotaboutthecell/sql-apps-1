import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCreationJson } from './creation-session.mjs';
import { request as httpRequest } from 'node:http';
import { localAuthenticationMatches, readLocalAuthentication } from './local-auth.mjs';
import { runtimeFor } from './workspace.mjs';
import { readSqlTarget, sqlTargetFingerprint } from './sql-target.mjs';

export function loopbackFetch(input, options = {}) {
  const url = new URL(input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Loopback probes cannot target remote services.');
  return new Promise((done, reject) => {
    const request = httpRequest(url, { method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), timeout: 5000 }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) response.destroy(new Error('Loopback probe response exceeded its size limit.'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        const status = response.statusCode ?? 502;
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        done(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('Loopback probe timed out.')));
    const abort = () => request.destroy(new Error('Loopback probe aborted.'));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => options.signal?.removeEventListener('abort', abort));
    request.end(options.body);
  });
}

export async function probeCreationGateway(snapshot, fetcher = loopbackFetch, onProgress = async () => {}) {
  const request = (path, options = {}) => fetcher(new URL(path, snapshot.gatewayOrigin), {
    ...options, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { ...options.headers, host: new URL(snapshot.publicOrigin).host, origin: snapshot.publicOrigin },
  });
  const identityResponse = await request('/local/workspace');
  if (!identityResponse.ok) throw new Error('GATEWAY_UNAVAILABLE');
  const identity = await identityResponse.json();
  if (identity.id !== snapshot.workspaceId || identity.origins?.app !== snapshot.publicOrigin ||
      identity.profile !== 'role-based-data' || !/^[a-f0-9]{64}$/.test(identity.sourceFingerprint) ||
      identity.gatewayOrigin !== snapshot.gatewayOrigin) throw new Error('WORKSPACE_IDENTITY_MISMATCH');
  if (!localAuthenticationMatches(identity.authentication, readLocalAuthentication())) throw new Error('AUTHENTICATION_IDENTITY_MISMATCH');
  const target = await readSqlTarget(snapshot.home, runtimeFor(undefined, snapshot.home).defaultSql);
  if (target.provider === 'container'
    ? identity.container !== target.container || identity.sqlProvider !== undefined && identity.sqlProvider !== 'container'
    : identity.sqlProvider !== target.provider || identity.sqlTargetFingerprint !== sqlTargetFingerprint(target)) {
    throw new Error('SQL_TARGET_IDENTITY_MISMATCH');
  }
  const provenance = await readCreationJson(join(snapshot.home, 'dist', 'build-provenance.json'));
  if (provenance.sourceFingerprint !== identity.sourceFingerprint) throw new Error('BUILD_SOURCE_MISMATCH');
  const ready = await request('/health/ready');
  const readiness = await ready.json();
  if (!ready.ok || readiness.status !== 'ready') throw new Error('DATA_ACCESS_NOT_READY');
  const profile = JSON.parse(await readFile(join(snapshot.home, 'role-based-data.json'), 'utf8'));
  if (!/^\/api\/[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(profile.readinessPath)) throw new Error('READINESS_PATH_INVALID');
  let token = process.env.SQL_APPS_ACCEPTANCE_TOKEN;
  if (identity.authentication?.mode === 'preview') {
    const session = await request('/local/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"preview":true}' });
    const body = await session.json();
    if (!session.ok || typeof body.token !== 'string' || !body.token) throw new Error('API_IDENTITY_UNAVAILABLE');
    token = body.token;
  }
  if (!token) return { identity, access: true, services: false, surfaces: [], diagnostic: 'AUTHENTICATED_CHECK_REQUIRED' };
  try {
    const surfaces = [];
    const response = await request(profile.readinessPath, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json();
    const restReady = response.ok && body && Array.isArray(body.value);
    surfaces.push({ id: 'readiness', kind: 'rest', path: profile.readinessPath, state: restReady ? 'verified' : 'failed',
      query: null, preview: identity.authentication?.mode === 'preview' });
    let contracts;
    try { contracts = await readCreationJson(join(snapshot.home, 'creation-checks.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const checks = [];
    if (contracts !== undefined) {
      if (contracts.version !== 1 || !Array.isArray(contracts.checks) || contracts.checks.length > 12 ||
          Object.keys(contracts).some(key => !['version', 'checks'].includes(key))) throw new Error('CAPABILITY_CONTRACT_INVALID');
      for (const [index, check] of contracts.checks.entries()) {
        if (!check || !['rest', 'graphql', 'mcp', 'openapi'].includes(check.kind) ||
            !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(check.path) ||
            Object.keys(check).some(key => !['kind', 'path', 'query'].includes(key))) throw new Error('CAPABILITY_CONTRACT_INVALID');
        let options = { headers: { authorization: `Bearer ${token}` } };
        if (check.kind === 'graphql') {
          if (typeof check.query !== 'string' || !/^\s*query\b/.test(check.query) || /\bmutation\b/.test(check.query)) throw new Error('CAPABILITY_CONTRACT_INVALID');
          options = { method: 'POST', headers: { ...options.headers, 'content-type': 'application/json' }, body: JSON.stringify({ query: check.query }) };
        } else if (check.kind === 'mcp') {
          options = { method: 'POST', headers: { ...options.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' };
        }
        checks.push({ index, check, options });
      }
    }
    await onProgress({ identity, access: true, services: false, surfaces: [...surfaces], diagnostic: 'CAPABILITY_CHECKS_RUNNING' });
    let nextCheck = 0;
    const verifyCheck = async () => {
      while (nextCheck < checks.length) {
        const { index, check, options } = checks[nextCheck++];
        let verified = false;
        try {
          const endpoint = await request(check.path, options);
          const data = await endpoint.json();
          verified = endpoint.ok && data && !(check.kind === 'rest' && !Array.isArray(data.value)) &&
            !(check.kind === 'graphql' && (!data.data || data.errors)) &&
            !(check.kind === 'mcp' && (!data.result || !Array.isArray(data.result.tools) || data.error)) &&
            !(check.kind === 'openapi' && (typeof data.openapi !== 'string' || !data.paths));
        } catch { verified = false; }
        surfaces.push({ id: `surface-${index}`, kind: check.kind, path: check.path,
          query: check.query ?? null, state: verified ? 'verified' : 'failed', preview: identity.authentication?.mode === 'preview' });
        await onProgress({ identity, access: true, services: false, surfaces: [...surfaces], diagnostic: 'CAPABILITY_CHECKS_RUNNING' });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, checks.length) }, verifyCheck));
    const document = await request('/');
    const application = document.ok && document.headers.get('content-type')?.includes('text/html') &&
      /<(?:html|!doctype)/i.test(await document.text());
    const services = surfaces.every(surface => surface.state === 'verified');
    const diagnostic = !services ? 'CAPABILITY_RESPONSE_INVALID' : application ? null : 'APPLICATION_RESPONSE_INVALID';
    return { identity, access: true, services, application, readinessPath: profile.readinessPath, surfaces, diagnostic };
  } finally {
    if (identity.authentication?.mode === 'preview') {
      const response = await request('/local/session', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('CHECK_SESSION_CLEANUP_FAILED');
    }
  }
}
