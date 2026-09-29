// The page model as the renderer reads it: the parsed PageModel itself, with
// the fields any node kind may carry readable on every node. It is readonly —
// a gesture's effect builds a new model (src/editGestures.ts), and the bytes
// change only through intents (plan §11.9) — so a parse is shown as it came,
// without a private copy to keep in step.
import type { Attr, PageModel, PageNode } from './page-node';
import type { NodeId } from './brand';
import { toNodeId } from './brand';

// The fields every node kind may carry, readable on any node without first
// narrowing its kind: panels read `node.props` or `node.children` whatever
// the node is, and absent means the kind has none.
interface EditorNodeCommon {
  readonly name?: string;
  readonly children?: readonly EditorNode[] | null;
  readonly props?: Readonly<Record<string, Attr>>;
  readonly attrOrder?: readonly string[];
  readonly value?: string;
  readonly chunkFile?: string;
  readonly dynamicTag?: boolean;
  readonly astroAsset?: boolean;
  readonly head?: string;
  readonly test?: string;
  readonly inner?: string;
  readonly source?: string;
}

export type EditorNode = PageNode & EditorNodeCommon;
export type EditorModel = Omit<PageModel, 'nodes'> & { readonly nodes: readonly EditorNode[] };

export function nodeId(value: string): NodeId {
  return toNodeId(value);
}
