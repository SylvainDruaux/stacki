// Selector parsing, specificity, and matching against the selected element.
//
// The Designer gives us no canvas DOM, so we can't call `element.matches()`.
// Instead we parse each selector with postcss-selector-parser and match it
// ourselves. Matching is tree-aware: it navigates the real page tree (ancestors,
// ordered siblings, descendants) via a TreeView, so descendant/child/sibling
// combinators, `:is()`/`:where()`/`:not()` and `:has()` all resolve correctly.
// It's async because element snapshots are read (and cached) on demand.

import selectorParser from 'postcss-selector-parser';
import type { ElementSnapshot, SelectorInfo, Specificity } from './styleTypes';
import { assert } from '../../../../shared/core/assert';

type Combinator = ' ' | '>' | '+' | '~';
type HasAxis = 'descendant' | 'child' | 'sibling' | 'adjacent';
type HasCond = { axis: HasAxis; sel: CompiledSelector };

type AttrCond = {
  name: string;
  operator: string | undefined;
  value: string | undefined;
  insensitive: boolean;
};

type Compound = {
  universal: boolean;
  tag: string | undefined;
  id: string | undefined;
  classes: string[];
  attrs: AttrCond[];
  /** `:not(...)` arguments, each a compiled selector to negate. */
  negations: CompiledSelector[];
  /** `:is()` / `:where()` groups — element must match ≥1 selector in each group. */
  requireAny: CompiledSelector[][];
  /** `:has(...)` relational conditions — element must satisfy each. */
  hasGroups: HasCond[];
  hasPseudoClass: boolean;
  /** State/structural pseudo-classes on this compound (`:hover`, `:focus`, …), lowercased. */
  pseudoClasses: string[];
  /** Positional pseudos with their raw `An+B` argument, which pseudoClasses drops. */
  positional: PositionalPseudo[];
  pseudoElement: string | undefined;
};

type PositionalPseudo = { name: string; arg: string | undefined };

type CompiledSelector = {
  text: string;
  compounds: Compound[];
  /** combinators[i] links compounds[i-1] and compounds[i]; combinators[0] unused. */
  combinators: Combinator[];
  specificity: Specificity;
  hasPseudoClass: boolean;
  pseudoElement: string | undefined;
};

const emptyCompound = (): Compound => ({
  universal: false,
  tag: undefined,
  id: undefined,
  classes: [],
  attrs: [],
  negations: [],
  requireAny: [],
  hasGroups: [],
  hasPseudoClass: false,
  pseudoClasses: [],
  positional: [],
  pseudoElement: undefined,
});

function normalizeCombinator(value: string): Combinator {
  const trimmed = value.trim();
  if (trimmed === '>') {
    return '>';
  }
  if (trimmed === '+') {
    return '+';
  }
  if (trimmed === '~') {
    return '~';
  }
  return ' ';
}

function isPseudoElement(value: string): boolean {
  if (value.startsWith('::')) {
    return true;
  }
  // Legacy single-colon pseudo-elements.
  return /^:(before|after|first-line|first-letter|placeholder|selection|marker|backdrop)$/i.test(
    value,
  );
}

/** Parse a full selector list (comma-separated) into display + match info. */
export function parseSelectorList(selectorText: string): SelectorInfo[] {
  const compiled = compileSelectorList(selectorText);
  return compiled.map((selector) => ({
    text: selector.text,
    specificity: selector.specificity,
    hasPseudoClass: selector.hasPseudoClass,
    pseudoElement: selector.pseudoElement,
    approximate: false,
  }));
}

export type SelectorListMember = {
  readonly text: string;
  readonly from: number;
  readonly to: number;
};

/** Locate top-level selector-list members without splitting commas in functions,
 *  attributes, or quoted attribute values. Offsets refer to the original text. */
export function selectorListMembers(selectorText: string): readonly SelectorListMember[] {
  const members: SelectorListMember[] = [];
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let start = 0;
  const append = (end: number) => {
    const raw = selectorText.slice(start, end);
    const leadingLength = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length === 0) {
      return;
    }
    const from = start + leadingLength;
    members.push({ text, from, to: from + text.length });
  };

  for (let index = 0; index < selectorText.length; index += 1) {
    const character = selectorText[index] ?? '';
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (character === ',' && parenthesisDepth === 0 && bracketDepth === 0) {
      append(index);
      start = index + 1;
    }
  }
  append(selectorText.length);
  return members;
}

/**
 * A single selector's subject compound projected into the element-token namespace
 * (`tag:div` / `class:a` / `attr:data-x`), matching snapshotTokens. `simple` is
 * true only for a lone compound of tag/classes/attrs (no combinator, no id, no
 * `:is()`/`:has()`/`:not()`) — the only shape a token chip can represent, so the
 * resolver treats non-simple selectors as complex/orange-only. `pseudoClasses`
 * carries the subject's state pseudos (`:hover`, …) regardless of `simple`.
 */
export type CanonicalCompound = {
  simple: boolean;
  /** True when the selector is a single compound (no combinator / descendant) — it
   *  may still carry `:is()`/`:not()`/pseudos, unlike `simple`. Distinguishes
   *  `.a:is(:hover,:focus)` (one compound) from `.parent .a` (complex). */
  oneCompound: boolean;
  tokens: string[];
  pseudoClasses: string[];
  /** The pseudo-element the selector targets ('::before'), normalized, or ''. A
   *  pseudo-element styles a generated box, so it's a separate edit target from the
   *  element itself and never `simple` (not chip/native-editable). */
  pseudoElement: string;
  /** True when the selector is a single plain compound (tag/class/attr[/id], plus a
   *  pseudo-class and/or pseudo-element) with NO combinator and NO `:is()`/`:has()`/
   *  `:not()`. Such a selector reads cleanly on its own, so it can be split out of a
   *  grouped rule for an isolated edit (`.a::before` yes; `:not(.x) > :is(...)` no). */
  splittable: boolean;
  /** True when the subject compound is the universal `*` (with no tag/class/attr). */
  universal: boolean;
};

// Pseudo-classes representable as a Webflow class STATE (a chip / native-editable
// combo). Any other pseudo-class — structural (:nth-child, :first-child, :nth-of-type,
// …) or an unsupported state — must keep the compound COMPLEX so its full text is
// preserved (embed-editable) instead of collapsing to the bare class.
const STATE_PSEUDO_CLASSES = new Set([':hover', ':focus', ':active']);

export function canonicalCompound(selectorText: string): CanonicalCompound {
  const first = compileSelectorList(selectorText)[0];
  const subject = first?.compounds[first.compounds.length - 1];
  if (!first || !subject) {
    return {
      simple: false,
      oneCompound: false,
      tokens: [],
      pseudoClasses: [],
      pseudoElement: '',
      splittable: false,
      universal: false,
    };
  }

  const pseudoClasses = subject.pseudoClasses;
  const pseudoElement = normalizePseudoElement(first.pseudoElement);
  const oneCompound = first.compounds.length === 1 && first.combinators.length === 0;
  const noFunctionalPseudo =
    subject.negations.length === 0 &&
    subject.requireAny.length === 0 &&
    subject.hasGroups.length === 0;
  // Only bare state pseudos keep a compound "simple"; a structural pseudo (:nth-child …)
  // isn't a Webflow class state, so it must read as complex to keep its full text.
  const stateOnly = pseudoClasses.every((pseudo) => STATE_PSEUDO_CLASSES.has(pseudo));
  const simple =
    oneCompound &&
    !pseudoElement &&
    !subject.universal &&
    subject.id === undefined &&
    noFunctionalPseudo &&
    stateOnly;
  // Like `simple`, but a pseudo-element is allowed (it's the whole point of splitting
  // `.a::before`). A bare universal (`::before`) is never splittable — it's hidden.
  const splittable = oneCompound && !subject.universal && noFunctionalPseudo;

  const tokens: string[] = [];
  if (subject.tag) {
    tokens.push(`tag:${subject.tag}`);
  }
  subject.classes.forEach((cls) => tokens.push(`class:${cls}`));
  subject.attrs.forEach((attr) => {
    // Presence `[data-x]` → `attr:data-x` (matches a chip); a valued/operator
    // form `[data-x="y"]` gets a distinct token so it stays orange-only.
    tokens.push(
      attr.operator && attr.value !== undefined
        ? `attr:${attr.name}${attr.operator}"${attr.value}"`
        : `attr:${attr.name}`,
    );
  });
  return {
    simple,
    oneCompound,
    tokens,
    pseudoClasses,
    pseudoElement,
    splittable,
    universal: subject.universal,
  };
}

/** True when the selector's subject is qualified by a parent or ancestor. */
export function selectorDependsOnAncestor(selectorText: string): boolean {
  const selectors = compileSelectorList(selectorText);
  return selectors.some((selector) =>
    selector.combinators.some((combinator) => combinator === ' ' || combinator === '>'),
  );
}

/** Normalize a pseudo-element to its `::name` form (handles legacy `:before`), or ''. */
export function normalizePseudoElement(pseudoElement: string | undefined): string {
  if (!pseudoElement) {
    return '';
  }
  return `::${pseudoElement.replace(/^::?/, '').toLowerCase()}`;
}

const compileCache = new Map<string, CompiledSelector[]>();

function compileSelectorList(selectorText: string): CompiledSelector[] {
  const cached = compileCache.get(selectorText);
  if (cached) {
    return cached;
  }

  let result: CompiledSelector[] = [];
  try {
    selectorParser((root) => {
      root.each((selector) => {
        if (selector.type !== 'selector') {
          return;
        }
        result.push(compileSelector(selector));
      });
    }).processSync(selectorText);
  } catch {
    // Unparseable selector — yield a never-matching stub so the rule still lists.
    result = [
      {
        text: selectorText.trim(),
        compounds: [],
        combinators: [],
        specificity: [0, 0, 0],
        hasPseudoClass: false,
        pseudoElement: undefined,
      },
    ];
  }

  compileCache.set(selectorText, result);
  return result;
}

type SelectorNode = selectorParser.Selector;

function compileSelector(selector: SelectorNode): CompiledSelector {
  const builder = new SelectorBuilder();
  selector.each((node) => {
    builder.add(node);
  });
  return builder.finish(selector.toString().trim());
}

// Accumulates one selector's compounds, combinators and specificity as its nodes are
// visited left to right. `current` is the compound being built; a combinator closes it.
class SelectorBuilder {
  private readonly compounds: Compound[] = [];
  private readonly combinators: Combinator[] = [];
  private current = emptyCompound();
  private started = false;
  private idCount = 0;
  private classCount = 0;
  private typeCount = 0;
  private hasPseudoClass = false;
  private pseudoElement: string | undefined;

  add(node: selectorParser.Node): void {
    switch (node.type) {
      case 'combinator': {
        if (this.started) {
          this.pushCurrent();
          this.combinators.push(normalizeCombinator(node.value));
          this.started = false;
        }
        return;
      }
      case 'tag': {
        this.current.tag = node.value.toLowerCase();
        this.typeCount += 1;
        break;
      }
      case 'universal': {
        this.current.universal = true;
        break;
      }
      case 'id': {
        this.current.id = node.value;
        this.idCount += 1;
        break;
      }
      case 'class': {
        this.current.classes.push(node.value);
        this.classCount += 1;
        break;
      }
      case 'attribute': {
        this.current.attrs.push({
          name: node.attribute.toLowerCase(),
          operator: node.operator,
          value: node.value,
          insensitive: Boolean(node.insensitive),
        });
        this.classCount += 1;
        break;
      }
      case 'pseudo': {
        this.addPseudo(node);
        break;
      }
      case 'string':
      case 'root':
      case 'comment':
      case 'nesting':
      case 'selector':
        return;
      default: {
        const unhandled: never = node;
        return unhandled;
      }
    }
    this.started = true;
  }

  private addPseudo(node: selectorParser.Pseudo): void {
    const value = node.value;
    if (isPseudoElement(value)) {
      this.current.pseudoElement = value;
      this.pseudoElement = value;
      this.typeCount += 1;
    } else if (value === ':not') {
      // Negation: compile inner, negate at match time; specificity = the
      // most specific argument (per spec).
      const inner = compileFunctionalArg(node);
      this.current.negations.push(...inner);
      this.addSpecificity(mostSpecific(inner));
    } else if (value === ':is' || value === ':matches' || value === ':where') {
      // :is()/:where() are static structural matchers, NOT state pseudo-
      // classes — the element must match one of their arguments. :where
      // adds zero specificity; :is/:matches add their most specific arg.
      const inner = compileFunctionalArg(node);
      if (inner.length) {
        this.current.requireAny.push(inner);
      }
      if (value !== ':where') {
        this.addSpecificity(mostSpecific(inner));
      }
    } else if (value === ':has') {
      // Relational: element must have a descendant/sibling matching the arg.
      const conditions = compileHasArg(node);
      this.current.hasGroups.push(...conditions);
      this.addSpecificity(mostSpecific(conditions.map((condition) => condition.sel)));
    } else {
      // A real state/structural pseudo-class (:hover, :focus, :nth-child, …)
      // — mark conditional. Positional ones also keep their An+B argument,
      // which pseudoClasses (names only) can't carry, so the matcher can
      // evaluate them against the tree.
      this.current.hasPseudoClass = true;
      const pseudoName = value.toLowerCase();
      this.current.pseudoClasses.push(pseudoName);
      if (POSITIONAL_PSEUDOS.has(pseudoName)) {
        this.current.positional.push({ name: pseudoName, arg: pseudoArgText(node) });
      }
      this.hasPseudoClass = true;
      this.classCount += 1;
    }
  }

  private addSpecificity(top: Specificity | undefined): void {
    if (top) {
      this.idCount += top[0];
      this.classCount += top[1];
      this.typeCount += top[2];
    }
  }

  private pushCurrent(): void {
    this.compounds.push(this.current);
    this.current = emptyCompound();
  }

  finish(text: string): CompiledSelector {
    if (this.started) {
      this.pushCurrent();
    }
    assert(
      this.combinators.length <= Math.max(0, this.compounds.length - 1),
      'SelectorBuilder: a combinator sits between two compounds',
    );
    return {
      text,
      compounds: this.compounds,
      combinators: this.combinators,
      specificity: [this.idCount, this.classCount, this.typeCount],
      hasPseudoClass: this.hasPseudoClass,
      pseudoElement: this.pseudoElement,
    };
  }
}

function compileFunctionalArg(node: selectorParser.Pseudo): CompiledSelector[] {
  const out: CompiledSelector[] = [];
  node.each?.((child) => {
    if (child.type === 'selector') {
      out.push(compileSelector(child));
    }
  });
  return out;
}

function axisFromCombinator(value: string): HasAxis {
  const trimmed = value.trim();
  if (trimmed === '>') {
    return 'child';
  }
  if (trimmed === '+') {
    return 'adjacent';
  }
  if (trimmed === '~') {
    return 'sibling';
  }
  return 'descendant';
}

/** Compile `:has(...)` args, reading the leading combinator as the relation. */
function compileHasArg(node: selectorParser.Pseudo): HasCond[] {
  const out: HasCond[] = [];
  node.each?.((child) => {
    if (child.type !== 'selector') {
      return;
    }
    const first = child.nodes[0];
    const axis: HasAxis =
      first && first.type === 'combinator' ? axisFromCombinator(first.value) : 'descendant';
    // compileSelector ignores a leading combinator, so `sel` is the arg minus it.
    out.push({ axis, sel: compileSelector(child) });
  });
  return out;
}

/** The most specific argument's specificity (for :not / :is / :has). */
function mostSpecific(selectors: CompiledSelector[]): Specificity | undefined {
  let best: Specificity | undefined;
  for (const selector of selectors) {
    if (!best || compareSpecificity(selector.specificity, best) > 0) {
      best = selector.specificity;
    }
  }
  return best;
}

// ─────────────────────────── Matching ───────────────────────────
//
// Matching is STRICT and tree-aware: a rule matches only when we can
// affirmatively confirm it against the element's tag/id/classes/attributes and
// its real position in the page tree (ancestors, ordered siblings, descendants).
// Anything unverifiable (an unknown tag on a bare type selector, a sibling we
// can't see) is a non-match, so the panel never shows styles that don't apply.

export type MatchResult = { matched: boolean; approximate: boolean };
const NO_MATCH: MatchResult = { matched: false, approximate: false };

/** Read-only view of the page tree the matcher navigates. */
export type TreeView = {
  /** True when ancestors above the root are unknown (component boundary). */
  truncated: boolean;
  parentKey: (key: string) => string | undefined;
  /** Ordered child keys of an element. */
  childKeys: (key: string) => string[];
  /**
   * Ordered children that actually render as elements, for the positional
   * pseudo-classes — `childKeys` also carries text/comment nodes, which CSS
   * doesn't count. Returns undefined when the answer can't be trusted (a loop or
   * expression sibling expands to an unknown number of elements), so callers
   * stay optimistic rather than guessing.
   */
  elementChildKeys?: (key: string) => string[] | undefined;
  /** Element identity by key, read + cached on demand. */
  snapshot: (key: string) => Promise<ElementSnapshot | undefined>;
};

export type MatchTarget = {
  rootKey: string;
  view: TreeView;
  /**
   * What the RENDERED page says about this element, when a live canvas can be
   * asked (see canvasQuery.js / primeDomMatches). Keyed by selector text.
   *
   * The tree walk below can only see the source: it stops at a component's
   * edge, and knows nothing of classes applied at runtime. Chromium matching
   * against the real DOM has neither limit, so its answer wins wherever it
   * has one — this map — and the walk stays as the fallback for everything
   * else (no preview running, a page that failed to build, a selector the
   * engine rejected).
   */
  domMatched?: Map<string, boolean>;
};

const HAS_DESCENDANTS_MAX = 2000;

// Compounds one selector may chain (`a > b c + d …`) before matching refuses it.
// Real stylesheets chain a handful; a few hundred leaves room for generated CSS.
const SELECTOR_LIMITS = { chainDepthMax: 256 } as const;

/** Match every selector in a list against the target element; results in order. */
export async function matchSelectorList(
  selectorText: string,
  target: MatchTarget,
): Promise<MatchResult[]> {
  const compiled = compileSelectorList(selectorText);
  const results: MatchResult[] = [];
  for (const selector of compiled) {
    const fromDom = target.domMatched?.get(selector.text);
    if (fromDom !== undefined) {
      results.push({ matched: fromDom, approximate: false });
      continue;
    }
    results.push(await matchComplex(selector, target.rootKey, target.view));
  }
  return results;
}

async function matchComplex(
  selector: CompiledSelector,
  subjectKey: string,
  view: TreeView,
): Promise<MatchResult> {
  if (!selector.compounds.length) {
    return NO_MATCH;
  }
  const keyIndex = selector.compounds.length - 1;
  const subject = selector.compounds[keyIndex];
  if (subject === undefined) {
    return NO_MATCH;
  }
  // Key (rightmost) compound must match the subject element itself.
  if (!(await matchCompound(subject, subjectKey, view))) {
    return NO_MATCH;
  }
  return { matched: await matchUpchain(selector, keyIndex, subjectKey, view), approximate: false };
}

/** Anchor compounds to the left of `compoundIndex` by walking the real tree. */
async function matchUpchain(
  selector: CompiledSelector,
  compoundIndex: number,
  currentKey: string,
  view: TreeView,
): Promise<boolean> {
  if (compoundIndex === 0) {
    return true;
  }
  // Each call anchors one compound further left, so the chain is as deep as the
  // selector is long. A chain past the bound is not hand-written CSS: refuse it.
  const chainDepth = selector.compounds.length - 1 - compoundIndex;
  if (chainDepth > SELECTOR_LIMITS.chainDepthMax) {
    return false;
  }
  // combinators[i] links compounds[i] and compounds[i+1], so the combinator to
  // the LEFT of compoundIndex lives at compoundIndex - 1.
  const combinator = selector.combinators[compoundIndex - 1];
  const left = selector.compounds[compoundIndex - 1];
  if (left === undefined) {
    return false;
  }

  if (combinator === '>') {
    const parent = view.parentKey(currentKey);
    if (parent === undefined) {
      return false;
    } // parent unknown → can't confirm
    if (!(await matchCompound(left, parent, view))) {
      return false;
    }
    return matchUpchain(selector, compoundIndex - 1, parent, view);
  }

  if (combinator === ' ') {
    // Descendant: some real ancestor must satisfy `left`.
    let ancestor = view.parentKey(currentKey);
    while (ancestor !== undefined) {
      if (
        (await matchCompound(left, ancestor, view)) &&
        (await matchUpchain(selector, compoundIndex - 1, ancestor, view))
      ) {
        return true;
      }
      ancestor = view.parentKey(ancestor);
    }
    return false;
  }

  // Sibling (`~` any preceding, `+` immediately preceding).
  const reach = combinator === '+' ? 'adjacent' : 'all';
  for (const sibling of precedingSiblings(currentKey, view, reach)) {
    if (
      (await matchCompound(left, sibling, view)) &&
      (await matchUpchain(selector, compoundIndex - 1, sibling, view))
    ) {
      return true;
    }
  }
  return false;
}

async function matchCompound(compound: Compound, key: string, view: TreeView): Promise<boolean> {
  const snapshot = await view.snapshot(key);
  if (!snapshot) {
    return false;
  }

  // An id must equal the element's.
  if (compound.id !== undefined && snapshot.id !== compound.id) {
    return false;
  }

  // Classes: every class in the selector must be on the element.
  for (const cls of compound.classes) {
    if (!snapshot.classes.includes(cls)) {
      return false;
    }
  }

  // Attributes and data attributes.
  for (const attr of compound.attrs) {
    if (!matchAttr(attr, snapshot)) {
      return false;
    }
  }

  // The tag is strict: it must equal the known tag. If the tag is unknown, only accept
  // when other constraints already pinned the element, so a bare unverifiable
  // type selector (`div`, `a`) never matches.
  if (compound.tag && compound.tag !== '*') {
    const hasOther =
      compound.id !== undefined ||
      compound.classes.length > 0 ||
      compound.attrs.length > 0 ||
      compound.requireAny.length > 0 ||
      compound.hasGroups.length > 0;
    if (snapshot.tag !== undefined) {
      if (snapshot.tag !== compound.tag) {
        return false;
      }
    } else if (!hasOther) {
      return false;
    }
  }

  // `:is(...)` / `:where(...)`: the element must match ≥1 selector in every group.
  for (const group of compound.requireAny) {
    let ok = false;
    for (const selector of group) {
      if ((await matchComplex(selector, key, view)).matched) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      return false;
    }
  }

  // `:has(...)`: the element must satisfy each relational condition.
  for (const cond of compound.hasGroups) {
    if (!(await matchHas(cond, key, view))) {
      return false;
    }
  }

  // `:not(...)`: the element must NOT match the negated selector.
  for (const negation of compound.negations) {
    if ((await matchComplex(negation, key, view)).matched) {
      return false;
    }
  }

  // Structural pseudo-classes we can decide statically. `:root` matches only the
  // document root (<html>); a nested element merely *inherits* the custom
  // properties declared on `:root`, so `:root { --var }` must not count as
  // applied to this element. Dynamic states (:hover/:focus/…) stay optimistic
  // (matched + flagged conditional) since we can't know the runtime state.
  for (const pseudo of compound.pseudoClasses) {
    if (pseudo === ':root' && snapshot.tag !== 'html') {
      return false;
    }
  }

  // Position in the parent is knowable from the tree, so don't wave these
  // through with the dynamic states — a first child was matching
  // `> :last-child` and picking up styles it never gets on the page.
  for (const entry of compound.positional) {
    if ((await matchesPosition(entry, key, view)) === false) {
      return false;
    }
  }

  return true;
}

// Pseudo-classes decided by position among siblings rather than runtime state.
const POSITIONAL_PSEUDOS = new Set([
  ':first-child',
  ':last-child',
  ':only-child',
  ':nth-child',
  ':nth-last-child',
  ':first-of-type',
  ':last-of-type',
  ':only-of-type',
  ':nth-of-type',
  ':nth-last-of-type',
]);

/** The text between a functional pseudo's parentheses (`2n + 1`), or undefined. */
function pseudoArgText(node: { toString: () => string }): string | undefined {
  const text = String(node);
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  return open !== -1 && close > open ? text.slice(open + 1, close).trim() : undefined;
}

/**
 * CSS An+B — "odd", "even", "3", "n", "2n", "-n+2", "2n+1"…
 * Returns undefined for anything unrecognised (including the `of S` form, whose
 * selector list we don't evaluate) so the caller stays optimistic.
 */
function parseNthFormula(raw: string | undefined): { step: number; offset: number } | undefined {
  if (!raw) {
    return undefined;
  }
  const compact = raw.replace(/\s+/g, '').toLowerCase();
  if (compact === 'odd') {
    return { step: 2, offset: 1 };
  }
  if (compact === 'even') {
    return { step: 2, offset: 0 };
  }
  if (compact.includes('of')) {
    return undefined;
  }
  const anb = /^([+-]?\d*)n([+-]\d+)?$/.exec(compact);
  if (anb) {
    const lead = anb[1];
    const step = lead === '' || lead === '+' ? 1 : lead === '-' ? -1 : Number(lead);
    const offset = anb[2] ? Number(anb[2]) : 0;
    return Number.isFinite(step) && Number.isFinite(offset) ? { step, offset } : undefined;
  }
  if (/^[+-]?\d+$/.test(compact)) {
    return { step: 0, offset: Number(compact) };
  }
  return undefined;
}

/** Does 1-based `position` satisfy An+B for some integer n ≥ 0? */
function nthMatches(position: number, step: number, offset: number): boolean {
  if (step === 0) {
    return position === offset;
  }
  const cycles = (position - offset) / step;
  return Number.isInteger(cycles) && cycles >= 0;
}

/**
 * Whether `key` sits where the pseudo requires, or undefined when the tree can't
 * say — no known parent (a component boundary), a sibling that expands to an
 * unknown number of elements, an unparseable An+B, or, for the `-of-type`
 * family, a sibling whose tag is unknown (a component renders markup this
 * panel can't see, so its element type is unknowable). Undefined keeps the old
 * optimistic behaviour instead of guessing.
 */
async function matchesPosition(
  entry: PositionalPseudo,
  key: string,
  view: TreeView,
): Promise<boolean | undefined> {
  const parent = view.parentKey(key);
  if (parent === undefined) {
    return undefined;
  }
  const siblings = view.elementChildKeys?.(parent);
  if (!siblings || siblings.indexOf(key) < 0) {
    return undefined;
  }

  // `-of-type` counts only siblings sharing this element's tag.
  let list = siblings;
  if (entry.name.endsWith('-of-type')) {
    const snaps = await Promise.all(siblings.map((siblingKey) => view.snapshot(siblingKey)));
    if (snaps.some((snapshot) => !snapshot?.tag)) {
      return undefined;
    }
    const ownTag = snaps[siblings.indexOf(key)]?.tag;
    if (!ownTag) {
      return undefined;
    }
    list = siblings.filter((_, i) => snaps[i]?.tag === ownTag);
  }

  const position = list.indexOf(key) + 1;
  if (position === 0) {
    return undefined;
  }
  const total = list.length;

  switch (entry.name) {
    case ':first-child':
    case ':first-of-type':
      return position === 1;
    case ':last-child':
    case ':last-of-type':
      return position === total;
    case ':only-child':
    case ':only-of-type':
      return total === 1;
    case ':nth-child':
    case ':nth-of-type': {
      const anb = parseNthFormula(entry.arg);
      return anb ? nthMatches(position, anb.step, anb.offset) : undefined;
    }
    case ':nth-last-child':
    case ':nth-last-of-type': {
      const anb = parseNthFormula(entry.arg);
      return anb ? nthMatches(total - position + 1, anb.step, anb.offset) : undefined;
    }
    default:
      return undefined;
  }
}

async function matchHas(cond: HasCond, subjectKey: string, view: TreeView): Promise<boolean> {
  for (const candidate of hasCandidates(cond.axis, subjectKey, view)) {
    if ((await matchComplex(cond.sel, candidate, view)).matched) {
      return true;
    }
  }
  return false;
}

function hasCandidates(axis: HasAxis, key: string, view: TreeView): string[] {
  if (axis === 'child') {
    return view.childKeys(key);
  }
  if (axis === 'adjacent') {
    return followingSiblings(key, view, 'adjacent');
  }
  if (axis === 'sibling') {
    return followingSiblings(key, view, 'all');
  }
  return descendants(key, view);
}

/** Which siblings a combinator reaches: only the adjacent one (`+`), or all (`~`). */
type SiblingReach = 'adjacent' | 'all';

function precedingSiblings(key: string, view: TreeView, reach: SiblingReach): string[] {
  const parent = view.parentKey(key);
  if (parent === undefined) {
    return [];
  }
  const siblings = view.childKeys(parent);
  const index = siblings.indexOf(key);
  if (index <= 0) {
    return [];
  }
  const adjacent = siblings[index - 1];
  // The preceding siblings come back nearest-first.
  return reach === 'adjacent' && adjacent !== undefined
    ? [adjacent]
    : siblings.slice(0, index).reverse();
}

function followingSiblings(key: string, view: TreeView, reach: SiblingReach): string[] {
  const parent = view.parentKey(key);
  if (parent === undefined) {
    return [];
  }
  const siblings = view.childKeys(parent);
  const index = siblings.indexOf(key);
  if (index < 0) {
    return [];
  }
  const after = siblings.slice(index + 1);
  return reach === 'adjacent' ? after.slice(0, 1) : after;
}

function descendants(key: string, view: TreeView): string[] {
  const out: string[] = [];
  const stack = [...view.childKeys(key)];
  while (stack.length && out.length < HAS_DESCENDANTS_MAX) {
    const current = stack.shift();
    if (current === undefined) {
      break;
    }
    out.push(current);
    for (const child of view.childKeys(current)) {
      stack.push(child);
    }
  }
  return out;
}

function attrValue(snapshot: ElementSnapshot, name: string): string | undefined {
  if (name === 'class') {
    return snapshot.classes.join(' ');
  }
  if (name === 'id') {
    return snapshot.id;
  }
  return snapshot.attributes[name];
}

function matchAttr(attr: AttrCond, snapshot: ElementSnapshot): boolean {
  const actual = attrValue(snapshot, attr.name);
  if (actual === undefined) {
    return false;
  }
  if (attr.operator === undefined || attr.value === undefined) {
    return true;
  } // [attr] presence

  const expected = attr.insensitive ? attr.value.toLowerCase() : attr.value;
  const got = attr.insensitive ? actual.toLowerCase() : actual;

  switch (attr.operator) {
    case '=':
      return got === expected;
    case '~=':
      return got.split(/\s+/).includes(expected);
    case '|=':
      return got === expected || got.startsWith(`${expected}-`);
    case '^=':
      return expected.length > 0 && got.startsWith(expected);
    case '$=':
      return expected.length > 0 && got.endsWith(expected);
    case '*=':
      return expected.length > 0 && got.includes(expected);
    default:
      return false;
  }
}

export function formatSpecificity(spec: Specificity): string {
  return `${spec[0]},${spec[1]},${spec[2]}`;
}

/** Compare specificity: positive when `left` is stronger than `right`. */
export function compareSpecificity(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
