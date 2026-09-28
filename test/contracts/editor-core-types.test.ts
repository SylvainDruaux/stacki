// Goal: the type-level half of the editor-core contracts (plan §10: brand
// separation and exhaustiveness are tsc-checked files using @ts-expect-error).
// Method: each `@ts-expect-error` line below must fail to compile; if a change
// made it compile, tsc reports the directive as unused and the gate fails. The
// runtime test only keeps the file in the suite and asserts the helpers exist.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  toByteOffset,
  toIntentId,
  toUtf16Offset,
  type ByteOffset,
  type Digest,
  type IntentId,
} from '../../dist/shared/brand.js';
import type { Capability } from '../../dist/shared/capability.js';
import type { Outcome, RejectionReason, SubmissionResult } from '../../dist/shared/intent.js';
import type { AnchorRef } from '../../dist/shared/ref.js';
import type { Snapshot } from '../../dist/shared/snapshot.js';
import type { Projection } from '../../dist/shared/source-projection.js';
import { utf16ToByteOffsets, type ByteSpan, type Utf16Span } from '../../dist/shared/span.js';

function byteOnly(offset: ByteOffset): ByteOffset {
  return offset;
}

function describe(outcome: Outcome): string {
  switch (outcome.tag) {
    case 'applied':
      return outcome.checksum;
    case 'rejected':
      return outcome.reason;
    case 'uncertain':
      return outcome.candidateChecksum ?? 'unknown';
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export function typeChecks(snapshot: Snapshot, projection: Projection, reason: RejectionReason): void {
  const utf16 = toUtf16Offset(3);
  // @ts-expect-error A UTF-16 offset is not a byte offset (plan §3.2).
  byteOnly(utf16);
  // @ts-expect-error A plain number is not a byte offset either.
  byteOnly(3);
  byteOnly(toByteOffset(3));
  // @ts-expect-error The one conversion takes UTF-16 offsets, never bytes.
  utf16ToByteOffsets('abc', [toByteOffset(1)]);
  const utf16Span: Utf16Span = { start: utf16, end: utf16 };
  // @ts-expect-error A UTF-16 span is not a byte span.
  const byteSpan: ByteSpan = utf16Span;
  // @ts-expect-error An intent id is not any string.
  const id: IntentId = 'i1';
  // @ts-expect-error A digest is built only by toDigest.
  const digest: Digest = 'a'.repeat(64);
  // @ts-expect-error A snapshot has no version field (plan §3.1).
  void snapshot.version;
  // @ts-expect-error Backpressure is a submission result, not an outcome (plan §3.5).
  const outcome: Outcome = { tag: 'backpressured' } satisfies SubmissionResult;
  // @ts-expect-error Diagnostics exist only on the parse-error variant.
  void projection.diagnostics;
  // @ts-expect-error `queue-full` is not a rejection reason: a full queue backpressures.
  const full: RejectionReason = 'queue-full';
  // @ts-expect-error Capabilities are a closed set.
  const writable: Capability = 'writable';
  // @ts-expect-error An anchor's kind is a closed set too.
  const anchor: AnchorRef = { span: { start: toByteOffset(0), end: toByteOffset(0) }, path: [], expectedKind: 'widget' };
  void [byteSpan, id, digest, outcome, full, writable, anchor, reason];
}

test('type-level contracts compile only as intended', () => {
  assert.equal(typeof typeChecks, 'function');
  assert.equal(describe({ tag: 'rejected', intentId: toIntentId('i1'), reason: 'write-race' }), 'write-race');
});
