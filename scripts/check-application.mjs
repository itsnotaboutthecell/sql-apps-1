import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const sampleMarkers = [
  /\b(?:TodoExampleClient|TodoOwnerPredicate|TodoOwnerPolicy)\b/,
  /\b(?:listTodos|createTodo|updateTodo|deleteTodo|parseTodo)\b/,
  /(?:todo-form|id=["']todos["']|No Todos yet|001-todos\.sql)/,
  /\btodos\s*[:({]/,
  /(?:\bdbo\s*\.\s*Todos\b|\[\s*dbo\s*\]\s*\.\s*\[\s*Todos\s*\])/i,
  /\/api\/Todo\b/,
  /examples[\\/]+todo/,
];

function exampleDependencies(path, content) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const dependencies = new Set();
  const scopes = [new Map()];
  const literal = node => node && ts.isStringLiteralLike(node) ? node.text : undefined;
  const values = node => {
    const text = literal(node);
    if (text !== undefined) return [text];
    if (node && ts.isArrayLiteralExpression(node)) return node.elements.flatMap(values);
    if (node && ts.isIdentifier(node)) {
      for (const scope of [...scopes].reverse()) if (scope.has(node.text)) return scope.get(node.text);
    }
    if (node && ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text :
        ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (['join', 'resolve'].includes(name)) {
        const parts = node.arguments.map(values);
        if (parts.length && parts.every(part => part.length === 1)) return [parts.map(part => part[0]).join('/')];
      }
    }
    return [];
  };
  const record = value => {
    if (value && /(?:^|[\\/])examples(?:[\\/]|$)/.test(value)) dependencies.add(value);
  };
  function visit(node) {
    const scoped = ts.isBlock(node) || ts.isFunctionLike(node) || ts.isForOfStatement(node);
    if (scoped) scopes.push(new Map());
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const loop = node.parent.parent;
      scopes.at(-1).set(node.name.text, values(node.initializer ??
        (ts.isForOfStatement(loop) ? loop.expression : undefined)));
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) scopes.at(-1).set(node.name.text, []);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(literal(node.moduleSpecifier));
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text :
        ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ['require', 'readFile', 'readFileSync', 'access', 'stat', 'lstat', 'cp', 'copyFile', 'createReadStream'].includes(name)) {
        for (const value of values(node.arguments[0])) record(value);
      }
    }
    ts.forEachChild(node, visit);
    if (scoped) scopes.pop();
  }
  visit(source);
  return [...dependencies];
}

export async function checkApplication(root = process.cwd(), model) {
  root = resolve(root);
  const config = JSON.parse(await readFile(join(root, 'application.json'), 'utf8'));
  if (typeof config.name !== 'string' || !config.name || !Array.isArray(config.selectedExamples) ||
      config.selectedExamples.length || Object.keys(config).some(key => !['name', 'selectedExamples'].includes(key))) {
    throw new Error('Clean application validation requires a named application with selectedExamples: []');
  }
  const violations = [];
  let inspected = 0;
  async function inspect(path, optional = false, tests = false) {
    let info;
    try { info = await lstat(path); }
    catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Application delivery paths must not be symlinks: ${path}`);
    if (info.isDirectory()) {
      for (const child of await readdir(path)) {
        if (['node_modules', 'obj', 'bin'].includes(child)) continue;
        await inspect(join(path, child), false, tests);
      }
    } else if (['.ts', '.mts', '.js', '.mjs', '.html', '.css', '.json', '.sql', '.sqlproj', '.xml'].includes(extname(path))) {
      if (path === join(root, 'sql', 'local', 'application-acceptance.sql')) return;
      inspected++;
      const content = await readFile(path, 'utf8');
      if (tests) {
        for (const dependency of exampleDependencies(path, content)) {
          violations.push(`Unselected example dependency in ${path}: ${dependency}`);
        }
      } else if (sampleMarkers.some(marker => marker.test(content))) violations.push(path);
    }
  }
  for (const directory of ['src', 'public', 'dab', 'sql']) await inspect(join(root, directory));
  for (const directory of ['dist/src', 'dist/functions']) await inspect(join(root, directory));
  for (const directory of ['tests', 'dist/tests']) await inspect(join(root, directory), true, true);
  for (const filename of ['dist/src/client.js', 'dist/src/server.js', 'dist/functions/src/index.js']) {
    await inspect(join(root, filename));
  }
  await inspect(join(root, 'public', 'app.js'));
  if (model) await inspect(resolve(model));
  for (const filename of ['Dockerfile', 'functions/Dockerfile', 'functions/local.Dockerfile']) {
    const content = await readFile(join(root, filename), 'utf8');
    for (const line of content.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
      const copy = /^\s*COPY\s+(.+)$/i.exec(line);
      if (!copy) continue;
      const argumentsText = copy[1].replace(/^(?:--\S+\s+)+/, '');
      const argumentsList = argumentsText.startsWith('[') ? JSON.parse(argumentsText) :
        (argumentsText.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(value => value.replace(/^["']|["']$/g, ''));
      if (!Array.isArray(argumentsList) || argumentsList.length < 2 || argumentsList.some(value => typeof value !== 'string')) {
        throw new Error(`Cannot validate Docker COPY arguments in ${filename}`);
      }
      const sources = argumentsList.slice(0, -1).map(value => value.replace(/\\/g, '/').replace(/\/+$/, ''));
      if (sources.some(value => value === '.' || value === '/app' || /(?:^|\/)(?:examples|tests|dist)(?:\/\*+)?$/.test(value))) {
        violations.push(`${filename}: copy only intended runtime artifacts, not the whole build/example tree`);
      }
    }
  }
  if (violations.length) throw new Error(`Unselected Todo example remains in application delivery:\n${violations.join('\n')}`);
  console.log(`Clean application passed (${config.name}): ${inspected} source/build/schema/test files; no selected examples.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--selected') {
    if (args.length < 3 || args.length > 4 || !['local-simulation', 'public-demo'].includes(args[2])) {
      console.error('Usage: check-application.mjs --selected <artifact-directory> <local-simulation|public-demo> [checkout]');
      process.exitCode = 1;
    } else {
      try {
        const { checkSelectedApplication } = await import('../dist/src/application-build.js');
        const manifest = await checkSelectedApplication(resolve(args[3] ?? process.cwd()), resolve(args[1]), args[2]);
        if (manifest.name !== 'todo') {
          for (const file of manifest.files) {
            if (!['.js', '.mjs', '.html', '.css', '.sql', '.json', '.sqlproj'].includes(extname(file.path))) continue;
            const content = await readFile(join(resolve(args[1]), file.path), 'utf8');
            if (sampleMarkers.some(marker => marker.test(content))) {
              throw new Error(`Unselected Todo example remains in selected application delivery: ${file.path}`);
            }
          }
        }
        console.log(`Selected application passed (${manifest.name}, ${manifest.profile}): source/artifact checksums and shared route contract.`);
      } catch (error) { console.error(error.message); process.exitCode = 1; }
    }
  } else if (args.length > 2) { console.error('Usage: check-application.mjs [checkout] [extracted DACPAC model.xml]'); process.exitCode = 1; }
  else checkApplication(args[0], args[1]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
