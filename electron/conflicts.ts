// Reading a conflicted file, and putting it back together.
//
// When a merge clashes, git writes the file with both versions in it, marked:
//
//     unchanged text
//     <<<<<<< HEAD
//     this branch's version
//     =======
//     the incoming version
//     >>>>>>> other-branch
//     more unchanged text
//
// Everything outside the markers is text both sides agree on. Everything
// inside is one disagreement — and a file can have several, which is the whole
// reason this exists: a page where the heading should come from one branch and
// the footer from the other is completely ordinary, and "keep the whole file
// from one side or the other" cannot express it.
//
// Git decides where the disagreements are, not this code. Two edits closer
// than a few lines come back as a single one, because git could not tell them
// apart either; that is a limit of the merge, not something to work around
// here.
//
// Parsing markers rather than diffing the two versions ourselves means the
// three-way merge is git's — with the common ancestor it alone has — and this
// only has to read the result.

// A run of the diff: agreed text, or the two disagreeing versions of it.
// Runs are built and merged locally here, so their arrays are mutable on
// purpose; nothing outside this module sees them before they are read out.
interface CommonRun {
  common: string[];
}
interface DiffRun {
  ours: string[];
  theirs: string[];
  base?: string[];
  changedBy?: 'ours' | 'theirs' | 'both';
}
type Run = CommonRun | DiffRun;

// Longest-common-subsequence line diff, used to break one of git's conflicts
// into the separate decisions it really contains.
//
// Git groups edits that are close together into a single conflict, because its
// merge works in regions rather than in lines. So a page where the heading was
// changed on one branch and the paragraph on the other arrives as ONE choice
// covering both — and no answer to it is right: either side loses an edit, and
// "both" duplicates the heading AND the paragraph.
//
// Comparing the two sides line by line separates them again. The lines they
// agree on stop being part of the choice, and each run they disagree on
// becomes a decision of its own.
function lineDiff(a: readonly string[], b: readonly string[]): Run[] {
  // A conflict big enough to make this expensive is one nobody is going to
  // resolve line by line anyway; left whole, it still works as one choice.
  if (a.length * b.length > 250000) {
    return [{ ours: [...a], theirs: [...b] }];
  }
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i];
    if (!row) {
      continue;
    }
    for (let j = n - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (dp[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const runs: Run[] = [];
  let i = 0;
  let j = 0;
  const push = (run: Run): void => {
    const last = runs[runs.length - 1];
    // Adjacent runs of the same sort are one run: two changed lines next to
    // each other are one edit, not two decisions.
    if (last && 'ours' in last === 'ours' in run) {
      if ('ours' in last && 'ours' in run) {
        last.ours.push(...run.ours);
        last.theirs.push(...run.theirs);
      } else if (!('ours' in last) && !('ours' in run)) {
        last.common.push(...run.common);
      }
      return;
    }
    runs.push(run);
  };
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push({ common: [a[i] ?? ''] });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      push({ ours: [a[i] ?? ''], theirs: [] });
      i++;
    } else {
      push({ ours: [], theirs: [b[j] ?? ''] });
      j++;
    }
  }
  if (i < m || j < n) {
    push({ ours: a.slice(i), theirs: b.slice(j) });
  }
  return runs;
}

interface Interval {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

// Where one side rewrote the ancestor: a list of `{start, end, lines}` over
// base line numbers, `lines` being what that side put there instead.
function changeIntervals(base: readonly string[], side: readonly string[]): Interval[] {
  const out: Interval[] = [];
  let b = 0;
  for (const run of lineDiff(base, side)) {
    if ('ours' in run) {
      out.push({ start: b, end: b + run.ours.length, lines: run.theirs });
      b += run.ours.length;
      continue;
    }
    b += run.common.length;
  }
  return out;
}

/**
 * One of git's conflicts, split into the decisions it really contains.
 *
 * Comparing the two sides to each OTHER is not enough: when a heading was
 * edited on one branch and the paragraph beneath it on the other, every line
 * differs between the two sides and there is nothing common to split on. What
 * separates them is the ancestor — the version both started from. Against it,
 * the heading was changed only by one branch and the paragraph only by the
 * other, so they are two independent decisions and neither needs asking about.
 *
 * Returns runs: `{ common }` for text nothing touched, or
 * `{ ours, theirs, base, changedBy }` where `changedBy` is which side actually
 * moved — 'ours', 'theirs', or 'both' when they really do disagree.
 */
function threeWay(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): Run[] {
  const A = changeIntervals(base, ours);
  const B = changeIntervals(base, theirs);
  const runs: Run[] = [];
  let i = 0;
  let ai = 0;
  let bi = 0;

  while (ai < A.length || bi < B.length) {
    const start = Math.min(
      ai < A.length ? (A[ai]?.start ?? Infinity) : Infinity,
      bi < B.length ? (B[bi]?.start ?? Infinity) : Infinity,
    );
    if (i < start) {
      runs.push({ common: base.slice(i, start) });
      i = start;
    }
    // Edits that OVERLAP are one decision — two rewrites of the same lines
    // cannot be answered separately. Edits that merely sit next to each other
    // are two, which is the whole point: a heading changed on one branch and
    // the paragraph under it changed on the other are adjacent, not the same
    // question, and joining them would put the user back to choosing a whole
    // block they only wanted half of.
    const mine: Interval[] = [];
    const yours: Interval[] = [];
    let end = start;
    // Take whichever starts here, then anything genuinely overlapping it. A
    // zero-width edit (a pure insertion) sitting exactly at the boundary joins
    // too: both sides inserting at one point really is one disagreement.
    const overlaps = (iv: Interval): boolean =>
      iv.start < end || (iv.start === end && iv.start === iv.end);
    const takeA = (): void => {
      const iv = A[ai];
      if (iv === undefined) {
        return;
      }
      end = Math.max(end, iv.end);
      mine.push(iv);
      ai++;
    };
    const takeB = (): void => {
      const iv = B[bi];
      if (iv === undefined) {
        return;
      }
      end = Math.max(end, iv.end);
      yours.push(iv);
      bi++;
    };
    if (ai < A.length && A[ai]?.start === start) {
      takeA();
    }
    if (bi < B.length && B[bi]?.start === start) {
      takeB();
    }
    for (let moved = true; moved;) {
      moved = false;
      while (ai < A.length) {
        const iv = A[ai];
        if (iv === undefined || !overlaps(iv)) {
          break;
        }
        takeA();
        moved = true;
      }
      while (bi < B.length) {
        const iv = B[bi];
        if (iv === undefined || !overlaps(iv)) {
          break;
        }
        takeB();
        moved = true;
      }
    }
    // What each side says across this stretch: the ancestor's lines with that
    // side's rewrites put back in.
    const build = (ivs: readonly Interval[]): string[] => {
      const out: string[] = [];
      let p = start;
      for (const iv of ivs) {
        out.push(...base.slice(p, iv.start));
        out.push(...iv.lines);
        p = iv.end;
      }
      out.push(...base.slice(p, end));
      return out;
    };
    runs.push({
      ours: build(mine),
      theirs: build(yours),
      base: base.slice(start, end),
      changedBy: mine.length && yours.length ? 'both' : mine.length ? 'ours' : 'theirs',
    });
    i = end;
  }
  if (i < base.length) {
    runs.push({ common: base.slice(i) });
  }
  return runs;
}

// Words, punctuation and the gaps between them, kept separately so joining
// them back together reproduces the text exactly. Splitting on whitespace
// alone would lose the whitespace, and a merge that quietly reformats a line
// is a merge nobody can trust.
const tokenize = (text: unknown): string[] =>
  String(text ?? '').match(/\s+|[A-Za-z0-9_]+|[^\s A-Za-z0-9_]/g) ?? [];

/**
 * Two edits to the same lines that do not actually touch each other.
 *
 * A heading where one branch added a class and the other rewrote the words is
 * a single conflicted line, and answering it either way throws away one of the
 * two edits. But inside the line the changes are nowhere near each other — one
 * is in the attributes, one is in the text — so the same three-way split, run
 * over words instead of lines, separates them and both can be kept.
 *
 * Returns the combined text, or null when the edits really do overlap and
 * there is a genuine choice to make.
 */
function mergeInline(base: string | null | undefined, ours: string, theirs: string): string | null {
  if (base == null) {
    return null;
  }
  const runs = threeWay(tokenize(base), tokenize(ours), tokenize(theirs));
  // Any region both sides rewrote is a real disagreement; combining it would
  // be inventing a version neither branch wrote.
  if (runs.some((r) => 'ours' in r && r.changedBy === 'both')) {
    return null;
  }
  if (!runs.some((r) => 'ours' in r)) {
    return null; // nothing to combine
  }
  return runs
    .map((r) => ('ours' in r ? (r.changedBy === 'theirs' ? r.theirs : r.ours) : r.common).join(''))
    .join('');
}

// Which side actually made the change, judged against what both started from.
// When one side still says what the ancestor said, it did not change — so the
// other side's edit is the only edit, and defaulting to it loses nothing.
// Only when both moved is there a real disagreement to put to the user.
function whoChanged(
  ours: string,
  theirs: string,
  base: string | null | undefined,
): 'ours' | 'theirs' | 'both' {
  if (base == null) {
    return 'both';
  }
  const inBase = (text: string): boolean => text.trim() === '' || base.includes(text.trim());
  const o = inBase(ours);
  const t = inBase(theirs);
  if (o && !t) {
    return 'theirs';
  }
  if (t && !o) {
    return 'ours';
  }
  return 'both';
}

const START = /^<<<<<<< ?(.*)$/;
const MIDDLE = /^=======\s*$/;
const BASE = /^\|\|\|\|\|\|\| ?(.*)$/; // only present under diff3 conflict style
const END = /^>>>>>>> ?(.*)$/;

export type ConflictPart =
  | { readonly kind: 'same'; readonly text: string }
  | {
      readonly kind: 'clash';
      readonly ours: string;
      readonly theirs: string;
      readonly changedBy: 'ours' | 'theirs' | 'both';
      merged?: string;
    };

/**
 * A conflicted file as a list of parts.
 *
 * Each part is either `{ kind: 'same', text }` — agreed text — or
 * `{ kind: 'clash', ours, theirs }`, one disagreement. Joining the `same`
 * parts with a chosen side of each `clash` rebuilds the file.
 *
 * A file with no markers comes back as a single `same` part, which is the
 * honest answer: there is nothing to choose.
 */
function parseConflict(text: unknown): ConflictPart[] {
  const lines = String(text ?? '').split('\n');
  const parts: ConflictPart[] = [];
  let same: string[] = [];
  let i = 0;

  const flushSame = (): void => {
    if (same.length) {
      parts.push({ kind: 'same', text: same.join('\n') });
    }
    same = [];
  };

  while (i < lines.length) {
    const startLine = lines[i];
    if (startLine === undefined || !START.test(startLine)) {
      same.push(startLine ?? '');
      i++;
      continue;
    }
    // A marker that never closes is a file somebody edited by hand and left
    // broken. Treating the rest as ordinary text keeps every line, which
    // matters more here than being clever: nothing is silently dropped.
    const ours: string[] = [];
    const theirs: string[] = [];
    const base: string[] = [];
    let sawMiddle = false;
    let sawBase = false;
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (END.test(line)) {
        closed = true;
        break;
      }
      if (MIDDLE.test(line)) {
        sawMiddle = true;
        continue;
      }
      // Under diff3 the common ancestor sits between the two sides. It is not
      // a third choice — it is what both started FROM — but it is what says
      // which side actually changed, so it is kept and never offered.
      if (BASE.test(line)) {
        sawBase = true;
        continue;
      }
      (sawMiddle ? theirs : sawBase ? base : ours).push(line);
    }
    if (!closed) {
      same.push(startLine);
      i++;
      continue;
    }
    flushSame();
    // One of git's conflicts is often several decisions wearing one coat.
    // Comparing the two sides line by line separates them, so the lines they
    // agree on stop being part of the choice and each run they disagree on
    // becomes its own.
    // With the ancestor, the split is exact — each side's edits are known
    // rather than guessed at. Without it (a repo not set to record it) the two
    // sides are compared to each other, which still separates edits that share
    // untouched lines between them.
    const split = sawBase
      ? threeWay(base, ours, theirs)
      : lineDiff(ours, theirs).map((r): Run =>
          'ours' in r
            ? { ...r, changedBy: whoChanged(r.ours.join('\n'), r.theirs.join('\n'), null) }
            : r,
        );
    for (const run of split) {
      if (!('ours' in run)) {
        parts.push({ kind: 'same', text: run.common.join('\n') });
        continue;
      }
      const clash: ConflictPart = {
        kind: 'clash',
        ours: run.ours.join('\n'),
        theirs: run.theirs.join('\n'),
        changedBy: run.changedBy ?? 'both',
      };
      // Both sides touched these lines — but perhaps not the same part of
      // them. Splitting again by word finds out, and where the two edits do
      // not overlap, keeping both is the answer nobody has to think about.
      if (clash.kind === 'clash' && clash.changedBy === 'both' && run.base) {
        const merged = mergeInline(run.base.join('\n'), clash.ours, clash.theirs);
        if (merged !== null) {
          clash.merged = merged;
        }
      }
      parts.push(clash);
    }
    i = j + 1;
  }
  flushSame();
  return parts;
}

/** How many disagreements are in a parsed file. */
const clashCount = (parts: readonly ConflictPart[] | null | undefined): number =>
  (parts ?? []).filter((p) => p.kind === 'clash').length;

/**
 * Put the file back together, given one answer per disagreement.
 *
 * `picks` is an array in the order the clashes appear: `'ours'`, `'theirs'`,
 * or `'both'`. Missing or unrecognised answers keep `ours` — between silently
 * dropping the user's own work and silently dropping work they asked to merge
 * in, the first is worse, because the incoming version is still on its branch
 * and theirs may exist nowhere else.
 */
function renderResolved(
  parts: readonly ConflictPart[] | null | undefined,
  picks: readonly unknown[] = [],
): string {
  let n = -1;
  return (parts ?? [])
    .map((part) => {
      if (part.kind === 'same') {
        return part.text;
      }
      n++;
      const pick = picks[n];
      // Both edits, combined — only offered where they were found not to
      // overlap, so this is the two changes and not a duplication.
      if (pick === 'merged' && part.merged != null) {
        return part.merged;
      }
      if (pick === 'theirs') {
        return part.theirs;
      }
      // Both sides, in the order they appear in the file. A heading changed on
      // two branches is usually one or the other; a list that gained an item on
      // each is usually both.
      if (pick === 'both') {
        return [part.ours, part.theirs].filter((s) => s !== '').join('\n');
      }
      return part.ours;
    })
    .join('\n');
}

export { parseConflict, renderResolved, clashCount, threeWay, lineDiff, mergeInline };
