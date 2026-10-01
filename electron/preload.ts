import type { PreloadBridge } from '../shared/preload-api';
import type { IpcChannel, IpcPayloads } from '../shared/ipc-payloads';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The boxes this file measures and the shapes it reports, shared by the
// outline, gap and hit-test paths.
type Box = { left: number; top: number; right: number; bottom: number };
type Rect = { x: number; y: number; w: number; h: number };
type TaggedPlace = { el: Element; rect: Rect };
type GapBand = { axis: 'column' | 'row'; x: number; y: number; w: number; h: number };
type ThinTarget = { path: string; el: Element; box: DOMRect };
type Spacing = {
  padding: Record<string, number>;
  margin: Record<string, number>;
  gaps: GapBand[];
};
type GapRow = { top: number; bottom: number; items: DOMRect[] };

// The canvas protocol spells absence `undefined`, like every other value in
// the app (AGENTS.md §6): postMessage is a structured clone, which keeps it,
// and the app's parsers (src/previewMessages.ts, src/canvasReply.ts) read it.

// How deep the frame walks the page. An HTML parser stops nesting elements at
// 512 (Chromium's limit), and style rules nest far less; a deeper tree did not
// come from the project's markup, and what lies below the bound is skipped.
const PRELOAD_LIMITS = { domDepthMax: 512, cssRuleDepthMax: 64 } as const;

const isElement = (node: Node): node is Element => node.nodeType === 1;
const isComment = (node: Node): node is Comment => node.nodeType === 8;
const isText = (node: Node): node is Text => node.nodeType === 3;
const isChildNode = (node: Node): node is ChildNode =>
  'remove' in node && typeof node['remove'] === 'function';

// Preview iframes (nodeIntegrationInSubFrames runs this preload in them too):
// don't expose the app API to the previewed site — just report the page's
// content height to the app so the canvas view can size frames to the page.
if (!process.isMainFrame) {
  // Which frame the page is in, as a class on <html>, so a project can style
  // for the editor: `stacki-designer` in the canvas, `stacki-preview` in the
  // interactive preview. Read from the frame's own URL rather than waited for
  // over a message — the page paints before the app can say anything, and a
  // canvas that started out looking like the preview would flash.
  //
  // The patcher leaves it alone: it applies the classes the SERVER's two
  // renderings disagree about, and neither of them has ever heard of these.
  const stackiMode = location.hash.includes('avb-design') ? 'stacki-designer' : 'stacki-preview';
  const markMode = () => document.documentElement?.classList.add(stackiMode);
  // <html> exists by the time a preload runs, but not always in a frame that
  // is still being created — so try again at the first two moments it
  // certainly does.
  markMode();
  document.addEventListener('readystatechange', markMode);
  window.addEventListener('DOMContentLoaded', markMode);

  // Design-mode frames (canvas + editor preview) are marked with #avb-design.
  // They get an editor cursor (no I-beam over text) and links/forms are
  // inert — navigation only happens in the interactive preview mode.
  if (location.hash.includes('avb-design')) {
    const injectDesignStyle = () => {
      if (document.getElementById('avb-design-style')) {
        return;
      }
      const style = document.createElement('style');
      style.id = 'avb-design-style';
      style.textContent = '*, *::before, *::after { cursor: default !important; }';
      (document.head || document.documentElement)?.appendChild(style);
    };
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', injectDesignStyle);
    } else {
      injectDesignStyle();
    }
    // Block navigation and submits at capture so page handlers never fire.
    window.addEventListener(
      'click',
      (event) => {
        const anchor =
          event.target instanceof Element ? event.target.closest('a[href]') : undefined;
        if (anchor) {
          event.preventDefault();
        }
      },
      true,
    );
    window.addEventListener('submit', (event) => event.preventDefault(), true);
    // A press on the canvas is a selection, not an interaction — and left to
    // the browser, a press focuses whatever is under the pointer. Focusing
    // something REVEALS it: the page scrolls to bring it into view, sideways
    // as well as down.
    //
    // A card in a slider is covered by a full-bleed link and half of them sit
    // past the right edge, so selecting one scrolled the canvas across. The
    // page it came from is 3399px wide against a 1280px frame, so there is a
    // long way to travel and nothing on screen to say what happened: the site
    // simply looks as though it has slipped off to the left.
    //
    // The frame still takes focus itself — that is what carries the modifiers
    // above, and what a page's own keyboard handlers listen from. It is the
    // ELEMENT focus, and the scroll that comes with it, that goes.
    window.addEventListener(
      'mousedown',
      (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        window.focus();
      },
      true,
    );
    // Which modifiers are held, forwarded for the same reason as the shortcuts
    // below: clicking an element on the canvas puts keyboard focus in here, so
    // every key after that is delivered to this frame and never reaches the
    // app. The style panel reads Shift and Option to decide how much of the
    // spacing box a hover or a drag applies to — and from the app's side,
    // nobody was pressing anything.
    let held = { shiftKey: false, altKey: false };
    const tellModifiers = (event: { shiftKey: boolean; altKey: boolean }) => {
      const next = { shiftKey: !!event.shiftKey, altKey: !!event.altKey };
      if (next.shiftKey === held.shiftKey && next.altKey === held.altKey) {
        return;
      }
      held = next;
      try {
        window.parent.postMessage({ type: 'avb:modifiers', ...held }, '*');
      } catch {
        /* no parent to tell */
      }
    };
    // Any key event, not just the modifiers themselves — see the style panel's
    // hover hook: what matters is the state now, so a keyup missed while this
    // frame was out of focus is corrected by whatever happens next.
    window.addEventListener('keydown', tellModifiers, true);
    window.addEventListener('keyup', tellModifiers, true);
    // Nothing is held once the page stops receiving keys.
    window.addEventListener('blur', () => tellModifiers({ shiftKey: false, altKey: false }));
    // Forward app shortcuts when the canvas has keyboard focus — otherwise
    // ⌘F/⌘E die inside the iframe and the insert palette never opens.
    window.addEventListener(
      'keydown',
      (event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'e')) {
          event.preventDefault();
          try {
            window.parent.postMessage({ type: 'avb:shortcut', name: 'insert' }, '*');
          } catch {
            /* ignore */
          }
          return;
        }
        const target = event.target;
        const typing =
          target instanceof window.HTMLElement &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable);
        if (typing) {
          return;
        }

        // Clicking the canvas puts keyboard focus inside this frame, so the
        // app's own arrow-key navigation would never see the keys. Forward
        // them (and swallow them here, so the page doesn't scroll instead).
        if (
          !mod &&
          !event.altKey &&
          !event.shiftKey &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
        ) {
          event.preventDefault();
          try {
            window.parent.postMessage({ type: 'avb:shortcut', name: 'arrow', key: event.key }, '*');
          } catch {
            /* ignore */
          }
          return;
        }

        // Editing the selected node from the canvas. Undo, copy and paste
        // already survive an iframe-focused canvas because they're native
        // menu accelerators, which fire whatever holds focus; delete and
        // duplicate have no menu item, so without this they only work when
        // the selection was made in the navigator.
        const isDelete =
          !mod && !event.altKey && (event.key === 'Delete' || event.key === 'Backspace');
        const isDuplicate =
          mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd';
        // ⌘Enter jumps to the class field. The canvas is where the selection is
        // usually made, so it has to reach the app from in here too.
        const isClassJump = mod && !event.altKey && !event.shiftKey && event.key === 'Enter';
        const isProperties =
          !mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
        if (isDelete || isDuplicate || isClassJump || isProperties) {
          event.preventDefault();
          try {
            window.parent.postMessage(
              { type: 'avb:shortcut', name: 'key', key: event.key, meta: mod },
              '*',
            );
          } catch {
            /* ignore */
          }
        }
      },
      true,
    );
  }

  // documentElement.scrollHeight is clamped to the viewport (= the iframe),
  // so once the frame is stretched it can never report a smaller page — a
  // one-way ratchet. Measure the body's own content height instead; the
  // frozen-mode override un-stretches html/body so this reflects content.
  const report = () => {
    try {
      const body = document.body;
      let height;
      if (body) {
        const styles = getComputedStyle(body);
        height = body.offsetTop + body.scrollHeight + (parseFloat(styles.marginBottom) || 0);
      } else {
        height = document.documentElement.scrollHeight;
      }
      window.parent.postMessage({ type: 'avb:page-height', height: Math.ceil(height) }, '*');
    } catch {
      /* ignore */
    }
  };

  // Canvas frames stretch to the full page height, which would make vh units
  // (viewport = iframe) track the frame instead of a screen — a 100vh hero
  // would fill the whole frame and the measured height would chase its own
  // tail (every breakpoint converging to the same height). The app posts
  // `avb:set-vh` with the breakpoint's real viewport height; we freeze vh by
  // copying every rule that uses vh units into an override stylesheet with
  // `Xvh` → `calc(X * var(--avb-vh))`, where --avb-vh is 1% of that height.
  const VH_RE = /(-?\d*\.?\d+)(vh|svh|lvh|dvh)\b/g;
  let overrideElement: HTMLStyleElement | undefined = undefined;
  let rewriteTimer: ReturnType<typeof setTimeout> | undefined;

  // Copies ONLY the declarations that need freezing (vh units, position:
  // fixed) into the override — never whole rule bodies. Re-asserting entire
  // rules at the end of the cascade would let base rules beat utility
  // classes that legitimately override them later in source order.
  const filterRule = (rule: CSSRule, depth: number): string => {
    if (depth > PRELOAD_LIMITS.cssRuleDepthMax) {
      return '';
    }
    if (asImport(rule)) {
      return filterImportRule(rule, depth);
    }
    if (asStyleLike(rule)) {
      return filterStyleRule(rule, depth);
    }
    // Grouping rule (@media, @supports, @layer, @keyframes …) — recurse.
    if (rule instanceof CSSGroupingRule && rule.cssRules.length) {
      const inner = filterRules(rule.cssRules, depth + 1);
      if (!inner) {
        return '';
      }
      const head = rule.cssText.slice(0, rule.cssText.indexOf('{'));
      return head + '{\n' + inner + '}\n';
    }
    return '';
  };

  // Every rule of a list, filtered and joined in order. CSSRuleList isn't
  // iterable in the type library, so an index loop walks it.
  const filterRules = (rules: CSSRuleList, depth: number): string => {
    let out = '';
    for (let ri = 0; ri < rules.length; ri++) {
      const child = rules[ri];
      if (child) {
        out += filterRule(child, depth);
      }
    }
    return out;
  };

  // An @import brings a whole stylesheet in, and its rules hang off
  // `rule.styleSheet`, not `rule.cssRules` — so a sheet reached this way was
  // invisible here. That's where a design system's `body { min-height:
  // 100svh }` usually lives, and leaving it live is what makes a stretched
  // canvas frame grow without end: svh tracks the frame, body grows, the
  // page reports a taller height, the frame stretches again.
  const filterImportRule = (rule: CSSImportRule, depth: number): string => {
    // Still loading: nothing to copy yet, and no <head> mutation will
    // announce it later, so ask for another pass.
    if (!rule.styleSheet) {
      importsPending = true;
      return '';
    }
    let inner = '';
    try {
      inner = filterRules(rule.styleSheet.cssRules, depth + 1);
    } catch {
      return ''; // cross-origin import — can't read it
    }
    if (!inner) {
      return '';
    }
    // Keep whatever layer it was imported into, or the copy would outrank
    // (or be outranked by) the original.
    const layer = /\blayer\(([^)]*)\)/i.exec(rule.cssText || '');
    if (!layer) {
      return inner;
    }
    const layerBody = layer[1] ?? '';
    return `@layer ${layerBody.trim()} {\n${inner}}\n`;
  };

  // With CSS nesting a style rule is BOTH: it has its own declarations and
  // it contains rules. Taking the grouping branch on the strength of
  // `cssRules` alone skipped everything the rule itself declared — which is
  // exactly where `body { min-height: 100svh; > main { … } }` hides, and why
  // a frame with that in its stylesheet grew without end.
  const filterStyleRule = (rule: CSSStyleRule | CSSKeyframeRule, depth: number): string => {
    let nested = '';
    if (rule instanceof CSSGroupingRule && rule.cssRules.length) {
      nested = filterRules(rule.cssRules, depth + 1);
    }
    let decls = '';
    for (let di = 0; di < rule.style.length; di++) {
      const prop = rule.style.item(di);
      const value = rule.style.getPropertyValue(prop);
      const prio = rule.style.getPropertyPriority(prop);
      VH_RE.lastIndex = 0;
      const hasVh = VH_RE.test(value);
      const isFixed = prop === 'position' && /fixed/.test(value);
      if (!hasVh && !isFixed) {
        continue;
      }
      VH_RE.lastIndex = 0;
      // position:fixed anchors to the stretched frame, so it becomes
      // absolute — headers/overlays sit at their page position instead of
      // floating mid-frame.
      const newValue = isFixed ? 'absolute' : value.replace(VH_RE, 'calc($1 * var(--avb-vh, 1$2))');
      decls += `${prop}: ${newValue}${prio ? ' !important' : ''}; `;
    }
    // Nested matches are re-emitted inside their parent, keeping the nesting
    // (and so the `&` context) they were written with.
    if (!decls && !nested) {
      return '';
    }
    const selector = selectorOf(rule);
    return `${selector} { ${decls}${nested ? '\n' + nested : ''}}\n`;
  };

  // The original checks these the same way (type constants and property
  // truthiness); the predicates just make the branches type-narrow.
  const asImport = (rule: CSSRule): rule is CSSImportRule =>
    rule.type === 3 || ('styleSheet' in rule && !!rule['styleSheet']);
  const asStyleLike = (rule: CSSRule): rule is CSSStyleRule | CSSKeyframeRule => {
    if (!('style' in rule) || !rule['style']) {
      return false;
    }
    const selectorText = 'selectorText' in rule ? rule['selectorText'] : undefined;
    const keyText = 'keyText' in rule ? rule['keyText'] : undefined;
    return !!(selectorText || keyText);
  };
  const selectorOf = (rule: CSSStyleRule | CSSKeyframeRule): string => {
    const selectorText = 'selectorText' in rule ? rule.selectorText : undefined;
    const keyText = 'keyText' in rule ? rule.keyText : undefined;
    return selectorText || keyText || '';
  };

  let importsPending = false;
  let importRetries = 0;
  const rewriteSheets = () => {
    if (!document.head) {
      return;
    }
    importsPending = false;
    // Un-stretch html/body so the frame's height comes from content, not
    // from the (stretched) viewport — kills height:100% feedback.
    let css = 'html, body { height: auto !important; }\n';
    const sheets = document.styleSheets;
    for (let si = 0; si < sheets.length; si++) {
      const sheet = sheets[si];
      if (!sheet) {
        continue;
      }
      if (sheet.ownerNode === overrideElement) {
        continue;
      }
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin stylesheet — can't read, leave it be
      }
      css += filterRules(rules, 0);
    }
    if (!overrideElement) {
      overrideElement = document.createElement('style');
      overrideElement.id = 'avb-vh-override';
    }
    if (overrideElement.textContent !== css) {
      overrideElement.textContent = css;
    }
    if (document.head.lastElementChild !== overrideElement) {
      document.head.appendChild(overrideElement);
    }
    // An @import that hadn't finished loading has rules we still need, and it
    // won't touch <head> when it arrives — so nothing else would bring us
    // back. Try again shortly, a bounded number of times.
    if (importsPending && importRetries < 25) {
      importRetries += 1;
      setTimeout(rewriteSheets, 120);
    }
  };

  const scheduleRewrite = () => {
    clearTimeout(rewriteTimer);
    rewriteTimer = setTimeout(() => {
      rewriteSheets();
      report();
    }, 100);
  };

  // --- Node outlines --------------------------------------------------------
  // Pages served through the app's marker plugin wrap every model node in
  // <!--avb-s:path--> / <!--avb-e:path--> comment pairs. Record each pair's
  // run of sibling DOM nodes, then take the markers out.
  //
  // Comments, not elements: a <template> counts for :nth-child, :first-child,
  // + and ~ like anything else, so the markers this replaced shifted the
  // page's own structural selectors for as long as they were in the DOM —
  // through first paint, since they can only be removed once the run has been
  // recorded. A comment is invisible to all of those. A node in a named slot
  // is marked the same way: its markers have to carry the `slot` attribute to
  // travel with it, and a <Fragment slot="…" set:html> carries the attribute
  // while putting nothing but the comment in the slot.
  //
  // A <template> is still READ as a marker below. Nothing writes one any more,
  // but a page served by a dev server that started before this app was updated
  // still has them, and a canvas that suddenly could not read its own markers
  // would be a blank navigator with no way to tell why.
  //
  // The app tracks paths; their rects are pushed back on scroll/resize/DOM
  // changes, and hovering the page reports the deepest node under the cursor.
  const regions = new Map<string, Node[][]>(); // path -> [ [node, ...], ... ]
  let trackedPaths: string[] = [];
  // The file the app is addressing: empty for the page, or a component's
  // namespace while one is open. Every .astro under src carries markers now,
  // so hover and click must resolve within the file being edited.
  let activeScope = '';
  const inScope = (nodePath: string) =>
    activeScope ? nodePath.startsWith(activeScope) : !nodePath.includes('|');

  // Which rendered copy of the open component is being edited. A component
  // used inside a loop renders once per item, and drilling into one card
  // means THAT card — so everything below (outlines, hit testing, the classes
  // the style panel reads) narrows to the nodes that one instance put on the
  // page. Its siblings stay as dim and as unclickable as the rest of it.
  let focusPath = '';
  let focusOcc = 0;
  // A run whose every node has left the document isn't an instance any more:
  // a patched page collects fresh runs and leaves the old ones in the map.
  const isLive = (run: Node[]) => run.some((node) => node.isConnected);
  // Undefined until asked, then the answer: no roots (nothing to narrow) or
  // the run of nodes the focused instance rendered. Recomputed whenever the
  // DOM moves — a patched page rebuilds the regions these come from.
  let focusCache: { readonly roots: Node[] | undefined } | undefined;
  const focusRoots = (): Node[] | undefined => {
    if (focusCache !== undefined) {
      return focusCache.roots;
    }
    focusCache = { roots: undefined };
    if (focusPath) {
      const runs = (regions.get(focusPath) || []).filter(isLive);
      // Any run at all is the instance that was opened, and everything below —
      // outlines, hit testing, what a scroll-to aims at — should mean THAT one.
      // This used to require two: with `<Button/>` written three times in a
      // page, each has its own path, so the one that was opened has a single
      // run, no narrowing happened, and the component's own paths resolved to
      // all three instances at once — three outlines on screen, and a scroll
      // that went to whichever came first in the document.
      //
      // Zero runs still doesn't narrow: a layout's marker pair is split across
      // <head> and <body> and never pairs up, and narrowing to nothing would
      // hide the page.
      if (runs.length) {
        focusCache = { roots: runs[focusOcc] || runs[0] };
      } else {
        // No marker pair at all: the instance is addressed by attribute — a
        // component rendered into another one's slot, or one whose root is a
        // conditional. Its places are the tagged elements, and the occurrence
        // picks the one that was opened, exactly as the click that opened it
        // counted them.
        //
        // Without this, nothing narrowed while such a component was open, and
        // every path inside it meant every instance on the page: 53 elements
        // answer to Button's `button_text`, so its outline was the union of all
        // of them — a box a thousand pixels tall — and the button itself
        // reported four boxes, one per copy, with the selected one among them
        // only by luck.
        //
        // The nested reads inside taggedPlaces ask focusRoots again; the cache
        // already holds no roots by then, so they narrow to nothing and this
        // decides the answer, rather than recurring.
        const places = taggedPlaces(focusPath);
        const one = places[focusOcc] || places[0];
        if (one) {
          focusCache = { roots: [one.el] };
        }
      }
    }
    return focusCache.roots;
  };
  const inFocus = (node: Node): boolean => {
    const roots = focusRoots();
    if (!roots) {
      return true;
    }
    return roots.some((root) => root === node || (root.nodeType === 1 && root.contains(node)));
  };
  // The occurrences of a path that are on the page, narrowed to the focused
  // instance when there is one. Rects, classes and occurrence numbering all
  // read this, so "the second copy" means the same thing to all of them.
  const runsOf = (nodePath: string): Node[][] | undefined => {
    const runs = regions.get(nodePath);
    if (!runs) {
      return runs;
    }
    const live = runs.filter(isLive);
    return focusRoots() ? live.filter((run) => run.some(inFocus)) : live;
  };
  // The hover the app was last told about; undefined until it has been told.
  let lastHover: { readonly path: string | undefined; readonly occurrence: number } | undefined;
  // Whether the markers have been walked yet. The app can ask about a node
  // before then — a selection made while the page is still parsing, or in the
  // instant after a patch — and the honest answer is "not yet", not "no such
  // element". Every answer carries this so the asker can tell the two apart,
  // and the announcement below tells it when to try again.
  let mapped = false;
  const announceMapped = () => {
    mapped = true;
    try {
      window.parent.postMessage({ type: 'avb:canvas-ready' }, '*');
    } catch {
      /* no parent to tell */
    }
    announceRender();
  };

  // --- The preview token (plan §9, step 7) ----------------------------------
  // Every file the dev plugin marks carries one stamp, <!--avb-d:<sha256>:<file>-->,
  // naming the bytes it was marked from. The stamps on the page are the
  // manifest of this rendering, and its token — the SHA-256 of the manifest's
  // canonical text — rides on every located event, so the app can refuse a
  // click from a rendering the files have since moved past. Mirrors
  // shared/preview-token.ts, which this sandboxed preload cannot require; the
  // contract test (test/contracts/preview-bridge.test.ts) pins the two to each
  // other. The patcher gathers the stamps at the document's end after each
  // patch; the page arrives with them wherever each file rendered.
  const STAMP_PREFIX = 'avb-d:';
  const STAMPS_MAX = 20000; // LIMITS.previewMarkersMax
  const MANIFEST_FILES_MAX = 512; // LIMITS.previewManifestFilesMax
  let renderToken: string | undefined = undefined;
  let renderSeq = 0;
  // Undefined when the page's stamps cannot form one manifest: too many, or
  // one file stamped with two checksums (a rendering mixing versions of it).
  const readManifest = (): { file: string; checksum: string }[] | undefined => {
    const byFile = new Map<string, string>();
    let stamps = 0;
    const stack: Node[] = [document];
    while (stack.length) {
      const parent = stack.pop();
      if (!parent) {
        break;
      }
      for (let node = parent.firstChild; node; node = node.nextSibling) {
        if (isElement(node)) {
          stack.push(node);
          continue;
        }
        if (!isComment(node) || !node.data.startsWith(STAMP_PREFIX)) {
          continue;
        }
        stamps += 1;
        if (stamps > STAMPS_MAX) {
          return undefined;
        }
        const rest = node.data.slice(STAMP_PREFIX.length);
        const checksum = rest.slice(0, 64);
        const file = rest.slice(65);
        if (!/^[0-9a-f]{64}$/.test(checksum) || rest[64] !== ':' || !file) {
          continue;
        }
        const seen = byFile.get(file);
        if (seen !== undefined && seen !== checksum) {
          return undefined;
        }
        byFile.set(file, checksum);
      }
    }
    if (byFile.size > MANIFEST_FILES_MAX) {
      return undefined;
    }
    return [...byFile.keys()]
      .sort((left, right) => (left < right ? -1 : left === right ? 0 : 1))
      .map((file) => ({ file, checksum: byFile.get(file) ?? '' }));
  };
  const announceRender = () => {
    renderSeq += 1;
    const seq = renderSeq;
    renderToken = undefined; // Until this rendering's digest is known, events carry none.
    const stamps = readManifest();
    const subtle = globalThis.crypto?.subtle;
    if (!stamps || !subtle) {
      return;
    }
    const canonical = stamps.map((stamp) => `${stamp.checksum} ${stamp.file}\n`).join('');
    subtle.digest('SHA-256', new TextEncoder().encode(canonical)).then(
      (digest) => {
        if (seq !== renderSeq) {
          return;
        } // A newer rendering has announced itself.
        const bytes = Array.from(new Uint8Array(digest));
        renderToken = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
        try {
          window.parent.postMessage({ type: 'avb:render', token: renderToken, stamps }, '*');
        } catch {
          /* no parent to tell */
        }
      },
      () => {
        /* no digest, no token: the app refuses this rendering's events */
      },
    );
  };

  // Element nodes also carry their path as an attribute, because the node
  // references above go stale: the page's own scripts are free to rebuild
  // the DOM, and text-animation libraries do exactly that — GSAP SplitText
  // rewrites a paragraph as one clone per line, leaving the original element
  // (the one recorded here) holding just the last line. Attributes ride
  // along on clones, so the path can be re-resolved live. It has to be an
  // attribute rather than leaving marker *nodes* in the DOM: an element marker
  // would change what :first-child/:nth-child match.
  const PATH_ATTR = 'data-avb-p';

  // An element can carry more than one path, space separated. The page
  // addresses a slotted element by its page path (written into the markup by
  // the serializer, since a slotted node can't be wrapped in markers); the
  // component that renders the slot addresses that same element by its own
  // path. Whichever file is open picks its namespace out of the list.
  const pathsOf = (element: Element): string[] =>
    (element.getAttribute(PATH_ATTR) || '').split(' ').filter(Boolean);
  // Which tags this file put on an element itself, as opposed to the ones the
  // page arrived with. The serializer writes a tag into the markup wherever a
  // marker pair can't go — a slotted node, a word in an inline run, a component
  // whose root is a conditional — and those belong to the file. The ones added
  // here are bookkeeping, and only bookkeeping is ours to withdraw.
  const ourTags = new WeakMap<Element, Set<string>>();
  // The shortest path this element carries in each component file — a marker
  // run tags every element it holds, so one element can carry several paths in
  // the same file, and the shortest of them is the highest node it stands for.
  const nsOf = (element: Element): Map<string, string> => {
    const out = new Map<string, string>();
    for (const nodePath of pathsOf(element)) {
      const bar = nodePath.indexOf('|');
      if (bar === -1) {
        continue;
      }
      const file = nodePath.slice(0, bar + 1);
      const inner = nodePath.slice(bar + 1);
      const had = out.get(file);
      if (had === undefined || inner.length < had.length) {
        out.set(file, inner);
      }
    }
    return out;
  };

  // The nearest ancestor that stands for a node this one is nested UNDER, in
  // the same file. Undefined means this element is where that file's rendering
  // begins — the root of a component instance.
  const nsParent = (element: Element, file: string, inner: string): Element | undefined => {
    let up = taggedAncestor(element);
    while (up) {
      const theirs = nsOf(up).get(file);
      if (theirs !== undefined && inner.startsWith(`${theirs}.`)) {
        return up;
      }
      up = taggedAncestor(up);
    }
    return undefined;
  };
  // The nearest strict ancestor that carries a path, if any.
  const taggedAncestor = (element: Element): Element | undefined =>
    element.parentElement?.closest(`[${PATH_ATTR}]`) ?? undefined;

  // What the page calls a component instance belongs on the element the
  // instance rendered as its root. It does not always land there: the
  // serializer hands the page's path to the component as a prop, and the
  // component decides where its `...rest` goes. A form field forwards it to the
  // <select>, so a FormSelect was named on the control and not on the <label>
  // around it — and everything downstream meant the control. The outline drew
  // around the box and left the field's own label outside it, and a click on
  // that label reached past the component to whatever contained it.
  //
  // Only for an element that is inside a component's rendering and is not the
  // root of any of them. An element that IS a root already answers for its own
  // instance, and its page path is its own name: a page section is the root of
  // Section.astro and sits inside the layout's slot, so it carries a path in
  // the layout's namespace too — climbing that would put the section's name on
  // <body>.
  //
  // The path is added to the root rather than moved off the element the
  // component put it on: that element still answers to it in the component's
  // own file, and the outermost of the two is what the boxes and the hit
  // testing already prefer.
  // Whether a page path on this element ARRIVED here — the caller's name for an
  // instance, riding in on `{...rest}` — as opposed to being the element's own
  // name.
  //
  // The serializer writes an element's own path first and whatever came in on
  // the spread after it, and the tags this file adds are known (`ourTags`), so
  // what is left is what the page was served with. A page path at the head of
  // that list is the element's own name: the page wrote `<section>` and the
  // serializer tagged that very element, and there is nothing to work out.
  //
  // Without this, a plain section slotted into a layout was promoted — it
  // carries a path in the LAYOUT's namespace, because the collector tags
  // everything inside a marker run, and it is not the root of that namespace,
  // so the climb ran all the way to <html>. A Webflow export is exactly that
  // shape: nine sections, all nine names ending up on <html>, and selecting
  // any one of them outlined the entire page.
  const rodeIn = (element: Element, path: string): boolean => {
    const mine = ourTags.get(element);
    const written = pathsOf(element).filter((nodePath) => !mine?.has(nodePath));
    const at = written.indexOf(path);
    return at > 0 && written.slice(0, at).some((nodePath) => nodePath.includes('|'));
  };

  const promoteInstanceTags = () => {
    for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
      const page = pathsOf(element).filter(
        (nodePath) => !nodePath.includes('|') && rodeIn(element, nodePath),
      );
      if (!page.length) {
        continue;
      }
      const ns = nsOf(element);
      if (!ns.size) {
        continue;
      }
      let file: string | undefined = undefined;
      for (const [candidateFile, inner] of ns) {
        if (!nsParent(element, candidateFile, inner)) {
          file = undefined;
          break;
        } // a root: leave it alone
        if (!file) {
          file = candidateFile;
        }
      }
      if (!file) {
        continue;
      }
      // nsParent returns a strict ancestor, so the climb ends within the
      // element's depth in the document.
      let at = element;
      let innerOf = nsOf(at).get(file);
      let up = innerOf === undefined ? undefined : nsParent(at, file, innerOf);
      while (up) {
        at = up;
        innerOf = nsOf(at).get(file);
        up = innerOf === undefined ? undefined : nsParent(at, file, innerOf);
      }
      if (at === element) {
        continue;
      }
      for (const nodePath of page) {
        addPath(at, nodePath);
      }
    }
  };

  const addPath = (element: Element, nodePath: string): void => {
    const list = pathsOf(element);
    if (list.includes(nodePath)) {
      return;
    }
    list.push(nodePath);
    element.setAttribute(PATH_ATTR, list.join(' '));
    let mine = ourTags.get(element);
    if (!mine) {
      ourTags.set(element, (mine = new Set()));
    }
    mine.add(nodePath);
  };
  // The elements a path is on, one per copy — outermost only. A path can land
  // on an element AND on something inside it: inside slot content the marker
  // is written onto the markup (see serializeNodeMarked), and a component that
  // spreads its rest props puts it on whatever element it spreads onto, which
  // may sit inside the one the collector tagged. Those are one copy addressed
  // twice, and counting them as two made a node with a single instance report
  // "copy 2" for a click in the wrong half of itself — and the classes and
  // spacing lists, which are one entry per occurrence, disagree with the boxes.
  const elementsWithPath = (nodePath: string): Element[] => {
    const all: Element[] = Array.from(document.querySelectorAll(`[${PATH_ATTR}]`)).filter(
      (element) => pathsOf(element).includes(nodePath) && inFocus(element),
    );
    return all.filter(
      (element) => !all.some((other) => other !== element && other.contains(element)),
    );
  };

  // The path a node marks, or undefined when it isn't a marker. `kind` is 's'/'e'.
  const markerPath = (node: Node, kind: 's' | 'e'): string | undefined => {
    if (isComment(node)) {
      const tag = `avb-${kind}:`;
      return node.data.startsWith(tag) ? node.data.slice(tag.length) : undefined;
    }
    if (isElement(node) && node.tagName === 'TEMPLATE') {
      return node.getAttribute(`data-avb-${kind}`) ?? undefined;
    }
    return undefined;
  };

  const collectRegions = () => {
    pruneRegions();
    const { starts, markers } = findMarkers();
    // What each path was found to hold this pass, so a tag left on an element
    // the region no longer contains can be taken off again (untagStale).
    const collected = new Map<string, Set<Node>>();
    for (const start of starts) {
      const nodePath = markerPath(start, 's');
      if (nodePath === undefined) {
        continue;
      } // a start marker always carries a path
      const run = runAfter(start, nodePath);
      let set = collected.get(nodePath);
      if (!set) {
        set = new Set();
        collected.set(nodePath, set);
      }
      for (const node of run) {
        set.add(node);
      }
      recordRun(nodePath, run);
    }
    untagStale(collected);
    for (const node of markers) {
      if (isChildNode(node)) {
        node.remove();
      }
    }
    promoteInstanceTags();
    focusCache = undefined; // new runs — the focused instance may be among them
  };

  // Runs that have left the document go first. A patched page collects
  // again, and what it collected last time is either the same nodes (the
  // patch morphed them in place) or nodes that are gone — never a second
  // copy of the node, however many times the page is edited.
  const pruneRegions = () => {
    for (const [nodePath, runs] of regions) {
      const live = runs.filter(isLive);
      if (live.length) {
        regions.set(nodePath, live);
      } else {
        regions.delete(nodePath);
      }
    }
  };

  // One pass in document order over both marker forms — the deeper path has
  // to be seen last so that it wins the tag on an element they share.
  // Walked by hand rather than with a TreeWalker: this runs in the preload's
  // isolated world, and depending on nothing but firstChild/nextSibling
  // keeps it working whatever that world does or doesn't expose. It is also
  // the only thing standing between the page and no outlines at all —
  // startOutlines gives up entirely when nothing is recorded.
  const findMarkers = (): { starts: Node[]; markers: Node[] } => {
    const starts: Node[] = [];
    const markers: Node[] = [];
    const visit = (parent: Node, depth: number) => {
      if (depth > PRELOAD_LIMITS.domDepthMax) {
        return;
      }
      for (let node = parent.firstChild; node; node = node.nextSibling) {
        const isStart = markerPath(node, 's') !== undefined;
        if (isStart) {
          starts.push(node);
        }
        if (isStart || markerPath(node, 'e') !== undefined) {
          markers.push(node);
        }
        if (isElement(node)) {
          visit(node, depth + 1);
        }
      }
    };
    visit(document, 0);
    return { starts, markers };
  };

  // The run a start marker opens, tagging each element in it with the path.
  //
  // The run ends at the matching close marker, and a run with no close
  // marker among its siblings is EMPTY — never "everything after it".
  // Both markers are written as siblings around the node, so a start
  // whose end isn't there has lost it, and the honest reading of that is
  // that the region holds nothing. Swallowing instead put the following
  // element inside the region, which then answered for clicks on it: the
  // docs footer reported a comment when its fine print was clicked.
  const runAfter = (start: Node, nodePath: string): Node[] => {
    let end: Node | undefined = undefined;
    for (let node = start.nextSibling; node; node = node.nextSibling) {
      if (markerPath(node, 'e') === nodePath) {
        end = node;
        break;
      }
    }
    const run: Node[] = [];
    for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
      if (!end) {
        break;
      }
      run.push(node);
      // A chunk group's run contains its members, which are marked too —
      // document order puts the deeper path last, so it wins the tag.
      if (isElement(node) && node.tagName !== 'TEMPLATE') {
        addPath(node, nodePath);
      }
    }
    return run;
  };

  // The same place, collected again: it replaces itself. Appending would
  // make one node look like many — the same box drawn over and over (and
  // the overlays are translucent, so a node hovered after fourteen edits
  // was painted fourteen times, an opaque wash over the page), and every
  // count of "which copy" off by however many edits had been made.
  const recordRun = (nodePath: string, run: Node[]) => {
    if (!regions.has(nodePath)) {
      regions.set(nodePath, []);
    }
    const runs = regions.get(nodePath) ?? [];
    const again = runs.findIndex((other) => other.some((node) => run.includes(node)));
    if (again >= 0) {
      runs[again] = run;
    } else {
      runs.push(run);
    }
  };

  // A tag WE added is only good while the region still holds the element. They
  // used to accumulate and never come off, so one bad pass — a marker briefly
  // out of place — left an element permanently answering to a path it wasn't
  // in.
  //
  // The tags the markup came with are not ours to withdraw, and taking them
  // meant a click landing nowhere. Five buttons on a page all carry
  // `Button.astro|0.0.0` — the component's own root, the same path in every
  // instance — and only the ones a marker pair happened to wrap counted as
  // collected, so the rest lost the tag. Open Button.astro, click one of
  // those, and the canvas could not place the click at all: no path in the
  // open file, but something under the pointer, which reads as "looked away"
  // and closed the component you were editing.
  const untagStale = (collected: Map<string, Set<Node>>) => {
    for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
      const mine = ourTags.get(element);
      const kept = pathsOf(element).filter(
        (nodePath) =>
          !mine?.has(nodePath) ||
          !collected.has(nodePath) ||
          (collected.get(nodePath)?.has(element) ?? false),
      );
      if (kept.length === pathsOf(element).length) {
        continue;
      }
      for (const nodePath of pathsOf(element)) {
        if (!kept.includes(nodePath)) {
          mine?.delete(nodePath);
        }
      }
      if (kept.length) {
        element.setAttribute(PATH_ATTR, kept.join(' '));
      } else {
        element.removeAttribute(PATH_ATTR);
      }
    }
  };

  // Grows `acc` (a left/top/right/bottom box, or undefined) by one node's box.
  // `depth` counts the `display: contents` elements descended through.
  const addNode = (acc: Box | undefined, node: Node, depth = 0): Box | undefined => {
    if (!node.isConnected) {
      return acc;
    }
    if (depth > PRELOAD_LIMITS.domDepthMax) {
      return acc;
    }
    let rect: DOMRect | undefined = undefined;
    if (isElement(node)) {
      if (node.tagName === 'TEMPLATE') {
        return acc;
      }
      rect = node.getBoundingClientRect();
      // `display: contents` generates no box of its own, so the element
      // measures zero however big its content is. Astro sets it on
      // <astro-island>/<astro-slot>, which is every client: component — they
      // selected fine (hover walks the DOM) but drew no outline. Fall back to
      // the children, which do generate boxes.
      if (rect.width === 0 && rect.height === 0) {
        let grown = acc;
        for (const child of Array.from(node.childNodes)) {
          grown = addNode(grown, child, depth + 1);
        }
        return grown;
      }
    } else if (isComment(node)) {
      return acc; // a marker still sitting in a recorded run — no box to add
    } else if (isText(node) && node.textContent.trim()) {
      const range = document.createRange();
      range.selectNode(node);
      rect = range.getBoundingClientRect();
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return acc;
    }
    if (!acc) {
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }
    return {
      left: Math.min(acc.left, rect.left),
      top: Math.min(acc.top, rect.top),
      right: Math.max(acc.right, rect.right),
      bottom: Math.max(acc.bottom, rect.bottom),
    };
  };

  const toRect = (box: Box): Rect => ({
    x: box.left,
    y: box.top,
    w: box.right - box.left,
    h: box.bottom - box.top,
  });

  // One rect per marker-pair occurrence (a loop child renders once per
  // item — each instance gets its own box), unioned across the nodes
  // inside each occurrence.
  // The box of the nearest descendants that DO have regions, unioned. Used for
  // a node whose own markers could not survive the HTML parser: a layout wraps
  // <html>, so its start marker is hoisted into <head> and its end into <body>
  // — never siblings, so the pair is never found. Its children are inside the
  // body and marked normally, and their union is exactly the layout's box.
  const rectsFromDescendants = (nodePath: string): Rect[] | undefined => {
    const prefix = nodePath + '.';
    let best = Infinity;
    const paths: string[] = [];
    for (const key of regions.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const depth = key.split('.').length;
      if (depth < best) {
        best = depth;
        paths.length = 0;
      }
      if (depth === best) {
        paths.push(key);
      }
    }
    let acc: Box | undefined = undefined;
    for (const key of paths) {
      for (const run of runsOf(key) || []) {
        for (const node of run) {
          acc = addNode(acc, node);
        }
      }
    }
    return acc ? [toRect(acc)] : undefined;
  };

  // A box with no width or no height, sitting beside boxes that have both.
  //
  // A line-splitter (GSAP's SplitText, Splitting.js) rebuilds a heading into
  // one element per line and leaves the original inline elements behind, empty.
  // Emptied, they still carry the path tag and still have a box — zero wide and
  // a line tall — so the node that WAS a word now reported two places: a hollow
  // one and the real one. The hollow one is first in the document, so it is the
  // one an outline drew: a 1px bar against the left edge of the line.
  //
  // Kept when it is all there is: an element that genuinely renders nothing wide
  // should still show where it sits.
  const withoutHollow = (list: Rect[]): Rect[] => {
    const real = list.filter((rect) => rect.w > 0 && rect.h > 0);
    return real.length ? real : list;
  };

  // The tagged elements that are really PLACES, each with its box.
  //
  // No marker pair — a slotted element, or a word inside an inline run, carries
  // its path as an attribute instead: a marker beside either would land in the
  // wrong slot or add a space between words. Inside a loop that means one
  // tagged element per item, and they are the occurrences of that node.
  //
  // One list, read by the boxes AND by the click that picks one of them, so
  // "the second copy" means the same thing to both. It didn't: the outlines
  // counted tagged elements and the click counted marker runs, of which a
  // tagged node has none — so clicking the second link in a list reported
  // occurrence 0 and the first one lit up.
  const taggedPlaces = (nodePath: string): TaggedPlace[] => {
    const out: TaggedPlace[] = [];
    for (const element of elementsWithPath(nodePath)) {
      const acc = addNode(undefined, element);
      if (acc) {
        out.push({ el: element, rect: toRect(acc) });
      }
    }
    // A line splitter leaves hollow copies of an element behind; they are not
    // places, and counting them would shift every occurrence after them.
    const real = out.filter((place) => place.rect.w > 0 && place.rect.h > 0);
    return real.length ? real : out;
  };

  const rectsForPath = (nodePath: string): Rect[] | undefined => {
    const runs = runsOf(nodePath);
    if (!runs) {
      const places = taggedPlaces(nodePath);
      return places.length ? places.map((place) => place.rect) : rectsFromDescendants(nodePath);
    }
    const out: Rect[] = [];
    for (const run of runs) {
      let acc: Box | undefined = undefined;
      for (const node of run) {
        acc = addNode(acc, node);
      }
      if (acc) {
        out.push(toRect(acc));
      }
    }
    // A single node can still be many elements on the page — see PATH_ATTR:
    // a split paragraph's original element covers only its last line, and
    // the rest of it lives in clones. Union every tagged piece back into one
    // box. Repeated occurrences (a loop child, once per item) are meant to
    // stay separate boxes, so they keep the per-run rects above.
    if (runs.length === 1) {
      let acc = (runs[0] || []).reduce<Box | undefined>(
        (grown, node) => addNode(grown, node),
        undefined,
      );
      for (const element of elementsWithPath(nodePath)) {
        acc = addNode(acc, element);
      }
      // Nothing measurable: fall through to the children (see below).
      if (acc) {
        return [toRect(acc)];
      }
    }
    if (out.length) {
      return out;
    }
    // Every run measured nothing, yet the node may well be on screen: a page
    // script can replace the recorded nodes outright (a marquee that clones its
    // track, a slider that rebuilds slides). The tag survives on the clones, so
    // re-resolve from the live DOM — one box per tagged element, in document
    // order, which is the order occurrences are counted in. Without this a
    // looped node under such a script draws no outline at all, even though
    // clicking it still selects (nodeAt reads the same tag).
    const tagged = elementsWithPath(nodePath);
    if (tagged.length) {
      for (const element of tagged) {
        const acc = addNode(undefined, element);
        if (acc) {
          out.push(toRect(acc));
        }
      }
      const real = withoutHollow(out);
      if (real.length) {
        return real;
      }
    }
    // A region that exists but contains nothing with a box — the layout case:
    // its start marker is orphaned in <head>, so the walk collected the head's
    // scripts and links rather than the page. Its children still measure.
    return rectsFromDescendants(nodePath);
  };

  // The classes actually on the page for a node, one entry per occurrence (a
  // node inside a loop renders once per item). The model can't answer this:
  // `class:list={[...]}` and `class={expr}` are expressions, so the authored
  // source has no class text to read — only the rendered element knows what
  // the expression evaluated to for THIS instance.
  // The classes this file puts on the page itself, which the app must never see
  // among the element's own: they would show up in the class picker, in the
  // selector well, and in the navigator's labels as if the project had written
  // them.
  const STACKI_CLASSES = new Set(['stacki-opened', 'stacki-designer', 'stacki-preview']);
  const ownClasses = (element: Element): string[] =>
    Array.from(element.classList).filter((className) => !STACKI_CLASSES.has(className));

  const classesForPath = (nodePath: string): string[][] => {
    const out: string[][] = [];
    for (const run of runsOf(nodePath) || []) {
      const element = run.find(
        (node): node is Element => isElement(node) && node.tagName !== 'TEMPLATE',
      );
      if (element) {
        out.push(ownClasses(element));
      }
    }
    if (!out.length) {
      for (const element of elementsWithPath(nodePath)) {
        out.push(ownClasses(element));
      }
    }
    return out;
  };

  // The element's own spacing, in px, for the box the style panel draws over the
  // canvas: hovering `padding-top` there lights the strip of this element that
  // padding-top actually occupies. Read from the computed style rather than the
  // authored value, because that is the question being asked — where is it on
  // the page, not what was typed.
  const SIDES = ['top', 'right', 'bottom', 'left'];

  // Where an element's `gap` actually is, as rectangles.
  //
  // Padding and margin are four numbers on the element itself, so the panel can
  // draw them from the box alone. A gap is not: it lives BETWEEN children, and
  // where those children are is a question only the laid-out page can answer —
  // flex wraps, grid places, and neither is reconstructable from the parent's
  // rectangle. So the bands are measured here, in the same viewport coordinates
  // as every other rect, and the app only has to draw them.
  //
  // Measured, but never larger than the gap: with `justify-content:
  // space-between` the space between two children is the gap PLUS the free
  // space shared out between them, and lighting all of that would say `gap` is
  // bigger than it is. The band is capped at the computed gap and sits against
  // the child before it, which is the part of that space the property is
  // actually responsible for.
  // The children of a flex or grid box a gap can be seen between: each laid
  // out, with a box of its own.
  const gapChildRects = (element: Element): DOMRect[] => {
    const kids: DOMRect[] = [];
    for (const child of Array.from(element.children)) {
      if (child.tagName === 'TEMPLATE') {
        continue;
      }
      const rect = child.getBoundingClientRect();
      // A child with no box is not somewhere a gap can be seen.
      if (rect.width <= 0 && rect.height <= 0) {
        continue;
      }
      const cd = window.getComputedStyle(child).display;
      if (cd === 'none' || cd === 'contents') {
        continue;
      }
      kids.push(rect);
    }
    return kids;
  };

  // Children grouped into visual rows: two that overlap vertically are on
  // the same line, whether that line came from flex-wrap or from grid.
  const visualRows = (kids: DOMRect[]): GapRow[] => {
    const byTop = [...kids].sort((left, right) => left.top - right.top || left.left - right.left);
    const rows: GapRow[] = [];
    for (const rect of byTop) {
      const row = rows[rows.length - 1];
      const overlaps = row && rect.top < row.bottom - 1 && rect.bottom > row.top + 1;
      if (overlaps) {
        row.items.push(rect);
        row.top = Math.min(row.top, rect.top);
        row.bottom = Math.max(row.bottom, rect.bottom);
      } else {
        rows.push({ top: rect.top, bottom: rect.bottom, items: [rect] });
      }
    }
    return rows;
  };

  // Between columns, within each row.
  const columnGapBands = (rows: GapRow[], colGap: number): GapBand[] => {
    const bands: GapBand[] = [];
    for (const row of rows) {
      const across = [...row.items].sort((left, right) => left.left - right.left);
      for (let i = 1; i < across.length; i++) {
        const previous = across[i - 1];
        const next = across[i];
        if (!previous || !next) {
          continue;
        }
        const space = next.left - previous.right;
        const width = Math.min(space, colGap);
        if (width <= 0.5) {
          continue;
        }
        bands.push({
          axis: 'column',
          x: previous.right,
          y: row.top,
          w: width,
          h: row.bottom - row.top,
        });
      }
    }
    return bands;
  };

  // Between rows, across the width the children occupy.
  const rowGapBands = (rows: GapRow[], rowGap: number): GapBand[] => {
    const bands: GapBand[] = [];
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1];
      const next = rows[i];
      if (!previous || !next) {
        continue;
      }
      const space = next.top - previous.bottom;
      const height = Math.min(space, rowGap);
      if (height <= 0.5) {
        continue;
      }
      const span = [...previous.items, ...next.items];
      const left = Math.min(...span.map((rect) => rect.left));
      const right = Math.max(...span.map((rect) => rect.right));
      bands.push({ axis: 'row', x: left, y: previous.bottom, w: right - left, h: height });
    }
    return bands;
  };

  const gapBandsFor = (element: Element, cs: CSSStyleDeclaration): GapBand[] => {
    const display = cs.display;
    if (!/(^|\s)(flex|grid|inline-flex|inline-grid)$/.test(display)) {
      return [];
    }
    const colGap = parseFloat(cs.columnGap) || 0;
    const rowGap = parseFloat(cs.rowGap) || 0;
    if (colGap <= 0 && rowGap <= 0) {
      return [];
    }
    const kids = gapChildRects(element);
    if (kids.length < 2) {
      return [];
    }
    const rows = visualRows(kids);
    return [
      ...(colGap > 0 ? columnGapBands(rows, colGap) : []),
      ...(rowGap > 0 ? rowGapBands(rows, rowGap) : []),
    ];
  };

  const spacingForPath = (nodePath: string): (Spacing | undefined)[] => {
    const out: Element[] = [];
    for (const run of runsOf(nodePath) || []) {
      const element = run.find(
        (node): node is Element => isElement(node) && node.tagName !== 'TEMPLATE',
      );
      if (element) {
        out.push(element);
      }
    }
    if (!out.length) {
      out.push(...elementsWithPath(nodePath));
    }
    return out.map((element) => {
      try {
        const cs = window.getComputedStyle(element);
        const box = (kind: string) =>
          Object.fromEntries(
            SIDES.map((side): [string, number] => [
              side,
              parseFloat(cs.getPropertyValue(`${kind}-${side}`)) || 0,
            ]),
          );
        return { padding: box('padding'), margin: box('margin'), gaps: gapBandsFor(element, cs) };
      } catch {
        // Whatever went wrong measuring one element, the boxes everything else
        // depends on still have to be reported.
        return undefined;
      }
    });
  };

  // The boxes as last reported, so the watcher below can tell whether the page
  // has moved since — see `followMotion`.
  let lastSentRects: Record<string, Rect[] | undefined> = {};

  const sendRects = () => {
    if (!trackedPaths.length) {
      return;
    }
    const rects: Record<string, Rect[] | undefined> = {};
    const classes: Record<string, string[][]> = {};
    const spacing: Record<string, (Spacing | undefined)[]> = {};
    for (const nodePath of trackedPaths) {
      rects[nodePath] = rectsForPath(nodePath);
      classes[nodePath] = classesForPath(nodePath);
      spacing[nodePath] = spacingForPath(nodePath);
    }
    lastSentRects = rects;
    window.parent.postMessage(
      {
        type: 'avb:rects',
        rects,
        classes,
        spacing,
      },
      '*',
    );
  };

  // --- a page that moves by itself ------------------------------------------
  //
  // Every measurement above is triggered by something that HAPPENED: a scroll,
  // a mutation, a resize, an element changing size. A CSS animation is none of
  // those. A marquee translates its track sixty times a second with the DOM
  // untouched, the elements the same size and the page not scrolled — so a box
  // was measured once, at the moment the node was selected, and then stood
  // still while the thing it was drawn around travelled out from under it.
  //
  // A strip that renders its content twice makes that unreadable rather than
  // merely wrong: the copy the outline was measured on moves away, the other
  // copy arrives where it was, and the box looks like it is stuck on the first
  // copy however far along you click.
  //
  // Nothing announces this, so the only way to know is to look. Measure the
  // tracked boxes every so often, and when they have moved with nothing having
  // happened, follow them frame by frame until they settle again.
  const MOVE_SLACK = 0.5; // sub-pixel drift is not movement
  const STILL_FRAMES = 20; // …and a third of a second of stillness is a stop
  const LOOK_EVERY = 200; // ms between looks while the page is holding still

  const boxesMoved = (before: Rect[] | undefined, now: Rect[] | undefined): boolean => {
    if (!before || !now || before.length !== now.length) {
      return true;
    }
    for (let i = 0; i < now.length; i++) {
      for (const key of ['x', 'y', 'w', 'h'] as const) {
        if (Math.abs((before[i]?.[key] ?? 0) - (now[i]?.[key] ?? 0)) > MOVE_SLACK) {
          return true;
        }
      }
    }
    return false;
  };

  const trackedMoved = () => {
    for (const nodePath of trackedPaths) {
      // Never reported yet is not movement: the send that reports it is
      // already on its way.
      if (!lastSentRects[nodePath]) {
        continue;
      }
      if (boxesMoved(lastSentRects[nodePath], rectsForPath(nodePath))) {
        return true;
      }
    }
    return false;
  };

  let following = false;
  let stillFor = 0;
  const followMotion = () => {
    if (!trackedPaths.length) {
      following = false;
      return;
    }
    if (trackedMoved()) {
      stillFor = 0;
      // The measurements that go stale with the boxes. Not the `stacki-opened`
      // class: painting it writes to the DOM, and a write on every frame of an
      // animation is a mutation storm answered by another measurement.
      thinCache = undefined;
      focusCache = undefined;
      sendRects();
    } else if (++stillFor >= STILL_FRAMES) {
      following = false;
      return;
    }
    requestAnimationFrame(followMotion);
  };

  const watchMotion = () => {
    if (following || !trackedPaths.length || !trackedMoved()) {
      return;
    }
    following = true;
    stillFor = 0;
    requestAnimationFrame(followMotion);
  };

  // Nodes that put nothing on the page: a component that returns null for the
  // props it was given (an <Img> with no src, a grid with no children) still
  // has its marker pair, with nothing between them. Structural only — no
  // measuring — so this can cover every node in the file rather than the two
  // or three whose rects are tracked. A node that renders only whitespace
  // counts as empty; one that renders a zero-size element does not, because
  // something IS there.
  // What actually reached the page. Reported the positive way round, because
  // a node can put nothing on screen in two ways: its markers are there with
  // nothing between them (a component that returned null), or its markers
  // never got emitted at all — everything inside a component that rendered
  // nothing, whose slot content was never evaluated. Only the app knows the
  // full node list, so it takes this set and treats the rest as unrendered.
  //
  // Structural only, no measuring, so it can cover every node in the file.
  // The scope and instance the page-wide answers were last worked out for.
  // `undefined` until the first track, so the first one always answers.
  let lastQuestion: string | undefined;
  let lastRenderedKey = '';
  const sendRendered = () => {
    const rendered = [];
    for (const nodePath of regions.keys()) {
      if (!inScope(nodePath)) {
        continue;
      }
      let live = false;
      for (const run of runsOf(nodePath) || []) {
        for (const node of run) {
          if (!node.isConnected) {
            continue;
          }
          if (isElement(node) && node.tagName !== 'TEMPLATE') {
            live = true;
          } else if (isText(node) && node.textContent !== null && node.textContent.trim()) {
            live = true;
          }
          if (live) {
            break;
          }
        }
        if (live) {
          break;
        }
      }
      // The tag survives on clones when a script rebuilds the DOM, so a node
      // whose recorded run went stale is still rendering something.
      if (!live && elementsWithPath(nodePath).length) {
        live = true;
      }
      if (live) {
        rendered.push(nodePath);
      }
    }
    // A slotted node is never wrapped in markers — it's addressed by the tag
    // alone (see pathsOf) — so it has no region to be found above. Anything
    // carrying a tag is on the page by definition.
    for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
      if (!inFocus(element)) {
        continue;
      }
      for (const nodePath of pathsOf(element)) {
        if (inScope(nodePath) && !rendered.includes(nodePath)) {
          rendered.push(nodePath);
        }
      }
    }
    sendStates(rendered);
    const key = rendered.join('\n');
    if (key === lastRenderedKey) {
      return;
    }
    lastRenderedKey = key;
    window.parent.postMessage({ type: 'avb:rendered-nodes', paths: rendered }, '*');
  };

  // Nodes that are on the page but not taking part in it: `display: none` (there
  // and not drawn) and `pointer-events: none` (drawn and not clickable). Both
  // are true of the element as the page computes it — they can arrive from any
  // rule in any stylesheet, so the source cannot answer and the navigator has
  // no way to ask per row.
  //
  // Read in the same pass, and only for nodes that put an element on the page:
  // a computed style is cheap to read one at a time and not free by the
  // hundred, so this rides the walk that already happens rather than adding
  // one of its own.
  let lastStatesKey = '';
  const firstElementFor = (nodePath: string): Element | undefined => {
    for (const run of runsOf(nodePath) || []) {
      const element = run.find(
        (node): node is Element => isElement(node) && node.tagName !== 'TEMPLATE',
      );
      if (element && element.isConnected) {
        return element;
      }
    }
    return elementsWithPath(nodePath)[0] || undefined;
  };
  const sendStates = (rendered: string[]): void => {
    const hidden = [];
    const inert = [];
    for (const nodePath of rendered) {
      const element = firstElementFor(nodePath);
      if (!element) {
        continue;
      }
      try {
        const cs = window.getComputedStyle(element);
        if (cs.display === 'none') {
          hidden.push(nodePath);
        }
        if (cs.pointerEvents === 'none') {
          inert.push(nodePath);
        }
      } catch {
        /* an element that cannot be measured says nothing about itself */
      }
    }
    const key = `${hidden.join(' ')}|${inert.join(' ')}`;
    if (key === lastStatesKey) {
      return;
    }
    lastStatesKey = key;
    window.parent.postMessage({ type: 'avb:node-states', hidden, inert }, '*');
  };

  // The classes each node actually ended up with. `class:list={[...]}` and
  // `class={expr}` are expressions, so the source can't say what they resolve
  // to — only the rendered element knows, and the navigator has no way to ask
  // per row. Reported for every node in the open file, first instance only:
  // a label needs one answer, and where instances differ the first is the one
  // the outline and the props panel are already showing.
  let lastClassKey = '';
  const sendClasses = () => {
    const out: Record<string, string[]> = {};
    for (const nodePath of regions.keys()) {
      if (!inScope(nodePath)) {
        continue;
      }
      const list = classesForPath(nodePath)[0];
      if (list && list.length) {
        out[nodePath] = list;
      }
    }
    // Slotted nodes have no marker pair, so they never appear above.
    for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
      const own = ownClasses(element);
      if (!own.length || !inFocus(element)) {
        continue;
      }
      for (const nodePath of pathsOf(element)) {
        if (inScope(nodePath) && !out[nodePath]) {
          out[nodePath] = own;
        }
      }
    }
    const key = JSON.stringify(out);
    if (key === lastClassKey) {
      return;
    }
    lastClassKey = key;
    window.parent.postMessage({ type: 'avb:node-classes', classes: out }, '*');
  };

  // Selecting a node in the navigator brings it onto the page. Only scrolls
  // when the node is actually out of sight — re-selecting something already
  // on screen shouldn't move the page under the user.
  const SCROLL_MARGIN = 24;
  // Where the page has to go for a box to be on screen, along one axis: the
  // scroll position it already has when the box is comfortably inside, and
  // otherwise enough to bring it in. A box longer than the viewport is aligned
  // to its start rather than centred, which would push the beginning of it out.
  const revealAlong = (start: number, length: number, viewport: number, at: number): number => {
    if (start >= SCROLL_MARGIN && start + length <= viewport - SCROLL_MARGIN) {
      return at;
    }
    const offset = length >= viewport - SCROLL_MARGIN * 2 ? SCROLL_MARGIN : (viewport - length) / 2;
    return Math.max(0, at + start - offset);
  };
  const scrollPathIntoView = (nodePath: string, occ: number): void => {
    const rects = rectsForPath(nodePath);
    if (!rects || !rects.length) {
      return;
    }
    // One path can render many times (a node inside a loop, a component used
    // repeatedly). Scroll to the instance being worked in, not whichever one
    // happens to come first in the document.
    const rect = rects[occ] ?? rects[0]; // viewport-relative
    if (!rect) {
      return;
    }
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const top = revealAlong(rect.y, rect.h, vh, window.scrollY);
    // Sideways too. A site can be wider than the frame — full-bleed sliders,
    // a track of cards, a decorative circle hanging off the edge — and once the
    // canvas is scrolled across, everything on it reads as having slipped off
    // to the left with no scrollbar to say otherwise. Selecting something is
    // how you ask to see it, so it is also how you get back.
    const left = revealAlong(rect.x, rect.w, vw, window.scrollX);
    if (top === window.scrollY && left === window.scrollX) {
      return;
    }
    window.scrollTo({ top, left, behavior: 'smooth' });
  };

  // `stacki-opened` on the instance being edited — the one that was actually
  // double-clicked, not every copy of the component. It goes on the element(s)
  // the instance rendered at its top level, which for a component with one root
  // is that root; a component that renders two siblings marks both, because it
  // has no single root to speak of.
  //
  // Painted from focusRoots(), so it means exactly what the outline, the hit
  // testing and the scroll-to mean by "the open instance" — one place decides,
  // and a component used inside a loop marks the card that was opened.
  //
  // Where the instance IS depends on how it was addressed. Most have a marker
  // pair, and the run between it is them. A component whose root is a
  // conditional has none: `{render && heading && (<details/>)}` renders the
  // branch's own element and the serializer puts the path on that element
  // rather than wrapping it — a marker beside it would land outside the branch,
  // where it would mark the instance whether the branch rendered or not. Same
  // for a component rendered into another one's slot. The element carrying the
  // path is the instance, so that is what gets marked, and the occurrence picks
  // the copy that was opened exactly as the click that opened it did.
  // A component's region holds its <script> and <style> too. They are elements,
  // and they are not what anyone means by the root of the component.
  const UNRENDERED = new Set(['TEMPLATE', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE']);
  const openedRoots = (): Element[] =>
    (focusRoots() || []).filter(
      (node): node is Element => isElement(node) && !UNRENDERED.has(node.tagName),
    );

  let openedEls: Element[] = [];
  const paintOpened = () => {
    const next = openedRoots();
    // Only when it actually moved. Writing the class again with the same value
    // is still a write, and the canvas re-measures on any mutation — so a
    // repaint that changed nothing scheduled the next repaint, once a frame,
    // for as long as the component stayed open.
    if (next.length === openedEls.length && next.every((element, i) => element === openedEls[i])) {
      return;
    }
    for (const element of openedEls) {
      if (!next.includes(element)) {
        element.classList.remove('stacki-opened');
      }
    }
    for (const element of next) {
      element.classList.add('stacki-opened');
    }
    openedEls = next;
  };

  // The canvas answers two different questions, and only one of them is asked
  // by a pointer.
  //
  //   where the tracked nodes ARE — a box each, for the two or three paths the
  //   app is watching. Changes when the page scrolls, when something moves, and
  //   when the app watches a different node.
  //
  //   what the page IS — which nodes put anything on it, and what each one's
  //   classes came out as. Those are facts about the whole file: they cost a
  //   walk of every marked node, five thousand of them on a page of any size,
  //   and they can only change when the DOM does.
  //
  // Both were sent together, so moving the pointer to a new node re-walked the
  // page. On a large one that walk is most of a second, and it is the wait
  // before an outline appears.
  let rectsQueued = false;
  let pageQueued = false;
  const queueRects = (pageToo = false) => {
    thinCache = undefined; // scrolled, resized or rebuilt — every box moved
    focusCache = undefined; // …including the instance being edited
    pageQueued = pageQueued || pageToo;
    if (rectsQueued) {
      return;
    }
    rectsQueued = true;
    requestAnimationFrame(() => {
      rectsQueued = false;
      const page = pageQueued;
      pageQueued = false;
      paintOpened();
      sendRects();
      if (page) {
        sendRendered();
        sendClasses();
      }
    });
  };

  // Measure on the next frame, and once more a moment later. The second pass is
  // for changes whose effect lands after the change itself: a stylesheet swapped
  // into <head> by the dev server is applied, then the page relayouts, and a box
  // read in between is the box from before. Dragging a padding value writes CSS
  // several times a second, so a measurement one beat behind is an outline that
  // never catches up.
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const remeasure = () => {
    // Something changed the document — which nodes rendered, and what their
    // classes resolved to, are both back in question.
    queueRects(true);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => queueRects(true), 120);
  };

  // Which rendered copy of a node the target sits in. A node inside a loop
  // is recorded once per item, so the runs are the instances in order.
  const occurrenceOf = (path: string, target: Node | undefined): number => {
    const runs = runsOf(path);
    if (runs && runs.length > 1) {
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (!run) {
          continue;
        }
        for (const node of run) {
          if (!node.isConnected) {
            continue;
          }
          if (node === target) {
            return i;
          }
          if (node.nodeType === 1 && target !== undefined && node.contains(target)) {
            return i;
          }
        }
      }
      return 0;
    }
    // A node addressed by its tag rather than by markers has no runs at all —
    // a link inside a list item is written as part of an inline run, and a
    // marker between the words would render as a space. Its copies are the
    // tagged elements, counted in the same order the boxes are measured in.
    const places = taggedPlaces(path);
    if (places.length > 1) {
      for (let i = 0; i < places.length; i++) {
        const place = places[i];
        if (!place) {
          continue;
        }
        const element = place.el;
        if (element === target) {
          return i;
        }
        if (target !== undefined && element.contains(target)) {
          return i;
        }
      }
    }
    return 0;
  };

  // Nodes that render as a line — an empty <div>, an <hr>, a wrapper whose
  // children are all absolutely positioned. They have a box, and the app draws
  // it, but nothing can be *inside* something zero pixels tall, so the hit test
  // below always lands on the parent and they'd be reachable only from the
  // navigator. Hit-test those with a few pixels of slack instead, which is how
  // wide the outline looks anyway.
  const THIN = 3; // a box this flat can't be entered
  const THIN_SLACK = 5; // …so accept the cursor this near it
  let thinCache: ThinTarget[] | undefined = undefined;
  const thinTargets = (): ThinTarget[] => {
    if (thinCache) {
      return thinCache;
    }
    thinCache = [];
    for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
      if (!inFocus(element)) {
        continue;
      }
      const nodePath = pathsOf(element).find(inScope);
      if (!nodePath) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      // Fully collapsed (0×0) is left alone: the app draws no outline for it,
      // so snapping to it would highlight nothing.
      if (rect.width < 1 && rect.height < 1) {
        continue;
      }
      if (rect.height > THIN && rect.width > THIN) {
        continue;
      }
      thinCache.push({ path: nodePath, el: element, box: rect });
    }
    return thinCache;
  };

  // The deepest line-thin node the cursor is within slack of. Constrained to
  // descendants of what the normal hit test found, so this only ever refines
  // the answer — it can't jump to something else on the page.
  const thinAt = (x: number, y: number, best: string | undefined): ThinTarget | undefined => {
    let hit: ThinTarget | undefined = undefined;
    let hitDepth = best ? best.split('.').length : 0;
    for (const target of thinTargets()) {
      if (best && !target.path.startsWith(best + '.')) {
        continue;
      }
      const depth = target.path.split('.').length;
      if (depth <= hitDepth) {
        continue;
      }
      const box = target.box;
      if (x < box.left - THIN_SLACK || x > box.right + THIN_SLACK) {
        continue;
      }
      if (y < box.top - THIN_SLACK || y > box.bottom + THIN_SLACK) {
        continue;
      }
      hit = target;
      hitDepth = depth;
    }
    return hit;
  };

  // Deepest marked node whose rendered DOM contains the target, plus which
  // instance of it was hit — the app outlines only that one.
  const nodeAt = (
    target: Node | undefined,
    x?: number,
    y?: number,
  ): { path: string | undefined; occurrence: number; outside: boolean } => {
    const tagged = taggedFor(target, x, y);
    // Whether anything at all was under the pointer, focus aside. No path
    // means the canvas could not place the click; `outside` means it could,
    // somewhere this file/instance doesn't own — and only the second is
    // somebody looking away from what they are editing. The app needs them
    // apart: it backs out of a component on one and must sit still for the
    // other.
    const anyTag = target instanceof Element ? target.closest(`[${PATH_ATTR}]`) : undefined;
    const best = deepestRegionAt(target, x, y, tagged && pathsOf(tagged).find(inScope));
    // Nothing containing the cursor can be flat, so this runs last, over the
    // node that did win: a zero-height child of it takes precedence.
    if (x !== undefined && y !== undefined) {
      const thin = thinAt(x, y, best);
      if (thin) {
        return { path: thin.path, occurrence: occurrenceOf(thin.path, thin.el), outside: false };
      }
    }
    // Resolved separately from the search above: when the winning path came
    // from the tag, its own runs were never scanned.
    return {
      path: best,
      occurrence: best ? occurrenceOf(best, target) : 0,
      outside: !best && !!anyTag,
    };
  };

  // What lights up has to contain the pointer.
  //
  // A page's own scripts are free to put a child's box outside its parent's,
  // and text animation does it as a matter of course: GSAP's SplitText gives
  // every word a line box taller than the line, so a word hangs thirteen
  // pixels above the component holding it — measured, on the page this came
  // from. The pointer in the space above a heading is over one of those
  // words; the browser says so, truthfully; and what got picked was a node
  // whose outline starts BELOW the pointer. Which reads, fairly, as the
  // margin above a thing being treated as part of the thing.
  //
  // So an element only answers for a point its own box holds. One that
  // doesn't hands the question to the element above it, which is what the
  // person was pointing at.
  const EDGE = 1; // the outline is drawn on the boundary; that pixel counts
  const holdsPoint = (element: Element, x: number | undefined, y: number | undefined) => {
    if (x === undefined || y === undefined) {
      return true;
    }
    const rect = element.getBoundingClientRect();
    // No box at all — a <template>, something display:none — cannot answer.
    if (rect.width === 0 && rect.height === 0) {
      return true;
    }
    return (
      x >= rect.left - EDGE &&
      x <= rect.right + EDGE &&
      y >= rect.top - EDGE &&
      y <= rect.bottom + EDGE
    );
  };

  // The tagged element that answers for the target. Clones the page's own
  // scripts made aren't in any recorded run, so the tag is the only way to
  // reach them — without this, clicking a split paragraph would select its
  // parent instead.
  const taggedFor = (target: Node | undefined, x?: number, y?: number): Element | undefined => {
    let tagged =
      target instanceof Element ? (target.closest(`[${PATH_ATTR}]`) ?? undefined) : undefined;
    while (x !== undefined && tagged && !holdsPoint(tagged, x, y)) {
      tagged = taggedAncestor(tagged);
    }
    // Walk out of any nested namespace until the tag belongs to the open file
    // — and, while an instance is focused, until it belongs to that instance:
    // a click on one of its siblings resolves to nothing, which is how the app
    // hears "done in here".
    while (tagged !== undefined && !(inFocus(tagged) && pathsOf(tagged).some(inScope))) {
      tagged = taggedAncestor(tagged);
    }
    return tagged;
  };

  // The deepest in-scope path whose marker run holds the target, or the path
  // the tag named when no run goes deeper.
  const deepestRegionAt = (
    target: Node | undefined,
    x: number | undefined,
    y: number | undefined,
    tagPath: string | undefined,
  ): string | undefined => {
    let best = tagPath;
    let bestDepth = best ? best.split('.').length : -1;
    for (const nodePath of regions.keys()) {
      if (!inScope(nodePath)) {
        continue;
      }
      const runs = runsOf(nodePath) || [];
      const depth = nodePath.split('.').length;
      if (depth <= bestDepth) {
        continue;
      }
      for (const run of runs) {
        const hit = run.some(
          (node) =>
            node.isConnected &&
            node.nodeType === 1 &&
            (node === target || (target !== undefined && node.contains(target))),
        );
        if (hit) {
          // Same rule for a node addressed by markers rather than by a tag:
          // its run has to be where the pointer is.
          if (x !== undefined && !run.some((node) => isElement(node) && holdsPoint(node, x, y))) {
            break;
          }
          best = nodePath;
          bestDepth = depth;
          break;
        }
      }
    }
    return best;
  };

  // What the pointer is actually over. A page script that calls
  // setPointerCapture — drag carousels, sliders, anything with a grab
  // cursor — makes every later pointer event, INCLUDING the click, report
  // the capturing element as its target. Trusting e.target there selects the
  // whole carousel however deep you click. Hit-test the cursor instead; a
  // synthesised event with no coordinates keeps e.target.
  const targetAt = (event: MouseEvent): Node | undefined =>
    (event.clientX || event.clientY
      ? document.elementFromPoint(event.clientX, event.clientY)
      : undefined) || (event.target instanceof window.Node ? event.target : undefined);

  // Same resolution for hover, click and dblclick, so what lights up under the
  // cursor is exactly what a click selects.
  const nodeAtEvent = (event: MouseEvent) =>
    event.clientX || event.clientY
      ? nodeAt(targetAt(event), event.clientX, event.clientY)
      : nodeAt(targetAt(event));

  const startOutlines = () => {
    // A page edit now patches the document instead of reloading it, so the
    // markers this map is built from move without the page ever going away.
    // Registered before the early return: the first collection can come up
    // empty (a page whose markup arrives with the first patch), and this is
    // what gets it a second chance.
    document.addEventListener('avb:morphed', () => {
      collectRegions();
      announceMapped();
      queueRects(true);
    });
    collectRegions();
    // Said even when the page has no markers at all: "nothing here" is a real
    // answer, and withholding it would leave every question waiting out its
    // timeout.
    announceMapped();
    if (!regions.size) {
      return;
    }
    // Wrapped, not passed straight in: a listener is handed the Event, and
    // queueRects reads its first argument as "the page may have changed too".
    // An Event is not false, so every scroll asked for the whole-page walk —
    // half a second of it on a page of any size, sixty times a second while
    // the wheel is moving.
    window.addEventListener('scroll', () => queueRects(), true);
    window.addEventListener('resize', remeasure);
    // The whole document, not just the body: styling something writes CSS, and
    // the dev server delivers CSS by swapping a <style> in <head>. Watching the
    // body alone meant the element moved under an outline that had no idea
    // anything had happened — the outline only caught up when something else
    // (a scroll, an edit to the markup) asked for a fresh measurement.
    new MutationObserver(remeasure).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    // A layout that changed without changing the DOM at all — a rule edited
    // through the CSSOM, a font finishing loading, a container query flipping.
    // Nothing to observe there but the boxes themselves.
    try {
      const ro = new ResizeObserver(remeasure);
      ro.observe(document.documentElement);
      if (document.body) {
        ro.observe(document.body);
      }
    } catch {
      /* no ResizeObserver: the observers above still cover the common cases */
    }
    // And a page that moves with nothing happening at all — an animation, a
    // transition, anything that only changes where things are. Nothing above
    // fires for that; see followMotion.
    lookForMotion();
    listenForPointer();
  };

  // Polls for motion nothing announces (see followMotion).
  const lookForMotion = () => {
    const look = setInterval(watchMotion, LOOK_EVERY);
    // A repeating timer is the one thing here that would hold a Node process
    // open — the suites run this file in jsdom, and a page's heartbeat is not
    // a reason for `node test/…` never to come back. In the browser the handle
    // is a number and this does nothing — both are checked without asserting.
    if (
      typeof look === 'object' &&
      look !== null &&
      'unref' in look &&
      typeof look['unref'] === 'function'
    ) {
      look['unref']();
    }
  };

  // Hover, double-click and click, each resolved to the node under the pointer.
  const listenForPointer = () => {
    document.addEventListener('mousemove', (event) => {
      const { path: nodePath, occurrence } = nodeAtEvent(event);
      if (
        lastHover === undefined ||
        nodePath !== lastHover.path ||
        occurrence !== lastHover.occurrence
      ) {
        lastHover = { path: nodePath, occurrence };
        postLocated('avb:hover-node', { path: nodePath, occurrence });
      }
    });
    document.documentElement.addEventListener('mouseleave', startOutlinesClearHover);
    // Double-clicking a component opens it for editing, the way Webflow
    // drills into one.
    document.addEventListener(
      'dblclick',
      (event) => {
        if (!designMode) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        // Report even when nothing in scope matched: markup the layout renders
        // itself (nav, footer — anything outside the page's <slot>) has no
        // in-scope marker, and the app opens the layout for those.
        // With the occurrence: a component inside a loop renders once per
        // item, and opening it means the one under the cursor.
        const { path: nodePath, occurrence } = nodeAtEvent(event);
        postLocated('avb:open-node', { path: nodePath || undefined, occurrence });
      },
      true,
    );

    // In the design canvas (any frame the app tracks paths in), clicking
    // selects the node in the app instead of activating links/buttons.
    // Interactive preview frames never receive avb:track, so they keep
    // normal page behavior.
    document.addEventListener(
      'click',
      (event) => {
        if (!designMode) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        // A click that hits no marked node still reports (no path), with
        // `outside` saying whether it landed on something the open file simply
        // doesn't own — which is what the app backs out of a component on.
        const { path: nodePath, occurrence, outside } = nodeAtEvent(event);
        postLocated('avb:click-node', {
          path: nodePath || undefined,
          occurrence,
          outside: !!outside,
        });
      },
      true,
    );
  };

  function startOutlinesClearHover(): void {
    // Told nothing yet, or told of a node: either way, the pointer has left.
    if (lastHover === undefined || lastHover.path !== undefined) {
      lastHover = { path: undefined, occurrence: 0 };
      // Clear messages use the same located-message contract as hover hits.
      postLocated('avb:hover-node', { path: undefined, occurrence: 0 });
    }
  }

  // Every located event names the rendering it landed on (step 7): the app
  // acts on it only while that rendering is still what the files hold.
  function postLocated(type: string, located: Record<string, unknown>): void {
    window.parent.postMessage({ type, ...located, token: renderToken }, '*');
  }

  let designMode = false;

  let frozen = false;
  // --- Asking the page itself ------------------------------------------------
  //
  // The style panel used to answer "does this selector target this element?"
  // by walking the app's source tree, which stops at a component's edge: a
  // rule hinging on a class the component renders (`.section > *`) looked like
  // no match, and a class added by a script was invisible. The rendered page
  // is right here, so ask it — Chromium's own selector engine, over the real
  // DOM, knows every element and every class however it got there.
  const elementsForPath = (nodePath: string): Element[] => {
    const out: Element[] = [];
    for (const run of runsOf(nodePath) || []) {
      for (const node of run) {
        if (!isElement(node)) {
          continue;
        }
        // A run holds everything between the marker pair, which includes the
        // markers of anything nested. Those are detached once collected, and a
        // <template> among them — from a page served before this app was
        // updated — never describes the element anyway: reporting one as the
        // node's identity tells the style panel the tag is `template` and there
        // are no classes. Same rule the rect measuring uses.
        if (!node.isConnected || node.tagName === 'TEMPLATE') {
          continue;
        }
        out.push(node);
      }
    }
    for (const element of elementsWithPath(nodePath)) {
      if (!out.includes(element)) {
        out.push(element);
      }
    }
    // A node that renders nothing of its own (a component wrapping a fragment,
    // `display: contents`) still has descendants that do — the first of those
    // stands in for it, the same fallback the rect measuring uses.
    if (!out.length) {
      const first = Array.from(document.querySelectorAll(`[${PATH_ATTR}]`)).find((element) =>
        pathsOf(element).some((x) => x.startsWith(nodePath + '.')),
      );
      if (first) {
        out.push(first);
      }
    }
    return out;
  };

  const identityOf = (element: Element) => ({
    tag: element.tagName.toLowerCase(),
    id: element.id || undefined,
    classes: ownClasses(element),
    attributes: Object.fromEntries(
      Array.from(element.attributes)
        .filter((attribute) => attribute.name !== PATH_ATTR)
        .map((attribute) => [attribute.name, attribute.value]),
    ),
  });

  // The app posts these messages with structured payloads; anything else from
  // its window — or from another frame entirely — is not ours to act on.
  const recordPayload = (x: unknown): x is Record<string, unknown> =>
    typeof x === 'object' && x !== null;

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) {
      return;
    }
    const data: unknown = event.data;
    if (!recordPayload(data)) {
      return;
    }
    if (data['type'] === 'avb:query' && typeof data['id'] === 'number') {
      answerQuery(data, data['id']);
      return;
    }
    if (data['type'] === 'avb:track' && Array.isArray(data['paths'])) {
      track(data, data['paths']);
    }
    if (data['type'] === 'avb:scroll-to' && typeof data['path'] === 'string') {
      scrollPathIntoView(data['path'], typeof data['occ'] === 'number' ? data['occ'] : 0);
    }
    if (data['type'] === 'avb:set-vh' && typeof data['px'] === 'number') {
      freezeViewportHeight(data['px']);
    }
  });

  const answerQuery = (data: Record<string, unknown>, id: number) => {
    const els = typeof data['path'] === 'string' ? elementsForPath(data['path']) : [];
    const wanted = (Array.isArray(data['compute']) ? data['compute'] : []).filter(
      (value): value is string => typeof value === 'string',
    );
    // No element named, or none found: the question is about the page rather
    // than about a node. That is what the variables panel asks — a value is
    // the same colour wherever it is written, and the custom properties it
    // leans on are declared on :root, which is this element. Only `compute`
    // takes this: the reads below are ABOUT a node, and answering them from
    // the root would be answering a different question.
    const host = els[0] || document.documentElement;
    const computed = wanted.length && host ? computeValues(host, wanted) : {};
    const props = Array.isArray(data['props']) ? data['props'] : [];
    const computedProps = props.length && els[0] ? computeProperties(els[0], props) : {};
    const selectors = (Array.isArray(data['selectors']) ? data['selectors'] : []).filter(
      (value): value is string => typeof value === 'string',
    );
    const matched: Record<string, boolean | undefined> = {};
    for (const selector of selectors) {
      try {
        // Any of the element's occurrences matching counts — a loop child is
        // one node in the tree and many elements on the page.
        matched[selector] = els.some((element) => element.matches(selector));
      } catch {
        matched[selector] = undefined; // not a selector this engine accepts
      }
    }
    window.parent.postMessage(
      {
        type: 'avb:query-result',
        id,
        ready: mapped,
        found: els.length > 0,
        computed,
        computedProps,
        identity: els[0] ? identityOf(els[0]) : undefined,
        matched,
      },
      '*',
    );
  };

  // What a value actually resolves to ON THIS ELEMENT. `var(--background)`
  // means nothing in the app's own document — the panel painted it there
  // and got transparent — and it can mean different things on two elements
  // of the same page (a theme class, a container query, a colour scheme).
  // Only the page can say, so it is asked: a throwaway span in the element
  // inherits its custom properties, takes the value as a colour, and the
  // engine hands back the computed one.
  const computeValues = (host: Element, wanted: string[]): Record<string, string | undefined> => {
    const computed: Record<string, string | undefined> = {};
    const probe = document.createElement('span');
    probe.setAttribute('style', 'position:absolute;width:0;height:0;visibility:hidden');
    host.appendChild(probe);
    for (const value of wanted) {
      try {
        // A sentinel first: assigning a value the engine rejects leaves the
        // previous one in place, and reading that back would report a
        // colour the value never had.
        probe.style.color = 'rgb(1, 2, 3)';
        probe.style.color = value;
        computed[value] =
          probe.style.color === 'rgb(1, 2, 3)' ? undefined : getComputedStyle(probe).color;
      } catch {
        computed[value] = undefined;
      }
    }
    probe.remove();
    return computed;
  };

  // What the element's style ACTUALLY is for a property nothing in the panel
  // sets — inherited from a parent, painted by a `*` rule the panel can't see
  // past a component edge, or a user-agent default. The panel highlights that
  // value in its dropdowns so an unset control still shows what's on the page.
  const computeProperties = (
    element: Element,
    props: unknown[],
  ): Record<string, string | undefined> => {
    const computedProps: Record<string, string | undefined> = {};
    // Design mode paints `cursor: default !important` over everything (see the
    // top of this file), so the page's own cursor is hidden behind it. Lift that
    // sheet for the read and put it straight back — nothing paints in between,
    // and otherwise every element would report `default`.
    const designStyle = document.getElementById('avb-design-style');
    const designSheet = designStyle instanceof HTMLStyleElement ? designStyle : undefined;
    try {
      if (designSheet) {
        designSheet.disabled = true;
      }
      const cs = getComputedStyle(element);
      for (const prop of props) {
        if (typeof prop !== 'string') {
          continue;
        }
        computedProps[prop] = cs.getPropertyValue(prop) || undefined;
      }
    } catch {
      // A detached or cross-document element answers nothing; the panel
      // falls back to its own defaults.
    } finally {
      if (designSheet) {
        designSheet.disabled = false;
      }
    }
    return computedProps;
  };

  const track = (data: Record<string, unknown>, paths: unknown[]) => {
    designMode = true;
    trackedPaths = paths.filter((nodePath): nodePath is string => typeof nodePath === 'string');
    activeScope = typeof data['scope'] === 'string' ? data['scope'] : '';
    focusPath = typeof data['focus'] === 'string' ? data['focus'] : '';
    focusOcc = typeof data['focusOcc'] === 'number' ? data['focusOcc'] : 0;
    focusCache = undefined;
    thinCache = undefined; // scope decides what's hit-testable
    paintOpened();
    sendRects();
    // The page-wide answers, but only when the QUESTION changed. Tracking a
    // different node does not change which nodes rendered — and the app
    // tracks a new node on every hover, so answering that here walked the
    // whole page each time the pointer moved.
    //
    // The scope and the focused instance do change it: both decide which
    // nodes are asked about at all.
    const question = `${activeScope}|${focusPath}|${focusOcc}`;
    if (question !== lastQuestion) {
      lastQuestion = question;
      lastRenderedKey = '';
      lastClassKey = '';
      sendRendered();
      sendClasses();
    }
  };

  const freezeViewportHeight = (px: number) => {
    document.documentElement.style.setProperty('--avb-vh', px / 100 + 'px');
    if (!frozen) {
      frozen = true;
      rewriteSheets();
      // Subresources — @import among them — are done by `load`, so take one
      // more pass then even if the retries above have run out.
      window.addEventListener('load', scheduleRewrite);
      // Vite HMR injects/replaces <style> tags — keep the override current
      // (and last in the cascade).
      new MutationObserver(scheduleRewrite).observe(document.head || document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
    report();
  };

  const start = () => {
    report();
    startOutlines();
    // Tell the app which route this frame is on (used by interactive
    // preview mode to follow link navigation).
    try {
      window.parent.postMessage(
        { type: 'avb:navigated', path: location.pathname + location.search },
        '*',
      );
    } catch {
      /* ignore */
    }
    try {
      const ro = new ResizeObserver(report);
      ro.observe(document.documentElement);
      if (document.body) {
        ro.observe(document.body);
      }
    } catch {
      /* old engines: load event still reports */
    }
    window.addEventListener('load', report);
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
} else {
  // Top-level return is not expressible in TypeScript, so the two halves of
  // this preload — the frame-side canvas logic above, the app-facing bridge
  // below — are an if/else on the same flag.

  // Types erase here: sandboxed preload cannot require arbitrary local modules.
  // Main parses every payload before it reaches a handler.
  const invoke =
    <K extends IpcChannel>(channel: K) =>
    (
      ...args: undefined extends IpcPayloads[K]
        ? [payload?: IpcPayloads[K]]
        : [payload: IpcPayloads[K]]
    ): Promise<unknown> =>
      ipcRenderer.invoke(channel, args[0]);

  contextBridge.exposeInMainWorld('avb', {
    platform: process.platform,

    // Project:
    openProjectDialog: invoke('project:openDialog'),
    newProjectDialog: invoke('project:newDialog'),
    scaffoldProject: invoke('project:scaffold'),
    createAstroProject: invoke('project:createAstro'),
    parentDialog: invoke('project:parentDialog'),
    createStarter: invoke('project:createStarter'),
    hasNodeModules: invoke('project:hasNodeModules'),
    installDeps: invoke('project:install'),
    scanProject: invoke('project:scan'),
    listProjectClasses: invoke('project:classes'),
    watchProject: invoke('watch:start'),

    // Assets (public/)
    listAssets: invoke('assets:list'),
    pickUploadAssets: invoke('assets:pickUpload'),
    uploadAssets: invoke('assets:upload'),
    moveAsset: invoke('assets:move'),
    renameAsset: invoke('assets:rename'),
    deleteAsset: invoke('assets:delete'),
    mkdirAssets: invoke('assets:mkdir'),
    readAssetText: invoke('assets:readText'),
    writeAssetText: invoke('assets:writeText'),
    // The source file an imported symbol is defined in — data files, consts,
    // anything the page pulls values from.
    readSymbolSource: invoke('src:readSymbol'),
    resolveSourcePath: invoke('src:resolvePath'),
    assetDimensions: invoke('assets:dimensions'),
    readSourceText: invoke('src:readText'),
    writeSourceText: invoke('src:writeText'),
    // OS drag-and-drop: resolve a DOM File to its filesystem path.
    getFilePath: (file: File) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        // Ourselves before Electron 29: the file carried its path as a
        // non-standard property that the shipped typings never declare.
        return 'path' in file && typeof file['path'] === 'string' ? file['path'] : undefined;
      }
    },
    onAssetsChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('assets:changed', listener);
      return () => ipcRenderer.removeListener('assets:changed', listener);
    },

    // ⇧⌘C — the canvas selection as file:line pointers, for an AI chat.
    copySelection: invoke('selection:copy'),

    // CMS (JSON data under src/)
    listCms: invoke('cms:list'),
    readCms: invoke('cms:read'),
    writeCms: invoke('cms:write'),
    createCms: invoke('cms:create'),
    deleteCms: invoke('cms:delete'),
    cmsUsage: invoke('cms:usage'),
    cmsAssetRef: invoke('cms:assetRef'),
    resolveImport: invoke('project:resolveImport'),
    cmsMeta: invoke('cms:meta'),
    contentConfig: invoke('content:config'),
    // Variables (CSS custom properties)
    cssVariables: invoke('css:variables'),
    setCssVariable: invoke('css:setVariable'),
    moveCssVariables: invoke('css:moveVariables'),
    addCssVariables: invoke('css:addVariables'),
    renameCssVariables: invoke('css:renameVariables'),
    setCssSectionTitle: invoke('css:setSectionTitle'),
    removeCssSection: invoke('css:removeSection'),
    addCssSection: invoke('css:addSection'),
    moveCssHeading: invoke('css:moveHeading'),
    onCssChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('css:changed', listener);
      return () => ipcRenderer.removeListener('css:changed', listener);
    },

    contentCollections: invoke('content:collections'),
    contentEntries: invoke('content:entries'),
    writeContentEntry: invoke('content:writeEntry'),
    validateContentEntry: invoke('content:validate'),
    contentTargets: invoke('content:targets'),
    contentRenamePlan: invoke('content:renamePlan'),
    renameContentEntry: invoke('content:rename'),
    setCmsMeta: invoke('cms:setMeta'),
    onCmsChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('cms:changed', listener);
      return () => ipcRenderer.removeListener('cms:changed', listener);
    },

    // Recent projects:
    listRecents: invoke('recents:list'),
    addRecent: invoke('recents:add'),
    removeRecent: invoke('recents:remove'),
    refreshThumb: invoke('recents:refreshThumb'),
    onThumbUpdated: (callback: (payload: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('recents:thumb', listener);
      return () => ipcRenderer.removeListener('recents:thumb', listener);
    },

    // Pages:
    readPage: invoke('page:read'),
    parsePageSource: invoke('page:parse'),
    editPage: invoke('page:edit'),
    previewPageEdit: invoke('page:previewEdit'),
    createPage: invoke('page:create'),
    deletePage: invoke('page:delete'),
    movePage: invoke('page:move'),
    createPageFolder: invoke('pagefolder:create'),
    renamePageFolder: invoke('pagefolder:rename'),
    deletePageFolder: invoke('pagefolder:delete'),
    importPathFor: invoke('page:importPathFor'),
    rebaseImport: invoke('page:rebaseImport'),
    createComponent: invoke('component:create'),
    componentProperties: invoke('component:properties'),
    editComponentProperties: invoke('component:editProperties'),
    revertComponentProperties: invoke('component:revertProperties'),
    componentUsage: invoke('component:usage'),
    dynamicPaths: invoke('page:dynamicPaths'),
    injectedRoutes: invoke('project:injectedRoutes'),
    sampleEntry: invoke('content:sampleEntry'),

    // Dev server:
    startDevServer: invoke('dev:start'),
    stopDevServer: invoke('dev:stop'),
    diagnoseDev: invoke('dev:diagnose'),
    probeDevPage: invoke('dev:probe'),

    // Style panel targets:
    listStyleFiles: invoke('style:listFiles'),
    listAstroStyleFiles: invoke('style:listAstroStyles'),
    readStyleFile: invoke('style:readFile'),
    writeStyleFile: invoke('style:writeFile'),

    // Git:
    gitInfo: invoke('git:info'),
    ghStatus: invoke('git:ghStatus'),
    gitInit: invoke('git:init'),
    gitCheckout: invoke('git:checkout'),
    previewAtCommit: invoke('preview:atCommit'),
    previewStop: invoke('preview:stop'),
    checkPreview: invoke('preview:check'),
    gitLog: invoke('git:log'),
    gitCommitFiles: invoke('git:commitFiles'),
    gitAllFiles: invoke('git:allFiles'),
    gitStatus: invoke('git:status'),
    gitFileAt: invoke('git:fileAt'),
    gitWorktrees: invoke('git:worktrees'),
    gitPark: invoke('git:park'),
    gitUnpark: invoke('git:unpark'),
    gitMerge: invoke('git:merge'),
    gitResolveMerge: invoke('git:resolveMerge'),
    gitDeleteBranch: invoke('git:deleteBranch'),
    gitCommit: invoke('git:commit'),
    gitRestoreFile: invoke('git:restoreFile'),
    gitRestoreProject: invoke('git:restoreProject'),
    gitPush: invoke('git:push'),
    gitPublish: invoke('git:publish'),

    openExternal: invoke('shell:openExternal'),

    // Dev only: the project to reopen after a "Reload All Code" relaunch.
    pendingProject: invoke('project:pending'),
    closeProject: invoke('project:close'),

    // Terminal (node-pty). Keystrokes and render acks are `send`, not `invoke`:
    // they're high-frequency and one-way, so they shouldn't pay for a round trip.
    startTerminal: invoke('terminal:start'),
    resizeTerminal: invoke('terminal:resize'),
    closeTerminal: invoke('terminal:close'),
    terminalInput: (id: string, data: string) => ipcRenderer.send('terminal:input', { id, data }),
    terminalAck: (id: string, count: number) => ipcRenderer.send('terminal:ack', { id, count }),
    terminalClipboardImage: (bytes: Uint8Array, mime: string) =>
      ipcRenderer.invoke('terminal:clipboardImage', { bytes, mime }),
    onTerminalData: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    onTerminalExit: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    },
    onTerminalProcess: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('terminal:process', listener);
      return () => ipcRenderer.removeListener('terminal:process', listener);
    },

    // Events:
    onPageMaybeChanged: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('page:maybe-changed', listener);
      return () => ipcRenderer.removeListener('page:maybe-changed', listener);
    },
    onDevLog: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('dev:log', listener);
      return () => ipcRenderer.removeListener('dev:log', listener);
    },
    onDevExit: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('dev:exit', listener);
      return () => ipcRenderer.removeListener('dev:exit', listener);
    },
    onProgress: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('progress', listener);
      return () => ipcRenderer.removeListener('progress', listener);
    },
    // Live output from `npm create astro@latest`, shown in the new-project wizard.
    onCreateLog: (callback: (chunk: unknown) => void) => {
      const listener = (_event: unknown, chunk: unknown) => callback(chunk);
      ipcRenderer.on('create:log', listener);
      return () => ipcRenderer.removeListener('create:log', listener);
    },
    onFsChanged: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('fs:changed', listener);
      return () => ipcRenderer.removeListener('fs:changed', listener);
    },

    // App preferences — read once on load; the menu pushes changes as they happen.
    settings: invoke('settings:get'),

    // Application menu events (macOS menu accelerators never reach the DOM)
    onMenu: (channel: string, callback: (data?: unknown) => void) => {
      // The payload is forwarded: a checkbox item sends its new state, and the
      // items that send nothing simply call back with undefined as before.
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on(`menu:${channel}`, listener);
      return () => ipcRenderer.removeListener(`menu:${channel}`, listener);
    },
    nativeCopy: invoke('native:copy'),
    nativePaste: invoke('native:paste'),
    nativeUndo: invoke('native:undo'),
    nativeRedo: invoke('native:redo'),
  } satisfies PreloadBridge);
}
