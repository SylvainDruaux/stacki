// Branded primitives (AGENTS.md §4): lookalike strings made distinct at compile
// time so a node id can never be passed where a file path belongs. Assertions
// exist only inside these validators, immediately after the check.

declare const brand: unique symbol;
export type Brand<T, B> = T & { readonly [brand]: B };

/** A page-tree node id: `n<digits>` for Astro nodes, `m<digits>` for Markdown, plus the two
 * well-known ids the app itself assigns — 'layout' (the detected page wrapper)
 * and `chunk<N>` (a serialization chunk group). */
export type NodeId = Brand<string, 'NodeId'>;

/** An absolute filesystem path as it crosses a boundary. POSIX or Windows
 * separators are both valid; the brand only proves non-emptiness. */
export type FilePath = Brand<string, 'FilePath'>;

/** The project root as configured in the app. Distinct from FilePath so a
 * scan request can never be pointed at a stray file path. */
export type ProjectPath = Brand<string, 'ProjectPath'>;

/** SHA-256 of a file's exact bytes as 64 lowercase hex characters: the token that
 * names which version of a file a read returned or an edit was authored against
 * (plan §3.1). Built only by toDigest — the wire parser and the main-process hash
 * function both go through it, so an unchecked string can never pose as one. */
export type Digest = Brand<string, 'Digest'>;

const NODE_ID_RE = /^(?:[nmc]\d+|layout|chunk\d+)$/;

export function toNodeId(value: string): NodeId {
  if (!NODE_ID_RE.test(value)) {
    throw new Error(
      `NodeId: expected 'n<N>', 'm<N>', 'c<N>', 'layout', or 'chunk<N>', got ${JSON.stringify(value)}`,
    );
  }
  return value as NodeId;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function toDigest(value: string): Digest {
  if (!DIGEST_RE.test(value)) {
    throw new Error('Digest: expected 64 lowercase hex characters');
  }
  return value as Digest;
}

export function toFilePath(value: string): FilePath {
  if (value.length === 0) {
    throw new Error('FilePath: expected non-empty string');
  }
  return value as FilePath;
}

export function toProjectPath(value: string): ProjectPath {
  if (value.length === 0) {
    throw new Error('ProjectPath: expected non-empty string');
  }
  return value as ProjectPath;
}
