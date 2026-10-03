// The node kinds the patch tells apart, and the editor's own comments in a
// page — node markers and rendering stamps — which take no part in comparing
// renderings.

// A <template> marker is an element, and the page removes those from itself on
// load, so they are taken out of the fetched copies too — otherwise they are
// nodes on one side with nothing to match on the other.
//
// The comment markers are left in place, and they are what makes this safe.
// They wrap every node the editor knows about, they carry its path, and they
// sit in the live document as well as in both fetched ones. Matching walks
// from one to the next, so it can never drift onto the wrong element the way
// guessing from tag names does.
export function stripTemplateMarkers(root: ParentNode): void {
  const gone = root.querySelectorAll('template[data-avb-s],template[data-avb-e]');
  for (let i = 0; i < gone.length; i++) {
    const node = gone[i];
    if (node) {
      node.remove();
    }
  }
}

// Every comment the editor puts in a page: the node markers (`avb-s:`,
// `avb-e:`) and each marked file's stamp (`avb-d:`, the bytes it was marked
// from — shared/page/previewToken.ts). None of them is content, and none takes part
// in the comparison.
export const isAnchor = (node: Node | undefined): boolean => {
  const comment = node !== undefined && asComment(node) ? node : undefined;
  return comment !== undefined && /^avb-[sed]:/.test(comment.data);
};

// How deep the patch walks a page. An HTML parser stops nesting elements at
// 512 (Chromium's limit), so a deeper tree did not come from the file's
// markup; the patch gives up on it and the page reloads instead. Kept inside
// the part of this file the tests lift out, which starts at `isAnchor`.
export const MORPH_LIMITS = { domDepthMax: 512 } as const;

// A stamp says which rendering the page is, not where a node is, so it is not
// put back beside its neighbours: the patch gathers every stamp of the new
// rendering at the document's end (syncStamps), where the canvas reads its
// manifest from. Left where it was, a stamp in <head> or before <html> would
// outlive the rendering it named, and the canvas would vouch for bytes the
// page no longer shows.
export const isStamp = (node: Node | undefined): boolean => {
  const comment = node !== undefined && asComment(node) ? node : undefined;
  return comment !== undefined && comment.data.startsWith('avb-d:');
};

export const asElement = (node: Node): node is Element => node.nodeType === 1;
export const asText = (node: Node): node is Text => node.nodeType === 3;
export const asComment = (node: Node): node is Comment => node.nodeType === 8;
export const asDocument = (node: Node): node is Document => node.nodeType === 9;
