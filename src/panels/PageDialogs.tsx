import React, { useEffect, useRef, useState } from 'react';
import type { ScanComponent } from '../../shared/scan';
import Dropdown from '../ui/Dropdown';

export function RenameInput({
  initial,
  onCommit,
}: {
  readonly initial: string;
  readonly onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      className="rename-input"
      value={text}
      spellCheck={false}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          onCommit(text);
        } else if (event.key === 'Escape') {
          onCommit(initial);
        }
      }}
    />
  );
}

export function NewPageModal({
  layouts,
  onClose,
  onCreate,
}: {
  readonly layouts: readonly ScanComponent[];
  readonly onClose: () => void;
  readonly onCreate: (name: string, layout: string | undefined) => void;
}) {
  const [name, setName] = useState('');
  const [layout, setLayout] = useState(layouts.at(0)?.name ?? '');
  const submit = (): void => {
    const clean = name.trim();
    if (clean) {
      onCreate(clean, layout || undefined);
    }
  };
  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal">
        <div className="modal-header">New Page</div>
        <div className="modal-body">
          <div>
            <label>Page name (e.g. &quot;about&quot; or &quot;blog/post-1&quot;)</label>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  submit();
                }
              }}
              placeholder="about"
            />
          </div>
          <div>
            <label>Layout</label>
            <Dropdown
              value={layout}
              options={[
                { value: '', label: '(no layout)', dim: true },
                ...layouts.map((item) => ({ value: item.name, label: item.name })),
              ]}
              onChange={setLayout}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim()} onClick={submit}>
            Create Page
          </button>
        </div>
      </div>
    </div>
  );
}
