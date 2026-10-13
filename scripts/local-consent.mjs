import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planConsent, grantConsent, assertConsent, revokeConsent, acknowledgeTerms } from '../src/local-consent.mjs';
import { projectHome, toolingHome } from '../src/tooling-context.mjs';

async function execute(command, args, home) {
  await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: home, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal || code !== 0) reject(new Error(`Consent-approved operation failed (${signal ?? code})`));
      else done();
    });
  });
}

export async function main(args = process.argv.slice(2), value, runner = execute) {
  const tools = await toolingHome(import.meta.url);
  let selected = value;
  if (selected === undefined) {
    try { selected = await projectHome(); }
    catch (error) {
      const pkg = JSON.parse(await readFile(join(tools, 'package.json'), 'utf8'));
      if (error.code !== 'PROJECT_NOT_FOUND' || pkg.name !== 'sql-apps') throw error;
      selected = process.cwd();
    }
  }
  const home = await realpath(selected);
  const [command = 'help', operation, selection] = args;
  if (command === 'help' && args.length <= 1) {
    console.log('Local consent: plan|status <operation> [selection] | grant|grant-once <absolute-plan.json> | grant|grant-once --plan-from <operation> [selection] | terms <absolute-reviewed-document> | revoke [scope|terms] | run <operation> [selection]');
    console.log('Record grants/terms only after explicit human approval. No global, installation or cloud permission is recorded. Recovery and retention cleanup require grant-once. For first startup prefer one bundle: setup approval.');
    return;
  }
  if (['plan', 'status', 'run'].includes(command)) {
    if (!operation || args.length > 3) throw new Error(`Usage: ${command} <operation> [selection]`);
    const request = { operation, ...(selection === undefined ? {} : { selection }) };
    const plan = await planConsent(home, request);
    if (command !== 'run') { console.log(JSON.stringify(plan, null, 2)); return; }
    if (operation === 'build' || operation === 'restore') {
      await assertConsent(home, request);
      if (operation === 'build') await runner(process.execPath, [join(tools, 'dist', 'scripts', 'build-provenance.mjs')], home);
      else {
        if (process.platform === 'win32') {
          const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
          if (!isAbsolute(npm) || !(await lstat(npm)).isFile()) throw new Error('npm CLI unavailable; run through npm run consent or review your Node installation');
          await runner(process.execPath, [npm, 'ci'], home);
        } else await runner('npm', ['ci'], home);
        await runner('dotnet', ['tool', 'restore'], home);
      }
    } else {
      // The runtime CLI rechecks and consumes one-operation grants immediately before dispatch.
      if (!plan.allowed) await assertConsent(home, request);
      await runner(process.execPath, [join(tools, 'dist', 'src', 'local-cli.js'), operation,
        ...(selection === undefined ? [] : [selection])], home);
    }
    return;
  }
  if ((command === 'grant' || command === 'grant-once') && operation === '--plan-from') {
    const [, , planned, chosen] = args;
    if (!planned || args.length > 4) throw new Error(`Usage: ${command} --plan-from <operation> [selection]`);
    const plan = await planConsent(home, { operation: planned, ...(chosen === undefined ? {} : { selection: chosen }) });
    await grantConsent(home, plan, { once: command === 'grant-once' });
    console.log(`Recorded ${command} for ${planned} (${plan.requirements.map(item => item.scope).join(', ') || 'no scopes'}) in ${home}. This records user approval of the plan just reviewed.`);
    return;
  }
  if (['grant', 'grant-once', 'terms'].includes(command)) {
    if (args.length !== 2 || !isAbsolute(operation ?? '')) throw new Error('Provide exactly one absolute reviewed document/plan path');
    if (command === 'terms') await acknowledgeTerms(home, operation);
    else {
      const info = await lstat(operation);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('Approved plan must be a bounded regular JSON file');
      const text = await readFile(operation, 'utf8');
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Approved plan is too large');
      let plan;
      try { plan = JSON.parse(text.replace(/^\uFEFF/, '')); }
      catch { throw new Error('Invalid approved plan JSON'); }
      await grantConsent(home, plan, { once: command === 'grant-once' });
    }
    console.log(`Recorded ${command} in ${home}. This records user approval; it does not verify chat consent or legal entitlement.`);
    return;
  }
  if (command === 'revoke' && args.length <= 2) {
    await revokeConsent(home, operation);
    console.log(`Revoked ${operation ?? 'all local permissions and terms acknowledgement'} in ${home}`);
    return;
  }
  throw new Error('Unsupported consent command; run npm run consent -- help');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
