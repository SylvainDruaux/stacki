import './cms.css';
import { useCallback } from 'react';
import CmsPanel from '../../../vendor/stacki/src/features/cms/CmsPanel';
import CmsView from '../../../vendor/stacki/src/features/cms/CmsView';
import ContentView from '../../../vendor/stacki/src/features/content/ContentView';
import type { CmsUndo } from '../../../vendor/stacki/src/features/cms/cmsWriter';
import type { EditorProps } from '../../app/Editor';
import type { SharedDocument } from '../collaboration/useDocument';

export type CmsSelection =
  | { readonly kind: 'data'; readonly rel: string; readonly settings: boolean }
  | { readonly kind: 'content'; readonly name: string };
export function CmsNavigation({ props }: { readonly props: EditorProps }) {
  const { cms, setCms } = props.view;
  return (
    <CmsPanel
      project={{ path: 'studio' }}
      selectedRel={cms?.kind === 'data' ? cms.rel : undefined}
      selectedContent={cms?.kind === 'content' ? cms.name : undefined}
      currentFile={props.file.replace(/^src\//, '')}
      refreshKey={props.project.pages.length}
      onSelect={(rel) =>
        setCms(rel === undefined ? undefined : { kind: 'data', rel, settings: false })
      }
      onSelectContent={(name) => setCms(name === undefined ? undefined : { kind: 'content', name })}
      onOpenSettings={(rel) => setCms({ kind: 'data', rel, settings: true })}
      showToast={props.report}
    />
  );
}
export function CmsWorkspace({
  props,
  document,
}: {
  readonly props: EditorProps;
  readonly document: SharedDocument | undefined;
}) {
  const { cms, setCms, panel, setPanel } = props.view;
  const record = useCallback(
    (command: CmsUndo) => {
      document?.recordCommand({
        undo: command.undo,
        redo: command.redo,
        coalesceKey: command.coalesceKey,
      });
    },
    [document],
  );
  const close = () => {
    if (window.matchMedia('(max-width: 700px)').matches) {
      setCms(undefined);
    } else {
      setPanel(undefined);
    }
  };
  if (!cms) {
    return null;
  }
  if (cms.kind === 'content') {
    return (
      <ContentView
        key={cms.name}
        project={{ path: 'studio' }}
        name={cms.name}
        hidden={panel !== 'collections'}
        showToast={props.report}
        onClose={close}
      />
    );
  }
  return (
    <CmsView
      project={{ path: 'studio' }}
      rel={cms.rel}
      settings={cms.settings}
      hidden={panel !== 'collections'}
      showToast={props.report}
      onRecordUndo={record}
      onClose={close}
      onCloseSettings={() => setCms({ ...cms, settings: false })}
      onDeleted={() => {
        setCms(undefined);
        props.refresh();
      }}
    />
  );
}
