// Narrowing `unknown` to a record is the first step of nearly every boundary
// parse (AGENTS.md §2). One validated home for it, so callers outside shared/
// never need the assertion the lint gate forbids.

/** The record behind `input`, or undefined when it isn't a plain object. */
export function toRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

/** The array behind `input`, or undefined when it isn't one. */
export function toArray(input: unknown): unknown[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  return input as unknown[];
}
