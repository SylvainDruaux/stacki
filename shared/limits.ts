// Every bound in the contract layer lives here (AGENTS.md §10). Parsers
// enforce them at the boundary; hitting one is a parse failure, never silent
// truncation. Values are sized against what a real Astro project can hold,
// with headroom, not against what would exhaust memory.

export const LIMITS = {
  /** Nodes in one page tree. A 50k-line page is already a code-view page. */
  treeNodesMax: 20_000,
  /** Nesting depth of one page tree. Hand-written markup rarely exceeds 20. */
  treeDepthMax: 64,
  /** Length of a tag or component name. */
  tagNameCharsMax: 128,
  /** Length of a single attribute name or value. */
  attrCharsMax: 8_192,
  /** Attributes on one tag. */
  attrsPerNodeMax: 256,
  /** Text/comment/raw payload of one node, in UTF-16 code units. */
  nodeValueCharsMax: 1_000_000,
  /** Entries of each kind in a project scan (pages, layouts, components). */
  scanEntriesMax: 10_000,
  /** Folders listed by a project scan. */
  scanFoldersMax: 2_000,
  /** Props on one component schema. */
  propSchemaFieldsMax: 512,
  /** Literal options on one union-typed prop. */
  propOptionsMax: 256,
  /** Import declarations in one frontmatter block. */
  importsMax: 256,
  /** Cap on rescan chain-follows and save drains: both loops converge because
   * each pass needs a strictly newer request; a live cap hit means a bug. */
  rescanChainMax: 256,
  saveDrainMax: 256,
  /** Length of one IPC payload string field. */
  ipcFieldCharsMax: 10_000_000,
  /** TextMate highlighting is synchronous CPU work after grammar startup. */
  syntaxHighlightCharsMax: 1_000_000,

  // Editor core (plan §8). The projection reuses treeNodesMax and treeDepthMax:
  // a projected node is a page-tree node, so one name keeps one meaning.
  /** Bytes of one source file. Merged up from electron/main.bounds.ts so the
   * renderer, the actor and the disk readers answer to one number. */
  sourceBytesMax: 10 * 1024 * 1024,
  /** Intents accepted by one document actor and not yet terminal. Past this,
   * submission returns `backpressured`; the persistence layer holds the draft. */
  intentsPendingMax: 64,
  /** UTF-8 bytes of every string an intent carries, summed. A `replace-source`
   * intent carries a whole file, so the bound is the file bound itself. */
  intentPayloadBytesMax: 10 * 1024 * 1024,
  /** Splices one intent may plan, and sites one multi-span operation may name.
   * A loop rename in a generated page touches hundreds of sites, not millions. */
  splicesPerIntentMax: 4_096,
  /** Work units one diff may spend (step 2 defines the unit). Exhaustion is a
   * `resource-limit` rejection, never a silent fallback. */
  diffWorkMax: 50_000_000,
  /** Parses one actor may have in flight: the current read plus one newer. */
  parseTasksInFlightMax: 2,
  /** Snapshots one actor retains: the committed one plus the candidate under
   * verification. Pending intents keep only their authored preconditions. */
  snapshotsRetainedMax: 2,
  /** Files one watcher tick may mark dirty. Events coalesce into a set, so the
   * bound caps a burst like `git checkout`, not the event count. */
  watcherFilesPerTickMax: 1_024,
  /** Source markers one preview render may carry — one per projected node. */
  previewMarkersMax: 20_000,
  /** Diagnostics one parse-error projection carries, and the length of each. */
  diagnosticsMax: 64,
  diagnosticCharsMax: 4_096,
} as const satisfies Record<string, number>;
