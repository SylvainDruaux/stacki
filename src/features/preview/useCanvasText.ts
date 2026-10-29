import { cmsTransport } from '../../ipc/editorEnvironment';
import type { CanvasTextEdit } from './canvasTextSource';
import { useEffect, useRef, type RefObject } from 'react';
import {
  parseCanvasTextEvent,
  type CanvasTextCatalog,
} from '../../../shared/properties/canvasText';
import {
  applyCanvasText,
  canvasTextNodes,
  canvasTextPlans,
  type CanvasSourceNode,
} from './canvasTextSource';
import { createCanvasTextOverlay } from './canvasTextOverlay';
import { parseCanvasTextOverlay } from '../../../shared/properties/canvasTextOverlay';
import { canvasTextDraft, clearCanvasTextDraft } from '../../ui/canvasTextDraft';

export interface CanvasTextDocument {
  readonly projectPath: string;
  readonly file: string;
  readonly source: string;
  readonly nodes: readonly CanvasSourceNode[];
  readonly pathFor: (id: string) => string | undefined;
  readonly apply: (source: string, position: number) => Promise<void>;
  readonly report: (message: string) => void;
  readonly loadContent: (document: CanvasTextDocument) => Promise<readonly CanvasTextEdit[]>;
}
interface Options {
  readonly document: CanvasTextDocument | undefined;
  readonly frame: RefObject<HTMLIFrameElement>;
  readonly url: string | undefined;
  readonly post: (message: unknown) => void;
  readonly subscribeLoad: (listener: () => void) => () => void;
}

export function useCanvasText(options: Options): void {
  const current = useRef(options);
  current.current = options;
  const document = options.document;
  const file = document?.file;
  const source = document?.source;
  useEffect(() => startCanvasText(current), [file, source]);
}

function startCanvasText(current: RefObject<Options>) {
  const initial = current.current?.document;
  if (!initial) {
    return;
  }
  const session = crypto.randomUUID();
  let disposed = false;
  let catalog: CanvasTextCatalog | undefined;
  let plans: readonly CanvasTextEdit[] = [];
  let revision = 0;
  const overlay = createCanvasTextOverlay({
    target: (key) => plans.find((plan) => plan.target.key === key)?.target,
    post: (message) => current.current?.post(message),
  });
  const send = () => catalog && current.current?.post(catalog);
  const refresh = () => {
    revision = (revision + 1) % 1_000_000;
    const version = revision;
    overlay.closeContent();
    void publishCanvasTextSession(initial, session, version, (ready) => {
      if (!disposed && version === revision) {
        plans = ready.plans;
        catalog = ready.catalog;
        send();
      }
    }).catch((error: unknown) => initial.report(String(error)));
  };
  refresh();
  const unsubscribeContent = cmsTransport.onCmsChanged(refresh);
  const unsubscribe = current.current?.subscribeLoad(send);
  const receive = createCanvasTextReceiver({
    current,
    initial,
    session,
    overlay,
    plans: () => plans,
  });
  window.addEventListener('message', receive);
  return () => {
    disposed = true;
    overlay.close();
    clearCanvasTextDraft(session);
    unsubscribeContent();
    if (catalog) {
      current.current?.post({ ...catalog, session: crypto.randomUUID(), targets: [] });
    }
    unsubscribe?.();
    window.removeEventListener('message', receive);
  };
}

interface CanvasTextReceiverOptions {
  readonly current: RefObject<Options>;
  readonly initial: CanvasTextDocument;
  readonly session: string;
  readonly overlay: ReturnType<typeof createCanvasTextOverlay>;
  readonly plans: () => readonly CanvasTextEdit[];
}

function createCanvasTextReceiver(options: CanvasTextReceiverOptions) {
  let busy = false;
  const nodes = new Map(
    canvasTextNodes(options.initial.nodes).map(({ node }) => [
      node.id ? options.initial.pathFor(node.id) : undefined,
      node,
    ]),
  );
  return (event: MessageEvent<unknown>) => {
    const message = canvasTextSessionMessage(event, options);
    if (!message) {
      return;
    }
    if (message.type === 'avb:text-active' || message.type === 'avb:text-inactive') {
      options.overlay.receive(message);
      if (!busy) {
        clearCanvasTextDraft(options.session);
      }
      return;
    }
    if (busy) {
      return;
    }
    const plan = options.plans().find((entry) => entry.target.key === message.key);
    if (!plan) {
      return;
    }
    if (message.type === 'avb:text-draft') {
      const node = nodes.get(plan.target.path);
      if (node?.id && node.value !== undefined) {
        canvasTextDraft.set({
          session: options.session,
          projectPath: options.initial.projectPath,
          file: options.initial.file,
          nodeID: node.id,
          sourceValue: node.value,
          value: message.value,
        });
      }
      return;
    }
    busy = true;
    const draft = canvasTextDraft.get();
    void plan
      .apply(message.value)
      .catch((error: unknown) => options.initial.report(String(error)))
      .finally(() => {
        busy = false;
        if (canvasTextDraft.get() === draft) {
          clearCanvasTextDraft(options.session);
        }
      });
  };
}

function canvasTextSessionMessage(
  event: MessageEvent<unknown>,
  options: CanvasTextReceiverOptions,
) {
  const host = options.current.current;
  const message = canvasTextMessage(event, host ?? undefined);
  if (!message || !host) {
    return undefined;
  }
  if (message.type === 'avb:text-refused') {
    options.initial.report(message.message);
    return undefined;
  }
  if (message.session !== options.session) {
    return undefined;
  }
  if (
    host.document?.source !== options.initial.source ||
    host.document.file !== options.initial.file
  ) {
    return undefined;
  }
  return message;
}

function canvasTextMessage(event: MessageEvent<unknown>, host: Options | undefined) {
  if (
    !host?.url ||
    event.source !== host.frame.current?.contentWindow ||
    event.origin !== new URL(host.url).origin
  ) {
    return undefined;
  }
  try {
    return parseCanvasTextEvent(event.data) ?? parseCanvasTextOverlay(event.data);
  } catch {
    return undefined;
  }
}

async function publishCanvasTextSession(
  document: CanvasTextDocument,
  session: string,
  revision: number,
  publish: (ready: {
    readonly plans: readonly CanvasTextEdit[];
    readonly catalog: CanvasTextCatalog;
  }) => void,
) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document.source));
  const checksum = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const literal = canvasTextPlans(document.source, document.nodes, document.pathFor);
  const plans: readonly CanvasTextEdit[] = [
    ...literal.map((plan) => ({
      target: plan.target,
      apply: (value: string) =>
        document.apply(applyCanvasText(document.source, plan, value), plan.start),
    })),
  ];
  const catalog: CanvasTextCatalog = {
    type: 'avb:text-catalog',
    session,
    file: document.file,
    checksum,
    targets: plans.map((plan) => plan.target).slice(0, 2_000),
  };
  publish({ plans, catalog });
  const content = await document.loadContent(document);
  if (content.length) {
    // CMS refreshes invalidate only CMS tickets. Literal editing keeps its focus
    // while scans run; an old CMS commit cannot pick up a newer entry snapshot.
    const refreshed = content.map((plan) => ({
      ...plan,
      target: { ...plan.target, key: `cms:${revision}:${plan.target.key}` },
    }));
    const combined = [...plans, ...refreshed].slice(0, 2_000);
    publish({
      plans: combined,
      catalog: { ...catalog, targets: combined.map((plan) => plan.target) },
    });
  }
}
