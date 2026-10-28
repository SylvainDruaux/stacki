// The sheet's two stacks, and the rows in them.
//
//   node test/renderer/variables/varsRowHeight.test.js
//
// The sheet is drawn as two stacks side by side: the names, which stay put, and
// the values, which scroll sideways. Every line runs across both, so the two
// only read as one sheet while they agree line for line about how tall each one
// is. Anything that changes a row's height on one side alone — a control added
// to a heading, a field that opens taller than the text it replaces — slides
// every value out of line with its name, all the way down. That is not obvious
// from the markup of either side, so it is measured here.
//
// A name in the variables sheet turns into a field when you click it, and a
// field is a taller box than the text it replaces. So the row grew, and every
// row under it moved down — in a sheet you read by running your eye down the
// names, which is the moment you are least able to afford the list jumping.
//
// Whether one box is taller than another is a question for a layout engine, so
// this mounts the real sheet with the real stylesheet in a real browser, clicks
// a name, and measures the row it is in. jsdom would report every height as
// zero and be perfectly happy.
// Hit-testing the menu and measuring scroll ranges with Studio's mobile styles
// also catch overlays that exist in the DOM but cannot receive pointer input.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const STYLESHEET = `:root {
  /* Swatches */
  --light-100: #ffffff;
  --light-200: #ebebeb;
  --dark-900: #1f1d1e;
  --brand-500: #c6fb50;

  /* Palette */

  /* Radius */
  --radius-small: 0.5rem;
  --radius-main: 1rem;
  --radius-round: 100vw;
}

:root,
.theme-light {
  --selection-background: var(--dark-900);
  --selection-text: var(--light-100);
  --button-background: var(--light-100);
  --button-text: var(--dark-900);
  --card-background: var(--light-200);
  --card-text: var(--dark-900);
}

.theme-dark {
  --selection-background: var(--light-100);
  --selection-text: var(--dark-900);
  --button-background: var(--dark-900);
  --button-text: var(--light-100);
  --card-background: var(--dark-900);
  --card-text: var(--light-200);
}
`;

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-varsrow-'));
  fs.mkdirSync(path.join(directory, 'src', 'styles'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'electron-profile'));
  fs.writeFileSync(path.join(directory, 'src', 'styles', 'tokens.css'), STYLESHEET);

  const cssVars = require('#dist/electron/project/cssVars.js');
  const data = cssVars.readVariables(directory);

  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/varsrow');
  fs.mkdirSync(buildDirectory, { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import VariablesView from './src/features/variables/VariablesView.tsx'
        import './src/app/styles.css'
        const root = createRoot(document.getElementById('root'))
        window.__show = (index) => root.render(
          <VariablesView
            project={{ path: '/p' }}
            selected={{ file: 'src/styles/tokens.css', index }}
            hidden={false}
            onClose={() => root.render(undefined)}
            showToast={(m) => { window.__toast = m }}
          />
        )
        window.__show(0)
      `,
      resolveDir: ROOT,
      loader: 'jsx',
    },
    outfile: path.join(buildDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
  });

  // The sheet reads the project over the bridge; in here the answer is the one
  // the real reader produced from the fixture above, handed over as a literal.
  fs.writeFileSync(
    path.join(buildDirectory, 'index.html'),
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css">
     <style>body { margin: 0; background: #191919 }</style>
     <div id="root"></div>
     <script>
       window.avb = {
         cssVariables: async () => (${JSON.stringify(data)}),
         onCssChanged: () => () => {},
         listStyleFiles: async () => ({ files: [] }),
         listAstroStyleFiles: async () => ({ files: [] }),
         readStyleFile: async () => ({ css: '' }),
         renameCssVariables: async () => ({ ok: true }),
         moveCssVariables: async (payload) => {
           window.__moves = payload.moves;
           return { ok: true };
         },
         moveCssHeading: async (payload) => { window.__heading = payload; return { ok: true } },
         readStyleFile: async () => ({ css: '' }),
         writeStyleFile: async () => ({ ok: true }),
       };
     </script>
     <script src="bundle.js"></script>`,
  );

  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log(
      'vars-row-height: skipped — no Electron to lay it out in ' +
        '(see test/electron/preload/gapBands.test.js for the pattern)',
    );
    return;
  }

  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.setPath('userData', ${JSON.stringify(path.join(directory, 'electron-profile'))});
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       // Native scroll and ResizeObserver delivery need a mapped window on Linux.
       // Keep it rendering without taking focus from the user's current window.
       const win = new BrowserWindow({
         show: false, width: 1000, height: 800,
         webPreferences: { backgroundThrottling: false },
       });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       win.showInactive();
       const js = (code) => win.webContents.executeJavaScript(code).catch((error) => {
         console.error('Failed renderer probe:', code);
         throw error;
       });
       const pointerAt = (type, x, y) => js(
         "(() => { const target = " +
           (type === 'pointerdown' ? "document.elementFromPoint(" + x + "," + y + ")" : "window") +
           "; if (!target) return false; target.dispatchEvent(new PointerEvent(" +
           JSON.stringify(type) +
           ", { bubbles: true, clientX: " + x + ", clientY: " + y +
           ", button: 0, buttons: " + (type === 'pointerup' ? 0 : 1) +
           ", pointerId: 1, pointerType: 'mouse', isPrimary: true })); return true; })()"
       );
       await new Promise((r) => setTimeout(r, 600));
       const out = {};
       // The invariant the whole sheet rests on: line n of the names and line n
       // of the values start at the same height and are the same size. Measured
       // first, with nothing clicked — the heading's menu is in the DOM from the
       // start (hidden until hover), which is how it pushed the stacks apart.
       out.stacks = await js("(() => { const box = (el) => { const r = " +
         "el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)] }; " +
         "return [...document.querySelectorAll('.vars-table')].map((table, " +
         "i) => { const fixed = [...table.querySelectorAll('.vars-fixed .vars-row')].map(box); " +
         "const scroll = [...table.querySelectorAll('.vars-scroll .vars-row')].map(box); " +
         "const off = fixed.map((f, n) => (scroll[n] ? [f[0] - scroll[n][0], " +
         "f[1] - scroll[n][1]] : null)); const last = [...table.querySelectorAll('.vars-fixed " +
         ".vars-row')].pop(); return { table: i, counts: [fixed.length, scroll.length], " +
         "extraIsAddRow: fixed.length === scroll.length || (fixed.length === scroll.length + 1 " +
         "&& !!last && last.className.includes('vars-add')), " +
         "mismatched: off.filter((o) => o && (o[0] !== 0 || o[1] !== 0)).length, " +
         "worst: off.filter(Boolean).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))[0] } }) })()");
       // Every row's height before anything is clicked, and where the row after
       // the one being renamed starts.
       // The heading's menu. It is portaled to <body>, outside the panel's own
       // reset, where the app's global button rule centres everything — so where
       // its rows start is a real question and not a styling detail.
       out.menu = await js("(() => { const b = document.querySelector('.vars-section-menu'); " +
         "if (!b) return null; b.click(); return true })()");
       await new Promise((r) => setTimeout(r, 120));
       out.menuRows = await js("(() => { const menu = document.querySelector('.more-menu'); " +
         "if (!menu) return null; const items = [...menu.querySelectorAll('.more-menu-item')]; " +
         "const m = menu.getBoundingClientRect(); return { labels: items.map((i) => " +
         "i.textContent.trim()), justify: getComputedStyle(items[0]).justifyContent, " +
         "iconLefts: items.map((i) => " +
         "Math.round(i.querySelector('svg').getBoundingClientRect().left - m.left)), " +
         "reachable: items.every((item) => { const r = item.getBoundingClientRect(); " +
         "return item.contains(document.elementFromPoint(r.left + r.width / 2, " +
         "r.top + r.height / 2)) }), sameStart: new Set(items.map((i) => " +
         "Math.round(i.querySelector('svg').getBoundingClientRect().left))).size === 1 } })()");
       // A coordinate-based click must reach Rename through the floating frame.
       await js("(() => { const item = document.querySelector('.more-menu-item'); " +
         "const r = item.getBoundingClientRect(); const target = document.elementFromPoint(" +
         "r.left + r.width / 2, r.top + r.height / 2); " +
         "if (item.contains(target)) target.click() })()");
       await new Promise((r) => setTimeout(r, 200));
       out.menuRename = await js("!!document.querySelector('.vars-section .vars-rename-input')");
       await js("document.querySelector('.vars-section .vars-rename-input')?.dispatchEvent(" +
         "new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
       out.before = await js("(() => { const rows = [...document.querySelectorAll('.vars-fixed " +
         ".vars-row')]; const name = rows.find((r) => (r.textContent || " +
         "'').includes('light-100')); const next = rows[rows.indexOf(name) + 1]; " +
         "return { rowH: Math.round(name.getBoundingClientRect().height), " +
         "nextTop: Math.round(next.getBoundingClientRect().top), heads: rows.length } })()");
       out.clicked = await js("(() => { const b = [...document.querySelectorAll('.vars-name " +
         ".vars-rename')].find((n) => n.textContent === 'light-100'); if (!b) return null; " +
         "b.click(); return true })()");
       await new Promise((r) => setTimeout(r, 150));
       out.after = await js("(() => { const rows = [...document.querySelectorAll('.vars-fixed " +
         ".vars-row')]; const editing = rows.find((r) => r.querySelector('.vars-rename-input')); " +
         "if (!editing) return null; const next = rows[rows.indexOf(editing) + 1]; " +
         "return { rowH: Math.round(editing.getBoundingClientRect().height), " +
         "nextTop: Math.round(next.getBoundingClientRect().top), " +
         "fieldH: " +
         "Math.round(editing.querySelector('.vars-rename-input').getBoundingClientRect().height) " +
         "} })()");
       // A heading that is a comment above some names opens the same way — it
       // writes the comment rather than any name, and it must not move the sheet
       // either.
       out.commentBefore = await js("(() => { const h = " +
         "[...document.querySelectorAll('.vars-fixed .vars-section')].find((n) => " +
         "/radius/i.test(n.textContent || '')); return h ? { text: h.textContent.trim(), " +
         "renamable: !!h.querySelector('.vars-rename'), h: " +
         "Math.round(h.getBoundingClientRect().height) } : null })()");
       out.commentClicked = await js("(() => { const b = " +
         "[...document.querySelectorAll('.vars-section .vars-rename')].find((n) => " +
         "/radius/i.test(n.textContent)); if (!b) return null; b.click(); return true })()");
       await new Promise((r) => setTimeout(r, 150));
       out.commentAfter = await js("(() => { const h = " +
         "[...document.querySelectorAll('.vars-fixed .vars-section')].find((n) => " +
         "n.querySelector('.vars-rename-input')); return h ? { h: " +
         "Math.round(h.getBoundingClientRect().height), value: " +
         "h.querySelector('.vars-rename-input').value } : null })()");

       // A group of modes, whose headings ARE names its rows share.
       await js('window.__show(1)');
       await new Promise((r) => setTimeout(r, 300));
       out.headBefore = await js("(() => { const h = [...document.querySelectorAll('.vars-fixed " +
         ".vars-section')].find((n) => (n.textContent || '').includes('selection')); " +
         "return h ? Math.round(h.getBoundingClientRect().height) : null })()");
       out.headClicked = await js("(() => { const b = " +
         "[...document.querySelectorAll('.vars-section .vars-rename')].find((n) => n.textContent " +
         "=== 'selection'); if (!b) return null; b.click(); return true })()");
       await new Promise((r) => setTimeout(r, 150));
       out.headAfter = await js("(() => { const h = [...document.querySelectorAll('.vars-fixed " +
         ".vars-section')].find((n) => n.querySelector('.vars-rename-input')); " +
         "return h ? Math.round(h.getBoundingClientRect().height) : null })()");
       // Dragging a variable from one group into another — the whole chain, from
       // a real press to the file edit that is asked for. A group is a run of
       // lines between two comments, so "into the empty group" comes out as
       // "in front of the first line of the group after it".
       await js('window.__show(0)');
       await new Promise((r) => setTimeout(r, 300));
       // Pressed on the NAME, which is what anyone reaching for a variable grabs.
       // (It is a button now — it opens the rename field — so this is exactly the
       // press that has to still start a drag.)
       const grab = await js("(() => { const n = [...document.querySelectorAll('.vars-name " +
         ".vars-rename')].find((el) => el.textContent === 'light-200'); if (!n) return null; " +
         "const b = n.getBoundingClientRect(); return { x: Math.round(b.left + 10), " +
         "y: Math.round(b.top + b.height / 2) } })()");
       const drop = await js("(() => { const tables = " +
         "[...document.querySelectorAll('.vars-table')]; const t = tables.find((n) => " +
         "/Palette/.test(n.textContent)); if (!t) return null; " +
         "const add = t.querySelector('.vars-fixed .vars-add'); " +
         "const b = add.getBoundingClientRect(); return { x: Math.round(b.left + 40), " +
         "y: Math.round(b.top + b.height / 2) } })()");
       if (grab && drop) {
         await pointerAt('pointerdown', grab.x, grab.y);
         await new Promise((r) => setTimeout(r, 50));
         for (let i = 1; i <= 6; i++) {
           await pointerAt('pointermove', grab.x, Math.round(grab.y + ((drop.y - grab.y) * i) / 6));
           await new Promise((r) => setTimeout(r, 25));
         }
         await pointerAt('pointerup', drop.x, drop.y);
         await new Promise((r) => setTimeout(r, 200));
       }
       out.drag = { grabbed: !!grab, dropped: !!drop, moves: await js('window.__moves || null') };

       // And the heading, dragged by its name for the same reason: the heading's
       // text is a button too.
       const grabHead = await js("(() => { const n = " +
         "[...document.querySelectorAll('.vars-section .vars-rename')].find((el) => " +
         "/Radius/.test(el.textContent)); if (!n) return null; " +
         "const b = n.getBoundingClientRect(); return { x: Math.round(b.left + 10), " +
         "y: Math.round(b.top + b.height / 2) } })()");
       // Above the row's middle, which is the line between "in front of this one"
       // and "after it".
       const dropHead = await js("(() => { const r = [...document.querySelectorAll('.vars-fixed " +
         ".vars-row')].find((n) => (n.textContent || '').includes('light-200')); " +
         "if (!r) return null; const b = r.getBoundingClientRect(); " +
         "return { x: Math.round(b.left + 40), y: Math.round(b.top + 3) } })()");
       if (grabHead && dropHead) {
         await pointerAt('pointerdown', grabHead.x, grabHead.y);
         await new Promise((r) => setTimeout(r, 50));
         for (let i = 1; i <= 6; i++) {
           await pointerAt(
             'pointermove',
             grabHead.x,
             Math.round(grabHead.y + ((dropHead.y - grabHead.y) * i) / 6),
           );
           await new Promise((r) => setTimeout(r, 25));
         }
         await pointerAt('pointerup', dropHead.x, dropHead.y);
         await new Promise((r) => setTimeout(r, 200));
       }
       out.headingDrag = { grabbed: !!grabHead, asked: await js('window.__heading || null') };

       // The shared bar lives outside the vertical scroller. Test actual layout,
       // native scroll events, and resizing rather than synthetic DOM widths.
       await js('window.__show(1)');
       await new Promise((r) => setTimeout(r, 200));
       await js("Object.assign(document.querySelector('.vars-view').style, " +
         "{ width: '560px', height: '280px' })");
       await new Promise((r) => setTimeout(r, 200));
       const scrollSnapshot = () => js("(() => { const bar = " +
         "document.querySelector('.vars-horizontal-scroll'); const body = " +
         "document.querySelector('.vars-body'); const strips = " +
         "[...body.querySelectorAll('.vars-scroll-rows, .vars-scroll-head')]; " +
         "return { count: document.querySelectorAll('.vars-horizontal-scroll').length, " +
         "visible: !bar.parentElement.hidden, left: bar.scrollLeft, " +
         "maximum: bar.scrollWidth - bar.clientWidth, " +
         "viewport: bar.clientWidth, start: bar.getBoundingClientRect().left, " +
         "bottom: bar.getBoundingClientRect().bottom, " +
         "bodyBottom: body.getBoundingClientRect().bottom, scrollTop: body.scrollTop, " +
         "nameLeft: body.querySelector('.vars-name').getBoundingClientRect().left, " +
         "strips: strips.map(s => ({ left: s.scrollLeft, " +
         "viewport: s.clientWidth, start: s.getBoundingClientRect().left, " +
         "maximum: s.scrollWidth - s.clientWidth })), " +
         "hiddenBars: [...body.querySelectorAll('.vars-scroll-rows')].every(s => " +
         "getComputedStyle(s).scrollbarWidth === 'none') } })()");
       // Poll real geometry for at most two seconds. A fixed sleep can finish
       // before the compositor delivers scroll events or resize notifications.
       const waitForScroll = async (ready) => {
         let snapshot = await scrollSnapshot();
         for (let attempt = 0; attempt < 100; attempt++) {
           if (ready(snapshot)) return snapshot;
           await new Promise((resolve) => setTimeout(resolve, 20));
           snapshot = await scrollSnapshot();
         }
         return snapshot;
       };
       const aligned = (snapshot) => snapshot.visible && snapshot.maximum > 0 &&
         snapshot.strips.every((strip) => strip.viewport === snapshot.viewport &&
           strip.start === snapshot.start) &&
         snapshot.maximum === Math.max(...snapshot.strips.map((strip) => strip.maximum));
       const synchronized = (snapshot) => snapshot.strips.every((strip) =>
         Math.abs(strip.left - Math.min(strip.maximum, snapshot.left)) <= 1);
       out.scrollBefore = await waitForScroll(aligned);
       await js("document.querySelector('.vars-horizontal-scroll').scrollLeft = 10000");
       out.scrollEnd = await waitForScroll((snapshot) => aligned(snapshot) &&
         snapshot.left === snapshot.maximum && synchronized(snapshot));
       await js("document.querySelector('.vars-body').scrollTop = 10000");
       out.scrollVertical = await waitForScroll((snapshot) => snapshot.scrollTop > 0);
       await js("document.querySelector('.vars-scroll-rows').scrollLeft = 12");
       out.scrollGesture = await waitForScroll((snapshot) =>
         snapshot.left === 12 && synchronized(snapshot));
       await js("document.querySelector('.vars-view').style.width = '950px'");
       out.scrollWide = await waitForScroll((snapshot) => !snapshot.visible &&
         snapshot.strips.every((strip) => strip.maximum === 0));
       await js("document.querySelector('.vars-view').style.width = '560px'");
       out.scrollNarrow = await waitForScroll(aligned);

       // Closing must actually unmount the view: a mode kept only in React
       // state survives tab changes but is lost when the X removes the editor.
       const waitForMode = async (expected) => {
         let mode;
         for (let attempt = 0; attempt < 100; attempt++) {
           mode = await js("document.querySelector('.vars-view')?.dataset.windowMode");
           if (mode === expected) return mode;
           await new Promise((resolve) => setTimeout(resolve, 20));
         }
         return mode;
       };
       await js("document.querySelector('.dockable-window-toggle').click()");
       await waitForMode('docked');
       await js("document.querySelector('.vars-view [title=Close]').click()");
       out.closedDocked = await waitForMode(undefined) === undefined;
       await js('window.__show(1)');
       out.reopenedDocked = await waitForMode('docked');
       await js("document.querySelector('.vars-view[data-window-mode=docked] " +
         ".dockable-window-toggle')?.click()");
       await waitForMode('floating');
       await js("document.querySelector('.dockable-window-header').dispatchEvent(" +
         "new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
       await js("document.querySelector('.window-resize-e').dispatchEvent(" +
         "new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
       out.floatingPlacement = await js("document.querySelector('.vars-view').style.cssText");
       await js("document.querySelector('.vars-view [title=Close]').click()");
       out.closedFloating = await waitForMode(undefined) === undefined;
       await js('window.__show(1)');
       out.reopenedFloating = await waitForMode('floating');
       out.reopenedPlacement = await js("document.querySelector('.vars-view').style.cssText");

       // Studio changes column sizes below 700px. The common bar must inherit
       // those sizes too, including the gap between the grip and the name.
       await win.webContents.insertCSS(${JSON.stringify(
         fs.readFileSync(repoPath('studio/src/app/studio.css'), 'utf8'),
       )});
       await js("document.getElementById('root').className = 'studio-editor-content'");
       win.setSize(390, 800);
       await waitForScroll((snapshot) => aligned(snapshot) &&
         snapshot.viewport < out.scrollNarrow.viewport);
       await js("document.querySelector('.vars-horizontal-scroll').scrollLeft = 10000");
       out.scrollMobile = await waitForScroll((snapshot) => aligned(snapshot) &&
         snapshot.left === snapshot.maximum && synchronized(snapshot));

       console.log(JSON.stringify(out));
       app.quit();
     }).catch((error) => { console.error(error); app.exit(1); });`,
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000 });
  const line = (run.stdout || '').split('\n').find((line) => line.trim().startsWith('{'));
  if (!line) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 400));
  } else {
    const out = JSON.parse(line);
    // The run reports through JSON, which spells a value it never found as null;
    // a key it never wrote reads as undefined. Either is "not there".
    const present = (value) => value !== null && value !== undefined;
    check(
      'the X unmounts docked and floating editors',
      out.closedDocked && out.closedFloating,
      JSON.stringify(out),
    );
    check(
      'closing a docked editor restores the docked mode',
      out.reopenedDocked === 'docked',
      String(out.reopenedDocked),
    );
    check(
      'closing a floating editor restores its mode and geometry',
      out.reopenedFloating === 'floating' && out.floatingPlacement === out.reopenedPlacement,
      JSON.stringify([out.reopenedFloating, out.floatingPlacement, out.reopenedPlacement]),
    );
    const start = out.scrollBefore;
    const end = out.scrollEnd;
    for (const [layout, snapshot] of [
      ['desktop', end],
      ['mobile', out.scrollMobile],
    ]) {
      check(
        `${layout} scrollbar aligns with every value strip`,
        snapshot?.strips.every(
          (strip) => strip.viewport === snapshot.viewport && strip.start === snapshot.start,
        ),
        JSON.stringify(snapshot),
      );
      check(
        `${layout} scrollbar reaches the complete content range without snapping back`,
        snapshot?.left > 0 &&
          snapshot.left === snapshot.maximum &&
          snapshot.maximum === Math.max(...snapshot.strips.map((strip) => strip.maximum)),
        JSON.stringify(snapshot),
      );
    }
    check(
      'one common bar replaces the section bars',
      start?.count === 1 && start.visible && start.hiddenBars,
      JSON.stringify(start),
    );
    check(
      'the bar covers the full horizontal range',
      end?.maximum > 0 &&
        end.left === end.maximum &&
        end.strips.length >= 4 &&
        end.strips.every((strip) => Math.abs(strip.left - Math.min(strip.maximum, end.left)) <= 1),
      JSON.stringify(end),
    );
    check(
      'the name column stays fixed',
      start?.nameLeft === end?.nameLeft,
      JSON.stringify([start?.nameLeft, end?.nameLeft]),
    );
    check(
      'the bar stays below the body while it scrolls vertically',
      out.scrollVertical?.scrollTop > 0 &&
        out.scrollVertical.bottom === start?.bottom &&
        out.scrollVertical.bodyBottom <= out.scrollVertical.bottom,
      JSON.stringify(out.scrollVertical),
    );
    check(
      'native scrolling in a section updates the shared bar',
      out.scrollGesture?.left === 12,
      JSON.stringify(out.scrollGesture),
    );
    check(
      'the bar disappears when all columns fit',
      out.scrollWide?.visible === false && out.scrollWide.left === 0,
      JSON.stringify(out.scrollWide),
    );
    check(
      'resizing narrow restores the bar',
      out.scrollNarrow?.visible === true && out.scrollNarrow.maximum > 0,
      JSON.stringify(out.scrollNarrow),
    );
    check('the sheet renders its rows', out.before?.heads > 0, JSON.stringify(out.before));
    check(
      'a name opens a field when clicked',
      out.clicked === true && present(out.after),
      JSON.stringify(out.after),
    );
    check(
      'the row keeps its height',
      out.after && out.before.rowH === out.after.rowH,
      `${out.before?.rowH} → ${out.after?.rowH}`,
    );
    check(
      'so the row below it does not move',
      out.after && out.before.nextTop === out.after.nextTop,
      `${out.before?.nextTop} → ${out.after?.nextTop}`,
    );
    check(
      'and the field is a real box, not a collapsed one',
      out.after?.fieldH >= 16,
      `${out.after?.fieldH}px`,
    );
    // Measured with the menu present — a control in the heading is exactly what
    // pushed the two stacks apart, by landing on a second grid row.
    const drift = (out.stacks || []).filter((stack) => stack.mismatched > 0);
    check(
      'the names and the values line up, row for row',
      drift.length === 0,
      JSON.stringify(drift),
    );
    // The names stack carries one line the values stack does not — the "New
    // variable" row, which has nothing to show on the value side.
    // Anything beyond that is a stack out of step.
    check(
      'and neither stack has a line the other lacks',
      (out.stacks || []).every((stack) => stack.extraIsAddRow),
      JSON.stringify((out.stacks || []).map((stack) => stack.counts)),
    );
    check('the heading has a menu', present(out.menuRows), String(out.menu));
    check('every menu action receives pointer input', out.menuRows?.reachable === true);
    check('clicking Rename opens the section field', out.menuRename === true);
    check(
      'offering rename, duplicate and delete',
      out.menuRows?.labels.join('|') === 'Rename|Duplicate|Delete',
      JSON.stringify(out.menuRows?.labels),
    );
    check(
      'its rows start at the left, not the middle',
      out.menuRows?.justify === 'flex-start',
      out.menuRows?.justify,
    );
    check(
      'so every row begins in the same place',
      out.menuRows?.sameStart === true,
      JSON.stringify(out.menuRows?.iconLefts),
    );
    // The drag, end to end: it must ask to move the line it was given, and aim
    // it at the group it was dropped on rather than at the end of everything.
    check(
      'a variable can be dragged out of its group',
      out.drag?.grabbed && out.drag?.dropped,
      JSON.stringify(out.drag),
    );
    check(
      'and the drop asks for one move',
      out.drag?.moves?.length === 1,
      JSON.stringify(out.drag?.moves),
    );
    check(
      'of the variable that was dragged',
      out.drag?.moves?.[0]?.name === '--light-200',
      JSON.stringify(out.drag?.moves?.[0]),
    );
    // Into the empty group means "in front of the comment that ends it" — the
    // next variable is on the far side of that comment and would put the line in
    // the group after this one (see test/renderer/variables/varsDrop.test.js).
    check(
      'landing inside the group it was dropped on',
      typeof out.drag?.moves?.[0]?.at === 'number',
      JSON.stringify(out.drag?.moves?.[0]),
    );
    check(
      'a heading can be dragged by its name too',
      out.headingDrag?.grabbed && present(out.headingDrag?.asked),
      JSON.stringify(out.headingDrag),
    );
    check(
      'and it asks to move the heading, not its variables',
      out.headingDrag?.asked?.expect === 'Radius',
      JSON.stringify(out.headingDrag?.asked),
    );
    check(
      'landing above the variable it was dropped on',
      out.headingDrag?.asked?.before === '--light-200',
      JSON.stringify(out.headingDrag?.asked),
    );
    check(
      'a comment heading can be renamed as well',
      out.commentBefore?.renamable === true,
      JSON.stringify(out.commentBefore),
    );
    check(
      'and opens with the heading in it',
      out.commentAfter?.value === out.commentBefore?.text,
      `${out.commentAfter?.value} vs ${out.commentBefore?.text}`,
    );
    check(
      'without moving the sheet either',
      out.commentBefore?.h === out.commentAfter?.h,
      `${out.commentBefore?.h} → ${out.commentAfter?.h}`,
    );
    check(
      'a shared-prefix heading opens a field',
      out.headClicked === true && present(out.headAfter),
      String(out.headAfter),
    );
    check(
      'and keeps its height as well',
      out.headBefore === out.headAfter,
      `${out.headBefore} → ${out.headAfter}`,
    );
  }

  fs.rmSync(directory, { recursive: true, force: true });
  if (failures.length) {
    console.error(
      `vars-row-height: ${failures.length} of ${checked} failed\n${failures.join('\n')}`,
    );
    process.exit(1);
  }
  console.log(`vars-row-height: ${checked} passed  [real sheet, real click, measured]`);
})();
