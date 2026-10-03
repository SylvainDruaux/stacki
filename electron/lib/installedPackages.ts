// Files that belong to an installed package rather than to the user's project.
// Anything inside a node_modules folder is installed code: the next install
// replaces it, and a package manager may share it with other projects (pnpm
// hard-links a `file:` dependency to its source). The editor may show such a
// file; it never writes one.

/** Whether `file` lies inside a node_modules folder, at any depth. The match
 * is a whole path segment, so `node_modules.astro` or `my_node_modules/` are
 * the user's own; case is ignored, as macOS and Windows ignore it. */
export function isInstalledFile(file: string): boolean {
  return file.split(/[\\/]/).some((segment) => segment.toLowerCase() === 'node_modules');
}

/** The package an installed file belongs to, when it is inside one. */
export function packageOf(file: unknown): string | undefined {
  // Resolve the innermost package, including Windows paths and pnpm's
  // node_modules/.pnpm/.../node_modules/<package> layout.
  const normalized = '/' + String(file || '').replace(/\\/g, '/');
  const at = normalized.lastIndexOf('/node_modules/');
  if (at === -1) {
    return undefined;
  }
  const match = normalized.slice(at + '/node_modules/'.length).match(/^((?:@[^/]+\/)?[^/]+)/);
  return match?.[1];
}
