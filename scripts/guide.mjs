import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectSource } from './workspace-check.mjs';
import { runtimeFor } from '../src/workspace.mjs';
import { projectHome } from '../src/tooling-context.mjs';

const maximumBytes = 16384;
const stages = [
  { id: 'describe', title: 'Describe', goal: 'Agree on who the app helps, its information and actions. No SQL knowledge required.' },
  { id: 'run-locally', title: 'Run locally', goal: 'Check setup, approve required changes, then verify a real browser action and saved SQL data.' },
  { id: 'make-it-yours', title: 'Make it yours', goal: 'Make one useful change and verify validation, save/reload and existing behavior.' },
  { id: 'share-optionally', title: 'Share optionally', goal: 'Local success is enough. Review data sensitivity, access, resources, costs and cleanup before Azure.' },
];

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label}: review its allowed fields.`);
}

function text(value, maximum = 500) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function list(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 12 &&
    value.every(item => text(item)) && new Set(value).size === value.length;
}

export function validateBrief(value) {
  object(value, ['purpose', 'audience', 'records', 'actions', 'capabilities', 'nextChange', 'checkpoint', 'costPreference'], 'project brief');
  if (!text(value.purpose) || !text(value.audience) || !text(value.nextChange) ||
      !list(value.records) || !list(value.actions)) {
    throw new Error('Invalid project brief: provide purpose, audience, 1-12 records/actions and a nextChange, each up to 500 characters.');
  }
  if (!list(value.capabilities) || !value.capabilities.includes('data') ||
      !value.capabilities.every(item => ['data', 'files', 'background-jobs'].includes(item)) ||
      (value.capabilities.includes('background-jobs') && !value.capabilities.includes('files'))) {
    throw new Error('Invalid capabilities: include data; add files only if needed, and files with background-jobs for the existing file processor.');
  }
  if (value.costPreference !== undefined && !['zero-azure-spend', 'review-paid-costs'].includes(value.costPreference)) {
    throw new Error('Invalid project brief costPreference: choose zero-azure-spend or review-paid-costs. This is a preference, not spending consent.');
  }
  if (value.checkpoint !== undefined) {
    object(value.checkpoint, ['stage', 'summary', 'evidence'], 'historical checkpoint');
    if (!['describe', 'run-locally', 'make-it-yours'].includes(value.checkpoint.stage) ||
        !text(value.checkpoint.summary) || !list(value.checkpoint.evidence)) {
      throw new Error('Invalid checkpoint: record a local stage, summary and 1-12 evidence descriptions. Cloud completion is not supported.');
    }
  }
  return value;
}

async function stateDirectory(home, create = false) {
  const directory = join(home, '.sql-apps');
  if (create) await mkdir(directory, { recursive: true });
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Guide state directory must be a local directory, not a symlink.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return directory;
}

export async function readBriefFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Project brief/guide must be a regular file, not a symlink.');
  if (info.size > maximumBytes) throw new Error('Project brief/guide is too large; keep it below 16 KiB and exclude secrets or actual records.');
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content) > maximumBytes) throw new Error('Project brief/guide is too large.');
  try { return JSON.parse(content); }
  catch { throw new Error('Invalid project brief/guide JSON; correct the file without resetting state.'); }
}

async function readState(home) {
  const directory = await stateDirectory(home);
  let state;
  try { state = await readBriefFile(join(directory, 'guide.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  object(state, ['version', 'home', 'sourceFingerprint', 'savedAt', 'brief'], 'saved guide');
  if (state.version !== 1 || !text(state.home, 4096) ||
      typeof state.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(state.sourceFingerprint) ||
      typeof state.savedAt !== 'string' || !Number.isFinite(Date.parse(state.savedAt))) {
    throw new Error('Invalid saved guide metadata; review it without resetting state.');
  }
  if (state.home !== home) throw new Error('Saved guide belongs to another checkout; preserve it and select the intended project.');
  validateBrief(state.brief);
  return state;
}

async function sourceFor(home) {
  const source = await inspectSource(home);
  if (!source.ready) throw new Error(`Cannot guide this project: ${source.code}. ${source.nextAction}`);
  return source;
}

export async function saveBrief(home, input) {
  const brief = validateBrief(input);
  const source = await sourceFor(home);
  const directory = await stateDirectory(source.home, true);
  const lock = join(directory, 'guide.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Guide is already being saved; review the active writer before retrying. Do not remove its lock automatically.');
    throw error;
  }
  const temporary = join(directory, `guide-${randomUUID()}.tmp`);
  try {
    await readState(source.home);
    const state = { version: 1, home: source.home, sourceFingerprint: source.fingerprint,
      savedAt: new Date().toISOString(), brief };
    const content = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(content) > maximumBytes) throw new Error('Saved guide is too large; shorten the brief and evidence.');
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'guide.json'));
    return state;
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rmdir(lock);
  }
}

export async function readGuide(home) {
  home ??= await projectHome();
  const source = await sourceFor(home);
  const runtime = runtimeFor(undefined, source.home);
  const state = await readState(source.home);
  const changed = state !== null && state.sourceFingerprint !== source.fingerprint;
  const checkpoint = state?.brief.checkpoint;
  const profile = await lstat(join(source.home, 'role-based-data.json')).then(() => 'role-based-data', () => null);
  const agreed = state?.brief.capabilities;
  const suggestedProfile = profile ?? (!agreed ? null :
    agreed.includes('files') || agreed.includes('background-jobs') ? 'foundation' : 'role-based-data');
  const setupPlan = `setup plan --profile ${suggestedProfile ?? '<foundation|role-based-data>'} (node scripts/setup.mjs plan)`;
  const nextStage = !state ? 'describe' : changed ? 'run-locally' :
    checkpoint?.stage === 'make-it-yours' ? 'share-optionally' :
      checkpoint?.stage === 'run-locally' ? 'make-it-yours' : 'run-locally';
  const nextActions = {
    describe: 'Describe who the app helps, its information and actions. Agree on a small scope before edits; use docs/guides/build-your-app.md.',
    'run-locally': changed && checkpoint ?
      `Source changed since the saved checkpoint, so its evidence is historical. Run ${setupPlan} to rebuild with approval, then verify the actual app locally again.` :
      `Run ${setupPlan} first. It orders setup checks and names each approval before installations, downloads, workspace selection or schema/startup changes.`,
    'make-it-yours': 'Recheck the intended running app, then make the saved nextChange. Verify browser validation, SQL save/reload and existing behavior before recording evidence.',
    'share-optionally': 'You can stop here with a useful local app. Sharing requires separate data/access review and explicit cloud approval; a saved checkpoint never authorizes deployment.',
  };
  const capabilities = state?.brief.capabilities ?? ['data'];
  return {
    home: source.home, application: source.application, profile, suggestedProfile, brief: state?.brief ?? null,
    stages, nextStage, nextAction: nextActions[nextStage],
    progress: { status: changed ? 'source-changed' : checkpoint ? 'reported-not-reverified' : 'not-verified',
      savedAt: state?.savedAt ?? null, checkpoint: checkpoint ?? null },
    build: source.build,
    workspace: { selected: runtime.mode !== 'legacy-unselected', mode: runtime.mode,
      origin: runtime.mode === 'legacy-unselected' ? null : runtime.origins.app },
    localServices: ['SQL', 'Data API', 'Browser/API',
      ...(capabilities.includes('files') ? ['File storage'] : []),
      ...(capabilities.includes('background-jobs') ? ['Background processing'] : [])],
    cloud: { authorized: false, optional: true,
      note: 'Public anonymous demos require synthetic data only. Use the maintained Azure Skills (prepare, validate, deploy) for new cloud deployments, then run SQL Apps live acceptance.' },
    cost: {
      preference: state?.brief.costPreference ?? 'zero-azure-spend',
      phase: nextStage === 'share-optionally' ? 'deployment-cost-review' :
        nextStage === 'make-it-yours' ? 'capability-cost-awareness' : 'local-cost-awareness',
      message: nextStage === 'share-optionally' ?
        'Before sharing, review expected Azure costs with the Azure Cost tooling (forecast, estimate and actual usage). Free SQL/compute allowances do not remove registry or managed-network charges. A zero-spend intent is blocked by the current template; never fall back to paid resources.' :
        'Local operation has no Azure usage bill; tool/access/licensing conditions still apply. Review future costs when adding files/background work, not cloud architecture during initial design.',
      reviewCommand: 'Use the azure-cost plugin (Azure Cost skills) to estimate the planned resources before approving any deployment.',
      usageStatus: 'not-queried',
      spendingAuthorized: false,
      scaleGuidance: 'Review actual remaining allowances, latency and availability needs before paying for capacity. User count is not a scaling threshold. Budgets are alerts, not hard spending caps.',
    },
    scope: 'Read-only guidance, saved decisions and historical reports; not live acceptance, service ownership, installation consent or deployment authorization.',
  };
}

export function formatGuide(report) {
  const lines = [
    'SQL Apps: Describe -> Run locally -> Make it yours -> Share optionally',
    `Project: ${report.home}`,
    ...report.stages.map(stage => `${stage.id === report.nextStage ? 'Next' : 'Stage'}: ${stage.title} - ${stage.goal}`),
  ];
  if (report.brief) {
    lines.push(`Purpose: ${report.brief.purpose}`, `For: ${report.brief.audience}`,
      `Information: ${report.brief.records.join('; ')}`, `Actions: ${report.brief.actions.join('; ')}`,
      `Capabilities: ${report.brief.capabilities.join(', ')}`, `Next change: ${report.brief.nextChange}`);
  } else lines.push('No saved brief yet. Start with what you want the app to do, not architecture choices.');
  lines.push(`Local services needed by the brief: ${report.localServices.join(', ')} (guidance only; nothing started)`,
    `Saved progress: ${report.progress.status}`,
    `Build: ${report.build.code} (not proof the app works)`,
    `Workspace: ${report.workspace.selected ? report.workspace.origin : 'not selected; no services started'}`);
  if (report.progress.checkpoint) lines.push(`Historical report: ${report.progress.checkpoint.summary}`,
    ...report.progress.checkpoint.evidence.map(value => `Reported evidence: ${value}`));
  lines.push(`Next action: ${report.nextAction}`, `Cost: ${report.cost.message}`);
  if (report.cost.phase === 'deployment-cost-review') {
    lines.push(`Cost review: ${report.cost.reviewCommand}`, report.cost.scaleGuidance);
  }
  lines.push(report.cloud.note, report.scope);
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2)) {
  const home = await projectHome();
  const json = args.at(-1) === '--json';
  const options = json ? args.slice(0, -1) : args;
  if (options.length && (options.length !== 2 || options[0] !== '--save' || !options[1] || options[1].startsWith('--'))) {
    throw new Error('Usage: npm run guide -- [--save <brief.json>] [--json]. Save only after agreeing on the brief; never include secrets or production data.');
  }
  if (options.length) await saveBrief(home, await readBriefFile(resolve(options[1])));
  const report = await readGuide(home);
  console.log(json ? JSON.stringify(report, null, 2) : formatGuide(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Guide failed'); process.exitCode = 1; });
}
