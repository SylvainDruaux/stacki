// The deterministic simulation (plan §10). One World holds a fake disk, one
// actor per file, and the client's view of each file. Every step the seeded
// PRNG picks one event — a visual intent, a stale preview intent, an oracle
// gesture, a code-editor save, an external manual edit, an AI-style rewrite, a
// git-style atomic replacement, a watcher tick, an actor step, a crash, a disk
// failure, a submission burst — applies it, and checks the invariants.
//
// Determinism is structural, not careful: the scheduler is the only source of
// order, the PRNG the only source of choice, the disk is in memory, and there
// is no timer, promise or clock anywhere under test/simulator/ (the lint gate
// enforces that). The trace of one seed is therefore a pure function of the
// seed and the fixtures, and its digest proves it (invariant 9).
import { createHash } from 'node:crypto';
import { assert } from '../../dist/shared/assert.js';
import { toFilePath, toIntentId, type Digest, type FilePath } from '../../dist/shared/brand.js';
import { toIntent, type Intent, type Outcome } from '../../dist/shared/intent.js';
import { LIMITS } from '../../dist/shared/limits.js';
import { toAnchorRef, toChildIndex } from '../../dist/shared/ref.js';
import type { Snapshot } from '../../dist/shared/snapshot.js';
import { decodeUtf8, encodeUtf8, toByteSpan } from '../../dist/shared/span.js';
import {
  actorHasWork,
  crashActor,
  createActor,
  markDirty,
  stepActor,
  submitIntent,
  type ActorEffect,
  type ActorState,
} from './actor.ts';
import { FakeDisk } from './fake-disk.ts';
import { checkBounds, checkCommitted, checkGeneration, checkOutcome, checkQuiescent } from './invariants.ts';
import { oracleIntent } from './oracle-intent.ts';
import { ORACLE_SCENARIOS, type OracleScenario } from './oracles.ts';
import { Prng } from './prng.ts';
import { sha256, snapshotOf } from './project.ts';
import { planByIdentity } from './reference-planner.ts';

export interface SimulationFile {
  /** Fixture name; the file lives at `/project/<name>` on the fake disk. */
  readonly name: string;
  readonly text: string;
}

export interface SimulationInput {
  readonly seed: number;
  readonly steps: number;
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

const EVENTS = [
  ['actor-step', 30],
  ['visual-intent', 12],
  ['watcher-tick', 8],
  ['oracle-gesture', 6],
  ['external-edit', 6],
  ['preview-intent', 5],
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
  private readonly history = new Map<FilePath, Snapshot[]>();
  private readonly gestures = new Map<string, { scenario: OracleScenario; next: number }>();
  private readonly inputs = new Map<string, Digest>();
  private readonly watched = new Set<FilePath>();
  private readonly trace: string[] = [];
  private readonly tally: Record<string, number> = {};
  private readonly input: SimulationInput;
  private intents = 0;

  constructor(input: SimulationInput) {
    this.input = input;
    this.prng = new Prng(input.seed);
    for (const file of input.files) {
      const path = toFilePath(`/project/${file.name}`);
      const bytes = encodeUtf8(file.text);
      this.disk.writeExternally(path, bytes);
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
    const result = stepActor(actor, this.disk, planByIdentity);
    this.actors.set(actor.path, result.state);
    checkBounds(this.actors.values(), result.parses);
    for (const effect of result.effects) {
      this.absorb(effect, actor.path);
    }
  }

  private absorb(effect: ActorEffect, path: FilePath): void {
    switch (effect.tag) {
      case 'outcome':
        return this.record(effect.outcome);
      case 'committed':
        checkCommitted(effect);
        this.remember(effect.candidate);
        this.log(`  commit ${effect.intent.id} ${effect.plan.splices.length} splice(s)`);
        return;
      case 'refreshed':
        checkGeneration(effect.previousGeneration, effect.generation);
        this.log(`  refresh ${path} gen ${effect.generation}`);
        return;
      default: {
        const exhaustive: never = effect;
        throw new Error(`Unknown effect ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private record(outcome: Outcome): void {
    checkOutcome(outcome, this.accepted, this.terminal);
    this.terminal.set(outcome.intentId, outcome);
    const detail = outcome.tag === 'rejected' ? ` ${outcome.reason}` : '';
    this.count(`outcome:${outcome.tag}${detail}`);
    this.log(`  outcome ${outcome.intentId} ${outcome.tag}${detail}`);
    const gesture = this.gestures.get(outcome.intentId);
    if (gesture !== undefined) {
      this.gestures.delete(outcome.intentId);
      this.continueGesture(gesture.scenario, gesture.next, outcome);
    }
  }

  private submit(intent: Intent): boolean {
    const actor = this.actors.get(intent.file);
    assert(actor !== undefined, 'Every intent names a simulated file');
    const submitted = submitIntent(actor, intent);
    this.actors.set(intent.file, submitted.state);
    this.log(`  submit ${intent.id} ${intent.operation.tag} ${submitted.result.tag}`);
    this.count(`submit:${submitted.result.tag}`);
    if (submitted.result.tag === 'accepted') {
      this.accepted.set(intent.id, intent);
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
   * when the actor has not read the file yet (page:read). */
  private clientView(path: FilePath): Snapshot {
    const snapshot = this.actors.get(path)?.snapshot;
    if (snapshot !== undefined) {
      return snapshot;
    }
    const read = this.disk.read(path);
    assert(read.ok, 'Simulated files are never deleted');
    const view = snapshotOf(path, read.value.bytes);
    this.remember(view);
    return view;
  }

  /** A preview rendered from an older version of the file. */
  private staleView(path: FilePath): Snapshot {
    const seen = this.history.get(path) ?? [];
    return seen.length > 0 ? this.prng.pick(seen) : this.clientView(path);
  }

  private remember(snapshot: Snapshot): void {
    const seen = this.history.get(snapshot.path) ?? [];
    const next = [...seen, snapshot].slice(-HISTORY_MAX);
    assert(next.length <= HISTORY_MAX, 'Client history is bounded');
    this.history.set(snapshot.path, next);
  }

  // --- Intents -----------------------------------------------------------------

  private submitVisual(view: Snapshot): void {
    const projection = view.projection;
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
        file: view.path,
        authoredChecksum: view.checksum,
        anchor,
        operation: { tag: 'set-attribute', name, value },
      }),
    );
  }

  private submitCodeSave(path: FilePath): void {
    const view = this.clientView(path);
    const decoded = decodeUtf8(view.bytes);
    assert(decoded.ok, 'Simulated writers only write UTF-8');
    const suffix = this.prng.pick(['\n<!-- saved -->\n', '\n<div', '']);
    const anchor = toAnchorRef({
      span: toByteSpan(0, view.bytes.length),
      path: [],
      expectedKind: 'document',
    });
    this.submit(
      toIntent({
        id: this.nextIntentId(),
        file: path,
        authoredChecksum: view.checksum,
        anchor,
        operation: { tag: 'replace-source', text: decoded.value + suffix },
      }),
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
    if (view.checksum !== this.inputs.get(step.file)) {
      this.log(`  gesture skipped: ${step.file} no longer holds the oracle input`);
      this.count('gesture:precondition');
      return;
    }
    const intent = oracleIntent(step, view, this.nextIntentId());
    if (this.submit(intent)) {
      this.gestures.set(intent.id, { scenario, next: index + 1 });
    }
  }

  // --- Other writers -----------------------------------------------------------

  private writeOutside(path: FilePath, text: string, what: string): void {
    const generation = this.disk.writeExternally(path, encodeUtf8(text));
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

  /** A manual edit: a comment at a node boundary, or (rarely) a broken tag. */
  private editExternally(path: FilePath): void {
    const text = this.diskText(path);
    const lines = text.split('\n');
    const line = this.prng.below(lines.length + 1);
    const inserted = this.prng.chance(1, 8) ? '<' : '<!-- external -->';
    const edited = [...lines.slice(0, line), inserted, ...lines.slice(line)].join('\n');
    this.writeOutside(path, edited, 'external-edit');
  }

  /** A formatter or an AI tool rewriting the whole file: line endings flipped. */
  private rewriteLineEndings(path: FilePath): void {
    const text = this.diskText(path);
    const rewritten = text.includes('\r\n') ? text.replaceAll('\r\n', '\n') : text.replaceAll('\n', '\r\n');
    this.writeOutside(path, rewritten, 'ai-rewrite');
  }

  private replaceLikeGit(path: FilePath): void {
    const name = path.slice('/project/'.length);
    const versions = this.input.alternates.get(name) ?? [];
    if (versions.length > 0) {
      this.writeOutside(path, this.prng.pick(versions), 'git-replace');
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
