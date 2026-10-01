// Backport electron-builder PR 10172 to the locked app-builder-lib 25.1.8.
// Certificate and keychain passwords are separate credentials; this patch
// refuses unknown upstream source so an upgrade cannot silently corrupt it.

import { createHash, randomUUID } from 'node:crypto';
import fs = require('node:fs');
import { createRequire } from 'node:module';
import path = require('node:path');
import { repositoryRoot } from '../lib/repoRoot';

const BUILDER_VERSION = '25.1.8';
const ORIGINAL_HASH = 'ab30cf9755231ef0c279fc4a13f31b405b0a88b2cab657a57604e85bbb7ebbfd';
const PATCHED_HASH = '0fd7bf220d2c45a99b06a26632f1777e16873431a2dc798477da3f9e6d0cf36d';

export type SigningFixResult = 'already-patched' | 'not-installed' | 'patched';

function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

export function patchSigningSource(source: string): string {
  const digest = sourceHash(source);
  if (digest === PATCHED_HASH) {
    return source;
  }
  if (digest !== ORIGINAL_HASH) {
    throw new Error(
      'Unrecognized electron-builder signing source; ' +
        'review the signing backport before installing.',
    );
  }
  const patched = source
    .replace(
      'return await importCerts(keychainFile, certPaths, cscPasswords);',
      'return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);',
    )
    .replace(
      'async function importCerts(keychainFile, paths, keyPasswords) {',
      'async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {',
    )
    .replace(
      '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]',
      '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", ' +
        'keychainPassword, keychainFile]',
    );
  if (sourceHash(patched) !== PATCHED_HASH) {
    throw new Error('Electron-builder signing backport failed validation.');
  }
  return patched;
}

function packageVersion(packagePath: string): string {
  const input: unknown = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (typeof input !== 'object' || input === null || !('version' in input)) {
    throw new Error(`${packagePath}: expected version field`);
  }
  if (typeof input.version !== 'string') {
    throw new Error(`${packagePath}: version must be a string`);
  }
  return input.version;
}

function isModuleNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND';
}

export function fixElectronBuilderSigning(projectDirectory = repositoryRoot()): SigningFixResult {
  const projectRequire = createRequire(path.join(projectDirectory, 'package.json'));
  let builderPackage: string;
  try {
    builderPackage = projectRequire.resolve('electron-builder/package.json');
  } catch (error: unknown) {
    if (isModuleNotFound(error)) {
      return 'not-installed';
    }
    throw error;
  }
  const libraryPackage = createRequire(builderPackage).resolve('app-builder-lib/package.json');
  const version = packageVersion(libraryPackage);
  if (version !== BUILDER_VERSION) {
    throw new Error(
      `Unsupported app-builder-lib ${version}; review the signing backport before upgrading.`,
    );
  }
  const filePath = path.join(path.dirname(libraryPackage), 'out/codeSign/macCodeSign.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const patched = patchSigningSource(source);
  if (source === patched) {
    return 'already-patched';
  }

  const temporaryPath = `${filePath}.stacki-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, patched, {
      flag: 'wx',
      mode: fs.statSync(filePath).mode & 0o777,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return 'patched';
}

function main(): void {
  try {
    console.log(`  • electron-builder signing: ${fixElectronBuilderSigning()}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  • electron-builder signing: ${message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
