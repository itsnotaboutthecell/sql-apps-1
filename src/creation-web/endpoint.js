const status = document.getElementById('endpoint-status'), run = document.getElementById('run'), result = document.getElementById('result');
let surface;
async function load(enable = true) {
  const response = await fetch('/__sql_apps/progress', { cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error('Verification status unavailable.');
  const value = await response.json();
  surface = value.surfaces.find(item => item.id === new URLSearchParams(location.search).get('capability') && item.state === 'verified');
  if (!surface || !surface.preview) throw new Error('Use the signed-in application to inspect this capability; preview access is not available.');
  status.textContent = `${surface.kind.toUpperCase()} ${surface.path} · Verified`;
  run.disabled = !enable;
}
run.onclick = async () => {
  run.disabled = true;
  let token;
  try {
    await load(false);
    const session = await fetch('/local/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{"preview":true}', redirect: 'error' });
    const identity = await session.json();
    if (!session.ok || typeof identity.token !== 'string') throw new Error('Local preview session could not be established.');
    token = identity.token;
    const headers = { authorization: `Bearer ${token}` };
    const options = { headers, redirect: 'error' };
    if (surface.kind === 'graphql' || surface.kind === 'mcp') {
      options.method = 'POST';
      headers['content-type'] = 'application/json';
      options.body = surface.kind === 'graphql' ? JSON.stringify({ query: surface.query }) : '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
      if (surface.kind === 'mcp') headers.accept = 'application/json, text/event-stream';
    }
    const response = await fetch(surface.path, options);
    if (!response.ok) throw new Error(`Request failed (${response.status}). Recheck the capability.`);
    result.textContent = JSON.stringify(await response.json(), null, 2);
    status.textContent = 'Read-only request succeeded.';
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Read-only request failed.'; }
  finally {
    if (token) {
      try {
        const cleanup = await fetch('/local/session', { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, redirect: 'error' });
        if (!cleanup.ok) throw new Error('Preview session cleanup was rejected.');
      } catch {
        status.textContent = 'Preview session cleanup failed. Inspect the local service before continuing.';
      }
    }
    run.disabled = false;
  }
};
void load().catch(error => { status.textContent = error instanceof Error ? error.message : 'Endpoint unavailable.'; });
