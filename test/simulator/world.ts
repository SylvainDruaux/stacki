// The deterministic simulation (plan §10). One World holds a fake disk, one
// actor per file, and the client's view of each file. Every step the seeded
// PRNG picks one event — a visual intent, a stale preview intent, an oracle
// gesture, a code-editor save, an external manual edit, a pasted copy of a
// line, an attribute added in another editor, an AI-style rewrite, a git-style
// atomic replacement, a watcher tick, an actor step, a crash, a disk failure, a
// submission burst — applies it, and checks the invariants.
//
// Determinism is structural, not careful: the scheduler is the only source of
// order, the PRNG the only source of choice, the disk is in memory, and there
// is no timer, promise or clock anywhere under test/simulator/ (the lint gate
// enforces that). The trace of one seed is therefore a pure function of the
// seed and the fixtures, and its digest proves it (invariant 9).
//
// From step 3 the actor plans set-attribute with the shipping planner, mapped
// through the diff when the intent is stale (engine-planner.ts). Every writer
// here also records where each byte came from (provenance.ts), and every stale
// set-attribute decision is judged against those origins (remap-judge.ts): a
// plan at any other element than the one the authored element became fails the
// run (`wrongSite: 'fail'`, the gate) or is counted (`'count'`, the spike
// report). The judgements are tallied per file.
import { createHash } from 'node:crypto';
import { assert } from '../../dist/shared/assert.js';
import { toFilePath, toIntentId, type Digest, type FilePath } from '../../dist/shared/brand.js';
import {
  toIntent,
  type Intent,
  type Outcome,
  type RejectionReason,
} from '../../dist/shared/intent.js';
import { LIMITS } from '../../dist/shared/limits.js';
import { toAnchorRef, toChildIndex } from '../../dist/shared/ref.js';
import type { Snapshot } from '../../dist/shared/snapshot.js';
import {
  decodeUtf8,
  encodeUtf8,
  toByteSpan,
  toByteString,
  utf8ByteLength,
} from '../../dist/shared/span.js';
import {
  actorHasWork,
  crashActor,
  createActor,
  markDirty,
  stepActor,
  submitIntent,
  type ActorEffect,
  type ActorState,
  type ActorStep,
  type Submission,
} from './actor.ts';
import { planEngine } from './engine-planner.ts';
import { FakeDisk } from './fake-disk.ts';
import { checkBounds, checkCommitted, checkGeneration, checkOutcome, checkQuiescent } from './invariants.ts';
import { oracleIntent } from './oracle-intent.ts';
import { ORACLE_SCENARIOS, type OracleScenario } from './oracles.ts';
import { Prng } from './prng.ts';
import { sha256, snapshotOf } from './project.ts';
import {
  OriginSource,
  insertOrigins,
  lineEndingOrigins,
  spliceOrigins,
  type Origins,
} from './provenance.ts';
import {
  checkMappingReference,
  judgeRemap,
  type RemapDecision,
  type RemapVerdict,
} from './remap-judge.ts';

export interface SimulationFile {
  /** Fixture name; the file lives at `/project/<name>` on the fake disk. */
  readonly name: string;
  readonly text: string;
}

export interface SimulationInput {
  readonly seed: number;
  readonly steps: number;
  /** A judged wrong-site plan fails the run at the event (`fail`, the gate), or
   * is counted and logged so a report can measure how often it happens. */
  readonly wrongSite: 'fail' | 'count';
  readonly files: readonly SimulationFile[];
  /** Whole-file versions git may swap in for a file (a checkout, a revert). */
  readonly alternates: ReadonlyMap<string, readonly string[]>;
}

export interface SimulationReport {
  readonly digest: string;
  readonly trace: readonly string[];
  readonly tally: Readonly<Record<string, number>>;
}

/** Steps one run may take; a nightly run raises the seed count, not this. */
export const SIMULATION_STEPS_MAX = 100_000;
/** Client-side snapshots kept per file, for authoring stale preview intents. */
const HISTORY_MAX = 8;
/** Disk versions whose byte origins a run keeps; older ones judge `unjudged`. */
const ORIGINS_RETAINED_MAX = 512;
/** Snapshots per file whose checksums the run remembers the actor holding. */
const HELD_MAX = 16;

/** A snapshot as the client saw it, with the disk generation it was read at. */
interface View {
  readonly snapshot: Snapshot;
  readonly generation: number;
}

const EVENTS = [
  ['actor-step', 30],
  ['visual-intent', 12],
  ['watcher-tick', 8],
  ['oracle-gesture', 6],
  ['external-edit', 6],
  ['preview-intent', 5],
  ['copy-paste', 3],
  ['attribute-append', 3],
  ['code-save', 4],
  ['git-replace', 3],
  ['ai-rewrite', 2],
  ['crash', 1],
  ['write-failure', 1],
  ['burst', 1],
] as const;

type EventKind = (typeof EVENTS)[number][0];
const EVENT_WEIGHT_TOTAL = EVENTS.reduce((total, [, weight]) => total + weight, 0);

const ATTRIBUTE_VALUES = ['New', 'café 🎉', 'two words', '', 'quote"breaks'] as const;

export function runSimulation(input: SimulationInput): SimulationReport {
  assert(input.steps <= SIMULATION_STEPS_MAX, 'Simulation steps are bounded');
  assert(input.files.length > 0, 'A simulation needs at least one file');
  const world = new World(input);
  for (let step = 0; step < input.steps; step++) {
    world.step(step);
  }
  world.drain();
  return world.report();
}

/** After a crash, compare the disk with the in-flight candidate (plan §3.5):
 * reconciliation is a comparison, not a guess, and needs no intent journal. */
function reconcile(current: Digest, base: Snapshot, candidate: Snapshot): string {
  if (current === candidate.checksum) {
    return 'applied';
  }
  if (current === base.checksum) {
    return 'not-applied';
  }
  return 'changed-again';
}

class World {
  private readonly prng: Prng;
  private readonly disk = new FakeDisk();
  private readonly actors = new Map<FilePath, ActorState>();
  private readonly accepted = new Map<string, Intent>();
  private readonly terminal = new Map<string, Outcome>();
  private readonly history = new Map<FilePath, View[]>();
  private readonly gestures = new Map<string, { scenario: OracleScenario; next: number }>();
  private readonly inputs = new Map<string, Digest>();
  private readonly watched = new Set<FilePath>();
  private readonly trace: string[] = [];
  private readonly tally: Record<string, number> = {};
  private readonly input: SimulationInput;
  // Ground truth for remapped intents: byte origins per disk generation, the
  // generations at which git replaced a file whole, the generation each intent
  // was authored at, and the checksums each actor has held.
  private readonly origins = new Map<number, Origins>();
  private readonly originSource = new OriginSource();
  private readonly replacedWhole = new Map<FilePath, number[]>();
  private readonly authoredAt = new Map<string, number>();
  private readonly held = new Map<FilePath, Digest[]>();
  private intents = 0;

  constructor(input: SimulationInput) {
    this.input = input;
    this.prng = new Prng(input.seed);
    for (const file of input.files) {
      const path = toFilePath(`/project/${file.name}`);
      const bytes = encodeUtf8(file.text);
      const generation = this.disk.writeExternally(path, bytes);
      this.keepOrigins(generation, this.originSource.fresh(bytes.length));
      this.actors.set(path, createActor(path));
      this.inputs.set(file.name, sha256(bytes));
    }
  }

  step(index: number): void {
    const kind = this.pickEvent();
    this.count(kind);
    this.log(`#${index} ${kind}`);
    this.dispatch(kind);
    checkBounds(this.actors.values(), 0);
  }

  /** Run actors until every accepted intent is terminal (invariant 1). Each
   * pass either finishes a phase or empties a queue, so the bound is the total
   * work: every queued intent takes at most three steps, plus one refresh each. */
  drain(): void {
    const passesMax = (LIMITS.intentsPendingMax * 3 + 2) * this.actors.size * 4;
    for (let pass = 0; pass < passesMax; pass++) {
      const busy = [...this.actors.values()].filter(actorHasWork);
      const [actor] = busy;
      if (actor === undefined) {
        checkQuiescent(this.accepted, this.terminal);
        return;
      }
      this.runActor(actor);
    }
    throw new Error(`Assertion failed: drain did not settle in ${passesMax} passes`);
  }

  report(): SimulationReport {
    const digest = createHash('sha256').update(this.trace.join('\n')).digest('hex');
    return { digest, trace: this.trace, tally: { ...this.tally } };
  }

  private pickEvent(): EventKind {
    let roll = this.prng.below(EVENT_WEIGHT_TOTAL);
    for (const [kind, weight] of EVENTS) {
      if (roll < weight) {
        return kind;
      }
      roll -= weight;
    }
    throw new Error('Assertion failed: the event roll lies inside the weight total');
  }

  private dispatch(kind: EventKind): void {
    switch (kind) {
      case 'actor-step': {
        const busy = [...this.actors.values()].filter(actorHasWork);
        if (busy.length > 0) {
          this.runActor(this.prng.pick(busy));
        }
        return;
      }
      case 'visual-intent':
        return this.submitVisual(this.clientView(this.pickPath()));
      case 'preview-intent':
        return this.submitVisual(this.staleView(this.pickPath()));
      case 'oracle-gesture':
        return this.startGesture(this.prng.pick(ORACLE_SCENARIOS));
      case 'code-save':
        return this.submitCodeSave(this.pickPath());
      case 'external-edit':
        return this.editExternally(this.pickPath());
      case 'copy-paste':
        return this.pasteLineCopy(this.pickPath());
      case 'attribute-append':
        return this.appendAttributeExternally(this.pickPath());
      case 'ai-rewrite':
        return this.rewriteLineEndings(this.pickPath());
      case 'git-replace':
        return this.replaceLikeGit(this.pickPath());
      case 'watcher-tick':
        return this.tickWatcher();
      case 'crash':
        return this.crash();
      case 'write-failure':
        return this.disk.failNextReplace(this.pickPath());
      case 'burst':
        return this.burst(this.pickPath());
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unknown event ${String(exhaustive)}`);
      }
    }
  }

  // --- Actors and outcomes ---------------------------------------------------

  private runActor(actor: ActorState): void {
    const head = actor.phase.tag === 'idle' ? actor.queue[0] : undefined;
    const generationBefore = this.disk.generationOf(actor.path);
    const result = stepActor(actor, this.disk, planEngine);
    this.actors.set(actor.path, result.state);
    checkBounds(this.actors.values(), result.parses);
    this.trackActorWrite(actor, result.state, generationBefore);
    if (head !== undefined) {
      this.judgePlanning(head, result);
    }
    for (const effect of result.effects) {
      this.absorb(effect, actor.path);
    }
  }

  /** The actor's atomic replace (planned → written) keeps the origins of every
   * byte outside its splices; the disk held the base bytes just before it. */
  private trackActorWrite(before: ActorState, after: ActorState, generationBefore: number): void {
    const generation = this.disk.generationOf(before.path);
    if (generation === generationBefore) {
      return;
    }
    assert(before.phase.tag === 'planned', 'Only a planned actor writes the disk');
    assert(after.phase.tag === 'written', 'A write moves the actor to written');
    const origins = this.origins.get(generationBefore);
    if (origins !== undefined) {
      const splices = before.phase.plan.splices;
      this.keepOrigins(generation, spliceOrigins(origins, splices, this.originSource));
    }
  }

  // Every stale set-attribute decision is judged against the origins; fresh
  // ones are the identity mapping and only counted.
  private judgePlanning(head: Submission, result: ActorStep): void {
    const intent = head.intent;
    if (intent.operation.tag !== 'set-attribute') {
      return;
    }
    const decision = decisionFor(intent, result);
    const current = result.state.snapshot;
    if (decision === undefined || current === undefined) {
      return; // The read failed: nothing was planned against anything.
    }
    if (head.authored.checksum === current.checksum) {
      this.count('mapping:identity');
      return;
    }
    const authoredGeneration = this.authoredAt.get(intent.id);
    assert(authoredGeneration !== undefined, 'Every submitted intent has an authored generation');
    const baseGeneration = result.state.generation;
    const input = {
      intent,
      authored: head.authored,
      current,
      authoredOrigins: this.origins.get(authoredGeneration),
      currentOrigins: this.origins.get(baseGeneration),
      replacedWhole: (this.replacedWhole.get(intent.file) ?? []).some(
        (generation) => generation > authoredGeneration && generation <= baseGeneration,
      ),
      decision,
    };
    this.count(checkMappingReference(input) ? 'reference:agreed' : 'reference:skipped');
    this.countAge(intent.file, head.authored.checksum, current.checksum);
    this.countVerdict(intent.file, judgeRemap(input));
  }

  private countVerdict(path: FilePath, verdict: RemapVerdict): void {
    if (verdict.tag === 'wrong-site') {
      const where = `seed ${this.input.seed}: ${verdict.detail}`;
      assert(this.input.wrongSite === 'count', `Wrong site (step-4 gate: zero allowed): ${where}`);
      this.count(`remap-wrong-site:${where}`);
    }
    const detail = verdictDetail(verdict);
    const key = detail === '' ? verdict.tag : `${verdict.tag} ${detail}`;
    this.count(`remap:${key}`);
    this.count(`remap-file:${path.slice('/project/'.length)}|${key}`);
    this.log(`  remap ${key}`);
  }

  /** How many snapshots before the current one the authored one was, in the
   * actor's own history — an actor keeping k earlier snapshots would have had
   * the authored bytes for ages up to k (open question: lastKnownBytes).
   * `unseen`: the actor never held them (the client read the disk itself). */
  private countAge(path: FilePath, authored: Digest, current: Digest): void {
    const held = this.held.get(path) ?? [];
    const chain = held[held.length - 1] === current ? held : [...held, current];
    const index = chain.lastIndexOf(authored);
    const age = chain.length - 1 - index;
    if (index < 0) {
      this.count('authored-age:unseen');
    } else {
      assert(age > 0, 'A stale intent was authored before the current snapshot');
      this.count(`authored-age:${age < 3 ? String(age) : '3+'}`);
    }
  }

  private hold(path: FilePath, checksum: Digest): void {
    const held = [...(this.held.get(path) ?? []), checksum].slice(-HELD_MAX);
    assert(held.length <= HELD_MAX, 'Held checksums are bounded');
    this.held.set(path, held);
  }

  private keepOrigins(generation: number, origins: Origins): void {
    assert(!this.origins.has(generation), 'A disk generation is written once');
    this.origins.set(generation, origins);
    if (this.origins.size > ORIGINS_RETAINED_MAX) {
      const [oldest] = this.origins.keys();
      assert(oldest !== undefined, 'A full origin store has an oldest entry');
      this.origins.delete(oldest);
    }
    assert(this.origins.size <= ORIGINS_RETAINED_MAX, 'Origin retention is bounded');
  }

  private absorb(effect: ActorEffect, path: FilePath): void {
    switch (effect.tag) {
      case 'outcome':
        return this.record(effect.outcome);
      case 'committed':
        checkCommitted(effect);
        this.hold(path, effect.candidate.checksum);
        this.remember({ snapshot: effect.candidate, generation: effect.generation });
        this.log(`  commit ${effect.intent.id} ${effect.plan.splices.length} splice(s)`);
        return;
      case 'refreshed':
        checkGeneration(effect.previousGeneration, effect.generation);
        this.holdCurrent(path);
        this.log(`  refresh ${path} gen ${effect.generation}`);
        return;
      default: {
        const exhaustive: never = effect;
        throw new Error(`Unknown effect ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private holdCurrent(path: FilePath): void {
    const snapshot = this.actors.get(path)?.snapshot;
    assert(snapshot !== undefined, 'A refreshed actor holds a snapshot');
    this.hold(path, snapshot.checksum);
  }

  private record(outcome: Outcome): void {
    checkOutcome(outcome, this.accepted, this.terminal);
    this.terminal.set(outcome.intentId, outcome);
    this.authoredAt.delete(outcome.intentId);
    const detail = outcome.tag === 'rejected' ? ` ${outcome.reason}` : '';
    this.count(`outcome:${outcome.tag}${detail}`);
    this.log(`  outcome ${outcome.intentId} ${outcome.tag}${detail}`);
    const gesture = this.gestures.get(outcome.intentId);
    if (gesture !== undefined) {
      this.gestures.delete(outcome.intentId);
      this.continueGesture(gesture.scenario, gesture.next, outcome);
    }
  }

  private submit(intent: Intent, view: View): boolean {
    const actor = this.actors.get(intent.file);
    assert(actor !== undefined, 'Every intent names a simulated file');
    const submitted = submitIntent(actor, { intent, authored: view.snapshot });
    this.actors.set(intent.file, submitted.state);
    this.log(`  submit ${intent.id} ${intent.operation.tag} ${submitted.result.tag}`);
    this.count(`submit:${submitted.result.tag}`);
    if (submitted.result.tag === 'accepted') {
      this.accepted.set(intent.id, intent);
      this.authoredAt.set(intent.id, view.generation);
      return true;
    }
    return false;
  }

  private nextIntentId(): ReturnType<typeof toIntentId> {
    this.intents += 1;
    return toIntentId(`i${this.intents}`);
  }

  // --- Client views ------------------------------------------------------------

  private pickPath(): FilePath {
    return this.prng.pick([...this.actors.keys()]);
  }

  /** What the renderer shows: the actor's snapshot, or its own read of the disk
   * when the actor has not read the file yet (page:read). The actor's
   * generation names the latest disk version it confirmed holds those bytes. */
  private clientView(path: FilePath): View {
    const actor = this.actors.get(path);
    assert(actor !== undefined, 'Every path has an actor');
    if (actor.snapshot !== undefined) {
      return { snapshot: actor.snapshot, generation: actor.generation };
    }
    const read = this.disk.read(path);
    assert(read.ok, 'Simulated files are never deleted');
    const snapshot = snapshotOf(path, read.value.bytes);
    const view = { snapshot, generation: read.value.generation };
    this.remember(view);
    return view;
  }

  /** A preview rendered from an older version of the file. */
  private staleView(path: FilePath): View {
    const seen = this.history.get(path) ?? [];
    return seen.length > 0 ? this.prng.pick(seen) : this.clientView(path);
  }

  private remember(view: View): void {
    const seen = this.history.get(view.snapshot.path) ?? [];
    const next = [...seen, view].slice(-HISTORY_MAX);
    assert(next.length <= HISTORY_MAX, 'Client history is bounded');
    this.history.set(view.snapshot.path, next);
  }

  // --- Intents -----------------------------------------------------------------

  private submitVisual(view: View): void {
    const snapshot = view.snapshot;
    const projection = snapshot.projection;
    if (projection.tag === 'parse-error') {
      this.log('  skip: the view does not parse');
      return;
    }
    const targets = projection.nodes.flatMap((node) =>
      node.attributes.filter((attribute) => attribute.type === 'string').map((attribute) => ({ node, attribute })),
    );
    if (targets.length === 0) {
      this.log('  skip: no string attribute in view');
      return;
    }
    const { node, attribute } = this.prng.pick(targets);
    const name = this.prng.chance(1, 10) ? 'data-absent' : attribute.name;
    const anchor = toAnchorRef({ span: node.span, path: node.path.map(toChildIndex), expectedKind: node.kind });
    const value = { type: 'string' as const, value: this.prng.pick(ATTRIBUTE_VALUES) };
    this.submit(
      toIntent({
        id: this.nextIntentId(),
        file: snapshot.path,
        authoredChecksum: snapshot.checksum,
        anchor,
        operation: { tag: 'set-attribute', name, value },
      }),
      view,
    );
  }

  private submitCodeSave(path: FilePath): void {
    const view = this.clientView(path);
    const decoded = decodeUtf8(view.snapshot.bytes);
    assert(decoded.ok, 'Simulated writers only write UTF-8');
    const suffix = this.prng.pick(['\n<!-- saved -->\n', '\n<div', '']);
    const anchor = toAnchorRef({
      span: toByteSpan(0, view.snapshot.bytes.length),
      path: [],
      expectedKind: 'document',
    });
    this.submit(
      toIntent({
        id: this.nextIntentId(),
        file: path,
        authoredChecksum: view.snapshot.checksum,
        anchor,
        operation: { tag: 'replace-source', text: decoded.value + suffix },
      }),
      view,
    );
  }

  /** More intents than the queue holds, at once: the tail must be backpressured. */
  private burst(path: FilePath): void {
    for (let index = 0; index < LIMITS.intentsPendingMax + 4; index++) {
      this.submitCodeSave(path);
    }
  }

  private startGesture(scenario: OracleScenario): void {
    this.continueGesture(scenario, 0, undefined);
  }

  // A gesture's next step goes out only after the previous one is applied, and
  // only while its own file still holds the oracle's input bytes (plan §3.3).
  private continueGesture(scenario: OracleScenario, index: number, previous: Outcome | undefined): void {
    if (previous !== undefined) {
      if (previous.tag !== 'applied') {
        this.log(`  gesture cancelled after ${previous.tag}`);
        this.count('gesture:cancelled');
        return;
      }
    }
    const step = scenario.steps[index];
    if (step === undefined) {
      this.count('gesture:completed');
      return;
    }
    const path = toFilePath(`/project/${step.file}`);
    const view = this.clientView(path);
    if (view.snapshot.checksum !== this.inputs.get(step.file)) {
      this.log(`  gesture skipped: ${step.file} no longer holds the oracle input`);
      this.count('gesture:precondition');
      return;
    }
    const intent = oracleIntent(step, view.snapshot, this.nextIntentId());
    if (this.submit(intent, view)) {
      this.gestures.set(intent.id, { scenario, next: index + 1 });
    }
  }

  // --- Other writers -----------------------------------------------------------

  private writeOutside(
    path: FilePath,
    bytes: ReturnType<typeof encodeUtf8>,
    origins: Origins | undefined,
    what: string,
  ): void {
    const generation = this.disk.writeExternally(path, bytes);
    if (origins !== undefined) {
      assert(origins.length === bytes.length, 'Origins describe the written bytes');
      this.keepOrigins(generation, origins);
    }
    this.watched.add(path);
    assert(this.watched.size <= LIMITS.watcherFilesPerTickMax, 'Watcher work per tick is bounded');
    this.log(`  ${what} ${path} gen ${generation}`);
  }

  private diskText(path: FilePath): string {
    const read = this.disk.read(path);
    assert(read.ok, 'Simulated files are never deleted');
    const decoded = decodeUtf8(read.value.bytes);
    assert(decoded.ok, 'Simulated writers only write UTF-8');
    return decoded.value;
  }

  /** A manual edit: a comment at a node boundary, or (rarely) a broken tag, as
   * a new line before line `line`, or after the last one. */
  private editExternally(path: FilePath): void {
    const text = this.diskText(path);
    const lines = text.split('\n');
    const line = this.prng.below(lines.length + 1);
    const inserted = this.prng.chance(1, 8) ? '<' : '<!-- external -->';
    if (line === lines.length) {
      this.insertExternally(path, utf8ByteLength(text), `\n${inserted}`, 'external-edit');
    } else {
      const before = lines.slice(0, line).map((kept) => `${kept}\n`).join('');
      this.insertExternally(path, utf8ByteLength(before), `${inserted}\n`, 'external-edit');
    }
  }

  /** Copy and paste in another editor: a line duplicated right below itself.
   * The copy is new bytes and the original keeps its origins, so a remap onto
   * the copy is a wrong-site application; the mapper must call it ambiguous. */
  private pasteLineCopy(path: FilePath): void {
    const text = this.diskText(path);
    const lines = text.split('\n');
    const line = this.prng.below(lines.length);
    const copied = lines[line];
    assert(copied !== undefined, 'The copied line exists');
    const through = lines.slice(0, line + 1).join('\n');
    this.insertExternally(path, utf8ByteLength(through), `\n${copied}`, 'copy-paste');
  }

  /** Another editor adds an attribute after an element's last one — the edit
   * step 2 pinned as byte-level conservatism for the element itself. */
  private appendAttributeExternally(path: FilePath): void {
    const projection = snapshotOf(path, this.diskBytes(path)).projection;
    if (projection.tag === 'parse-error') {
      this.log('  skip: the file does not parse');
      return;
    }
    const hosts = projection.nodes.filter((node) => node.attributes.length > 0);
    if (hosts.length === 0) {
      this.log('  skip: no element with attributes');
      return;
    }
    const host = this.prng.pick(hosts);
    const end = Math.max(...host.attributes.map((attribute) => attribute.span.end));
    this.insertExternally(path, end, ' data-edited="1"', 'attribute-append');
  }

  /** An outside writer inserts `text` at byte `at` and keeps every other byte,
   * so every other byte keeps its origin. */
  private insertExternally(path: FilePath, at: number, text: string, what: string): void {
    const bytes = this.diskBytes(path);
    assert(at <= bytes.length, 'An insertion point lies inside the file');
    const inserted = encodeUtf8(text);
    const next = new Uint8Array(bytes.length + inserted.length);
    next.set(bytes.subarray(0, at), 0);
    next.set(inserted, at);
    next.set(bytes.subarray(at), at + inserted.length);
    const origins = this.origins.get(this.disk.generationOf(path));
    const nextOrigins =
      origins === undefined
        ? undefined
        : insertOrigins(origins, at, this.originSource.fresh(inserted.length));
    this.writeOutside(path, toByteString(next), nextOrigins, what);
  }

  /** A formatter or an AI tool rewriting the whole file: line endings flipped. */
  private rewriteLineEndings(path: FilePath): void {
    const text = this.diskText(path);
    const toLf = text.includes('\r\n');
    const rewritten = toLf ? text.replaceAll('\r\n', '\n') : text.replaceAll('\n', '\r\n');
    const origins = this.origins.get(this.disk.generationOf(path));
    const direction = toLf ? 'to-lf' : 'to-crlf';
    const next =
      origins === undefined
        ? undefined
        : lineEndingOrigins(this.diskBytes(path), origins, direction, this.originSource);
    this.writeOutside(path, encodeUtf8(rewritten), next, 'ai-rewrite');
  }

  /** A checkout: the whole file is new bytes, and no byte's origin is known. */
  private replaceLikeGit(path: FilePath): void {
    const name = path.slice('/project/'.length);
    const versions = this.input.alternates.get(name) ?? [];
    if (versions.length > 0) {
      const bytes = encodeUtf8(this.prng.pick(versions));
      this.writeOutside(path, bytes, this.originSource.fresh(bytes.length), 'git-replace');
      const replaced = [...(this.replacedWhole.get(path) ?? []), this.disk.generationOf(path)];
      assert(replaced.length <= SIMULATION_STEPS_MAX, 'One replacement per step at most');
      this.replacedWhole.set(path, replaced);
    }
  }

  private tickWatcher(): void {
    assert(this.watched.size <= LIMITS.watcherFilesPerTickMax, 'Watcher work per tick is bounded');
    for (const path of this.watched) {
      const actor = this.actors.get(path);
      assert(actor !== undefined, 'The watcher only reports simulated files');
      this.actors.set(path, markDirty(actor));
    }
    this.log(`  watcher marked ${this.watched.size} file(s)`);
    this.watched.clear();
  }

  private crash(): void {
    const busy = [...this.actors.values()].filter((actor) => actor.phase.tag !== 'idle');
    if (busy.length === 0) {
      return;
    }
    const actor = this.prng.pick(busy);
    const phase = actor.phase;
    assert(phase.tag !== 'idle', 'A crash is injected mid-intent');
    const result = crashActor(actor);
    this.actors.set(actor.path, result.state);
    for (const effect of result.effects) {
      this.absorb(effect, actor.path);
    }
    const verdict = reconcile(sha256(this.diskBytes(actor.path)), phase.base, phase.candidate);
    this.count(`reconcile:${verdict}`);
    this.log(`  crash ${actor.path} in ${phase.tag}: reconciled ${verdict}`);
  }

  private diskBytes(path: FilePath): ReturnType<typeof encodeUtf8> {
    const read = this.disk.read(path);
    assert(read.ok, 'Simulated files are never deleted');
    return read.value.bytes;
  }

  // --- Trace -------------------------------------------------------------------

  private log(line: string): void {
    this.trace.push(line);
  }

  private count(key: string): void {
    this.tally[key] = (this.tally[key] ?? 0) + 1;
  }
}

/** What the planner decided for the head intent in one idle step: the plan now
 * in flight, or the rejection among the step's outcomes; undefined when the
 * step rejected before planning (a failed read). */
function decisionFor(intent: Intent, result: ActorStep): RemapDecision | undefined {
  const phase = result.state.phase;
  if (phase.tag === 'planned') {
    assert(phase.intent.id === intent.id, 'The planned intent is the head of the queue');
    return { tag: 'planned', plan: phase.plan };
  }
  const reason = rejectionOf(intent, result);
  assert(reason !== undefined, 'An idle step plans its head or rejects it');
  return reason === 'write-failed' ? undefined : { tag: 'rejected', reason };
}

function rejectionOf(intent: Intent, result: ActorStep): RejectionReason | undefined {
  for (const effect of result.effects) {
    if (effect.tag === 'outcome') {
      if (effect.outcome.intentId === intent.id) {
        assert(effect.outcome.tag === 'rejected', 'An idle step only rejects');
        return effect.outcome.reason;
      }
    }
  }
  return undefined;
}

function verdictDetail(verdict: RemapVerdict): string {
  switch (verdict.tag) {
    case 'applied-correct':
    case 'wrong-site':
      return '';
    case 'conservative':
    case 'rejected-conflict':
    case 'rejected-gone':
    case 'other':
      return verdict.reason;
    case 'unjudged':
      return verdict.decision;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}
