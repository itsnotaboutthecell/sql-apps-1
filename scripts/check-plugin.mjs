import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const plugin = join(checkout, 'plugins', 'sql-apps');
export const skillNames = ['sql-apps-local', 'sql-apps-diagnostics', 'sql-apps-validation', 'sql-apps-cloud-preview', 'sql-apps-application', 'sql-apps-design'];
const runtimeSkillNames = ['sql-apps-local', 'sql-apps-diagnostics', 'sql-apps-validation', 'sql-apps-cloud-preview', 'sql-apps-application'];

export async function checkPlugin() {
  const manifest = JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'sql-apps');
  assert.equal(manifest.version, '0.2.0');
  assert.ok(manifest.description?.length);
  const allowed = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']);
  assert.ok(Object.keys(manifest).every(key => allowed.has(key)), 'Manifest uses only Agent Plugins 1.0 metadata fields');
  const marketplaces = [];
  for (const directory of ['.github/plugin', '.claude-plugin']) {
    const marketplace = JSON.parse(await readFile(join(checkout, directory, 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.name, 'sql-apps-skills');
    const entry = marketplace.plugins.find(entry => entry.name === manifest.name);
    assert.equal(entry?.source, './plugins/sql-apps', 'Install only the clean plugin bundle, never the runtime/secrets');
    assert.equal(entry.version, manifest.version);
    marketplaces.push(marketplace);
  }
  assert.deepEqual(marketplaces[0], marketplaces[1]);
  assert.deepEqual((await readdir(join(plugin, 'skills'))).sort(), [...skillNames].sort());
  for (const name of skillNames) {
    const content = await readFile(join(plugin, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: "[^\\r\\n]+"\\r?\\n---`));
    if (runtimeSkillNames.includes(name)) {
      assert.match(content, /\.\.\/\.\.\/scripts\/sql-apps\.mjs/);
    } else {
      assert.match(content, /sql-apps-application.*authoritative|authoritative.*sql-apps-application/i, 'Design guidance defers SQL Apps setup and project authority to the application skill');
    }
    assert.ok(content.length < 7000, 'Keep skills focused; move detailed cases to on-demand references');
  }
  const files = [];
  const expectedFiles = [
    join(plugin, 'LICENSE'),
    join(plugin, 'plugin.json'),
    join(plugin, 'scripts', 'sql-apps.mjs'),
    ...skillNames.map(name => join(plugin, 'skills', name, 'SKILL.md')),
  ];
  async function inspect(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      assert.equal(info.isSymbolicLink(), false, 'Do not ship symlinks to runtime state');
      if (info.isDirectory()) await inspect(path);
      else files.push(path);
    }
  }
  assert.deepEqual((await readdir(plugin)).sort(), ['LICENSE', 'plugin.json', 'scripts', 'skills']);
  await inspect(plugin);
  assert.deepEqual(files.sort(), expectedFiles.sort(), 'Bundle contains only the declared manifest, launcher, six focused skills and MIT license');
  console.log('Local plugin packaging passed: six focused skills, MIT license, portable manifest, clean isolated bundle and matching marketplaces.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkPlugin().catch(error => { console.error(error.message); process.exitCode = 1; });
}
