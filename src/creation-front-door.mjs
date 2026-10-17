import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilityResult, changeBuild, validateProgress } from './creation-progress.mjs';
import { creationBuild, readCreationJson, updateCreation } from './creation-session.mjs';
import { probeCreationGateway } from './creation-checks.mjs';
import { inspectSource } from '../scripts/workspace-check.mjs';
import { acceptanceDigest } from './creation-acceptance.mjs';

const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const safeCodes = new Set(['GATEWAY_UNAVAILABLE', 'WORKSPACE_IDENTITY_MISMATCH', 'BUILD_SOURCE_MISMATCH',
  'DATA_ACCESS_NOT_READY', 'READINESS_PATH_INVALID', 'API_IDENTITY_UNAVAILABLE', 'CAPABILITY_RESPONSE_INVALID',
  'CAPABILITY_CONTRACT_INVALID', 'APPLICATION_RESPONSE_INVALID', 'CHECK_SESSION_CLEANUP_FAILED',
  'AUTHENTICATION_IDENTITY_MISMATCH', 'SQL_TARGET_IDENTITY_MISMATCH']);

export async function startCreationFrontDoor({ directory, tools, probe = probeCreationGateway, inspect = inspectSource, interval = 2000 }) {
  let snapshot = validateProgress(await readCreationJson(join(directory, 'progress.json')));
  const owned = { home: snapshot.home, sessionId: snapshot.sessionId, workspaceId: snapshot.workspaceId,
    publicOrigin: snapshot.publicOrigin, gatewayOrigin: snapshot.gatewayOrigin };
  const startedAt = Date.now();
  let gateway = false, sourceCurrent = false, diagnostic = null, checking = false, closed = false, surfaces = [];
  let lastAttemptAt = 0, lastObservedAt = 0;
  let surfacesObserved = false;
  const clients = new Set(), sockets = new Set(), assets = new Map();
  for (const [path, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/__sql_apps/style.css', 'style.css', 'text/css; charset=utf-8'],
    ['/__sql_apps/progress.js', 'progress.js', 'text/javascript; charset=utf-8'],
    ['/__sql_apps/endpoint', 'endpoint.html', 'text/html; charset=utf-8'],
    ['/__sql_apps/endpoint.js', 'endpoint.js', 'text/javascript; charset=utf-8'],
  ]) assets.set(path, { body: await readFile(new URL(`./creation-web/${file}`, import.meta.url)), type });
  const view = () => {
    const current = sourceCurrent && Date.now() - lastObservedAt <= interval * 2;
    const capabilities = snapshot.capabilities.map(item => item.state === 'verified' &&
      (!current || Date.parse(item.checkedAt) <= startedAt ||
        !gateway && ['services', 'application'].includes(item.id))
      ? { ...item, state: 'stale' } : item);
    const capabilityBlockers = capabilities.filter(item => item.state !== 'verified').map(item => item.id);
    const blockers = [...capabilityBlockers];
    if (!snapshot.workflow || snapshot.workflow.build !== snapshot.build) blockers.push('browser-workflow');
    if (!snapshot.design || snapshot.design.build !== snapshot.build) blockers.push('design-review');
    const usable = gateway && snapshot.build !== null && capabilityBlockers.length === 0;
    return { ...snapshot, usable, ready: usable && blockers.length === 0, blockers, capabilities,
      surfaces: gateway && (current || checking && surfacesObserved) ? surfaces : surfaces.map(item => ({ ...item, state: 'stale' })),
      diagnostic, connected: true };
  };
  function broadcast() {
    for (const response of clients) {
      if (!response.write(`data: ${JSON.stringify(view())}\n\n`)) {
        response.end();
        clients.delete(response);
      }
    }
  }
  async function refresh() {
    if (checking || closed) return;
    checking = true;
    surfacesObserved = false;
    lastAttemptAt = Date.now();
    try {
      snapshot = validateProgress(await readCreationJson(join(directory, 'progress.json')));
      if (Object.entries(owned).some(([key, value]) => snapshot[key] !== value)) throw new Error('WORKSPACE_IDENTITY_MISMATCH');
      let source;
      try { source = await inspect(snapshot.home, { toolingHome: tools }); }
      catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'PROJECT_NOT_FOUND') throw error;
      }
      if (!source?.ready || !source.build?.ready) {
        gateway = false;
        sourceCurrent = false;
        diagnostic = source?.ready ? 'BUILD_REQUIRED' : 'PROJECT_SETUP_REQUIRED';
        if (source?.ready) snapshot = await updateCreation(snapshot.home, value => changeBuild(value, null)) ?? snapshot;
        return;
      }
      const build = await creationBuild(snapshot.home);
      sourceCurrent = true;
      if (snapshot.build !== build) { gateway = false; surfaces = []; }
      snapshot = await updateCreation(snapshot.home, value => changeBuild(value, build)) ?? snapshot;
      for (const kind of ['workflow', 'design']) {
        let changed = false;
        if (snapshot[kind]) {
          try { changed = await acceptanceDigest(snapshot.home, snapshot[kind].artifacts) !== snapshot[kind].digest; }
          catch { changed = true; }
        }
        if (changed) {
          snapshot = await updateCreation(snapshot.home, value => ({ ...value, [kind]: null, sequence: value.sequence + 1 })) ?? snapshot;
          diagnostic = 'ACCEPTANCE_EVIDENCE_CHANGED';
        }
      }
      const reportProgress = async progress => {
        if (!progress.access) return;
        gateway = true;
        surfaces = progress.surfaces ?? [];
        surfacesObserved = true;
        diagnostic = progress.diagnostic ?? 'CAPABILITY_CHECKS_RUNNING';
        broadcast();
      };
      const result = await probe(snapshot, undefined, reportProgress);
      snapshot = await updateCreation(snapshot.home, value => {
        let next = changeBuild(value, build);
        for (const id of ['data', 'data-access']) next = capabilityResult(next, id, 'verified', 'Configured authorized SQL procedure query verified.');
        if (result.services) {
          next = capabilityResult(next, 'services', 'verified', 'Authenticated required endpoint responses verified.');
          next = result.application === false
            ? capabilityResult(next, 'application', 'failed', null, 'APPLICATION_RESPONSE_INVALID')
            : capabilityResult(next, 'application', 'verified', 'Browser document and required data path responded.');
        } else if (next.capabilities.find(item => item.id === 'services').state !== 'verified' ||
            Date.parse(next.capabilities.find(item => item.id === 'services').checkedAt) < startedAt) {
          next = capabilityResult(next, 'services', 'blocked', null, result.diagnostic);
        } else if (result.diagnostic !== 'AUTHENTICATED_CHECK_REQUIRED') {
          next = capabilityResult(next, 'services', 'failed', null, result.diagnostic);
        }
        return next;
      }) ?? snapshot;
      gateway = true;
      surfaces = result.surfaces ?? [];
      diagnostic = result.diagnostic ?? null;
    } catch (error) {
      gateway = false;
      diagnostic = safeCodes.has(error.message) ? error.message : 'CAPABILITY_PROBE_FAILED';
      const failedCapability = diagnostic === 'APPLICATION_RESPONSE_INVALID' ? 'application' :
        ['CAPABILITY_RESPONSE_INVALID', 'CAPABILITY_CONTRACT_INVALID', 'API_IDENTITY_UNAVAILABLE', 'CHECK_SESSION_CLEANUP_FAILED'].includes(diagnostic) ? 'services' : 'data-access';
      try {
        const current = await updateCreation(owned.home, value =>
          capabilityResult(value, failedCapability, 'failed', null, diagnostic));
        if (current) snapshot = current;
      } catch (stateError) {
        if (stateError.code !== 'ENOENT') {
          console.error('Creation status could not persist a probe result; inspect session state and permissions.');
          diagnostic = 'CREATION_STATE_INVALID';
        }
      }
    } finally {
      checking = false;
      lastObservedAt = Date.now();
      broadcast();
    }
  }
  const app = createServer((incoming, outgoing) => {
    outgoing.setHeader('cache-control', 'no-store');
    outgoing.setHeader('x-content-type-options', 'nosniff');
    outgoing.setHeader('referrer-policy', 'no-referrer');
    if (incoming.headers.host !== new URL(owned.publicOrigin).host) { outgoing.writeHead(403).end(); return; }
    let url;
    try { url = new URL(incoming.url ?? '/', owned.publicOrigin); }
    catch { outgoing.writeHead(400).end(); return; }
    if (url.origin !== owned.publicOrigin) { outgoing.writeHead(400).end(); return; }
    if (url.pathname !== '/__sql_apps/identity' && Date.now() - lastAttemptAt >= interval) void refresh();
    if (url.pathname.startsWith('/__sql_apps')) {
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') { outgoing.writeHead(405).end(); return; }
      if (url.pathname === '/__sql_apps/identity') {
        outgoing.setHeader('content-type', 'application/json');
        outgoing.end(JSON.stringify({ version: 1, ...owned, pid: process.pid }));
      } else if (url.pathname === '/__sql_apps/progress') {
        outgoing.setHeader('content-type', 'application/json');
        outgoing.end(JSON.stringify(view()));
      } else if (url.pathname === '/__sql_apps/check') {
        outgoing.setHeader('content-type', 'application/json');
        void (async () => {
          await refresh();
          for (let attempt = 0; checking && attempt < 5000; attempt++) await new Promise(done => setTimeout(done, 10));
          if (checking) throw new Error('Capability check exceeded its bounded wait.');
          outgoing.end(JSON.stringify(view()));
        })().catch(() => outgoing.writeHead(503).end(JSON.stringify({ error: 'Capability check did not complete. Inspect setup diagnostics.' })));
      } else if (url.pathname === '/__sql_apps/events') {
        outgoing.setHeader('content-type', 'text/event-stream');
        outgoing.write(`data: ${JSON.stringify(view())}\n\n`);
        clients.add(outgoing);
        outgoing.on('close', () => clients.delete(outgoing));
      } else if (url.pathname === '/__sql_apps/creation') sendAsset('/');
      else if (assets.has(url.pathname)) sendAsset(url.pathname);
      else outgoing.writeHead(404).end();
      return;
    }
    const availableSurface = surfaces.some(item => item.state === 'verified' && item.path === url.pathname);
    const explorerSupport = surfaces.some(item => item.state === 'verified') && ['/auth/config', '/local/session'].includes(url.pathname);
    if (!gateway || !view().usable && diagnostic !== 'AUTHENTICATED_CHECK_REQUIRED' && !availableSurface && !explorerSupport &&
        !['/local/workspace', '/health/live', '/health/ready'].includes(url.pathname)) {
      if (incoming.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) sendAsset('/');
      else {
        outgoing.setHeader('content-type', 'application/json');
        outgoing.setHeader('x-sql-apps-creation', 'pending');
        outgoing.writeHead(503).end(JSON.stringify({ error: 'Application capability is not verified.', diagnostic }));
      }
      return;
    }
    const headers = {};
    const connectionHeaders = String(incoming.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim());
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (!hop.has(key) && !connectionHeaders.includes(key) && !key.startsWith('x-forwarded-') && key !== 'forwarded') headers[key] = value;
    }
    headers.host = new URL(owned.publicOrigin).host;
    const upstream = httpRequest(new URL(`${url.pathname}${url.search}`, owned.gatewayOrigin), {
      method: incoming.method, headers, timeout: 35000,
    }, response => {
      const resultHeaders = {};
      for (const [key, value] of Object.entries(response.headers)) if (!hop.has(key)) resultHeaders[key] = value;
      if (typeof resultHeaders.location === 'string' && resultHeaders.location.startsWith(owned.gatewayOrigin + '/')) {
        resultHeaders.location = owned.publicOrigin + resultHeaders.location.slice(owned.gatewayOrigin.length);
      }
      outgoing.writeHead(response.statusCode ?? 502, resultHeaders);
      response.pipe(outgoing);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Gateway timeout')));
    upstream.on('error', () => {
      gateway = false;
      diagnostic = 'GATEWAY_UNAVAILABLE';
      if (!outgoing.headersSent) {
        outgoing.setHeader('content-type', 'application/json');
        outgoing.writeHead(502).end(JSON.stringify({ error: 'Gateway unavailable. A submitted mutation may have an uncertain outcome; reload before retrying.' }));
      } else outgoing.destroy();
      broadcast();
    });
    incoming.on('aborted', () => upstream.destroy());
    incoming.pipe(upstream);
    function sendAsset(path) {
      const asset = assets.get(path);
      outgoing.setHeader('content-type', asset.type);
      outgoing.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      outgoing.end(incoming.method === 'HEAD' ? undefined : asset.body);
    }
  });
  app.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  app.headersTimeout = 10000;
  app.requestTimeout = 35000;
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen({ host: '127.0.0.1', port: Number(new URL(owned.publicOrigin).port), exclusive: true }, resolve);
  });
  const timer = setInterval(() => { if (clients.size) void refresh(); }, interval);
  void refresh();
  return {
    origin: owned.publicOrigin,
    refresh,
    close: async () => {
      closed = true;
      clearInterval(timer);
      for (const response of clients) response.end();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
      for (let attempt = 0; checking && attempt < 1000; attempt++) await new Promise(done => setTimeout(done, 10));
      if (checking) throw new Error('Creation probe did not stop within its bounded shutdown window.');
    },
  };
}
