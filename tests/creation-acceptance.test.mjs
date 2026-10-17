import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { importCreationAcceptance, acceptanceDigest } from '../src/creation-acceptance.mjs';

function png(width, height) {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, bytes])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-acceptance-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'docs', 'evidence'), { recursive: true });
  const build = 'a'.repeat(64), source = 'b'.repeat(64), origin = 'http://127.0.0.1:30000';
  const headings = ['Audience', 'Primary recurring task', 'First-read information', 'Typography', 'Palette', 'Layout', 'Responsive behavior'];
  const intent = '# Design Intent\n' + headings.map(heading => `\n## ${heading}\nCustomer records and their primary action lead.\n`).join('') +
    '\n## Composition A\n- Hierarchy: Customer first.\n- Density: Compact.\n- Primary action: Save contact.\n' +
    '\n## Composition B\n- Hierarchy: Queue first.\n- Density: Spacious.\n- Primary action: Open queue.\n' +
    '\n## Selected composition\n- Choice: Composition A.\n- Why: Contact work leads.\n' +
    '\n## Design capability\n- Skill: sql-apps-design\n';
  const states = ['signed-out', 'no-access', 'first-run', 'empty', 'single-record', 'populated', 'saving', 'error', 'success', 'disabled'];
  const review = `# Design Review\n\n## Review target\n- Origin: ${origin}\n- Source/build: ${source}\n\n## Matrix\n| State | Desktop | Narrow |\n| --- | --- | --- |\n` +
    states.map(state => `| ${state} | observed | observed |`).join('\n') +
    '\n\n## Findings\n- Contact fields lead at both widths.\n\n## Critique\n' +
    ['Representative screen', 'First viewport', 'Defining information', 'Generic elements', 'Remove or demote', 'Top changes']
      .map(field => `- ${field}: Contact details and save action reviewed at desktop and narrow widths.`).join('\n') +
    '\n\n## Design quality\n- Verdict: accepted\n- Rationale: The contact workflow and information lead; no material defect remains.\n';
  await writeFile(join(home, 'docs', 'design-intent.md'), intent);
  await writeFile(join(home, 'docs', 'design-review.md'), review);
  for (const filename of ['save.txt', 'reload.txt', 'failed-save.txt']) await writeFile(join(home, 'docs', 'evidence', filename), 'Synthetic test observation only.');
  await writeFile(join(home, 'docs', 'evidence', 'desktop.png'), png(1280, 800));
  await writeFile(join(home, 'docs', 'evidence', 'narrow.png'), png(390, 844));
  const input = { version: 1, build, origin, observedAt: new Date().toISOString(), workflow: {
    primaryAction: 'Save customer contact', save: { persisted: true, artifact: 'docs/evidence/save.txt' },
    reload: { freshDocument: true, persisted: true, artifact: 'docs/evidence/reload.txt' },
    failedSave: { visibleFeedback: true, artifact: 'docs/evidence/failed-save.txt' },
  }, design: {
    desktop: { width: 1280, height: 800, artifact: 'docs/evidence/desktop.png' },
    narrow: { width: 390, height: 844, artifact: 'docs/evidence/narrow.png' },
  } };
  const path = join(home, 'docs', 'evidence', 'acceptance.json');
  await writeFile(path, JSON.stringify(input));
  return { home, build, source, origin, input, path };
}
test('acceptance imports current browser and retained viewport/design evidence, not health alone', async t => {
  const f = await fixture(t);
  const records = await importCreationAcceptance(f.home, f.path, f.build, f.origin, f.source);
  assert.equal(records.workflow.kind, 'browser-workflow');
  assert.equal(records.design.kind, 'design-review');
  assert.equal(await acceptanceDigest(f.home, records.design.artifacts), records.design.digest);
  await writeFile(join(f.home, 'docs', 'design-review.md'), 'Revised and no longer accepted.');
  assert.notEqual(await acceptanceDigest(f.home, records.design.artifacts), records.design.digest);
});
test('stale builds, missing feedback, blocked design and incorrect render dimensions cannot pass', async t => {
  const f = await fixture(t);
  await assert.rejects(importCreationAcceptance(f.home, f.path, 'c'.repeat(64), f.origin, f.source), /current build/i);
  f.input.workflow.failedSave.visibleFeedback = false;
  await writeFile(f.path, JSON.stringify(f.input));
  await assert.rejects(importCreationAcceptance(f.home, f.path, f.build, f.origin, f.source), /failed-save/i);
  f.input.workflow.failedSave.visibleFeedback = true;
  f.input.design.narrow.width = 400;
  await writeFile(f.path, JSON.stringify(f.input));
  await assert.rejects(importCreationAcceptance(f.home, f.path, f.build, f.origin, f.source), /viewport dimensions/i);
  f.input.design.narrow.width = 390;
  await writeFile(f.path, JSON.stringify(f.input));
  const review = await readFile(join(f.home, 'docs', 'design-review.md'), 'utf8');
  await writeFile(join(f.home, 'docs', 'design-review.md'), review.replace('Verdict: accepted', 'Verdict: blocked'));
  await assert.rejects(importCreationAcceptance(f.home, f.path, f.build, f.origin, f.source), /unsupported.*verdict.*blocked/i);
  await writeFile(join(f.home, 'docs', 'design-review.md'), review);
  await rm(join(f.home, 'docs', 'evidence', 'save.txt'));
  await assert.rejects(importCreationAcceptance(f.home, f.path, f.build, f.origin, f.source), { code: 'ENOENT' });
});
