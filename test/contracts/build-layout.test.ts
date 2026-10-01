// Goal: a build is self-contained under dist and leaves authored directories clean.
// Methodology: inspect real build artifacts, sandboxed preload imports, copied
// worker/icon bytes, and package entry paths after the normal gate builds them.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { record, text } from '#dist/shared/boundary.js';

const root = resolve(import.meta.dirname, '../..');
const filesMax = 1000;

test('all compiler output lives under dist', () => {
  for (const directory of ['electron', 'shared']) {
    const files = readdirSync(resolve(root, directory), { recursive: true, encoding: 'utf8' });
    assert.ok(files.length < filesMax, 'Source inventory stays bounded');
    for (const file of files) {
      assert.doesNotMatch(file, /\.jsx?$/, `${directory}/${file} is generated output`);
      if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        const output = resolve(root, 'dist', directory, file.replace(/\.ts$/, '.js'));
        assert.ok(existsSync(output), `Missing compiler output for ${directory}/${file}`);
      }
    }
  }
  assert.ok(existsSync(resolve(root, 'dist/renderer/index.html')));
  assert.equal(existsSync(resolve(root, 'dist/index.html')), false, 'No obsolete renderer entry');
});

test('package entry and sandboxed preload use the built runtime', () => {
  const input: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const manifest = record(input);
  const main = text(manifest['main']);
  assert.equal(main, 'dist/electron/main.js');
  assert.ok(existsSync(resolve(root, main)));
  const exports = record(manifest['exports']);
  assert.equal(exports['./frontmatter'], './dist/electron/frontmatter.js');
  const preload = readFileSync(resolve(root, 'dist/electron/preload/preload.js'), 'utf8');
  const imports = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)];
  assert.ok(imports.length > 0);
  assert.ok(imports.length < 10);
  for (const match of imports) {
    assert.equal(match[1], 'electron', 'Sandboxed preload must not load shared modules');
  }
});

test('runtime workers and icons are copied without changing their contents', () => {
  for (const directory of ['electron/content/workers', 'resources']) {
    const files = readdirSync(resolve(root, directory));
    assert.ok(files.length < filesMax);
    for (const file of files) {
      if (/\.(mjs|png|ico|icns)$/.test(file)) {
        assert.deepEqual(
          readFileSync(resolve(root, 'dist', directory, file)),
          readFileSync(resolve(root, directory, file)),
          `${directory}/${file} is available to the packaged runtime`,
        );
      }
    }
  }
});
