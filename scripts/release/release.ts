// Release automation stays in TypeScript so version parsing and every process
// result are checked. The script deliberately stops on the first failed step;
// a partly tagged or partly pushed release needs human inspection.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const ACTIONS_URL = 'https://github.com/flowtricks/stacki/actions';
const CHOICE_CHARS_MAX = 8;

function packageVersion(): Version {
  const input: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
  if (typeof input !== 'object' || input === null || !('version' in input)) {
    throw new Error('package.json: expected a version field');
  }
  if (typeof input.version !== 'string') {
    throw new Error('package.json.version: expected string');
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(input.version);
  if (!match) {
    throw new Error(`package.json.version: expected numeric semver, got ${input.version}`);
  }
  const parts = match.slice(1).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error('package.json.version: components must be safe integers');
  }
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error('package.json.version: expected three components');
  }
  return { major, minor, patch };
}

function nextVersion(current: Version, choice: string): string {
  switch (choice) {
    case '1':
      return `${current.major}.${current.minor}.${current.patch + 1}`;
    case '2':
      return `${current.major}.${current.minor + 1}.0`;
    case '3':
      return `${current.major + 1}.0.0`;
    default:
      throw new Error('Release choice must be 1, 2, or 3');
  }
}

function run(command: string, argumentsList: readonly string[]): void {
  const result = spawnSync(command, argumentsList, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${String(result.status)}`);
  }
}

function openActions(): void {
  if (process.platform === 'darwin') {
    run('open', [ACTIONS_URL]);
  } else if (process.platform === 'win32') {
    run('cmd.exe', ['/c', 'start', '', ACTIONS_URL]);
  } else {
    run('xdg-open', [ACTIONS_URL]);
  }
}

async function main(): Promise<void> {
  const current = packageVersion();
  stdout.write(`Current version: ${current.major}.${current.minor}.${current.patch}\n`);
  stdout.write('What kind of release?\n');
  stdout.write(`  1) patch (${current.major}.${current.minor}.${current.patch + 1})\n`);
  stdout.write(`  2) minor (${current.major}.${current.minor + 1}.0)\n`);
  stdout.write(`  3) major (${current.major + 1}.0.0)\n`);

  const prompt = createInterface({ input: stdin, output: stdout });
  const answer = await prompt.question('Choose [1/2/3]: ');
  prompt.close();
  if (answer.length > CHOICE_CHARS_MAX) {
    throw new Error('Release choice exceeds limit');
  }
  const version = nextVersion(current, answer.trim());

  run('npm', ['version', version, '--no-git-tag-version']);
  stdout.write(`Bumped to ${version}\n`);
  run('git', ['add', '--all']);
  run('git', ['commit', '--message', `v${version}`]);
  run('git', ['tag', `v${version}`]);
  run('git', ['push']);
  run('git', ['push', '--tags']);
  stdout.write(`Release v${version} triggered!\n`);
  openActions();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
