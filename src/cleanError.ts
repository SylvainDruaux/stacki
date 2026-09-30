// Error-message tidying, shared by App and the panels that surface failures.
//
// Lives outside App.tsx on purpose: a module that exports both a component and
// a plain function can't Fast Refresh, so every edit to App.tsx forced Vite
// into a full page reload — which drops the open project and lands you back on
// the dashboard mid-edit.

import { toRecord } from '../shared/record';

export function cleanError(error: unknown): string {
  const record = toRecord(error);
  const message = record?.['message'];
  const text = typeof message === 'string' && message ? message : String(error);
  return stripAnsi(text.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
}

export function stripAnsi(text: unknown): string {
  return String(text)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b/g, '')
    .replace(/\[(\d{1,2})m/g, '');
}
