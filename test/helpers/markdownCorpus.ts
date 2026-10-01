// A seeded corpus of Markdown and MDX documents for the contract suites (step
// 10): every block shape the parser reads, nested in quotes and lists, with
// CRLF line breaks, byte-order marks, astral characters and JSX blocks mixed
// in. The generator is deterministic — mulberry32 over a fixed seed — so a
// failure names a document that replays exactly. Pure: no I/O.

/** One generated page: its name, whether it is MDX, and its text. */
export interface MarkdownDocument {
  readonly name: string;
  readonly mdx: boolean;
  readonly text: string;
}

const PIECES = [
  '# Heading',
  '## Two #',
  '  ### indented',
  'Para line one',
  'second line',
  'Setext',
  '====',
  '---',
  '- - -',
  '- item',
  '- item two',
  '  continued',
  '* star',
  '+ plus',
  '1. one',
  '2. two',
  '07) seven',
  '10. ten',
  '> quote',
  '> > nested',
  '>no gap',
  'lazy line',
  '```js',
  'code()',
  '```',
  '~~~',
  'tilde',
  '~~~~',
  '<Callout type="info">',
  '  inside **md**',
  '</Callout>',
  '<Chart data={[1, 2]} />',
  '<div>a</div><p>b</p>',
  '| a | b |',
  '|---|:-:|',
  '| 1 | 2 |',
  '![alt](./x.png)',
  '![](y.png "title")',
  'import X from "./x"',
  'export const y = 1;',
  '',
  '',
  '',
  '    - deep',
  '   1. deepnum',
  '  > quoted item',
  '{year}',
  'café 🎉 naïve',
  '- ',
  '>',
  '<!-- c -->',
  '<img src="a.png" alt="b">',
] as const;

// mulberry32 — deterministic, so a failure replays exactly.
function prng(seed: number): (bound: number) => number {
  let state = seed;
  return (bound) => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296) * bound);
  };
}

/** `count` documents from `seed`; at most 10 000 (a bound, not a target). */
export function generatedMarkdown(seed: number, count: number): readonly MarkdownDocument[] {
  if (count > 10_000) {
    throw new Error('generatedMarkdown: at most 10 000 documents');
  }
  const below = prng(seed);
  const documents: MarkdownDocument[] = [];
  for (let index = 0; index < count; index++) {
    const lines: string[] = [];
    if (below(3) === 0) {
      lines.push('---', 'title: x', 'layout: ../L.astro', '---');
    }
    const length = 1 + below(25);
    for (let line = 0; line < length; line++) {
      lines.push(PIECES[below(PIECES.length)] ?? '');
    }
    let text = lines.join(below(4) === 0 ? '\r\n' : '\n');
    if (below(2) === 1) {
      text += '\n';
    }
    if (below(8) === 0) {
      text = `﻿${text}`;
    }
    documents.push({ name: `generated-${seed}-${index}`, mdx: index % 2 === 0, text });
  }
  return documents;
}
