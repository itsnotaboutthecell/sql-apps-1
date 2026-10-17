export function connectCreationStatus(path: '/__sql_apps/creation'): () => void {
  const host = document.createElement('aside');
  host.setAttribute('aria-label', 'Local application verification');
  const shadow = host.attachShadow({ mode: 'open' });
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/__sql_apps/style.css';
  const strip = document.createElement('div');
  strip.className = 'creation-strip';
  const message = document.createElement('span');
  message.setAttribute('role', 'status');
  message.textContent = 'Checking local verification…';
  const details = document.createElement('a');
  details.href = path;
  details.textContent = 'View checks';
  strip.append(message, details);
  shadow.append(stylesheet, strip);
  document.body.prepend(host);
  const events = new EventSource('/__sql_apps/events');
  let shrink: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  function disconnected() {
    if (shrink) clearTimeout(shrink);
    ready = false;
    message.hidden = false;
    message.textContent = 'Reconnecting — verification status may be stale';
  }
  events.onmessage = event => {
    if (!navigator.onLine) { disconnected(); return; }
    try {
      const value: unknown = JSON.parse(String(event.data));
      if (!value || typeof value !== 'object' || !('ready' in value) || !('usable' in value)) throw new Error('Invalid progress');
      const wasReady = ready;
      ready = value.ready === true;
      if (!ready) {
        if (shrink) clearTimeout(shrink);
        message.hidden = false;
      } else if (!wasReady) {
        message.hidden = false;
        shrink = setTimeout(() => { message.hidden = true; }, 5000);
      }
      message.textContent = value.ready === true ? 'Ready — workflow verified, design accepted' :
        value.usable === true ? 'Usable — browser and design review pending' : 'Capability verification incomplete — inspect checks before continuing';
    } catch {
      disconnected();
      message.textContent = 'Verification status unavailable — inspect checks';
    }
  };
  events.onerror = disconnected;
  window.addEventListener('offline', disconnected);
  return () => {
    if (shrink) clearTimeout(shrink);
    window.removeEventListener('offline', disconnected);
    events.close();
    host.remove();
  };
}
