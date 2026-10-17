import { fork, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { creationSession, readCreationJson, writeCreationJson, updateCreation, creationBuild } from '../src/creation-session.mjs';
import { fingerprint, validateProgress, completion, changeBuild } from '../src/creation-progress.mjs';
import { startCreationFrontDoor } from '../src/creation-front-door.mjs';
import { projectHome, toolingHome } from '../src/tooling-context.mjs';
import { inspectSource } from './workspace-check.mjs';

export async function creationImplementation() {
  return fingerprint(await Promise.all([
    '../src/creation-progress.mjs', '../src/creation-session.mjs', '../src/creation-checks.mjs',
    '../src/creation-front-door.mjs', '../src/creation-web/index.html', '../src/creation-web/style.css',
    '../src/creation-web/progress.js',
    '../src/creation-web/endpoint.html', '../src/creation-web/endpoint.js',
    './creation.mjs', './projects.mjs', '../src/workspace.mjs', '../src/creation-acceptance.mjs',
  ].map(async path => (await readFile(new URL(path, import.meta.url))).toString('utf8'))));
}

export async function startCreationProcess(directory, tools, options = {}) {
  const state = validateProgress(await readCreationJson(join(directory, 'progress.json')));
  const log = openSync(join(directory, `server-${randomUUID()}.log`), 'ax', 0o600);
  let child;
  try {
    child = fork(new URL('./creation.mjs', import.meta.url), ['serve-session', directory, tools], {
      cwd: tools, detached: true, windowsHide: true, stdio: ['ignore', log, log, 'ipc'],
    });
  } finally { closeSync(log); }
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Creation front door did not become ready. Inspect the selected port and session.')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Creation front door stopped before readiness. Inspect ${directory}.`)); });
      child.once('message', message => {
        clearTimeout(timer);
        if (message?.ready !== state.sessionId) reject(new Error('Creation front-door identity did not match.'));
        else done();
      });
    });
    child.disconnect();
    child.unref();
    const response = await fetch(`${state.publicOrigin}/__sql_apps/identity`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    const identity = await response.json();
    if (!response.ok || identity.sessionId !== state.sessionId || identity.home !== state.home || identity.pid !== child.pid) {
      throw new Error('Creation front-door readiness identity mismatched.');
    }
    await (options.writeReceipt ?? writeCreationJson)(
      join(directory, 'process.json'), { version: 1, pid: child.pid, sessionId: state.sessionId });
    return state.publicOrigin;
  } catch (error) {
    try { await stopForkedChild(child); }
    catch (cleanup) {
      const failure = new AggregateError([error, cleanup], 'Creation front door failed to start and could not be stopped.');
      failure.code = 'CREATION_PROCESS_CLEANUP_FAILED';
      throw failure;
    }
    throw error;
  }
}

async function stopForkedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = error => finish(error);
    child.once('exit', onExit);
    child.once('error', onError);
    timer = setTimeout(() => finish(new Error('Owned front-door child did not stop after startup failed.')), 5000);
    try { child.kill(); }
    catch (error) { finish(error); }
  });
}

export async function openCreationBrowser(origin, runner = spawn) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) throw new Error('Browser URL must be the selected loopback origin.');
  const [file, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', origin]] :
    process.platform === 'darwin' ? ['open', [origin]] : ['xdg-open', [origin]];
  try {
    await new Promise((done, reject) => {
      const child = runner(file, args, { shell: false, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { child.unref(); reject(new Error('Browser launcher did not confirm opening within the bounded wait.')); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error('Browser launcher failed.')); });
    });
    return true;
  } catch {
    console.error(`Browser could not be opened. Open the verified local URL manually: ${origin}`);
    return false;
  }
}

export async function stopCreationProcess(directory) {
  const state = validateProgress(await readCreationJson(join(directory, 'progress.json')));
  const receipt = await readCreationJson(join(directory, 'process.json'));
  const response = await fetch(`${state.publicOrigin}/__sql_apps/identity`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  const identity = await response.json();
  if (!response.ok || receipt.version !== 1 || receipt.sessionId !== state.sessionId ||
      identity.sessionId !== state.sessionId || identity.pid !== receipt.pid || identity.home !== state.home ||
      !Number.isInteger(receipt.pid) || receipt.pid < 1) throw new Error('Front-door ownership could not be verified; no process stopped.');
  process.kill(receipt.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(receipt.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Owned front-door process did not stop within the bounded wait.');
}

export async function main(args = process.argv.slice(2), home) {
  const [command = 'status', ...rest] = args;
  if (command === 'serve-session') {
    if (rest.length !== 2) throw new Error('Internal creation session requires its state directory and tooling root.');
    const app = await startCreationFrontDoor({ directory: resolve(rest[0]), tools: resolve(rest[1]) });
    const state = validateProgress(await readCreationJson(join(rest[0], 'progress.json')));
    process.send?.({ ready: state.sessionId });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void app.close().then(() => process.exit(0), () => { console.error('Creation front-door shutdown failed.'); process.exit(1); });
    });
    return;
  }
  if (command === 'help') {
    console.log('Creation: status | check | start --approval <id> | stop | accept <absolute-evidence.json>. Status/check are read-only; start/stop manage only the owned front door. No service recovery or data mutation is automatic.');
    return;
  }
  home ??= await projectHome();
  const session = await creationSession(home);
  if (!session) throw new Error('This project has no progressive creation session. Existing direct-start behavior is unchanged.');
  const tools = await toolingHome(import.meta.url);
  const approval = fingerprint({ sessionId: session.snapshot.sessionId, home: session.snapshot.home,
    origin: session.snapshot.publicOrigin, implementation: await creationImplementation() }).slice(0, 12);
  if (command === 'status' || command === 'check') {
    if (rest.length) throw new Error('Creation status/check take no arguments.');
    let live;
    try {
      const response = await fetch(`${session.snapshot.publicOrigin}/__sql_apps/${command === 'check' ? 'check' : 'progress'}`, {
        signal: AbortSignal.timeout(command === 'check' ? 55000 : 3000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Creation status returned an unsuccessful response.');
      live = await response.json();
      if (live.sessionId !== session.snapshot.sessionId) throw new Error('Creation status belongs to another session.');
    } catch (error) {
      console.error('Creation status could not verify a live owned front door; persisted checks are historical.');
      live = { ...session.snapshot, ...completion(session.snapshot), connected: false, ready: false, usable: false,
        capabilities: session.snapshot.capabilities.map(item => item.state === 'verified' ? { ...item, state: 'stale' } : item),
        diagnostic: 'FRONT_DOOR_UNAVAILABLE' };
    }
    console.log(JSON.stringify({ ...live, startApproval: approval,
      startEffects: ['Start the owned loopback status/proxy process.', 'Recheck existing capabilities without changing SQL data.'] }, null, 2));
    return;
  }
  if (command === 'start') {
    if (rest.length !== 2 || rest[0] !== '--approval' || rest[1] !== approval) throw new Error('Review creation status and explicitly approve its current startApproval before restarting the front door.');
    console.log(await startCreationProcess(session.directory, tools));
  } else if (command === 'stop') {
    if (rest.length) throw new Error('Creation stop takes no arguments.');
    await stopCreationProcess(session.directory);
    console.log('Stopped only the verified creation front door. Application services and data are preserved.');
  } else if (command === 'accept') {
    if (rest.length !== 1 || !/^(?:[A-Za-z]:[\\/]|\/)/.test(rest[0])) throw new Error('Provide an absolute nonsecret browser/design evidence JSON file.');
    const source = await inspectSource(home);
    if (!source.ready || !source.build.ready) throw new Error('Acceptance requires a current verified build.');
    const { importCreationAcceptance } = await import('../src/creation-acceptance.mjs');
    const build = await creationBuild(home);
    const accepted = await importCreationAcceptance(home, rest[0], build, session.snapshot.publicOrigin, source.fingerprint);
    await updateCreation(home, value => ({ ...changeBuild(value, build), ...accepted, sequence: value.sequence + 1 }));
    console.log('Acceptance evidence recorded for this build. Ready still requires current live capability verification.');
  } else throw new Error('Unknown creation command. Use creation help.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Creation command failed.'); process.exitCode = 1; });
}
