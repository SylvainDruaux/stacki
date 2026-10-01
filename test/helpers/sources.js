// Goal: one spelling for every repository file a test names, so the layout
// tool (scripts/move/moveSources.mts) can follow a file when it moves.
// Method: a test writes a repository-relative path as one string —
// repoPath('src/editor/pageEdits.ts'), never path pieces or `../` — and stubs a
// module by the file it resolves to, never by the text of an import, so a
// changed specifier can never make a stub silently stop matching.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

/** The absolute path of a repository-relative path written with `/`. */
function repoPath(relative) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('repoPath: expected a repository-relative path');
  }
  if (relative.startsWith('/') || relative.split('/').includes('..')) {
    throw new Error(`repoPath: ${relative} must stay inside the repository`);
  }
  return path.join(ROOT, ...relative.split('/'));
}

/** A path written for an esbuild stdin import: absolute, quoted for code. */
function sourceSpecifier(relative) {
  return JSON.stringify(repoPath(relative));
}

/**
 * An esbuild plugin that replaces whole modules, matched by the file they
 * resolve to. `stubs` maps a repository path to a function of the absolute
 * path returning esbuild's `{ contents, loader }`, or undefined to load the
 * real file.
 */
function stubSources(name, stubs) {
  const byPath = new Map(Object.entries(stubs).map(([file, stub]) => [repoPath(file), stub]));
  return {
    name,
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
        const stub = byPath.get(path.resolve(args.path));
        return stub === undefined ? undefined : stub(args.path);
      });
    },
  };
}

// The components App.tsx reaches as panels. Harnesses that mount the real App
// replace them with stubs that record their props (stubPanels).
const PANEL_SOURCES = Object.freeze([
  'src/panels/AssetsPanel.tsx',
  'src/panels/CanvasView.tsx',
  'src/panels/CapabilityNotice.tsx',
  'src/panels/CmsField.tsx',
  'src/panels/CmsPanel.tsx',
  'src/panels/CmsSettings.tsx',
  'src/panels/CmsView.tsx',
  'src/panels/CodePanel.tsx',
  'src/panels/ComponentPropertiesPanel.tsx',
  'src/panels/ContentFields.tsx',
  'src/panels/ContentView.tsx',
  'src/panels/DevOffline.tsx',
  'src/panels/GitChip.tsx',
  'src/panels/GitChipView.tsx',
  'src/panels/HistoryPanel.tsx',
  'src/panels/HistorySections.tsx',
  'src/panels/HistoryTimeline.tsx',
  'src/panels/ListField.tsx',
  'src/panels/MergeConflictModal.tsx',
  'src/panels/ObjectField.tsx',
  'src/panels/PageDialogs.tsx',
  'src/panels/PageTreeView.tsx',
  'src/panels/PagesPanel.tsx',
  'src/panels/PaletteDialogs.tsx',
  'src/panels/PalettePanel.tsx',
  'src/panels/PreviewOverlays.tsx',
  'src/panels/PreviewPane.tsx',
  'src/panels/PreviewSizeControls.tsx',
  'src/panels/PreviewToolbar.tsx',
  'src/panels/PropField.tsx',
  'src/panels/PropertyDeclarationInfo.tsx',
  'src/panels/PropertyDefault.tsx',
  'src/panels/PropertyEditor.tsx',
  'src/panels/PropertyOptions.tsx',
  'src/panels/PropertyReadOnlyFields.tsx',
  'src/panels/PropertyReorder.tsx',
  'src/panels/PropertyType.tsx',
  'src/panels/PropsPanel.tsx',
  'src/panels/PublishModal.tsx',
  'src/panels/SaveConflictNotice.tsx',
  'src/panels/StructurePanel.tsx',
  'src/panels/StructureTree.tsx',
  'src/panels/StylePanel.tsx',
  'src/panels/SwitchBranchModal.tsx',
  'src/panels/TerminalDock.tsx',
  'src/panels/TerminalPane.tsx',
  'src/panels/VariableCell.tsx',
  'src/panels/VariableTable.tsx',
  'src/panels/VariablesPanel.tsx',
  'src/panels/VariablesView.tsx',
  'src/features/welcome/WelcomeScreen.tsx',
  'src/features/welcome/WelcomeWizards.tsx',
  'src/panels/propAttributes.tsx',
  'src/panels/propBindings.tsx',
  'src/panels/propNodeEditors.tsx',
]);

/**
 * stubSources over every panel component: `stub(name)` receives the component's
 * file name without its extension and returns esbuild's `{ contents, loader }`,
 * or undefined to keep the real component.
 */
function stubPanels(name, stub) {
  const stubs = PANEL_SOURCES.map((file) => [
    file,
    () => stub(path.basename(file, path.extname(file))),
  ]);
  return stubSources(name, Object.fromEntries(stubs));
}

module.exports = { PANEL_SOURCES, ROOT, repoPath, sourceSpecifier, stubPanels, stubSources };
