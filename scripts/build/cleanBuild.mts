// A clean output tree prevents removed modules and obsolete renderer bundles
// from entering the next package. Resolve from this script, never the shell cwd.
import { rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Walk up from this script to the package.json that names the project, so
// the answer holds wherever the script sits (as scripts/lib/repoRoot.ts does
// for the compiled scripts; this one runs from source, before any build).
const ROOT_SEARCH_DEPTH_MAX = 8;

function repositoryRoot(): string {
  let directory = import.meta.dirname;
  for (let depth = 0; depth <= ROOT_SEARCH_DEPTH_MAX; depth += 1) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest) && readFileSync(manifest, 'utf8').includes('"name": "stacki"')) {
      return directory;
    }
    directory = dirname(directory);
  }
  throw new Error('Clean build: no stacki package.json above the script.');
}

async function main(): Promise<void> {
  await rm(resolve(repositoryRoot(), 'dist'), { recursive: true, force: true });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
