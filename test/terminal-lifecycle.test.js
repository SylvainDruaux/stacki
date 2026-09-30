// Goal: the terminal dock loads xterm only when opened, keeps scrollback while
// hidden, and ignores a startup reply for a terminal already disposed.
// Method: TerminalDock is bundled with xterm and the bridge replaced by
// recording fakes, mounted in jsdom, and driven through open, hide and dispose
// while the fakes report what was created and written.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test(
  'terminals load on demand, retain scrollback ' +
    'while hidden, and ignore disposed startup replies',
  async () => {
    const output = path.join(
      __dirname,
      '../node_modules/.stacki-test/terminal-lifecycle.bundle.js',
    );
    global.__terminalTest = { loads: 0, terminals: [], dimensions: { cols: 80, rows: 24 } };
    await require('esbuild').build({
      entryPoints: [path.join(__dirname, '../src/panels/TerminalDock.tsx')],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      loader: { '.css': 'empty' },
      logLevel: 'silent',
      plugins: [
        {
          name: 'terminal-double',
          setup(build) {
            build.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, ({ path }) => ({
              path,
              namespace: 'terminal-double',
            }));
            build.onLoad({ filter: /.*/, namespace: 'terminal-double' }, ({ path }) => ({
              loader: 'js',
              contents: path.endsWith('addon-fit')
                ? `export class FitAddon { fit() {} proposeDimensions() { return ` +
                  `globalThis.__terminalTest.dimensions; } }`
                : `globalThis.__terminalTest.loads++;
           export class Terminal {
             constructor() {
               this.disposed = false; this.output = '';
               globalThis.__terminalTest.terminals.push(this);
             }
             loadAddon() {} open() {} focus() {} onData() {} onTitleChange() {} onScroll() {}
             write(text, done) {
               if (this.disposed) throw new Error('wrote to disposed terminal');
               this.output += text; done?.();
             }
             writeln(text) { this.write(text); }
             dispose() { this.disposed = true; }
           }`,
            }));
          },
        },
      ],
    });
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    });
    for (const name of [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'Element',
      'Node',
      'MutationObserver',
      'localStorage',
    ]) {
      Object.defineProperty(global, name, {
        value: name === 'window' ? dom.window : dom.window[name],
        configurable: true,
      });
    }
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', { get: () => 600 });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', { get: () => 240 });
    global.IS_REACT_ACT_ENVIRONMENT = true;
    global.getComputedStyle = dom.window.getComputedStyle;
    global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    global.cancelAnimationFrame = clearTimeout;
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    dom.window.ResizeObserver = global.ResizeObserver;
    const dataListeners = new Set();
    const sizes = [];
    const closed = [];
    let started;
    let answerStart;
    dom.window.avb = {
      platform: 'darwin',
      startTerminal: (args) => {
        started = args;
        return new Promise((resolve) => {
          answerStart = resolve;
        });
      },
      resizeTerminal: (size) => {
        sizes.push(size);
        return Promise.resolve({ ok: true });
      },
      closeTerminal: (args) => {
        closed.push(args.id);
        return Promise.resolve({ ok: true });
      },
      onTerminalData: (listener) => {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onTerminalExit: () => () => {},
      onTerminalProcess: () => () => {},
      terminalAck: () => {},
    };
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const Dock = require(output).default;
    const root = createRoot(document.getElementById('root'));
    const render = async (open) => {
      await React.act(async () =>
        root.render(React.createElement(Dock, { projectPath: '/site', open, onClose: () => {} })),
      );
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };
    try {
      await render(false);
      assert.equal(global.__terminalTest.loads, 0, 'closed dock does not evaluate xterm');
      await render(true);
      const terminal = global.__terminalTest.terminals[0];
      assert.equal(global.__terminalTest.loads, 1);
      assert.equal(global.__terminalTest.terminals.length, 1);
      assert.ok(started.id);
      for (const listener of dataListeners) {
        listener({ id: started.id, data: 'saved scrollback' });
      }
      assert.equal(sizes.length, 1, 'first fit sizes the native terminal');
      window.dispatchEvent(new dom.window.Event('resize'));
      window.dispatchEvent(new dom.window.Event('resize'));
      assert.equal(sizes.length, 1, 'unchanged dimensions do not repeat IPC resize requests');
      global.__terminalTest.dimensions = { cols: 100, rows: 30 };
      window.dispatchEvent(new dom.window.Event('resize'));
      assert.equal(sizes.length, 2, 'changed dimensions still resize');
      await render(false);
      await render(true);
      assert.equal(
        global.__terminalTest.terminals.length,
        1,
        'hiding/reopening keeps the terminal instance',
      );
      assert.equal(terminal.output, 'saved scrollback');
      assert.equal(terminal.disposed, false);
      await React.act(async () => root.unmount());
      assert.equal(terminal.disposed, true);
      assert.equal(dataListeners.size, 0);
      assert.ok(closed.includes(started.id));
      await React.act(async () => {
        answerStart({ ok: false, error: 'late failure' });
        await Promise.resolve();
      });
      assert.equal(
        terminal.output,
        'saved scrollback',
        'a late start failure cannot write to disposed xterm',
      );
    } finally {
      await React.act(async () => root.unmount());
      dom.window.close();
      delete global.__terminalTest;
    }
  },
);
