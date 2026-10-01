import React, { useEffect, useRef, useState } from 'react';
import {
  createAstroProject,
  createStarterProject,
  subscribeCreateLog,
  type ProjectTemplate,
} from './welcomeBridge';

const CREATE_LOG_CHARS_MAX = 20_000;
const TEMPLATES = [
  { value: 'basics', label: 'Basics', hint: 'A basic, helpful starter project' },
  { value: 'blog', label: 'Blog', hint: 'Content collections and post routing' },
  { value: 'starlight', label: 'Docs (Starlight)', hint: "Astro's documentation theme" },
  { value: 'minimal', label: 'Empty', hint: 'Nothing but the essentials' },
] as const satisfies readonly {
  readonly value: ProjectTemplate;
  readonly label: string;
  readonly hint: string;
}[];

type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'error'; readonly message: string };

interface WizardProps {
  readonly onClose: () => void;
  readonly onDone: (directory: string) => void;
}

export function StarterWizard({
  parentPath,
  onClose,
  onDone,
}: WizardProps & { readonly parentPath: string }) {
  const [name, setName] = useState('my-site');
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const log = useCreateLog();
  const cleanName = name.trim();
  const invalid = !cleanName || !/^[A-Za-z0-9._-]+$/.test(cleanName);
  const running = state.kind === 'running';
  const run = async (): Promise<void> => {
    setState({ kind: 'running' });
    log.clear();
    const result = await createStarterProject(parentPath, cleanName);
    if (!result.ok) {
      setState({ kind: 'error', message: result.error });
    } else if (!result.value.ok) {
      setState({ kind: 'error', message: 'The starter did not finish.' });
    } else {
      onDone(result.value.projectPath);
    }
  };
  return (
    <WizardFrame
      title="Start from Lumos"
      running={running}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button className="primary" onClick={() => void run()} disabled={running || invalid}>
            {running ? 'Creating…' : 'Create site'}
          </button>
        </>
      }
    >
      <label className="starter-field">
        <span>Site name</span>
        <input
          autoFocus
          value={name}
          spellCheck={false}
          disabled={running}
          maxLength={255}
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !invalid && !running) {
              void run();
            }
          }}
        />
      </label>
      <div className="new-project-dir" title={`${parentPath}/${cleanName || 'my-site'}`}>
        {`${parentPath}/${cleanName || 'my-site'}`}
      </div>
      <div className="starter-note">
        Runs <code>npm create lumos@latest</code>, then starts a git history of its own — so
        publishing it later publishes your site, not a fork of the starter.
      </div>
      {(running || log.text) && <CreateLog log={log.text} elementRef={log.elementRef} />}
      {state.kind === 'error' && <div className="error-text">{state.message}</div>}
    </WizardFrame>
  );
}

export function NewProjectWizard({
  directory,
  onClose,
  onDone,
}: WizardProps & { readonly directory: string }) {
  const [template, setTemplate] = useState<ProjectTemplate>('basics');
  const [install, setInstall] = useState(true);
  const [git, setGit] = useState(true);
  const [ai, setAi] = useState(false);
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const log = useCreateLog();
  const running = state.kind === 'running';
  const run = async (): Promise<void> => {
    setState({ kind: 'running' });
    log.clear();
    const result = await createAstroProject({ directory, template, install, git, ai });
    if (result.ok) {
      onDone(directory);
    } else {
      setState({ kind: 'error', message: result.error });
    }
  };
  return (
    <WizardFrame
      title="New Astro Project"
      running={running}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={running}>
            {state.kind === 'error' ? 'Close' : 'Cancel'}
          </button>
          <button className="primary" onClick={() => void run()} disabled={running}>
            {running ? 'Creating…' : state.kind === 'error' ? 'Try again' : 'Create Project'}
          </button>
        </>
      }
    >
      <div className="new-project-dir" title={directory}>
        {directory}
      </div>
      {state.kind === 'idle' && (
        <ProjectChoices
          template={template}
          install={install}
          git={git}
          ai={ai}
          setTemplate={setTemplate}
          setInstall={setInstall}
          setGit={setGit}
          setAi={setAi}
        />
      )}
      {state.kind !== 'idle' && (
        <CreateLog log={log.text || 'Starting…'} elementRef={log.elementRef} />
      )}
      {state.kind === 'error' && <div className="error-text">{state.message}</div>}
    </WizardFrame>
  );
}

function useCreateLog() {
  const [text, setText] = useState('');
  const elementRef = useRef<HTMLPreElement>(null);
  useEffect(
    () =>
      subscribeCreateLog((chunk) =>
        setText((previous) => (previous + chunk).slice(-CREATE_LOG_CHARS_MAX)),
      ),
    [],
  );
  useEffect(() => {
    if (elementRef.current) {
      elementRef.current.scrollTop = elementRef.current.scrollHeight;
    }
  }, [text]);
  return { text, elementRef, clear: () => setText('') };
}

function WizardFrame({
  title,
  running,
  onClose,
  children,
  footer,
}: {
  readonly title: string;
  readonly running: boolean;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly footer: React.ReactNode;
}) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !running) {
          onClose();
        }
      }}
    >
      <div className="modal new-project-modal">
        <div className="modal-header">{title}</div>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  );
}

interface ProjectChoicesProps {
  readonly template: ProjectTemplate;
  readonly install: boolean;
  readonly git: boolean;
  readonly ai: boolean;
  readonly setTemplate: (template: ProjectTemplate) => void;
  readonly setInstall: (value: boolean) => void;
  readonly setGit: (value: boolean) => void;
  readonly setAi: (value: boolean) => void;
}

function ProjectChoices(props: ProjectChoicesProps) {
  return (
    <>
      <div>
        <label>How would you like to start your new project?</label>
        <div className="template-list">
          {TEMPLATES.map((template) => (
            <div
              key={template.value}
              className={`template-option ${props.template === template.value ? 'on' : ''}`}
              onClick={() => props.setTemplate(template.value)}
            >
              <div className="template-name">{template.label}</div>
              <div className="template-hint">{template.hint}</div>
            </div>
          ))}
        </div>
      </div>
      <CheckRow label="Install dependencies" checked={props.install} change={props.setInstall} />
      <CheckRow label="Initialize a new git repository" checked={props.git} change={props.setGit} />
      <CheckRow label="Add AI agent files" checked={props.ai} change={props.setAi} />
    </>
  );
}

function CheckRow({
  label,
  checked,
  change,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly change: (value: boolean) => void;
}) {
  return (
    <label className="check-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => change(event.currentTarget.checked)}
      />
      {label}
    </label>
  );
}

function CreateLog({
  log,
  elementRef,
}: {
  readonly log: string;
  readonly elementRef: React.RefObject<HTMLPreElement>;
}) {
  return (
    <pre className="create-log" ref={elementRef}>
      {log}
    </pre>
  );
}
