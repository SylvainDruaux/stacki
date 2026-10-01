// What a drop on the Navigator carries: a component from the palette or a node
// moved within the tree (PalettePanel and StructureTree set these types). Drag
// data can come from any window, so it is parsed like any other input: a name
// or id past the page-tree bound is no drop at all.
import { LIMITS } from '../../../shared/core/limits';

export type NavigatorDrop =
  | { readonly kind: 'component'; readonly name: string }
  | { readonly kind: 'node'; readonly id: string };

/** `read` is `DataTransfer.getData`: an absent type reads as the empty string. */
export function parseNavigatorDrop(read: (type: string) => string): NavigatorDrop | undefined {
  const name = read('avb/component');
  if (name !== '') {
    return name.length <= LIMITS.tagNameCharsMax ? { kind: 'component', name } : undefined;
  }
  const id = read('avb/node');
  if (id !== '') {
    return id.length <= LIMITS.tagNameCharsMax ? { kind: 'node', id } : undefined;
  }
  return undefined;
}
