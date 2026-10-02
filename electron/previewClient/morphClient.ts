// Astro renders components on the server, so Vite cannot hot-swap one: any
// edit ends in "reload the document". A reload restarts every CSS animation,
// rewinds every video, drops scroll position and closes whatever was open —
// in an editor, that is the state you were looking at when you made the edit.
// The dev plugin catches that reload and sends a message here instead.
//
// What arrives is a NEW server rendering of the page. The obvious thing is to
// diff it against the live DOM, and that is wrong: the live DOM is not the
// server's to command. A slider has cloned its slides, a menu has set
// aria-expanded, an analytics tag has appended an iframe. Diffing against the
// live DOM treats all of that as content the server deleted, and removes it.
//
// So the diff is between the server's PREVIOUS rendering and its new one, and
// only that difference is applied to the live page. Anything the client did
// appears in neither rendering, so nothing here has an opinion about it, and
// it survives untouched. Three trees, and the live one is only ever written
// where the other two disagree.

// This module is served to the browser as source text (main.js reads it and
// hands it to the dev plugin), so it is emitted as plain ESM by its own
// tsconfig, never as CommonJS. The exports at the bottom are the module
// marker the compiler needs (import.meta is only legal in a module) and a
// no-op to the page.

declare global {
  // Vite's import.meta.hot; only .on is used here, so only .on is declared.
  interface ImportMeta {
    readonly hot?: {
      readonly on: (event: string, handler: () => void) => void;
    };
  }
}

// The patcher's bounds (plan §9, step 7), from shared/core/limits.ts: main prepends
// this constant when it hands the source to the dev plugin — the bridge
// boundary — so the page and the app answer to one number. Past either, the
// page reloads instead of patching, and tells the app why.
declare const AVB_PREVIEW_LIMITS: {
  /** Node markers one rendering may carry. */
  readonly previewMarkersMax: number;
  /** Child-list matrix cells one patch may spend lining renderings up. */
  readonly previewMorphWorkMax: number;
};

// A <template> marker is an element, and the page removes those from itself on
// load, so they are taken out of the fetched copies too — otherwise they are
// nodes on one side with nothing to match on the other.
//
// The comment markers are left in place, and they are what makes this safe.
// They wrap every node the editor knows about, they carry its path, and they
// sit in the live document as well as in both fetched ones. Matching walks
// from one to the next, so it can never drift onto the wrong element the way
// guessing from tag names does.
function stripTemplateMarkers(root: ParentNode): void {
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
const isAnchor = (node: Node | undefined): boolean => {
  const comment = node !== undefined && asComment(node) ? node : undefined;
  return comment !== undefined && /^avb-[sed]:/.test(comment.data);
};

// How deep the patch walks a page. An HTML parser stops nesting elements at
// 512 (Chromium's limit), so a deeper tree did not come from the file's
// markup; the patch gives up on it and the page reloads instead. Kept inside
// the part of this file the tests lift out, which starts at `isAnchor`.
const MORPH_LIMITS = { domDepthMax: 512 } as const;

// A stamp says which rendering the page is, not where a node is, so it is not
// put back beside its neighbours: the patch gathers every stamp of the new
// rendering at the document's end (syncStamps), where the canvas reads its
// manifest from. Left where it was, a stamp in <head> or before <html> would
// outlive the rendering it named, and the canvas would vouch for bytes the
// page no longer shows.
const isStamp = (node: Node | undefined): boolean => {
  const comment = node !== undefined && asComment(node) ? node : undefined;
  return comment !== undefined && comment.data.startsWith('avb-d:');
};

// Why the page reloaded instead of patching. The first two are the caps: a
// rendering with more nodes than the canvas may map, or two renderings too far
// apart to line up within the work bound. The others were always reloads.
type ReloadReason = 'markers-over-cap' | 'diff-over-cap' | 'scripts-changed' | 'patch-failed';

// Thrown where a cap is hit, caught by update(), which reloads for its reason.
class OverCap extends Error {
  readonly reason: 'markers-over-cap' | 'diff-over-cap';
  constructor(reason: 'markers-over-cap' | 'diff-over-cap') {
    super(`the canvas patch is over its cap (${reason})`);
    this.reason = reason;
  }
}

// The work one patch may still spend. update() refills it before each patch;
// diffChildren draws on it before it allocates a matrix, so the cap is hit
// before the memory is taken, never after.
let morphWorkLeft = AVB_PREVIEW_LIMITS.previewMorphWorkMax;
function refillMorphWork(): void {
  morphWorkLeft = AVB_PREVIEW_LIMITS.previewMorphWorkMax;
}
function spendMorphWork(cells: number): void {
  if (morphWorkLeft < cells) {
    throw new OverCap('diff-over-cap');
  }
  morphWorkLeft -= cells;
}

// The node markers a rendering carries — one pair per rendered copy of a node.
// Counted by walking, and the walk stops at the cap: it is a bound, not a size.
function checkMarkerCap(root: ParentNode): void {
  let markers = 0;
  const stack: ParentNode[] = [root];
  while (stack.length) {
    const parent = stack.pop();
    if (!parent) {
      break;
    }
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (asComment(node) && /^avb-s:/.test(node.data)) {
        markers++;
        if (markers > AVB_PREVIEW_LIMITS.previewMarkersMax) {
          throw new OverCap('markers-over-cap');
        }
      } else if (asElement(node)) {
        stack.push(node);
      }
    }
  }
}

const asElement = (node: Node): node is Element => node.nodeType === 1;
const asText = (node: Node): node is Text => node.nodeType === 3;
const asComment = (node: Node): node is Comment => node.nodeType === 8;
const asDocument = (node: Node): node is Document => node.nodeType === 9;

// test/electron/previewClient/morph.test.js lifts the patching half out of this file by slicing
// from the `const isAnchor =` line, so the type guards live below that marker, before
// their first use. That keeps the lifted source self-contained.

// Markers take no part in the comparison. Their path is an index, so removing
// one node renumbers every marker after it, and a diff that reads them as
// content sees the whole rest of the page change. They are stripped from both
// fetched copies, skipped over in the live page, and put back afterwards.
function stripAnchors(root: ParentNode): void {
  const gone: Comment[] = [];
  const walk = (parent: ParentNode, depth: number): void => {
    if (depth > MORPH_LIMITS.domDepthMax) {
      throw new Error('the page nests deeper than the patch walks');
    }
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (asComment(node) && isAnchor(node)) {
        gone.push(node);
      } else if (asElement(node)) {
        walk(node, depth + 1);
      }
    }
  };
  walk(root, 0);
  for (const node of gone) {
    node.remove();
  }
}

// Markers are comments: invisible to layout, to selectors and to animation, so
// they can be taken out and put back without the page noticing. Done in one
// pass after the content is settled, from a copy of the new rendering that
// still has them, so the editor's paths point at what is on the page now.
function syncAnchors(liveRoot: ParentNode, serverRoot: ParentNode): void {
  stripAnchors(liveRoot);

  // Whitespace is not content, and is never matched.
  //
  // It used to be: any text node stood for any other. Two renderings of the
  // same page hardly ever have the same number of blank text nodes — the diff
  // above keeps whichever ones it can — so one server blank could be matched
  // against a live blank on the far side of an element, and the cursor came out
  // PAST that element. Every anchor after it then landed a node too late, and
  // when the cursor ran off the end they were appended to the parent instead:
  // a closing marker after the very element it was supposed to close, and a
  // region that swallowed its next sibling whole. On the docs footer that made
  // a clicked line report the comment above it.
  const blank = (node: Node): boolean => (asText(node) ? node.data.trim() === '' : false);
  const sameKind = (left: Node, right: Node): boolean => {
    if (left.nodeType !== right.nodeType) {
      return false;
    }
    if (right.nodeType !== 1) {
      return true;
    }
    return asElement(left) && asElement(right) && left.tagName === right.tagName;
  };

  const walk = (live: ParentNode, server: ParentNode, depth: number): void => {
    if (depth > MORPH_LIMITS.domDepthMax) {
      throw new Error('the page nests deeper than the patch walks');
    }
    let cursor = live.firstChild;
    for (let sv = server.firstChild; sv; sv = sv.nextSibling) {
      const marker = asComment(sv) && isAnchor(sv) ? sv : undefined;
      if (marker) {
        if (!isStamp(marker)) {
          live.insertBefore(document.createComment(marker.data), cursor);
        }
        continue;
      }
      if (blank(sv)) {
        continue;
      }
      let candidate = cursor;
      while (candidate && (blank(candidate) || !sameKind(candidate, sv))) {
        candidate = candidate.nextSibling;
      }
      if (!candidate) {
        continue;
      }
      if (asElement(candidate) && asElement(sv)) {
        walk(candidate, sv, depth + 1);
      }
      cursor = candidate.nextSibling;
    }
  };
  walk(liveRoot, serverRoot, 0);
}

// Every stamp in the live document goes, wherever it was — before <html>, in
// <head>, in the body — and the new rendering's stamps, from anywhere in it,
// are appended to the document itself. A comment is a legal child of a
// document, and no selector, layout or script counts it.
function syncStamps(liveDocument: Document, serverDocument: Document): void {
  const gone: Comment[] = [];
  const found: string[] = [];
  const collect = (root: Node, into: (comment: Comment) => void): void => {
    const stack: Node[] = [root];
    while (stack.length) {
      const parent = stack.pop();
      if (!parent) {
        break;
      }
      for (let node = parent.firstChild; node; node = node.nextSibling) {
        if (asComment(node) && isStamp(node)) {
          into(node);
        } else if (asElement(node)) {
          stack.push(node);
        }
      }
    }
  };
  collect(liveDocument, (comment) => gone.push(comment));
  collect(serverDocument, (comment) => found.push(comment.data));
  for (const node of gone) {
    node.remove();
  }
  for (const data of found) {
    liveDocument.appendChild(liveDocument.createComment(data));
  }
}

// Never looked inside. A dev stylesheet belongs to Vite, which swaps it in by
// data-vite-dev-id; an external script re-runs if it is re-inserted, which is
// the reload this exists to avoid.
//
// <noscript> is here for a different and less obvious reason. Whether its
// markup is parsed at all depends on whether scripting is enabled in the
// document doing the parsing. In the live page it is, so the contents are
// inert text and the element has no children. In a DOMParser document it is
// not, so the same markup comes back as real elements. The two can never be
// compared, and walking in found children on one side and none on the other,
// gave up, and reloaded — on every patch, for any page carrying a <noscript>.
// Nothing in it can change without the file around it changing anyway.
//
// <template> is opaque for the same kind of reason: its markup lives in a
// separate fragment rather than in childNodes.
const pinned = (node: Node): boolean => {
  if (!asElement(node)) {
    return false;
  }
  return (
    node.tagName === 'NOSCRIPT' ||
    node.tagName === 'TEMPLATE' ||
    (node.tagName === 'SCRIPT' && !!node.getAttribute('src')) ||
    (node.tagName === 'STYLE' && node.hasAttribute('data-vite-dev-id'))
  );
};

// An id, and deliberately nothing else. `data-avb-p` looks like a better key —
// it is the editor's own node path — but the canvas stamps it onto live
// elements as it records them, while the server's HTML mostly has no such
// attribute. Reading it here compared a stamped path against an id, decided
// every element was a different element, and fell back to reloading the page
// on every keystroke: the exact thing this was written to stop.
const keyOf = (node: Node | undefined): string | undefined => {
  if (node !== undefined && asElement(node)) {
    return node.getAttribute('id') || undefined;
  }
  return undefined;
};

// What makes two nodes the same kind of thing for the purpose of lining up two
// lists: a tag, and an id if it has one. Every text node is interchangeable
// with every other, and so is every comment — their content is what changes,
// and the diff below decides which is which.
//
// Class is pointedly NOT part of this. It reads like free identity, but a
// class is the thing these props exist to change: pick another variant or
// theme and a wrapper goes from `theme-brand` to `theme-invert`. Counting that
// as a different element meant the old one was removed and a new one built in
// its place — and a wrapper takes the whole page down with it, which is why
// changing a variant threw the canvas back to the top. It is an attribute, and
// it is patched like one.
function keyFor(node: Node): string {
  if (asElement(node)) {
    return 'e:' + node.tagName + '#' + (keyOf(node) || '');
  }
  return asComment(node) ? 'c' : 't';
}

// Longest common subsequence over the two child lists.
//
// This replaces the obvious thing — walk both lists and guess, when they stop
// agreeing, whether something was inserted or removed. That guess is wrong far
// too often: whitespace text nodes are everywhere and all alike, so a look
// ahead always finds one, decides a node was inserted, and from there every
// remaining sibling is rebuilt. An element that was only meant to keep still
// loses its animation, its scroll position and anything the client hung on it.
// Consume a shared prefix before building the matrix. Most edits change text
// or attributes, leaving every child key in place; those lists, along with
// appends and removals at the end, take linear time and memory. The remaining
// matrix keeps the existing tie-breaking for repeated text and element keys.
type DiffOp = readonly [kind: number, i: number, j: number];

function diffChildren(before: readonly string[], after: readonly string[]): DiffOp[] {
  const beforeCount = before.length;
  const afterCount = after.length;
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeCount && j < afterCount && before[i] === after[j]) {
    ops.push([0, i++, j++]);
  }

  const start = i;
  const dp: Int32Array[] = [];
  if (i < beforeCount && j < afterCount) {
    spendMorphWork((beforeCount - start + 1) * (afterCount - start + 1));
    for (let row = 0; row <= beforeCount - start; row++) {
      dp.push(new Int32Array(afterCount - start + 1));
    }
    for (let row = beforeCount - start - 1; row >= 0; row--) {
      const currentRow = dp[row];
      const next = dp[row + 1];
      if (!currentRow || !next) {
        continue;
      }
      for (let col = afterCount - start - 1; col >= 0; col--) {
        currentRow[col] =
          before[row + start] === after[col + start]
            ? (next[col + 1] ?? 0) + 1
            : Math.max(next[col] ?? 0, currentRow[col + 1] ?? 0);
      }
    }
  }
  while (i < beforeCount && j < afterCount) {
    if (before[i] === after[j]) {
      ops.push([0, i++, j++]);
      continue; // keep
    }
    if ((dp[i - start + 1]?.[j - start] ?? 0) >= (dp[i - start]?.[j - start + 1] ?? 0)) {
      ops.push([-1, i++, -1]); // removed
    } else {
      ops.push([1, -1, j++]); // inserted
    }
  }
  while (i < beforeCount) {
    ops.push([-1, i++, -1]);
  }
  while (j < afterCount) {
    ops.push([1, -1, j++]);
  }
  return ops;
}

// Raised when the live document cannot be lined up with the server's, which
// happens when client code has rearranged something this cannot reason about.
// The caller turns it into the reload it replaced: losing the running state is
// a disappointment, patching the wrong element is a bug.
function Ambiguous(what: string): Error {
  return new Error('cannot line up ' + what + ' with the live page');
}

// The live node standing for a server node. The scan steps over anything the
// client added — that is the whole point — and over the editor's own markers,
// which are put back separately.
//
// A key is taken at its word. Without one, class is evidence — but the test is
// whether the live node still carries the classes the SERVER gave it, not
// whether the two lists are identical. Client code adds classes constantly, and
// that is the one thing this must not read as a different element: a tablist
// marks its open tab `is-active`, so `tabs_link is-active` stopped matching the
// server's `tabs_link`, the scan ran on to the next tab — which still had the
// pristine class — and matched THAT. Two tabs were patched as each other and
// the third had nothing left to match, so the page reloaded, which is the
// flicker this whole file exists to avoid.
//
// Order is the stronger signal, because the diff has already decided which
// nodes persist and in what order. So the first candidate that isn't
// contradicted wins, and scanning past one for a "better" match is exactly the
// mistake. A same-tag node is still remembered as a last resort, for the case
// where client code took one of the server's own classes away.
const classesOf = (node: Element): string[] =>
  (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);

// Every class the server put on the node is still on the live one. A node the
// server gave no class to has to have none either — otherwise the test is
// vacuous and would match anything, including a node the client inserted.
function keepsClassesOf(live: Element, serverNode: Element): boolean {
  const want = classesOf(serverNode);
  if (!want.length) {
    return live.classList.length === 0;
  }
  for (const className of want) {
    if (!live.classList.contains(className)) {
      return false;
    }
  }
  return true;
}

function findLive(from: Node | undefined, serverNode: Node): Node | undefined {
  let loose: Element | undefined = undefined;
  if (!asElement(serverNode)) {
    for (let node = from; node; node = node.nextSibling ?? undefined) {
      if (isAnchor(node)) {
        continue;
      }
      if (node.nodeType === serverNode.nodeType) {
        return node;
      }
    }
    return undefined;
  }
  const key = keyOf(serverNode);
  for (let node = from; node; node = node.nextSibling ?? undefined) {
    if (isAnchor(node)) {
      continue;
    }
    if (!asElement(node)) {
      continue;
    }
    if (node.tagName !== serverNode.tagName) {
      continue;
    }
    // An explicit id cannot fall back to a different same-tag element. If
    // client code removed it, reloading is safer than editing its neighbour.
    if (key !== undefined) {
      if (keyOf(node) === key) {
        return node;
      }
      continue;
    }
    if (keepsClassesOf(node, serverNode)) {
      return node;
    }
    // Same tag, weaker evidence. Kept in case nothing better turns up: the
    // diff has already decided this node persists, so the only question left
    // is which one it is, and a same-tag sibling beats giving up and reloading.
    if (!loose) {
      loose = node;
    }
  }
  return loose;
}

// Class is merged rather than assigned: a class the server added or dropped is
// applied, and one the client added — `is-open`, `in-view` — is left in place.
function patchClass(live: Element, previous: Element, next: Element): void {
  const before = (previous.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const after = (next.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  for (const className of before) {
    if (after.indexOf(className) === -1) {
      live.classList.remove(className);
    }
  }
  for (const className of after) {
    if (before.indexOf(className) === -1) {
      live.classList.add(className);
    }
  }
}

// Only where the two renderings disagree. An attribute the client set that the
// server never mentions is never seen here, so it stays.
function patchAttrs(live: Element, previous: Element, next: Element): void {
  const want = next.attributes;
  for (let i = 0; i < want.length; i++) {
    const attribute = want[i];
    if (!attribute) {
      continue;
    }
    if (previous.getAttribute(attribute.name) === attribute.value) {
      continue;
    }
    if (attribute.name === 'class') {
      patchClass(live, previous, next);
    } else {
      live.setAttribute(attribute.name, attribute.value);
    }
  }
  const had = previous.attributes;
  for (let i = had.length - 1; i >= 0; i--) {
    const attribute = had[i];
    if (!attribute) {
      continue;
    }
    if (next.hasAttribute(attribute.name)) {
      continue;
    }
    if (attribute.name === 'class') {
      patchClass(live, previous, next);
    } else {
      live.removeAttribute(attribute.name);
    }
  }
}

function patchNode(live: Node, previous: Node, next: Node): void {
  // An unchanged server subtree has no patch to contribute. Client code is
  // free to reorder, remove, or clone anything inside it, so descending into
  // that live subtree is both wasted work and actively unsafe: a slider or nav
  // can no longer resemble its server rendering even though the edit happened
  // somewhere else on the page.
  if (previous.isEqualNode(next)) {
    return;
  }
  if (live.nodeType === 3 || live.nodeType === 8) {
    // Only when the server changed it, and only if the live copy still says
    // what the server last said — client code that rewrote this text keeps it.
    const liveText = asText(live) ? live : asComment(live) ? live : undefined;
    const previousData = (asText(previous) ? previous : asComment(previous) ? previous : undefined)
      ?.data;
    const nextData = (asText(next) ? next : asComment(next) ? next : undefined)?.data;
    if (
      liveText &&
      previousData !== undefined &&
      nextData !== undefined &&
      previousData !== nextData &&
      liveText.data === previousData
    ) {
      liveText.data = nextData;
    }
    return;
  }
  if (!asElement(live) || pinned(live)) {
    return;
  }
  if (!asElement(previous) || !asElement(next)) {
    // The diff only pairs nodes of equal kind, so reach is impossible; the
    // guard keeps the types truthful rather than encoding a lie about it.
    return;
  }
  patchAttrs(live, previous, next);
  patchChildren(live, previous, next);
}

function patchChildren(liveParent: Element, previousParent: Element, nextParent: Element): void {
  const before: Node[] = [];
  for (let node = previousParent.firstChild; node; node = node.nextSibling) {
    before.push(node);
  }
  const after: Node[] = [];
  for (let node = nextParent.firstChild; node; node = node.nextSibling) {
    after.push(node);
  }

  let live = liveParent.firstChild;
  const locate = (serverNode: Node): Node => {
    const target = findLive(live ?? undefined, serverNode);
    if (!target) {
      throw Ambiguous(describe(serverNode));
    }
    return target;
  };

  for (const [kind, i, j] of diffChildren(before.map(keyFor), after.map(keyFor))) {
    if (kind === 0) {
      const previousNode = before[i];
      const nextNode = after[j];
      // The diff only emits keep ops for valid indexes; a gap is a bug, and
      // the reload the catch performs is the right failure then too.
      if (previousNode === undefined || nextNode === undefined) {
        throw Ambiguous('index gap in diff');
      }
      const target = locate(previousNode);
      patchNode(target, previousNode, nextNode);
      live = target.nextSibling;
    } else if (kind === -1) {
      const previousNode = before[i];
      if (previousNode === undefined) {
        throw Ambiguous('index gap in diff');
      }
      const target = locate(previousNode);
      if (live === target) {
        live = target.nextSibling;
      }
      // remove() lives on the leaf kinds, not on Node itself.
      const removal = asElement(target)
        ? target
        : asText(target)
          ? target
          : asComment(target)
            ? target
            : undefined;
      removal?.remove();
    } else {
      const nextNode = after[j];
      if (nextNode !== undefined) {
        liveParent.insertBefore(document.importNode(nextNode, true), live);
      }
    }
  }
}

const describe = (node: Node): string => {
  if (asElement(node)) {
    return '<' + node.tagName.toLowerCase() + '>';
  }
  if (asComment(node)) {
    return 'marker ' + node.data;
  }
  return 'text';
};

// A component's <style> is delivered as a MODULE in dev — one
// `<script type="module" src="…?astro&type=style…">` per styled component that
// renders. So the page's list of scripts changes whenever the SET of rendered
// components changes, and that is exactly what switching a variant does: one
// card becomes another, an icon appears, and the page carries a different
// handful of stylesheets.
//
// Which made the rule below reload the page for a stylesheet — the flicker this
// file exists to avoid, on the one edit most likely to be made over and over.
// Style modules are held apart from real scripts and patched like anything
// else.
function isStyleModule(source: string): boolean {
  return /[?&]astro&type=style|\.(css|s[ac]ss|less|pcss|styl)(\?|$)/.test(source || '');
}

interface ScriptInfo {
  readonly src: string;
  readonly type: string;
  readonly attrs: readonly [name: string, value: string][];
  readonly signature: string;
}

// A script that CHANGED, or one that is GONE, cannot be patched in: rewriting
// one does not run it, and nothing can un-run one. Both are wrong, so the page
// reloads. (Kept below the erased interface: comments attached to a type
// declaration are dropped at emit, and test/electron/previewClient/morph.test.js slices this file
// by this comment.)
//
// A script that only APPEARED is a different matter, and it is the common one.
// Switching a variant is how a component starts rendering something it wasn't:
// a slider, a marquee, anything with behaviour, and in dev Astro hands each of
// those out as its own module — so the new rendering asks for a module the page
// has not run yet. Reloading for that threw away the scroll position, every
// running animation and whatever was open, on a page whose markup this had
// just finished patching in place. Worse where it hurts most: hovering down a
// list of variants reloaded the page per option.
//
// So a new module is loaded rather than reloaded around — the same thing
// loadStyles does for a stylesheet, for the same reason: an element made here
// runs, a cloned one does not.
function scriptsOf(page: Document): ScriptInfo[] {
  const out: ScriptInfo[] = [];
  const list = page.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const script = list[i];
    if (!script) {
      continue;
    }
    const source = script.getAttribute('src') || '';
    if (isStyleModule(source)) {
      continue;
    }
    let attrs: [string, string][] = Array.from(script.attributes, (attribute) => [
      attribute.name,
      attribute.value,
    ]);
    attrs = attrs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    out.push({
      src: source,
      type: script.getAttribute('type') || '',
      attrs,
      signature: JSON.stringify([attrs, script.textContent]),
    });
  }
  return out;
}

// Structured signatures cannot collide with separators in URLs or source.
function scriptSignature(page: Document): string {
  return JSON.stringify(scriptsOf(page).map((script) => script.signature));
}

/**
 * What the new rendering adds, or undefined when it does anything else to the
 * scripts — which is the reload.
 *
 * Only an external script can be added this way. An inline script has to run
 * where it sits, and this cannot put it there: the copy the patch inserted is
 * inert and replacing it is a different job. So an inline arrival still reloads.
 */
function addedScripts(
  previousDocument: Document,
  nextDocument: Document,
): ScriptInfo[] | undefined {
  const before = scriptsOf(previousDocument);
  const after = scriptsOf(nextDocument);
  const had = new Set(before.map((script) => script.signature));
  const added: ScriptInfo[] = [];
  let i = 0;
  for (const script of after) {
    if (script.signature === before[i]?.signature) {
      i++;
    } else {
      // Already-run scripts must keep their order and count. Neither a
      // reorder nor another execution of an existing script can be patched.
      if (had.has(script.signature) || !script.src) {
        return undefined;
      }
      added.push(script);
    }
  }
  return i === before.length ? added : undefined;
}

// The modules a rendering asks for that this page has never run. Made here, not
// cloned, so they run.
const loadedScripts = new Set<string>();
function noteScripts(page: Document): void {
  for (const { src: source } of scriptsOf(page)) {
    if (source) {
      loadedScripts.add(source);
    }
  }
}
function runScripts(added: readonly ScriptInfo[]): void {
  for (const { src: source, attrs } of added) {
    if (!source || loadedScripts.has(source)) {
      continue;
    }
    loadedScripts.add(source);
    const element = document.createElement('script');
    // Preserve loading semantics such as integrity, crossorigin and nonce.
    // Dynamic classic scripts default to async; source scripts without that
    // attribute must instead execute in insertion order.
    element.async = false;
    for (const [name, value] of attrs) {
      element.setAttribute(name, value);
    }
    document.head.appendChild(element);
  }
}

// The stylesheets a rendering asks for, loaded for real.
//
// The patch cannot do this itself: a <script> cloned out of a fetched document
// is inert — the parser that made it had no browsing context, so inserting it
// into this one runs nothing (measured; see test/electron/previewClient/morph.test.js). An
// element made here does run, and running one of these modules is what injects its CSS.
//
// A stylesheet whose component is no longer rendered is left loaded. Its rules
// match nothing now, and it is already in hand for the moment the variant is
// switched back.
const loadedStyles = new Set<string>();
function noteStyles(page: Document): void {
  const list = page.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const script = list[i];
    if (!script) {
      continue;
    }
    const source = script.getAttribute('src');
    if (source !== null && isStyleModule(source)) {
      loadedStyles.add(source);
    }
  }
}
function loadStyles(page: Document): void {
  const list = page.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const script = list[i];
    if (!script) {
      continue;
    }
    const source = script.getAttribute('src');
    if (source === null || !isStyleModule(source) || loadedStyles.has(source)) {
      continue;
    }
    loadedStyles.add(source);
    const element = document.createElement('script');
    element.type = 'module';
    element.src = source;
    document.head.appendChild(element);
  }
}

// Vite swaps a dev stylesheet itself only when the browser imported its
// module. A page's own <style> never was — the server inlines it — so an edit
// to the page reaches the browser as a reload, which this patch replaces, and
// nothing else would ever bring the page's new CSS: the canvas kept the
// stylesheet the page loaded with, whatever the style panel wrote. The
// rendering just fetched holds every dev stylesheet as the server compiled it
// for this edit, so a live one whose text differs takes the new text. One
// whose text is the same is left alone: a rewritten stylesheet restarts every
// animation it defines, on every keystroke of a text edit.
function refreshDevStyles(page: Document): void {
  const fresh = new Map<string, string>();
  const served = page.querySelectorAll('style[data-vite-dev-id]');
  for (let i = 0; i < served.length; i++) {
    const id = served[i]?.getAttribute('data-vite-dev-id');
    if (id !== null && id !== undefined) {
      fresh.set(id, served[i]?.textContent ?? '');
    }
  }
  const live = document.querySelectorAll('style[data-vite-dev-id]');
  for (let i = 0; i < live.length; i++) {
    const style = live[i];
    const text = fresh.get(style?.getAttribute('data-vite-dev-id') ?? '');
    if (style === undefined || text === undefined) {
      continue; // Not in this rendering: Vite's own, or a component that left.
    }
    if (style.textContent !== text) {
      style.textContent = text;
    }
  }
}

interface FetchedDocument {
  readonly withAnchors: Document;
  readonly clean: Document;
}

function fetchDocument(): Promise<FetchedDocument> {
  return fetch(location.href, { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) {
        throw new Error('dev server answered ' + response.status);
      }
      return response.text();
    })
    .then((html) => {
      const withAnchors = new DOMParser().parseFromString(html, 'text/html');
      stripTemplateMarkers(withAnchors);
      const clone = withAnchors.cloneNode(true);
      // A cloned document is a Document; the guard is the types' only honest
      // way to say nodeType 9 without an assertion.
      if (!asDocument(clone)) {
        throw new Error('cloned rendering is not a document');
      }
      const clean = clone;
      stripAnchors(clean);
      return { withAnchors, clean };
    });
}

// The server's own rendering of this page, captured before any client code can
// alter it. The live DOM is not a substitute: a script that appends during
// parse has already run by the time this module does, and mistaking its work
// for server output would delete it on the first patch.
let previousDocument: Document | undefined = undefined;
const ready = fetchDocument().then(
  (fetched) => {
    previousDocument = fetched.clean;
    noteStyles(fetched.clean);
    noteScripts(fetched.clean);
  },
  () => {
    previousDocument = undefined;
  },
);

// A reload is honest: the app hears why before the page goes, and shows it when
// a cap was the reason — the canvas lost its running state on purpose, not by
// accident.
function reloadFor(reason: ReloadReason): void {
  try {
    window.parent.postMessage({ type: 'avb:preview-reload', reason }, '*');
  } catch {
    /* no parent to tell */
  }
  location.reload();
}

let busy = false;
let again = false;

// It calls itself only once the last patch has settled (see the end), so the
// stack never grows: that is event re-entry, bounded by `busy`, not recursion.
// eslint-disable-next-line stacki/bounded-recursion -- Event re-entry after settling.
async function update(): Promise<void> {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    await ready;
    if (!previousDocument) {
      throw new Error('no baseline rendering to compare against');
    }
    const next = await fetchDocument();
    checkMarkerCap(next.withAnchors);
    const added = addedScripts(previousDocument, next.clean);
    if (added === undefined) {
      reloadFor('scripts-changed');
      return;
    }
    refillMorphWork();
    const liveRoot = document.documentElement;
    const previousRoot = previousDocument.documentElement;
    const nextRoot = next.clean.documentElement;
    if (!liveRoot || !previousRoot || !nextRoot) {
      throw new Error('missing <html> in one of the renderings');
    }
    patchAttrs(liveRoot, previousRoot, nextRoot);
    patchChildren(document.head, previousDocument.head, next.clean.head);
    patchChildren(document.body, previousDocument.body, next.clean.body);
    previousDocument = next.clean;
    // After the patch, so a component that has just appeared is styled by the
    // time anything measures it — and running by the time anything clicks it.
    loadStyles(next.clean);
    refreshDevStyles(next.clean);
    runScripts(added);
    const liveBody = document.body;
    const serverBody = next.withAnchors.body;
    if (!liveBody || !serverBody) {
      throw new Error('missing <body> in one of the renderings');
    }
    syncAnchors(liveBody, serverBody);
    syncStamps(document, next.withAnchors);
    document.dispatchEvent(new CustomEvent('avb:morphed'));
  } catch (error: unknown) {
    // Whatever went wrong, the page must still end up showing what the file
    // says. Falling back to the reload this replaced is always safe.
    // The original called console.warn, which no browser implements — the
    // throw it caused skipped the reload line below, which is the whole point
    // of the catch. Log and reload.
    console.error('[stacki] could not patch the page, reloading:', error);
    reloadFor(error instanceof OverCap ? error.reason : 'patch-failed');
    return;
  } finally {
    busy = false;
  }
  if (again) {
    again = false;
    // Not a nested call: this runs after the last patch has settled and returns
    // at its first await. update() reports its own failures and reloads.
    void update();
  }
}

// Two ways the news arrives, because one of them is not reliable enough on its
// own. HMR is the fast path: the dev server saw the file change and said so.
// But that message rides a WebSocket the page opened when it loaded, and a
// socket has ways of going quiet — a dev server restarted under a canvas that
// stayed open, a laptop that slept, a reconnect that landed on something else
// listening on the same port. Nothing tells the page it has stopped hearing;
// it simply never updates again, and the only way to see an edit is to press
// refresh.
//
// The app watches the file system itself, for its own reasons, so it knows
// about every change either way — and it can say so straight to this frame.
// Patching twice for one edit costs a fetch and a diff that finds nothing.
if (import.meta.hot) {
  import.meta.hot.on('avb:page-changed', () => {
    // update() reports its own failures and reloads; nothing is left to catch.
    void update();
  });
}
window.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data['type'] === 'avb:patch-now'
  ) {
    // update() reports its own failures and reloads; nothing is left to catch.
    void update();
  }
});

// `update` is the module's entry; scriptSignature is not referenced internally
// but is part of the tested surface — test/electron/previewClient/morph.test.js slices it out of
// this source, so deleting it would delete coverage of the script-diff decision.
export { update, scriptSignature };
