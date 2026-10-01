// Source slots cross IPC with the page model. Keep their validated contract
// independent of Electron so the renderer and source writer share one shape.
import { LIMITS } from '../core/limits';
import { toArray, toRecord } from '../core/record';

export interface ImportMember {
  readonly name: string;
  readonly path: string;
  readonly quote: string;
  readonly at: number;
  readonly named?: boolean;
  readonly imported?: string;
  readonly typeOnly?: boolean;
}

export interface ImportSlot {
  readonly at: number;
  readonly offset: number;
  readonly source: string;
  readonly suffix: string;
  readonly tail: string;
  readonly members: readonly ImportMember[];
}

export interface FrontmatterLayout {
  readonly extra: string;
  readonly slots: readonly ImportSlot[];
}

export function parseImportSlots(input: unknown): readonly ImportSlot[] {
  const slots = toArray(input);
  if (!slots) {
    throw new Error('ImportSlots: expected array');
  }
  if (slots.length > LIMITS.importsMax) {
    throw new Error('ImportSlots: exceeds limit');
  }
  return slots.map(parseImportSlot);
}

export function parseImportSlot(input: unknown): ImportSlot {
  const slot = toRecord(input);
  if (!slot) {
    throw new Error('ImportSlot: expected object');
  }
  const members = toArray(slot['members']);
  if (!members) {
    throw new Error('ImportSlot.members: expected array');
  }
  if (members.length > LIMITS.importsMax) {
    throw new Error('ImportSlot.members: exceeds limit');
  }
  return {
    at: parseOffset(slot['at'], 'ImportSlot.at'),
    offset: parseOffset(slot['offset'], 'ImportSlot.offset'),
    source: parseText(slot['source'], 'ImportSlot.source'),
    suffix: parseText(slot['suffix'], 'ImportSlot.suffix'),
    tail: parseText(slot['tail'], 'ImportSlot.tail'),
    members: members.map(parseImportMember),
  };
}

export function parseImportMember(input: unknown): ImportMember {
  const member = toRecord(input);
  if (!member) {
    throw new Error('ImportMember: expected object');
  }
  const named = member['named'];
  const typeOnly = member['typeOnly'];
  for (const flag of [named, typeOnly]) {
    if (flag !== undefined && typeof flag !== 'boolean') {
      throw new Error('ImportMember: expected boolean flag');
    }
  }
  return {
    name: parseText(member['name'], 'ImportMember.name'),
    path: parseText(member['path'], 'ImportMember.path'),
    quote: parseText(member['quote'], 'ImportMember.quote'),
    at: parseOffset(member['at'], 'ImportMember.at'),
    ...(typeof named === 'boolean' ? { named } : {}),
    ...(typeof typeOnly === 'boolean' ? { typeOnly } : {}),
    ...(member['imported'] === undefined
      ? {}
      : {
          imported: parseText(member['imported'], 'ImportMember.imported'),
        }),
  };
}

function parseText(input: unknown, field: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${field}: expected string`);
  }
  if (input.length > LIMITS.nodeValueCharsMax) {
    throw new Error(`${field}: exceeds limit`);
  }
  return input;
}

function parseOffset(input: unknown, field: string): number {
  if (typeof input !== 'number') {
    throw new Error(`${field}: expected integer`);
  }
  if (!Number.isSafeInteger(input)) {
    throw new Error(`${field}: expected integer`);
  }
  if (input < 0 || input > LIMITS.ipcFieldCharsMax) {
    throw new Error(`${field}: outside source bounds`);
  }
  return input;
}
