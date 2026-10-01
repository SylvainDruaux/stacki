// What the visual editor may do with a projected node or attribute (plan §6).
// A node the engine cannot edit safely says so, visibly, instead of falling
// back to something that looks editable and writes somewhere else.

export const CAPABILITIES = [
  /** Visual intents may target it. */
  'editable',
  /** Code the engine keeps verbatim: expressions, spreads, `<script>`, `set:html`. */
  'read-only-opaque',
  /** One source node rendered many times — inside a loop. Clicking a rendered
   * instance selects this source node (the occurrence only picks which copy is
   * outlined); it never mints an instance id. An edit changes the source, and so
   * every copy (step 7). Placing nodes beside it stays refused: a loop body is
   * code, and a second root there does not build. */
  'repeated-source-node',
  /** One runtime element assembled from several sources (a chunk group). */
  'runtime-aggregate',
  /** No operation writes it: kept so a new node kind decides, at compile time,
   * what the editor may do with it (Markdown and MDX pages carried it until
   * step 10; nothing is classified so today). */
  'unsupported',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function parseCapability(input: unknown): Capability {
  for (const capability of CAPABILITIES) {
    if (capability === input) {
      return capability;
    }
  }
  throw new Error(`Capability: unknown value ${JSON.stringify(input)}`);
}

/** Whether visual intents may target a node with this capability. Written as an
 * exhaustive switch so a new capability must decide, at compile time, whether
 * it is visually editable. A repeated node is: its one source node is what the
 * canvas addresses, and editing it is what the model can actually do — refusing
 * it would be a read-only downgrade (decided at step 7). */
export function capabilityAcceptsVisualIntent(capability: Capability): boolean {
  switch (capability) {
    case 'editable':
    case 'repeated-source-node':
      return true;
    case 'read-only-opaque':
    case 'runtime-aggregate':
    case 'unsupported':
      return false;
    default: {
      const exhaustive: never = capability;
      return exhaustive;
    }
  }
}

/** The visible reason shown beside a node the editor will not change. */
export function describeCapability(capability: Capability): string {
  switch (capability) {
    case 'editable':
      return 'Editable';
    case 'read-only-opaque':
      return 'Code — edit it in the code panel';
    case 'repeated-source-node':
      return 'Repeated by a loop — an edit here changes every item';
    case 'runtime-aggregate':
      return 'Assembled from several files — edit each source file';
    case 'unsupported':
      return 'Not supported by the visual editor yet';
    default: {
      const exhaustive: never = capability;
      return exhaustive;
    }
  }
}
