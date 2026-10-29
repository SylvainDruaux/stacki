// A source text region is authoritative. A fallback may ignore animation wrappers,
// but never an authored child element, duplicate text, or changed rendered words.
import type { CanvasTextTarget } from '../../shared/properties/canvasText';
import { elementsWithPath, pathsOf, runsOf } from './frameRegions';

export interface TextMatch {
  readonly nodes: readonly Text[];
  readonly element: Element;
}
export function matchCanvasText(target: CanvasTextTarget, clicked: Element): TextMatch | undefined {
  const parents = elementsWithPath(target.parent).filter((parent) => parent.contains(clicked));
  if (parents.length !== 1) {
    return undefined;
  }
  const parent = parents[0];
  if (!parent || (target.kind === 'element' && parent.localName !== target.tag)) {
    return undefined;
  }
  let ancestor: Element | undefined = clicked;
  for (let depth = 0; ancestor && ancestor !== parent && depth < 32; depth++) {
    if (pathsOf(ancestor).some((path) => target.siblings.includes(path))) {
      return undefined;
    }
    ancestor = ancestor.parentElement ?? undefined;
  }
  const mapped = (runsOf(target.path) ?? []).filter(
    (run) => run.length > 0 && run.every((node) => node.isConnected && parent.contains(node)),
  );
  const exact = mapped.filter((run) => run.every((node) => node instanceof Text));
  if (exact.length === 1) {
    const nodes = exact[0]?.filter((node): node is Text => node instanceof Text) ?? [];
    if (sameText(nodes, target.value)) {
      return { nodes, element: parent };
    }
  }
  if (
    target.siblings.some(
      (path) => elementsWithPath(path).filter((element) => parent.contains(element)).length !== 1,
    )
  ) {
    return undefined;
  }
  const groups = textGroups(parent, target);
  const matches = groups.filter((nodes) => sameText(nodes, target.value));
  return matches.length === 1 && matches[0] ? { nodes: matches[0], element: parent } : undefined;
}

function textGroups(parent: Element, target: CanvasTextTarget): Text[][] {
  const groups: Text[][] = [[]];
  const queue = Array.from(parent.childNodes).reverse();
  let count = 0;
  while (queue.length > 0 && count++ < 1_000) {
    const node = queue.pop();
    if (node instanceof Text) {
      groups[groups.length - 1]?.push(node);
    } else if (node instanceof Element) {
      const boundary = isTextBoundary(node, target);
      if (boundary) {
        groups.push([]);
      } else {
        queue.push(...Array.from(node.childNodes).reverse());
      }
    }
  }
  return queue.length ? [] : groups.filter((nodes) => nodes.length > 0);
}

function isTextBoundary(element: Element, target: CanvasTextTarget): boolean {
  const paths = pathsOf(element);
  const namespace = target.parent.slice(0, target.parent.lastIndexOf('|') + 1);
  // Component-owned wrappers are not authored children of the slot. Their own
  // namespace can be crossed, while every child authored by the caller stays protected.
  const authored = paths.some((path) => {
    if (path === target.parent || path === target.path) {
      return false;
    }
    if (target.kind === 'element' || target.siblings.includes(path)) {
      return true;
    }
    return path.slice(0, path.lastIndexOf('|') + 1) === namespace;
  });
  if (authored) {
    return true;
  }
  if (target.kind === 'component') {
    return ['SCRIPT', 'STYLE', 'TEXTAREA', 'SELECT', 'SVG'].includes(element.tagName);
  }
  return !['SPAN', 'DIV'].includes(element.tagName);
}

function sameText(nodes: readonly Text[], expected: string): boolean {
  const actual = nodes.map((node) => node.data).join('');
  // HTML collapses ASCII whitespace, but NBSP and other meaningful characters remain exact.
  const normalize = (value: string) => value.replace(/[\t\r\n ]+/g, ' ').trim();
  return normalize(actual) === normalize(expected);
}

export function canvasTextRect(match: TextMatch): DOMRect | undefined {
  const first = match.nodes[0];
  const last = match.nodes.at(-1);
  if (!first || !last) {
    return undefined;
  }
  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  return range.getBoundingClientRect();
}
