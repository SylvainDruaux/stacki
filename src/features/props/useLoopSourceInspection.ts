import { useEffect, useState } from 'react';
import type { SourceContext } from './bindingTypes';
import type { LoopSourceInspection } from './loopSourceInspection';
import { findDeclaration, findImportOf } from '../../editor/dataSource';
import { readSymbol } from '../../ipc/bridge';
import { inspectLoopSource } from './loopSourceInspection';

interface LoadedSource {
  readonly key: string;
  readonly inspection: LoopSourceInspection;
}

export function useLoopSourceInspection(
  context: SourceContext | undefined,
  path: string,
  options: { readonly open: boolean },
) {
  const root = path.split('.')[0] ?? '';
  const local = findDeclaration(context?.frontmatter, root);
  const imported = local ? undefined : findImportOf(context?.imports, root);
  const projectPath = context?.projectPath;
  const filePath = context?.filePath;
  const spec = imported?.spec;
  const key = `${projectPath ?? ''}|${filePath ?? ''}|${spec ?? ''}|${path}`;
  const loaded = useImportedSource({ ...options, projectPath, filePath, spec, root, path, key });

  if (!path || !root) {
    return { inspection: undefined, root, local: false, imported: false };
  }
  if (local) {
    return {
      inspection: inspectLoopSource(
        context?.frontmatter ?? '',
        root,
        path,
        'This file · frontmatter',
      ),
      root,
      local: true,
      imported: false,
    };
  }
  if (imported) {
    return {
      inspection:
        loaded?.key === key
          ? loaded.inspection
          : unavailable(path, imported.spec, 'Reading source…'),
      root,
      local: false,
      imported: true,
    };
  }
  return {
    inspection: unavailable(path, 'This file', 'The list is computed at runtime.'),
    root,
    local: false,
    imported: false,
  };
}

function useImportedSource({
  open,
  projectPath,
  filePath,
  spec,
  root,
  path,
  key,
}: {
  readonly open: boolean;
  readonly projectPath: string | undefined;
  readonly filePath: string | undefined;
  readonly spec: string | undefined;
  readonly root: string;
  readonly path: string;
  readonly key: string;
}): LoadedSource | undefined {
  const [loaded, setLoaded] = useState<LoadedSource | undefined>(undefined);
  useEffect(() => {
    if (!open || !spec || !projectPath || !filePath || !root) {
      return undefined;
    }
    let cancelled = false;
    void readSymbol(projectPath, filePath, spec, root).then(
      (result) => {
        if (!cancelled) {
          const inspection = result.ok
            ? inspectLoopSource(result.text, root, path, result.rel)
            : unavailable(path, spec, 'Source preview is unavailable.');
          setLoaded({ key, inspection });
        }
      },
      () => {
        if (!cancelled) {
          setLoaded({ key, inspection: unavailable(path, spec, 'Source preview is unavailable.') });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, projectPath, filePath, spec, root, path, key]);
  return loaded;
}

function unavailable(path: string, origin: string, note: string): LoopSourceInspection {
  return { path, origin, count: undefined, items: [], note, tree: undefined };
}
