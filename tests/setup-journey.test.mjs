import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeFor, initializeWorkspace } from '../src/workspace.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { planConsent, grantConsent } from '../src/local-consent.mjs';
import { checkSetup } from '../scripts/setup-check.mjs';
import { sqlTargetFingerprint } from '../src/sql-target.mjs';

let setup;
try { setup = await import('../scripts/setup.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

async function fixture(t, selected = true) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-journey-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (selected) await initializeWorkspace(home, 30000, async () => 'free');
  return {
    home,
    options: { profile: 'role-based-data' },
    deps: {
      environment: { ...process.env, NODE_ENV: 'test', SQL_APPS_LOCAL_AUTH: 'preview' },
      source: async () => ({ ready: true, fingerprint: 'fixture-build', build: { ready: true, code: 'BUILD_CURRENT' } }),
      check: async () => ({ ready: true, checks: [] }),
      dependencies: async () => ({ ready: true, npmReady: true, sqlToolsReady: true }),
      consent: async (_, request) => ({ allowed: false, request, requirements: [{ scope: 'services' }], missing: ['services'] }),
      fetch: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); },
    },
  };
}

test('a dependency-free coordinator exposes planning and guarded execution', () => {
  assert.equal(typeof setup?.planSetup, 'function');
  assert.equal(typeof setup?.runSetup, 'function');
});

test('endpoint gateway reuse requires the actual selected provider and target fingerprint', async t => {
  const { home, deps, options } = await fixture(t);
  const runtime = runtimeFor(undefined, home);
  const target = { version: 1, provider: 'express', instance: 'SQLEXPRESS', server: '127.0.0.1', port: 1433, database: 'development' };
  await writeFile(join(home, '.sql-apps', 'sql-target.json'), JSON.stringify({ version: 1, home, target }));
  const identity = { version: 1, id: runtime.id, mode: runtime.mode, profile: options.profile, origins: runtime.origins,
    container: runtime.defaultSql, sourceFingerprint: 'fixture-build', authentication: { mode: 'preview' } };
  const response = value => async url => Response.json(String(url).endsWith('/local/workspace') ? value : { status: 'ready' });
  for (const value of [identity, { ...identity, sqlProvider: 'express', sqlTargetFingerprint: 'wrong' }]) {
    const report = await setup.planSetup(home, options, { ...deps, fetch: response(value) });
    assert.equal(report.running, false);
    assert.equal(report.next.code, 'WORKSPACE_SQL_TARGET_MISMATCH');
  }
  const report = await setup.planSetup(home, options, { ...deps,
    fetch: response({ ...identity, sqlProvider: 'express', sqlTargetFingerprint: sqlTargetFingerprint(target) }) });
  assert.equal(report.running, true);
});

test('prerequisites ready never means workspace selected or launch approved', async t => {
  const { home, deps, options } = await fixture(t, false);
  const report = await setup.planSetup(home, options, deps);
  assert.equal(report.prerequisitesReady, true);
  assert.equal(report.running, false);
  assert.equal(report.launchUrl, undefined);
  assert.equal(report.next.id, 'workspace');
  assert.equal(report.next.status, 'blocked');
  assert.match(report.next.nextAction, /workspace/);
  const { proposal } = report.next;
  const suggested = proposal.conflicts.length ? proposal.alternative.basePort : proposal.descriptor.basePort;
  assert.match(report.next.nextAction, new RegExp(`--workspace ${suggested}\\b`));
  assert.match(report.next.nextAction, new RegExp(`setup approval --profile role-based-data --workspace ${suggested}\\b`));
  assert.match(report.next.nextAction, new RegExp(`setup run --profile role-based-data --workspace ${suggested}\\b`));
  assert.doesNotMatch(report.next.nextAction, /workspace-plan/, 'workspace-plan needs a current build; setup must be usable before it');
  const launch = report.stages.find(stage => stage.id === 'launch');
  assert.match(launch.nextAction, new RegExp(`app starts under the same setup approval`), 'the launch stage must say the startup is covered by the one approval');
});

test('a missing role-based configuration blocks launch with guidance instead of crashing consent planning', async t => {
  for (const selected of [true, false]) {
    const { home, deps, options } = await fixture(t, selected);
    const requested = [];
    const consent = deps.consent;
    deps.consent = async (h, request) => { requested.push(request.operation); return consent(h, request); };
    deps.check = async () => ({ ready: true, checks: [{ id: 'role-based-config', status: 'action-required', required: false,
      code: 'ROLE_BASED_CONFIG_MISSING', message: 'role-based-data.json is not configured yet.', nextAction: 'Copy role-based-data.example.json to role-based-data.json.' }] });
    const report = await setup.planSetup(home, options, deps);
    const launch = report.stages.find(stage => stage.id === 'launch');
    assert.equal(launch.status, 'blocked');
    assert.equal(launch.code, 'ROLE_BASED_CONFIG_MISSING');
    assert.match(launch.nextAction, /^role-based-data\.json is not configured yet\. .*role-based-data\.example\.json/);
    assert.equal(requested.includes('app'), false, 'startup consent must not be planned without the profile configuration');
    assert.equal(report.stages.find(stage => stage.id === 'prerequisites').status, 'done');
  }
});

test('setup execution refuses missing grants before spawning or writing workspace state', async t => {
  const { home, deps, options } = await fixture(t);
  let called = false;
  const result = await setup.runSetup(home, options, { ...deps, execute: async () => { called = true; } });
  assert.equal(result.next.id, 'launch');
  assert.equal(result.next.status, 'blocked');
  assert.equal(called, false);
});

test('an intended ready gateway is reused without install, restore, build or launch', async t => {
  const { home, deps, options } = await fixture(t);
  const runtime = runtimeFor(undefined, home);
  let calls = 0;
  const result = await setup.runSetup(home, options, {
    ...deps,
    fetch: async url => new Response(JSON.stringify(String(url).endsWith('/local/workspace') ?
      { version: 1, id: runtime.id, mode: runtime.mode, profile: options.profile, origins: runtime.origins,
        container: runtime.defaultSql, sourceFingerprint: 'fixture-build', authentication: { mode: 'preview' } } : { status: 'ready' })),
    execute: async () => { calls++; },
    launch: async () => { calls++; },
  });
  assert.equal(result.running, true);
  assert.equal(result.launchUrl, runtime.origins.app);
  assert.equal(result.workflowVerified, false);
  assert.equal(result.next.id, 'acceptance');
  assert.equal(calls, 0);
});

test('setup refuses a gateway with wrong authentication and never replaces it', async t => {
  const { home, deps, options } = await fixture(t);
  const runtime = runtimeFor(undefined, home);
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const clientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const environment = { ...process.env, NODE_ENV: 'test', SQL_APPS_LOCAL_AUTH: 'entra',
    AZURE_TENANT_ID: tenantId, API_CLIENT_ID: clientId };
  let launches = 0;
  for (const authentication of [
    { mode: 'preview' },
    { mode: 'entra', tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', clientId },
    { mode: 'entra', tenantId, clientId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    undefined,
  ]) {
    let healthReads = 0;
    const result = await setup.runSetup(home, options, {
      ...deps, environment,
      fetch: async url => {
        if (String(url).endsWith('/local/workspace')) return Response.json({
          version: 1, id: runtime.id, mode: runtime.mode, profile: options.profile, origins: runtime.origins,
          container: runtime.sqlContainer, sourceFingerprint: 'fixture-build', authentication,
        });
        healthReads++;
        return Response.json({ status: 'ready' });
      },
      launch: async () => { launches++; },
    });
    assert.equal(result.running, false);
    assert.equal(result.launchUrl, undefined);
    assert.equal(result.next.id, 'ownership');
    assert.equal(result.next.code, 'WORKSPACE_AUTHENTICATION_MISMATCH');
    assert.equal(healthReads, 0, 'authentication must match before any health probe');
  }
  assert.equal(launches, 0);
  const authentication = { mode: 'entra', tenantId, clientId };
  const matching = await setup.planSetup(home, options, {
    ...deps, environment,
    fetch: async url => Response.json(String(url).endsWith('/local/workspace') ? {
      version: 1, id: runtime.id, mode: runtime.mode, profile: options.profile, origins: runtime.origins,
      container: runtime.sqlContainer, sourceFingerprint: 'fixture-build', authentication,
    } : { status: 'ready' }),
  });
  assert.equal(matching.running, true);
  assert.equal(matching.launchUrl, runtime.origins.app);
  assert.deepEqual(matching.authentication, authentication);
});

test('setup reports invalid real-auth before launch effects', async t => {
  const { home, deps, options } = await fixture(t);
  let launches = 0;
  let probes = 0;
  let executions = 0;
  for (const environment of [
    { NODE_ENV: 'test', SQL_APPS_LOCAL_AUTH: 'entra' },
    { NODE_ENV: 'test', SQL_APPS_LOCAL_AUTH: 'invalid' },
    { NODE_ENV: 'production', SQL_APPS_LOCAL_AUTH: 'preview' },
  ]) {
    const result = await setup.runSetup(home, options, {
      ...deps, environment,
      fetch: async () => { probes++; return Response.json({ status: 'ready' }); },
      execute: async () => { executions++; },
      launch: async () => { launches++; },
    });
    assert.equal(result.running, false);
    assert.equal(result.launchUrl, undefined);
    assert.equal(result.next.id, 'authentication');
    assert.equal(result.next.status, 'blocked');
    assert.equal(result.next.code, 'LOCAL_AUTHENTICATION_INVALID');
    assert.equal(result.authentication, undefined);
  }
  assert.equal(launches, 0);
  assert.equal(probes, 0);
  assert.equal(executions, 0);
});

test('setup passes its reviewed authentication environment to the attached launcher', async t => {
  const { home, deps, options } = await fixture(t);
  const runtime = runtimeFor(undefined, home);
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const clientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const environment = { ...process.env, NODE_ENV: 'test', SQL_APPS_LOCAL_AUTH: 'entra',
    AZURE_TENANT_ID: tenantId, API_CLIENT_ID: clientId };
  const authentication = { mode: 'entra', tenantId, clientId };
  let launched = false;
  const result = await setup.runSetup(home, options, {
    ...deps, environment,
    consent: async (_, request) => ({ allowed: true, request }),
    fetch: async url => {
      if (!launched) throw new Error('offline');
      return Response.json(String(url).endsWith('/local/workspace') ? {
        version: 1, id: runtime.id, mode: runtime.mode, profile: options.profile, origins: runtime.origins,
        container: runtime.sqlContainer, sourceFingerprint: 'fixture-build', authentication,
      } : { status: 'ready' });
    },
    launch: async (root, operation, container, selected, profile, fetcher, injected) => {
      assert.equal(root, home);
      assert.equal(operation, 'app');
      assert.equal(container, undefined);
      assert.equal(selected.id, runtime.id);
      assert.equal(profile, options.profile);
      assert.equal(typeof fetcher, 'function');
      assert.ok(injected?.environment === environment, 'the reviewed environment must reach the attached launcher unchanged');
      launched = true;
      return { completion: Promise.resolve(), stop: async () => {} };
    },
    progress: () => {},
  });
  assert.equal(launched, true);
  assert.equal(result.running, true);
  assert.deepEqual(result.authentication, authentication);
  await result.completion;
});

test('setup reuses the explicitly selected external SQL container without launching another process', async t => {
  const { home, deps, options } = await fixture(t);
  const runtime = runtimeFor('external-sql', home);
  let launches = 0;
  const report = await setup.runSetup(home, { ...options, container: runtime.sqlContainer }, {
    ...deps,
    fetch: async url => Response.json(String(url).endsWith('/local/workspace') ? {
      version: 1, id: runtime.id, mode: runtime.mode, origins: runtime.origins, profile: options.profile,
      container: runtime.sqlContainer, sourceFingerprint: 'fixture-build', authentication: { mode: 'preview' },
    } : { status: 'ready' }),
    launch: async () => { launches++; },
  });
  assert.equal(report.running, true);
  assert.equal(report.launchUrl, runtime.origins.app);
  assert.equal(report.next.id, 'acceptance');
  assert.equal(launches, 0);
});

for (const health of [
  { name: 'absent worker', status: 503, body: { status: 'not-ready', dependency: 'data' } },
  { name: 'contradictory success', status: 200, body: { status: 'not-ready', dependency: 'data' } },
  { name: 'arbitrary success JSON', status: 200, body: {} },
  { name: 'wrong readiness state', status: 200, body: { status: 'live' } },
  { name: 'malformed JSON', status: 200, body: 'not-json' },
]) {
  test(`matching unready gateway (${health.name}) is blocked without automatic relaunch`, async t => {
    const { home, deps } = await fixture(t);
    const runtime = runtimeFor(undefined, home);
    let executions = 0;
    let launches = 0;
    const report = await setup.runSetup(home, { profile: 'role-based-data' }, {
      ...deps,
      check: async () => ({ checks: [{ required: true, status: 'action-required', code: 'EXISTING_GATEWAY_CHECK_OWNERSHIP' }] }),
      consent: async (_, request) => ({ allowed: true, request }),
      fetch: async url => String(url).endsWith('/local/workspace')
        ? Response.json({ version: 1, id: runtime.id, mode: runtime.mode, origins: runtime.origins,
          profile: 'role-based-data', container: runtime.sqlContainer, sourceFingerprint: 'fixture-build', authentication: { mode: 'preview' } })
        : typeof health.body === 'string' ? new Response(health.body, { status: health.status })
          : Response.json(health.body, { status: health.status }),
      execute: async () => { executions++; },
      launch: async () => { launches++; throw new Error('must not relaunch'); },
      progress: () => {},
    });
    assert.equal(report.gatewayReachable, true);
    assert.equal(report.prerequisitesReady, true);
    assert.equal(report.running, false);
    assert.equal(report.launchUrl, undefined);
    assert.equal(report.workflowVerified, false);
    assert.equal(report.next.id, 'launch');
    assert.equal(report.next.code, 'WORKSPACE_NOT_READY');
    assert.equal(executions, 0);
    assert.equal(launches, 0);
    const output = setup.renderSetup(report).join('\n');
    assert.doesNotMatch(output, /Done: launch|Running:/);
    if (typeof health.body === 'object' && health.body.dependency) {
      assert.match(output, new RegExp(health.body.dependency));
    }
  });
}

test('a reachable unready gateway does not trigger restores or builds before its blocked launch', async t => {
  const { home, deps } = await fixture(t);
  const runtime = runtimeFor(undefined, home);
  let commands = 0;
  const report = await setup.runSetup(home, { profile: 'role-based-data' }, {
    ...deps,
    source: async () => ({ ready: true, fingerprint: 'fixture-build', build: { ready: false, code: 'BUILD_UNVERIFIED' } }),
    dependencies: async () => ({ ready: false }),
    consent: async (_, request) => ({ allowed: true, request }),
    fetch: async url => String(url).endsWith('/local/workspace')
      ? Response.json({ version: 1, id: runtime.id, mode: runtime.mode, origins: runtime.origins,
        profile: 'role-based-data', container: runtime.sqlContainer, sourceFingerprint: 'fixture-build', authentication: { mode: 'preview' } })
      : Response.json({ status: 'not-ready', dependency: 'data' }, { status: 503 }),
    execute: async () => { commands++; },
    progress: () => {},
  });
  assert.equal(report.gatewayReachable, true);
  assert.equal(commands, 0);
  assert.equal(report.next.id, 'restore');
  assert.equal(report.stages.find(stage => stage.id === 'launch').code, 'WORKSPACE_NOT_READY');
});

test('readiness recovery reuses the same matching gateway without another startup', async t => {
  const { home, deps, options } = await fixture(t);
  const runtime = runtimeFor(undefined, home);
  let ready = false;
  let launches = 0;
  const injected = {
    ...deps,
    fetch: async url => String(url).endsWith('/local/workspace')
      ? Response.json({ version: 1, id: runtime.id, mode: runtime.mode, origins: runtime.origins,
        profile: options.profile, container: runtime.sqlContainer, sourceFingerprint: 'fixture-build', authentication: { mode: 'preview' } })
      : Response.json(ready ? { status: 'ready' } : { status: 'not-ready', dependency: 'data' },
        { status: ready ? 200 : 503 }),
    launch: async () => { launches++; },
  };
  const before = await setup.planSetup(home, options, injected);
  assert.equal(before.launchUrl, undefined);
  assert.equal(before.next.code, 'WORKSPACE_NOT_READY');
  ready = true;
  const after = await setup.runSetup(home, options, injected);
  assert.equal(after.running, true);
  assert.equal(after.launchUrl, runtime.origins.app);
  assert.equal(launches, 0);
});

test('external SQL startup guidance reviews the selected target instead of the owned-container bundle', async t => {
  const { home, deps, options } = await fixture(t);
  const report = await setup.planSetup(home, { ...options, container: 'external-sql' }, deps);
  const text = setup.renderSetup(report).join('\n');
  assert.match(text, /consent-plan app external-sql/);
  assert.doesNotMatch(text, /setup approval --profile/, 'the setup bundle cannot approve external SQL selection');
});

test('first setup uses the proposed or explicit isolated ports while the legacy gateway is occupied', async t => {
  for (const workspace of [undefined, '30000']) {
    const { home, deps, options } = await fixture(t, false);
    const checked = [];
    const report = await setup.planSetup(home, { ...options, ...(workspace ? { workspace } : {}) }, {
      ...deps,
      check: options => checkSetup(options, {
        platform: 'win32', architecture: 'x64', nodeVersion: '22.22.2', memoryBytes: 8 * 1024 ** 3,
        exists: async () => true,
        read: async path => path.endsWith('package.json') ?
          '{"name":"sql-apps","engines":{"node":">=22 <23 || >=24 <25"}}' :
          path.endsWith('local.ts') ? "const sqlImage = 'fixture.invalid/sql:v1';" :
          Promise.reject(Object.assign(new Error('missing configuration'), { code: 'ENOENT' })),
        port: async port => { checked.push(port); return port === 18080 ? 'occupied' : 'free'; },
        fetch: async () => Response.json({ status: 'live' }),
        run: async (command, args) => command === 'npm' ? '10.9.4' :
          command === 'dotnet' ? args[0] === '--list-sdks' ? '8.0.421 [SDK]' : '8.0.421' :
          args[0] === '--version' ? 'Docker version 28.0.0' :
          args[0] === 'info' ? '{"OSType":"linux","Architecture":"x86_64","MemTotal":8589934592}' :
          args[0] === 'image' ? '[{"Architecture":"amd64","Os":"linux"}]' : '',
      }),
    });
    assert.equal(report.prerequisitesReady, true);
    assert.equal(report.next.id, 'workspace');
    const selected = workspace ? Number(workspace) :
      report.next.proposal.conflicts.length ? report.next.proposal.alternative.basePort : report.next.proposal.descriptor.basePort;
    assert.deepEqual(checked, [selected, selected + 1]);
    await assert.rejects(readFile(join(home, '.sql-apps', 'workspace.json')), { code: 'ENOENT' });
  }
});

test('a responding gateway with another identity is a blocker, never a usable launch URL', async t => {
  const { home, deps, options } = await fixture(t);
  const result = await setup.planSetup(home, options, {
    ...deps, fetch: async () => new Response(JSON.stringify({ version: 1, id: 'another-app' })),
  });

  assert.equal(result.running, false);
  assert.equal(result.launchUrl, undefined);
  assert.equal(result.next.id, 'ownership');
  assert.equal(result.next.status, 'blocked');
});

test('a matching workspace cannot reuse another SQL container or an older running build', async t => {
  const { home, deps, options } = await fixture(t);
  const runtime = runtimeFor(undefined, home);
  for (const changed of [{ container: 'foreign-sql' }, { sourceFingerprint: 'older-build' }]) {
    const report = await setup.planSetup(home, options, {
      ...deps, fetch: async () => new Response(JSON.stringify({
        version: 1, id: runtime.id, mode: runtime.mode, profile: options.profile, origins: runtime.origins,
        container: runtime.defaultSql, sourceFingerprint: 'fixture-build', authentication: { mode: 'preview' }, ...changed,
      })),
    });
    assert.equal(report.next.id, 'ownership');
    assert.equal(report.running, false);
  }
});

test('setup requires explicit supported capability profile and rejects cloud or malformed arguments', () => {
  assert.deepEqual(setup.parseSetupArguments(['plan', '--profile', 'role-based-data', '--json']),
    { command: 'plan', options: { profile: 'role-based-data', json: true } });
  assert.throws(() => setup.parseSetupArguments(['run', '--profile', 'cloud']));
  assert.throws(() => setup.parseSetupArguments(['run', '--profile', 'role-based-data', '--profile', 'role-based-data']));
  assert.throws(() => setup.parseSetupArguments(['install', 'relative.json']));
});

test('resuming with the same explicit isolated port block preserves its selection', async t => {
  const { home, deps, options } = await fixture(t);
  const report = await setup.planSetup(home, { ...options, workspace: '30000' }, deps);
  assert.equal(report.workspace.mode, 'isolated');
  assert.equal(report.next.id, 'launch');
  await assert.rejects(setup.planSetup(home, { ...options, workspace: '30010' }, deps), /differs/);
});

test('JSON mode returns a bounded failure envelope for invalid input', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/setup.mjs'), 'run', '--profile', 'invalid', '--json'],
    { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'SETUP_FAILED');
});

test('setup commands, CI and entry guidance consistently expose the guarded journey', async () => {
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(pkg.scripts.setup, 'node scripts/setup.mjs');
  for (const name of ['setup-install.test.mjs', 'setup-journey.test.mjs']) {
    assert.ok(pkg.scripts.test.includes(name));
    assert.ok((await readFile(resolve('.github/workflows/azure-native-ci.yml'), 'utf8')).includes(name));
  }
  for (const file of ['content/start.md', 'plugins/sql-apps/skills/sql-apps-local/SKILL.md',
    'docs/guides/getting-started.md']) {
    assert.match(await readFile(resolve(file), 'utf8'), /setup.*plan|plan.*setup/i);
  }
  assert.match(await readFile(resolve('skills/sql-apps-getting-started/SKILL.md'), 'utf8'), /`sql-apps-local`: prerequisites/);
});

test('post-launch verification failure stops the attached child before reporting a blocker', async t => {
  const { home, deps, options } = await fixture(t);
  let stopped = false;
  const result = await setup.runSetup(home, options, {
    ...deps,
    consent: async (_, request) => ({ allowed: true, request }),
    launch: async () => ({ completion: Promise.resolve(), stop: async () => { stopped = true; } }),
    progress: () => {},
  });
  assert.equal(result.next.code, 'SETUP_STAGE_FAILED');
  assert.equal(stopped, true);
});

test('public setup planning rejects unsupported options before probing or selecting resources', async t => {
  const { home, deps } = await fixture(t);
  await assert.rejects(setup.planSetup(home, { profile: 'role-based-data', container: '--invalid' }, deps), /Invalid/);
  await assert.rejects(setup.planSetup(home, { profile: 'role-based-data', workspace: '30001' }, deps), /aligned/);
  await assert.rejects(setup.planSetup(home, { profile: 'role-based-data', deploy: true }, deps), /Unknown/);
});

test('approved restore and build re-plan readiness and skip already verified npm dependencies', async t => {
  const { home, deps, options } = await fixture(t);
  await mkdir(join(home, '.config'));
  await mkdir(join(home, 'scripts'));
  for (const name of ['package.json', 'package-lock.json', '.config/dotnet-tools.json', 'tsconfig.runtime.json']) {
    await writeFile(join(home, name), '{}');
  }
  await writeFile(join(home, 'scripts', 'build-provenance.mjs'), '// fixture');
  for (const operation of ['restore', 'build']) await grantConsent(home, await planConsent(home, { operation }));
  let restored = false;
  let built = false;
  const calls = [];
  const report = await setup.runSetup(home, options, {
    ...deps,
    source: async () => ({ ready: true, fingerprint: 'fixture-build', build: { ready: built, code: 'FIXTURE' } }),
    dependencies: async () => ({ ready: restored, npmReady: true, sqlToolsReady: restored }),
    consent: async (root, request) => ['restore', 'build'].includes(request.operation) ?
      planConsent(root, request) : deps.consent(root, request),
    execute: async (file, args) => {
      calls.push([file, args]);
      if (file === 'dotnet') restored = true;
      else built = true;
    },
    progress: () => {},
  });
  assert.equal(report.next.id, 'launch');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['dotnet', ['tool', 'restore']]);
  assert.equal(calls[1][0], process.execPath);
  assert.equal(calls.flat(2).includes('ci'), false);
});

test('foundation bootstrap stops after restore so the installed tooling is reviewed before build', async t => {
  const { home, deps, options } = await fixture(t);
  for (const name of ['package.json', 'package-lock.json', '.config/dotnet-tools.json', 'tsconfig.runtime.json', 'scripts/build-provenance.mjs']) {
    await mkdir(join(home, name, '..'), { recursive: true });
    await writeFile(join(home, name), '{}');
  }
  for (const operation of ['restore', 'build']) await grantConsent(home, await planConsent(home, { operation }));
  let restored = false;
  const calls = [];
  const report = await setup.runSetup(home, options, {
    ...deps,
    source: async () => ({ ready: true, bootstrap: !restored, fingerprint: 'fixture-build',
      build: { ready: false, code: 'BUILD_UNVERIFIED' } }),
    dependencies: async () => ({ ready: restored, npmReady: true, sqlToolsReady: restored }),
    consent: async (root, request) => ['restore', 'build'].includes(request.operation) ?
      planConsent(root, request) : deps.consent(root, request),
    execute: async (file, args) => { calls.push([file, args]); restored = true; },
    progress: () => {},
  });
  assert.equal(calls.length, 1, 'bootstrap must not run a foundation build after installing the project package');
  assert.equal(report.next.id, 'build');
  assert.equal(report.next.status, 'blocked');
  assert.equal(report.next.code, 'TOOLING_RESTORED');
});

test('a timed-out dependency probe blocks restore instead of running npm ci under an existing grant', async t => {
  const { home, deps, options } = await fixture(t);
  const calls = [];
  const report = await setup.runSetup(home, options, {
    ...deps,
    dependencies: async () => ({ ready: false, npmReady: false, sqlToolsReady: true, probeTimedOut: true,
      checks: [{ id: 'npm-tree', ready: false, code: 'NPM_TREE_PROBE_TIMEOUT' }] }),
    consent: async (_, request) => ({ allowed: true, request }),
    execute: async (file, args) => { calls.push([file, args]); },
    progress: () => {},
  });
  assert.equal(report.next.id, 'restore');
  assert.equal(report.next.status, 'blocked');
  assert.match(report.next.nextAction, /timed out/);
  assert.deepEqual(calls, []);
});

test('human setup output states completed results and names the checks behind a blocker', () => {
  assert.equal(typeof setup.renderSetup, 'function');
  const lines = setup.renderSetup({ running: false, stages: [
    { id: 'build', status: 'done', nextAction: 'Build only missing/stale source or artifacts after approval.' },
    { id: 'prerequisites', status: 'blocked', nextAction: 'Resolve the named checks.', blockers: [{ id: 'docker-engine', code: 'DOCKER_ENGINE_UNAVAILABLE' }] },
    { id: 'restore', status: 'blocked', nextAction: 'Restore only unresolved npm/SQL tools.',
      dependencies: { checks: [{ id: 'fastify', ready: true }, { id: 'npm-tree', ready: false, code: 'NPM_TREE_PROBE_TIMEOUT' }] } },
  ], next: { nextAction: 'Resolve the named checks.' } });
  assert.equal(lines[0], 'Done: build');
  assert.match(lines[1], /docker-engine \(DOCKER_ENGINE_UNAVAILABLE\)/);
  assert.match(lines[2], /npm-tree \(NPM_TREE_PROBE_TIMEOUT\)/);
  assert.doesNotMatch(lines[2], /fastify/);
  const [build] = setup.renderSetup({ stages: [{ id: 'build', status: 'blocked', code: 'BUILD_SOURCE_MISMATCH',
    nextAction: 'Build only missing/stale source or artifacts after approval.',
    consent: { request: { operation: 'build' }, missing: [{ scope: 'build' }], termsRequired: false, termsAcknowledged: false } }] });
  assert.match(build, /BUILD_SOURCE_MISMATCH/);
  assert.match(build, /Needs approval: build/);
  assert.match(build, /consent-plan build/);
  const workspace = { id: 'workspace', status: 'blocked', nextAction: 'Workspace 21240 creates only the workspace descriptor.',
    consent: { request: { operation: 'workspace-init', selection: '21240' }, missing: [{ scope: 'workspace' }] } };
  const summary = setup.renderSetup({ stages: [workspace], next: workspace }).at(-1);
  assert.match(summary, /^Next: workspace/);
  assert.match(summary, /consent-plan workspace-init 21240/, 'the final next step must say what to approve, not only the effect');
  const bundled = setup.renderSetup({ profile: 'role-based-data', stages: [workspace], next: workspace }).at(-1);
  assert.match(bundled, /setup approval --profile role-based-data --workspace 21240/, 'profile reports point at the single approval');
});

async function processFixture(t, outcome, container) {
  const fixtureValue = await fixture(t);
  const { home, options, deps } = fixtureValue;
  const runtime = runtimeFor(container, home);
  await mkdir(join(home, 'dist', 'src'), { recursive: true });
  await writeFile(join(home, 'identity.json'), JSON.stringify({
    version: 1, id: runtime.id, mode: runtime.mode, origins: runtime.origins, profile: options.profile,
    container: runtime.sqlContainer, sourceFingerprint: 'fixture-build', authentication: { mode: 'preview' },
  }));
  await writeFile(join(home, 'dist', 'src', 'local-cli.js'), outcome === 'exit' ? 'process.exit(7);' : `
const { createServer } = require('node:http');
const { readFileSync, writeFileSync } = require('node:fs');
const identity = JSON.parse(readFileSync('identity.json', 'utf8'));
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  const unready = ${JSON.stringify(outcome === 'unready')};
  response.statusCode = request.url === '/health/ready' && unready ? 503 : 200;
  response.end(JSON.stringify(request.url === '/local/workspace' ? identity :
    unready ? { status: 'not-ready', dependency: 'data' } : { status: 'ready' }));
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync('endpoint.txt', 'http://127.0.0.1:' + server.address().port);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
`);
  let child;
  const injected = {
    environment: deps.environment,
    source: deps.source,
    spawn: (...args) => { child = spawn(...args); return child; },
    wait: () => new Promise(done => setTimeout(done, 25)),
  };
  const fetcher = async url => {
    const endpoint = await readFile(join(home, 'endpoint.txt'), 'utf8');
    return fetch(new URL(new URL(url).pathname, endpoint));
  };
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(done => child.once('close', done));
      child.kill();
      await closed;
    }
  });
  return { ...fixtureValue, runtime, injected, fetcher, child: () => child };
}

test('attached launch reports invalid real-auth before spawning', async t => {
  const { home, options, deps } = await fixture(t);
  const runtime = runtimeFor(undefined, home);
  let spawns = 0;
  await assert.rejects(setup.launchSetup(home, 'role-based-app', undefined, runtime, options.profile, deps.fetch, {
    source: deps.source,
    environment: { NODE_ENV: 'test', SQL_APPS_LOCAL_AUTH: 'entra' },
    spawn: () => { spawns++; throw new Error('Unexpected launch effect'); },
  }), /Local Entra authentication requires/);
  assert.equal(spawns, 0);
});

test('attached launch passes the exact real-auth environment to its child', async t => {
  const { home, options, deps, runtime, injected, fetcher, child } = await processFixture(t);
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const clientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const environment = { ...process.env, NODE_ENV: 'test', SQL_APPS_LOCAL_AUTH: 'entra',
    AZURE_TENANT_ID: tenantId.toUpperCase(), API_CLIENT_ID: clientId.toUpperCase() };
  const authentication = { mode: 'entra', tenantId, clientId };
  const identityPath = join(home, 'identity.json');
  await writeFile(identityPath, JSON.stringify({
    ...JSON.parse(await readFile(identityPath, 'utf8')), authentication,
  }));
  const launcherPath = join(home, 'dist', 'src', 'local-cli.js');
  await writeFile(launcherPath, `${await readFile(launcherPath, 'utf8')}
require('node:fs').writeFileSync('authentication-environment.json', JSON.stringify({
  mode: process.env.SQL_APPS_LOCAL_AUTH, tenantId: process.env.AZURE_TENANT_ID,
  clientId: process.env.API_CLIENT_ID, nodeEnvironment: process.env.NODE_ENV,
}));
`);
  const started = await setup.launchSetup(home, 'role-based-app', undefined, runtime, options.profile, fetcher, {
    ...injected, environment,
    spawn: (file, args, options) => {
      assert.ok(options.env === environment, 'the configured environment must be passed unchanged to the child');
      return injected.spawn(file, args, options);
    },
  });
  assert.equal(child().exitCode, null);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'authentication-environment.json'), 'utf8')), {
    mode: 'entra', tenantId: environment.AZURE_TENANT_ID, clientId: environment.API_CLIENT_ID, nodeEnvironment: 'test',
  });
  const report = await setup.planSetup(home, options, { ...deps, environment, fetch: fetcher });
  assert.equal(report.running, true);
  assert.deepEqual(report.authentication, authentication);
  await started.stop();
  await started.completion;
  assert.throws(() => process.kill(child().pid, 0), { code: 'ESRCH' });
});

test('attached launch closes its own child on an authentication mismatch without reading health', async t => {
  const { home, options, runtime, injected, fetcher, child } = await processFixture(t);
  const identityPath = join(home, 'identity.json');
  await writeFile(identityPath, JSON.stringify({
    ...JSON.parse(await readFile(identityPath, 'utf8')),
    authentication: { mode: 'entra', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  }));
  let healthReads = 0;
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  await assert.rejects(async () => {
    const started = await setup.launchSetup(home, 'role-based-app', undefined, runtime, options.profile,
      async url => {
        if (String(url).endsWith('/health/ready')) healthReads++;
        return fetcher(url);
      }, injected);
    await started.stop();
  }, /identity changed/);
  assert.equal(healthReads, 0);
  assert.throws(() => process.kill(child().pid, 0), { code: 'ESRCH' });
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});

test('attached launch becomes HTTP-ready and stopping it closes the real child', async t => {
  const { home, options, runtime, injected, fetcher, child } = await processFixture(t);
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const started = await setup.launchSetup(home, 'role-based-app', undefined, runtime, options.profile, fetcher, injected);
  assert.equal(child().exitCode, null);
  await started.stop();
  await started.completion;
  assert.throws(() => process.kill(child().pid, 0), { code: 'ESRCH' });
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});

test('attached launch verifies an explicitly selected external SQL container over real HTTP', async t => {
  const { home, options, runtime, injected, fetcher, child } = await processFixture(t, undefined, 'external-sql');
  const started = await setup.launchSetup(home, 'role-based-app', runtime.sqlContainer, runtime, options.profile, fetcher, injected);
  assert.equal(child().exitCode, null);
  await started.stop();
  await started.completion;
  assert.throws(() => process.kill(child().pid, 0), { code: 'ESRCH' });
});

test('attached launch propagates an early child failure without leaking listeners', async t => {
  const { home, options, runtime, injected, fetcher } = await processFixture(t, 'exit');
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  await assert.rejects(setup.launchSetup(home, 'role-based-app', undefined, runtime, options.profile, fetcher, injected),
    /exited \(7\)/);
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});

test('attached launch stops its real child after a responding identity conflict', async t => {
  const { home, options, runtime, injected, fetcher, child } = await processFixture(t);
  await writeFile(join(home, 'identity.json'), '{"version":1,"id":"foreign-workspace"}');
  await assert.rejects(setup.launchSetup(home, 'role-based-app', undefined, runtime, options.profile, fetcher, injected),
    /identity changed/);
  assert.throws(() => process.kill(child().pid, 0), { code: 'ESRCH' });
});

test('attached launch timeout stops its real child rather than leaving a server running', async t => {
  const { home, options, runtime, injected, child } = await processFixture(t);
  let clock = 0;
  await assert.rejects(setup.launchSetup(home, 'role-based-app', undefined, runtime, options.profile,
    async () => { throw new Error('unavailable'); }, { ...injected, now: () => { clock += 100_000; return clock; } }),
  /bounded wait/);
  assert.throws(() => process.kill(child().pid, 0), { code: 'ESRCH' });
});

test('attached launch never publishes a matching but unready child and closes it at the deadline', async t => {
  const { home, options, runtime, injected, fetcher, child } = await processFixture(t, 'unready');
  let probes = 0;
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  await assert.rejects(setup.launchSetup(home, 'role-based-app', undefined, runtime, options.profile,
    async url => {
      const response = await fetcher(url);
      if (String(url).endsWith('/health/ready')) probes++;
      return response;
    }, { ...injected, now: () => probes ? 300_001 : 0 }), /bounded wait/);
  assert.ok(probes > 0, 'must observe the real matching child and its failed readiness');
  assert.throws(() => process.kill(child().pid, 0), { code: 'ESRCH' });
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});
