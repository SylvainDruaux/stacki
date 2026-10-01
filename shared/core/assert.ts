// Programmer errors crash loudly (AGENTS.md §9). The `asserts condition`
// signature narrows for the compiler from the same statement that checks at
// runtime — one assertion, both channels.

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
