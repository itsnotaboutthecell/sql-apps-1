const labels = { data: 'Data', 'data-access': 'Data access', services: 'Application services', application: 'Application' };
const explanations = {
  GATEWAY_UNAVAILABLE: 'The application gateway is not responding. Working data is preserved.',
  PROJECT_SETUP_REQUIRED: 'Scaffolding or dependency installation is still required. Review setup for the next action.',
  BUILD_REQUIRED: 'Build missing or stale. Review setup before rebuilding.',
  AUTHENTICATED_CHECK_REQUIRED: 'Sign-in is required to verify the application endpoints.',
  CAPABILITY_RESPONSE_INVALID: 'An endpoint responded, but its response did not satisfy the application contract.',
  WORKSPACE_IDENTITY_MISMATCH: 'The responding service belongs to a different workspace. It was not adopted.',
  AUTHENTICATION_IDENTITY_MISMATCH: 'The helper and application use different authentication settings. Review and restart the owned helper with the intended settings.',
  SQL_TARGET_IDENTITY_MISMATCH: 'The application is connected to a different SQL target. Review the saved target and owned service before restarting.',
};
const nodes = new Map();
for (const [id, label] of Object.entries(labels)) {
  const row = document.createElement('li');
  const state = document.createElement('span');
  state.className = 'state';
  const content = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('small');
  title.textContent = label;
  content.append(title, detail);
  row.append(state, content);
  document.getElementById('capabilities').append(row);
  nodes.set(id, { row, state, detail });
}
let sequence = -1, navigating = false;
function render(value) {
  if (!navigator.onLine) { disconnected(); return; }
  if (!value || value.version !== 1 || !Array.isArray(value.capabilities) || value.sequence < sequence) return;
  sequence = value.sequence;
  document.getElementById('title').textContent = `Bringing ${value.name} to life`;
  document.title = `${value.name} · SQL Apps`;
  for (const item of value.capabilities) {
    const node = nodes.get(item.id);
    if (!node) continue;
    node.row.dataset.state = item.state;
    node.state.textContent = item.state[0].toUpperCase() + item.state.slice(1);
    node.detail.textContent = item.proof ?? (item.diagnostic ? explanations[item.diagnostic] ?? 'Inspect this capability through setup before retrying.' : 'Waiting for verified evidence.');
  }
  document.getElementById('origin').textContent = value.publicOrigin;
  const surfaceList = document.getElementById('surfaces');
  surfaceList.replaceChildren();
  for (const surface of value.surfaces ?? []) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${surface.kind.toUpperCase()} ${surface.path} · ${surface.state}`;
    item.append(label);
    if (surface.state === 'verified' && surface.preview) {
      const link = document.createElement('a');
      link.href = `/__sql_apps/endpoint?capability=${encodeURIComponent(surface.id)}`;
      link.textContent = 'Inspect';
      item.append(link);
    } else if (surface.state === 'failed') item.append(document.createTextNode('Recheck this surface; other verified endpoints remain usable.'));
    surfaceList.append(item);
  }
  document.getElementById('blockers').textContent = value.blockers?.join(', ') || 'None';
  document.getElementById('diagnostic').textContent = value.diagnostic ?
    `${value.diagnostic}: ${explanations[value.diagnostic] ?? 'Inspect setup diagnostics; resources and data have been preserved.'}` : 'Checks are current.';
  document.getElementById('acceptance').hidden = !value.usable;
  document.getElementById('acceptance-title').textContent = value.ready ? 'Ready — workflow verified, design accepted' : 'Usable — review pending';
  document.getElementById('summary').textContent = value.ready ? 'Your verified application is ready.' :
    value.usable ? 'Your application is connected. Browser and design acceptance remain separate gates.' :
      'Working capabilities appear as they are verified. You can inspect details without changing resources.';
  if (value.usable && location.pathname === '/' && !navigating) {
    navigating = true;
    location.replace('/');
  }
}
async function snapshot() {
  const response = await fetch('/__sql_apps/progress', { cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error('Status unavailable');
  render(await response.json());
}
function disconnected() {
  document.getElementById('summary').textContent = 'Reconnecting — status may be stale. Previously verified checks are not current health.';
  document.getElementById('acceptance').hidden = true;
  for (const node of nodes.values()) {
    if (node.row.dataset.state === 'verified') {
      node.row.dataset.state = 'stale';
      node.state.textContent = 'Stale';
    }
  }
  for (const link of document.getElementById('surfaces').querySelectorAll('a')) link.remove();
}
const events = new EventSource('/__sql_apps/events');
document.getElementById('recheck').onclick = async event => {
  event.currentTarget.disabled = true;
  try {
    const response = await fetch('/__sql_apps/check', { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('Check failed');
    render(await response.json());
  } catch { disconnected(); }
  finally { document.getElementById('recheck').disabled = false; }
};
events.onopen = () => { void snapshot().catch(disconnected); };
events.onmessage = event => {
  try { render(JSON.parse(event.data)); }
  catch { disconnected(); }
};
events.onerror = disconnected;
window.addEventListener('offline', disconnected);
window.addEventListener('online', () => { void snapshot().catch(disconnected); });
void snapshot().catch(disconnected);
