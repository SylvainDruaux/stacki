// Replies come from a project's iframe, so validate before resolving a pending
// query. Invalid messages remain unanswered and use the normal timeout fallback.
import { boolean, count, dictionary, list, object, optional, text } from '../shared/boundary';
import { err, ok, type Result } from '../shared/result';

const identity = object({
  tag: text,
  id: optional(text),
  classes: list(text),
  attributes: dictionary(text),
});
const reply = object({
  id: count,
  found: boolean,
  ready: optional(boolean),
  identity: optional(identity),
  matched: optional(dictionary(optional(boolean))),
  computed: optional(dictionary(optional(text))),
  computedProps: optional(dictionary(optional(text))),
});
export type CanvasReply = ReturnType<typeof reply>;
// An answer's maps are the reply's own: a value the page could not resolve
// arrives absent (`undefined`), as everywhere in the app (AGENTS.md §6).
export type CanvasAnswer = {
  readonly identity: CanvasReply['identity'];
  readonly matched: NonNullable<CanvasReply['matched']>;
  readonly computed: NonNullable<CanvasReply['computed']>;
  readonly computedProps: NonNullable<CanvasReply['computedProps']>;
};

export function parseCanvasReply(input: unknown): Result<CanvasReply> {
  try {
    return ok(reply(input));
  } catch (error: unknown) {
    return err({ code: 'invalid_canvas_reply', message: String(error) });
  }
}
