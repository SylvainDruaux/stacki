import React, { useState } from 'react';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import { NO_LIVE_TEXT, useLiveValue, type LiveValue } from '../../ui/liveValue';

const NODE_URL = 'https://nodejs.org/en/download';
export type DevDiagnosis = IpcResults['dev:diagnose'];

export function DevOffline({
  devLog,
  devDiag,
  onRestart,
}: {
  readonly devLog?: LiveValue<string> | undefined;
  readonly devDiag?: DevDiagnosis | undefined;
  readonly onRestart?: () => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const log = useLiveValue(devLog ?? NO_LIVE_TEXT);
  const message = offlineMessage(devDiag);
  return (
    <>
      <div className={message.known ? 'offline-title' : undefined}>{message.title}</div>
      {message.detail && <p className="offline-detail">{message.detail}</p>}
      <div className="offline-actions">
        <button onClick={onRestart}>Start dev server</button>
        <OfflineAction action={message.action} />
      </div>
      {devDiag?.nodePath && (
        <div className="offline-meta">
          Using Node {devDiag.nodeVersion ?? '?'} — {devDiag.nodePath}
        </div>
      )}
      {log && (
        <>
          <button
            className="ghost offline-log-toggle"
            onClick={() => setShowLog((value) => !value)}
          >
            {showLog ? 'Hide log' : 'Show log'}
          </button>
          {showLog && <pre className="offline-log">{log}</pre>}
        </>
      )}
    </>
  );
}

function OfflineAction({ action }: { readonly action: OfflineMessage['action'] }) {
  if (!action) {
    return undefined;
  }
  return (
    <button className="ghost" onClick={() => void window.avb.openExternal(action.url)}>
      {action.label}
    </button>
  );
}

interface OfflineMessage {
  readonly known: boolean;
  readonly title: string;
  readonly detail: string | undefined;
  readonly action: { readonly label: string; readonly url: string } | undefined;
}

function offlineMessage(diagnosis: DevDiagnosis | undefined): OfflineMessage {
  if (diagnosis?.kind === 'no-node') {
    return {
      known: true,
      title: "Node.js isn't installed — or isn't where this app can see it.",
      detail:
        'Astro needs Node.js to run. Stacki looks on the system path, your login shell’s path, ' +
        'and the usual Homebrew, nvm, fnm, volta, asdf and mise locations, and found nothing. ' +
        'Install Node, then start the server again.',
      action: { label: 'Get Node.js', url: NODE_URL },
    };
  }
  if (diagnosis?.kind === 'node-too-old') {
    return {
      known: true,
      title: `Node ${diagnosis.nodeVersion} is too old for this project.`,
      detail:
        `astro ${diagnosis.astroVersion} needs Node ${diagnosis.requires}. Install a newer ` +
        "Node — if you use a version manager, the one it picks in this project's folder is " +
        'the one Stacki will use.',
      action: { label: 'Get Node.js', url: NODE_URL },
    };
  }
  if (diagnosis?.kind === 'no-deps') {
    return {
      known: true,
      title: "This project's dependencies aren't installed.",
      detail:
        'Astro was not found in node_modules. Starting the server installs them automatically — ' +
        'if that keeps failing, the log below has the reason.',
      action: undefined,
    };
  }
  return { known: false, title: 'Preview is offline.', detail: undefined, action: undefined };
}
