import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkSetup, inspectDependencies, planInstallation, installReviewed, runSetupCommand } from './setup-check.mjs';
import { inspectSource } from './workspace-check.mjs';
import { main as consentRun } from './local-consent.mjs';
import { planConsent, planBundle, grantBundle } from '../src/local-consent.mjs';
import { readLocalAuthentication, localAuthenticationMatches } from '../src/local-auth.mjs';
import { runtimeFor, proposeWorkspace } from '../src/workspace.mjs';
import { projectHome, toolingHome } from '../src/tooling-context.mjs';

const profiles = ['role-based-data'];

export function parseSetupArguments(args) {
  const [command = 'help', ...rest] = args;
  if (!['help', 'plan', 'status', 'run', 'resume', 'approval', 'approve', 'install-plan', 'install'].includes(command)) throw new Error('Unsupported setup command; run setup help.');
  if (command === 'help') {
    if (rest.length) throw new Error('setup help takes no arguments.');
    return { command, options: {} };
  }
  if (command === 'install' || command === 'install-plan') {
    if (rest.length !== 1 || (command === 'install' ? !isAbsolute(rest[0]) : !['node', 'npm', 'dotnet', 'docker'].includes(rest[0]))) {
      throw new Error('Use install <absolute-reviewed-plan.json> or install-plan <node|npm|dotnet|docker>.');
    }
    return { command, selection: rest[0], options: {} };
  }
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const key = { '--profile': 'profile', '--container': 'container', '--workspace': 'workspace', '--json': 'json', '--approval': 'approval' }[flag];
    if (!key || options[key] !== undefined) throw new Error('Unknown or duplicate setup argument.');
    if (key === 'json') { options.json = true; continue; }
    const value = rest[++i];
    if (key === 'approval') {
      if (command !== 'approve' || !/^[a-f0-9]{12}$/.test(value ?? '')) throw new Error('--approval takes the 12-character id shown by setup approval, only with setup approve.');
      options.approval = value;
      continue;
    }
    if (!value || (key === 'profile' && !profiles.includes(value)) ||
        (key === 'container' && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) ||
        (key === 'workspace' && value !== 'legacy' && !/^\d{5}$/.test(value))) throw new Error('Invalid setup profile, container or workspace selection.');
    if (key === 'workspace' && value !== 'legacy' && (Number(value) < 20000 || Number(value) > 60000 || Number(value) % 10 !== 0)) {
      throw new Error('Workspace port block must be aligned to 10 between 20000 and 60000.');
    }
    options[key] = value;
  }
  options.profile ??= 'role-based-data';
  if (command === 'approval' || command === 'approve') {
    if (options.container) throw new Error(`setup ${command} covers the workspace-owned SQL container only.`);
    if (command === 'approve' && !options.approval) throw new Error('setup approve needs --approval <id> from setup approval.');
  }
  return { command, options };
}

// Uses the existing selection, the requested block, or the free proposed block, so one review needs no extra flags.
async function bundleWorkspace(home, options, injected = {}) {
  if (options.workspace || runtimeFor(undefined, home).mode !== 'legacy-unselected') return options.workspace;
  const proposal = await (injected.propose ?? proposeWorkspace)(home);
  const suggested = proposal.conflicts?.length ? proposal.alternative?.basePort : proposal.descriptor?.basePort;
  if (!suggested) throw new Error('No free isolated port block was found; review occupied ports, then pass --workspace <base-port|legacy>.');
  return String(suggested);
}

export async function planApproval(value, options, injected = {}) {
  const home = await realpath(value);
  const workspace = await bundleWorkspace(home, options, injected);
  return planBundle(home, { profile: options.profile, ...(workspace ? { workspace } : {}) });
}

export function renderApproval(bundle) {
  const command = `--profile ${bundle.profile} --workspace ${bundle.workspace}`;
  if (bundle.allowed) return [`Already approved for ${bundle.profile} in ${bundle.home} (workspace ${bundle.workspace}).`, `Next: setup run ${command}`];
  return [
    `One local approval for ${bundle.profile} in ${bundle.home} (workspace ${bundle.workspace}):`,
    ...bundle.requirements.map(item => `- ${item.scope}${bundle.missing.some(other => other.contract === item.contract) ? '' : ' (already approved)'}: ${item.effects.join(' ')}`),
    ...(bundle.terms.required ? [`- SQL terms (${bundle.terms.acknowledged ? 'already accepted' : 'accepting'}): ${bundle.terms.statement}`] : []),
    'Not included: tool installs, stopping or recovering resources, retention maintenance and anything in Azure.',
    `After explicit approval: setup approve ${command} --approval ${bundle.approval}`,
  ];
}

async function liveWorkspace(runtime, profile, fetcher, sourceFingerprint, authentication) {
  let response;
  try { response = await fetcher(`${runtime.origins.app}/local/workspace`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); }
  catch { return { ready: false, code: 'GATEWAY_UNAVAILABLE' }; }
  if (!response.ok) return { ready: false, conflict: true, code: 'WORKSPACE_ENDPOINT_UNAVAILABLE' };
  let identity;
  try { identity = await response.json(); }
  catch { return { ready: false, conflict: true, code: 'WORKSPACE_IDENTITY_INVALID' }; }
  if (identity?.version !== 1 || identity.id !== runtime.id || identity.mode !== runtime.mode ||
      identity.profile !== profile || identity.origins?.app !== runtime.origins.app || identity.origins?.data !== runtime.origins.data ||
      identity.container !== runtime.sqlContainer || identity.sourceFingerprint !== sourceFingerprint) {
    return { ready: false, conflict: true, code: 'WORKSPACE_IDENTITY_MISMATCH' };
  }
  if (!localAuthenticationMatches(identity.authentication, authentication)) {
    return { ready: false, conflict: true, code: 'WORKSPACE_AUTHENTICATION_MISMATCH' };
  }
  try {
    const ready = await fetcher(`${runtime.origins.app}/health/ready`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    const body = await ready.json();
    const valid = body !== null && typeof body === 'object' && !Array.isArray(body);
    const confirmed = ready.status === 200 && valid && body.status === 'ready';
    const dependency = valid && body.status === 'not-ready' && body.dependency === 'data' ?
      body.dependency : undefined;
    return { reachable: true, ready: confirmed, code: confirmed ? 'WORKSPACE_READY' : 'WORKSPACE_NOT_READY',
      ...(dependency ? { dependency } : {}) };
  } catch { return { reachable: true, ready: false, code: 'WORKSPACE_NOT_READY' }; }
}

export async function planSetup(value, options = {}, injected = {}) {
  options = { ...options, profile: options.profile ?? 'role-based-data' };
  const flags = { profile: '--profile', container: '--container', workspace: '--workspace', json: '--json' };
  const args = ['plan'];
  for (const [key, option] of Object.entries(options)) {
    if (!Object.hasOwn(flags, key)) throw new Error('Unknown setup option.');
    if (key === 'json') {
      if (typeof option !== 'boolean') throw new Error('Invalid setup JSON selection.');
      if (option) args.push(flags[key]);
    } else {
      if (typeof option !== 'string') throw new Error('Invalid setup selection.');
      args.push(flags[key], option);
    }
  }
  parseSetupArguments(args);
  const home = await realpath(value);
  if (options.profile !== undefined && !profiles.includes(options.profile)) throw new Error('Select a supported local setup profile.');
  const source = await (injected.source ?? inspectSource)(home);
  const stages = [];
  const add = (id, status, nextAction, extra = {}) => stages.push({ id, status, nextAction, ...extra });
  const result = { version: 1, home, profile: options.profile ?? null, stages,
    prerequisitesReady: false, gatewayReachable: false, running: false, workflowVerified: false,
    scope: 'Local setup planning/live probes; not installation approval, production authentication or browser/SQL acceptance.' };
  const finish = () => ({ ...result, next: stages.find(stage => stage.status !== 'done') });
  add('checkout', source.ready ? 'done' : 'blocked', source.ready ? 'Intended checkout verified.' : source.nextAction);
  if (!source.ready) return finish();
  add('profile', 'done', 'role-based-data: SQL, Data API builder and the browser gateway. Examples require their separate explicit application workflow.');
  let authentication;
  try { authentication = readLocalAuthentication(injected.environment ?? process.env); }
  catch (error) {
    add('authentication', 'blocked', error instanceof Error ? error.message : 'Local authentication configuration is invalid.',
      { code: 'LOCAL_AUTHENTICATION_INVALID' });
    return finish();
  }
  result.authentication = authentication;
  const runtime = runtimeFor(options.container, home);
  result.workspace = { id: runtime.id, mode: runtime.mode, origins: runtime.origins };
  const live = runtime.mode === 'legacy-unselected' ? { ready: false } : await liveWorkspace(runtime, options.profile, injected.fetch ?? fetch, source.fingerprint, authentication);
  result.gatewayReachable = Boolean(live.reachable);
  if (live.conflict) {
    add('ownership', 'blocked', 'A responding gateway does not match this checkout/workspace/profile/authentication. Inspect it; never stop or replace it automatically.', { code: live.code });
    return finish();
  }
  const proposal = runtime.mode === 'legacy-unselected' ? await proposeWorkspace(home) : undefined;
  const suggested = proposal?.conflicts?.length ? proposal.alternative?.basePort : proposal?.descriptor?.basePort;
  const workspace = options.workspace ?? (suggested ? String(suggested) : undefined);
  const check = await (injected.check ?? checkSetup)({ root: home, profile: options.profile,
    ...(options.container ? { container: options.container } : {}), ...(workspace ? { workspace } : {}) });
  const blockers = check.checks.filter(item => item.required && item.status !== 'ready' &&
    !(live.reachable && item.code === 'EXISTING_GATEWAY_CHECK_OWNERSHIP'));
  result.prerequisitesReady = blockers.length === 0;
  const profileConfig = check.checks.find(item => item.id === 'role-based-config' && item.status !== 'ready');
  add('prerequisites', blockers.length ? 'blocked' : 'done', blockers.length ?
    'Resolve the named checks. Use install-plan only for missing tools; preview access, terms and credentials remain human steps.' : 'Prerequisites checked.',
  { checks: check.checks, blockers });
  const dependencies = await (injected.dependencies ?? inspectDependencies)(home);
  const restore = dependencies.ready || dependencies.probeTimedOut ? undefined : await (injected.consent ?? planConsent)(home, { operation: 'restore' });
  add('restore', dependencies.ready ? 'done' : restore?.allowed ? 'next' : 'blocked',
    dependencies.probeTimedOut ? 'A dependency readiness probe timed out; rerun setup plan before approving or running any restore.' :
      'Restore only unresolved npm/SQL tools after explicit approval; review failed probes before restoring.', { dependencies, ...(restore ? { consent: restore } : {}) });
  const build = source.build.ready ? undefined : await (injected.consent ?? planConsent)(home, { operation: 'build' });
  add('build', source.build.ready ? 'done' : build.allowed ? 'next' : 'blocked',
    'Build only missing/stale source or artifacts after approval.', { code: source.build.code, ...(build ? { consent: build } : {}) });
  if (runtime.mode === 'legacy-unselected') {
    const permission = options.workspace ? await (injected.consent ?? planConsent)(home, { operation: 'workspace-init', selection: options.workspace }) : undefined;
    const approval = selected => `setup approval --profile ${options.profile} --workspace ${selected}`;
    add('workspace', permission?.allowed ? 'next' : 'blocked', options.workspace ?
      `Workspace ${options.workspace} creates only the workspace descriptor. Review ${approval(options.workspace)}: one approval covers restore, build, this workspace, startup and the SQL terms.` :
      `${suggested ? `Proposed isolated port block ${suggested} (free when checked, not reserved). Review ${approval(suggested)} (one approval covers restore, build, this workspace, startup and the SQL terms), then setup run --profile ${options.profile} --workspace ${suggested}` :
        'No free isolated port block was found; review occupied ports, then choose --workspace <base-port>'}, or --workspace legacy to keep an existing legacy stack.`,
      { proposal, ...(permission ? { consent: permission } : {}) });
    add('launch', 'blocked', profileConfig ? `${profileConfig.message} ${profileConfig.nextAction}` :
      `After workspace initialization, app starts under the same setup approval (startup scopes and SQL terms).`,
    profileConfig ? { code: profileConfig.code } : {});
  } else {
    if (options.workspace && (options.workspace !== 'legacy' ? runtime.mode !== 'isolated' || Number(options.workspace) !== runtime.ports.gateway : runtime.mode !== 'legacy')) {
      throw new Error('Requested workspace differs from the existing selection; inspect it without overwriting.');
    }
    add('workspace', 'done', 'Existing workspace selected; ownership still checked before startup.');
    if (live.ready) {
      result.running = true;
      result.launchUrl = runtime.origins.app;
      add('launch', 'done', 'Intended workspace/profile gateway responds as ready; reuse it.');
    } else if (live.reachable) {
      add('launch', 'blocked',
        `The intended gateway is responding but ${live.dependency ?? 'profile'} readiness failed. ` +
        'Inspect the named dependency and its approval before recovery; no automatic restart was performed.',
        { code: 'WORKSPACE_NOT_READY', ...(live.dependency ? { dependency: live.dependency } : {}) });
    } else if (profileConfig) {
      add('launch', 'blocked', `${profileConfig.message} ${profileConfig.nextAction}`, { code: profileConfig.code });
    } else {
      const operation = 'app';
      const permission = await (injected.consent ?? planConsent)(home, { operation,
        ...(options.container ? { selection: options.container } : {}) });
      const review = options.container ? `consent-plan ${operation} ${options.container}` : `setup approval --profile ${options.profile}`;
      add('launch', permission.allowed ? 'next' : 'blocked',
        `Review ${review} for the startup scopes and any required SQL terms. Run only the approved profile; changed launcher effects require renewed review.`,
        { consent: permission, code: live.code });
    }
  }
  add('acceptance', 'blocked', 'Verify an actual browser action and SQL save/reload, then one useful change. Record exact evidence through guide; a launch URL is not workflow acceptance.');
  return finish();
}

export async function launchSetup(home, operation, container, runtime, profile, fetcher, injected = {}) {
  const source = await (injected.source ?? inspectSource)(home);
  if (!source.ready || !source.build.ready) throw new Error('Local startup requires verified current build provenance.');
  const environment = injected.environment ?? process.env;
  const authentication = readLocalAuthentication(environment);
  const tools = source.toolingHome ?? home;
  const childEnvironment = source.toolingHome
    ? { ...environment, SQL_APPS_PROJECT_HOME: home, SQL_APPS_TOOLING_HOME: tools }
    : environment;
  const child = (injected.spawn ?? spawn)(process.execPath, [join(tools, 'dist', 'src', 'local-cli.js'), operation, ...(container ? [container] : [])],
    { cwd: home, shell: false, windowsHide: true, stdio: ['inherit', 2, 2],
      env: childEnvironment });
  let stopped = false;
  const completion = new Promise((done, reject) => {
    child.once('error', error => { stopped = true; reject(error); });
    child.once('close', (code, signal) => {
      stopped = true;
      if (code !== 0 && !signal) reject(new Error(`Local startup exited (${code}); inspect its named stage.`));
      else done();
    });
  });
  // Observe startup failures while waiting for HTTP readiness without unhandled rejections.
  completion.catch(() => {});
  const interrupt = () => { child.kill('SIGINT'); };
  const terminate = () => { child.kill('SIGTERM'); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  completion.finally(() => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }).catch(() => {});
  const stop = async () => {
    if (!stopped) child.kill('SIGTERM');
    await completion;
  };
  const now = injected.now ?? Date.now;
  const deadline = now() + 300_000;
  while (now() < deadline && !stopped) {
    const live = await liveWorkspace(runtime, profile, fetcher, source.fingerprint, authentication);
    if (live.ready) return { completion, stop };
    if (live.conflict) {
      await stop();
      throw new Error('Gateway identity changed during startup; no launch URL is published. Inspect owned resources.');
    }
    await (injected.wait ?? (() => new Promise(done => setTimeout(done, 1000))))();
  }
  if (stopped) { await completion; throw new Error('Local startup stopped before readiness.'); }
  await stop();
  throw new Error('Local startup did not become ready within the bounded wait. Preserve data and inspect its stage before resuming.');
}

export async function runSetup(home, options, injected = {}) {
  const execute = injected.execute ?? runSetupCommand;
  let previous;
  for (let attempt = 0; attempt < 6; attempt++) {
    const report = await planSetup(home, options, injected);
    if (report.gatewayReachable && !report.running) return report;
    if (report.next.status !== 'next') return report;
    const stage = report.next;
    if (previous === stage.id) return { ...report, next: { ...stage, status: 'blocked',
      nextAction: 'The completed command did not establish readiness. Inspect its output before retrying; no automatic repeat was performed.' } };
    previous = stage.id;
    (injected.progress ?? (message => console.error(message)))(`Working: ${stage.id}. Completed work/data is preserved if this stage fails.`);
    let started;
    try {
      if (stage.id === 'launch') {
        const runtime = runtimeFor(options.container, home);
        const operation = 'app';
        started = await (injected.launch ?? launchSetup)(home, operation, options.container, runtime, options.profile, injected.fetch ?? fetch,
          injected.environment === undefined ? {} : { environment: injected.environment });
        const after = await planSetup(home, options, injected);
        if (!after.running) throw new Error('Started process did not verify the selected gateway.');
        return { ...after, completion: started.completion };
      }
      await consentRun(['run', stage.consent.request.operation, ...(stage.consent.request.selection ? [stage.consent.request.selection] : [])], home,
        async (file, args, cwd) => {
          if (stage.id === 'restore' && (args.includes('ci') && stage.dependencies.npmReady ||
              file === 'dotnet' && stage.dependencies.sqlToolsReady)) return;
          await execute(file, args, cwd);
        });
    } catch (error) {
      if (started) await started.stop();
      return { ...report, next: { ...stage, status: 'blocked', code: 'SETUP_STAGE_FAILED',
        nextAction: `Setup stopped at ${stage.id}. Review safe process output and its approvals, preserve resources and run resume after fixing the cause.`,
        diagnostic: error instanceof Error ? error.name : 'UnknownError' } };
    }
  }
  throw new Error('Setup reached its bounded continuation limit; inspect status before retrying.');
}

export function renderSetup(report) {
  const describe = stage => {
    const failing = [...(stage.blockers ?? []), ...(stage.dependencies?.checks ?? []).filter(check => !check.ready)]
      .map(check => `${check.id} (${check.code})`);
    const missing = (stage.consent?.missing ?? []).map(item => item.scope);
    if (stage.consent?.termsRequired && !stage.consent.termsAcknowledged) missing.push('SQL terms acknowledgement');
    const request = stage.consent?.request;
    const workspace = request?.operation === 'workspace-init' ? ` --workspace ${request.selection}` : '';
    const external = request?.selection && request.operation !== 'workspace-init';
    const review = report.profile && !external ? `setup approval --profile ${report.profile}${workspace}` :
      `consent-plan ${request?.operation}${request?.selection ? ` ${request.selection}` : ''}`;
    const approval = missing.length ? ` Needs approval: ${missing.join(', ')}; review ${review} first.` : '';
    return `${stage.id}${stage.code ? ` (${stage.code})` : ''} - ${stage.nextAction}${failing.length ? ` Failing: ${failing.join(', ')}.` : ''}${approval}`;
  };
  const lines = report.stages.map(stage => stage.status === 'done' ? `Done: ${stage.id}` :
    `${stage.status === 'blocked' ? 'Blocked' : 'Next'}: ${describe(stage)}`);
  if (report.launchUrl) lines.push(`Running: ${report.launchUrl}; browser/SQL workflow verification is still required.`);
  if (report.next) lines.push(`Next: ${report.next.id ? describe(report.next) : report.next.nextAction}`);
  return lines;
}

export async function main(args = process.argv.slice(2), home) {
  if (home === undefined) {
    try { home = await projectHome(); }
    catch (error) {
      const tools = await toolingHome(import.meta.url);
      if (error.code !== 'PROJECT_NOT_FOUND' || tools !== resolve(join(import.meta.dirname, '..'))) throw error;
      home = process.cwd();
    }
  }
  const { command, options, selection } = parseSetupArguments(args);
  if (command === 'help') {
    console.log('SQL Apps setup: plan|status|run|resume [--profile role-based-data] [--workspace <base-port|legacy>] [--container <name>] [--json]');
    console.log('One local approval: approval --profile <profile> [--workspace <base-port|legacy>] lists restore, build, workspace, startup and SQL terms; approve ... --approval <id> records it after explicit human approval.');
    console.log('External SQL selection uses the individual consent-plan/grant workflow for that container; the setup approval bundle covers only workspace-owned SQL.');
    console.log('Installation: install-plan <node|npm|dotnet|docker> | install <absolute-reviewed-plan.json>. Execute only after explicit human approval. No cloud operations.');
    return;
  }
  if (command === 'approval' || command === 'approve') {
    const bundle = await planApproval(home, options);
    if (command === 'approve') {
      await grantBundle(bundle.home, { profile: options.profile, workspace: bundle.workspace, approval: options.approval });
      const recorded = await planApproval(home, { ...options, workspace: bundle.workspace });
      if (options.json) console.log(JSON.stringify(recorded, null, 2));
      else console.log(`Recorded one local approval for ${recorded.profile} (workspace ${recorded.workspace}). Next: setup run --profile ${recorded.profile} --workspace ${recorded.workspace}`);
      if (!recorded.allowed) process.exitCode = 1;
      return;
    }
    if (options.json) console.log(JSON.stringify(bundle, null, 2));
    else for (const line of renderApproval(bundle)) console.log(line);
    return;
  }
  let report;
  if (command === 'install-plan') report = await planInstallation(home, selection);
  else if (command === 'install') report = await installReviewed(selection, home);
  else report = await (command === 'run' || command === 'resume' ? runSetup : planSetup)(home, options);
  const { completion, ...output } = report;
  if (options.json || command.startsWith('install')) console.log(JSON.stringify(output, null, 2));
  else for (const line of renderSetup(report)) console.log(line);
  if (report.outcome ? report.outcome !== 'ready' : !report.running) process.exitCode = 1;
  if (completion) await completion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    if (process.argv.includes('--json')) console.log(JSON.stringify({ version: 1, running: false, workflowVerified: false,
      error: { code: 'SETUP_FAILED', nextAction: 'Review setup arguments, checkout manifests and permissions. No successful setup is claimed.' } }));
    else console.error(error instanceof Error ? error.message : 'Setup failed; inspect the selected checkout.');
    process.exitCode = 1;
  });
}
