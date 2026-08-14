/**
 * Arcanas — the run-shaping cards the player is offered a handful of times per run.
 *
 * WHAT AN ARCANA IS, MECHANICALLY
 * An arcana is two things bolted together: a `RunModifier` (so every number it changes goes through
 * the same two-tier, order-independent resolution as a passive, a mode and a shop rank), and an
 * optional behaviour bit from `ARCANA_FLAG` for the part that is not a number. Nothing else. There
 * is no `if (arcana === TWIN_TOLL)` anywhere in the sim and there must never be one: the sim reads
 * `Stats` and one integer of flags, exactly as it already does for modes.
 *
 * WHY THE MODIFIERS GO IN THE LOADOUT AND NOT THE STACK
 * Run modifiers are written into the replay header and the co-op join packet. An arcana is not a
 * property of the run you started, it is a choice you made inside it — like a passive, it is
 * reconstructed by replaying the picks. So arcana modifiers are added with `addLoadout`, and their
 * wire ids deliberately sit in their own range (`ARCANA_WIRE_BASE`) so that a header full of mode
 * ids can never decode as an arcana.
 *
 * WHY THE DECK IS PURE AND ALLOCATION-FREE
 * `ArcanaDeck` decides *what is offered* and *what is held*. It never draws, never touches health or
 * enemies, and never reads the clock itself — the run loop hands it the run second. Every array is
 * sized at construction. A replay re-simulation, a co-op guest applying the host's pick and a live
 * player all drive the same object the same way, which is the only reason those three agree.
 *
 * WHY THE POOL IS PASSED IN
 * Which arcanas a profile has unlocked is a save-file question, and `game/sim` does not read save
 * files. `begin()` takes the list of available indices; the unlock bridge upstream decides it. Same
 * split as stages: the simulation knows the content, something else knows what you have earned.
 */

import type { Rng } from "../core/rng";
import { MODIFIER_SOURCE, type ModifierStack, type RunModifier } from "./modifiers";
import { STAT } from "./stats";

/**
 * Behaviour an arcana changes that is not a stat.
 *
 * A bitfield rather than a per-arcana hook, for the same reason `RUN_FLAG` is: the sim reads one
 * integer once, and a second arcana that reuses an existing bit costs nothing at all.
 */
export const ARCANA_FLAG = {
  /** The weapon you started the run with fires a second, mirrored copy. */
  mirroredStarter: 1 << 0,
  /** Healing also burns everything standing next to you. */
  healingBurns: 1 << 1,
  /** While you are on full health, every hit is a critical. */
  critAtFullHealth: 1 << 2,
  /** Picking up a large gem damages everything currently on the floor. */
  gemBurst: 1 << 3,
  /** Level-up cards never offer passives, so weapons come up far more often. */
  weaponsOnlyCards: 1 << 4,
  /** Gold picked up during the run is also worth experience. */
  coinsFeedTheLevel: 1 << 5,
} as const;

export type ArcanaFlag = (typeof ARCANA_FLAG)[keyof typeof ARCANA_FLAG];

/**
 * How an arcana is earned.
 *
 * `always` is the starter. `surviveAnywhere` reads the profile's single best survival time;
 * `surviveStage` reads one place's own best. Two kinds rather than one because "last 20 minutes,
 * anywhere" and "last 15 minutes in the marsh specifically" teach different things.
 */
export const ARCANA_UNLOCK = {
  always: 0,
  surviveAnywhere: 1,
  surviveStage: 2,
} as const;

export type ArcanaUnlockKind = (typeof ARCANA_UNLOCK)[keyof typeof ARCANA_UNLOCK];

export interface ArcanaUnlock {
  readonly kind: ArcanaUnlockKind;
  /** Seconds that must be survived. Ignored by `always`. */
  readonly seconds: number;
  /** Which place, for `surviveStage`. `-1` for the other kinds. */
  readonly stageIndex: number;
}

/**
 * What the profile knows, reduced to the two things an unlock rule may ask about.
 *
 * Deliberately not the save record: this file must stay readable by a test that never touches a
 * codec, and must never grow a dependency on the save schema.
 */
export interface ArcanaProgress {
  /** Best survival time on the profile, in seconds, regardless of where it happened. */
  readonly bestAnywhereSeconds: number;
  /** Best survival time per place, in seconds, indexed by stage index. */
  readonly bestByStageIndex: readonly number[];
}

export interface ArcanaType {
  readonly id: string;
  /** Append-only and permanent — written into co-op pick messages and replay pick streams. */
  readonly wireId: number;
  /** Roman numeral shown on the card, purely presentational. */
  readonly numeral: string;
  readonly name: string;
  /** One line, plain language, shown under the name. */
  readonly blurb: string;
  /** Bits from `ARCANA_FLAG`. Zero for an arcana that only moves numbers. */
  readonly flags: number;
  readonly unlock: ArcanaUnlock;
  readonly modifier: RunModifier;
}

/** Arcana wire ids start here so they cannot collide with the mode catalog's small ids. */
export const ARCANA_WIRE_BASE = 100;

const always: ArcanaUnlock = { kind: ARCANA_UNLOCK.always, seconds: 0, stageIndex: -1 };
const anywhere = (seconds: number): ArcanaUnlock => ({
  kind: ARCANA_UNLOCK.surviveAnywhere,
  seconds,
  stageIndex: -1,
});
const inStage = (stageIndex: number, seconds: number): ArcanaUnlock => ({
  kind: ARCANA_UNLOCK.surviveStage,
  seconds,
  stageIndex,
});

/**
 * The launch set. Append-only: an arcana's position is its index everywhere, including the unlock
 * bitset in the save file, so an insertion in the middle would hand players the wrong card.
 *
 * Eight is the launch target from `plan.md`. Each one is either a sharp trade (something real given
 * up for something real gained) or a rule change — an arcana that is only "+20% damage" is a passive
 * wearing a bigger frame, and the genre's arcanas are memorable because they are not that.
 */
export const ARCANA_TYPES: readonly ArcanaType[] = [
  {
    id: "twinToll",
    wireId: ARCANA_WIRE_BASE + 0,
    numeral: "I",
    name: "Twin Toll",
    blurb: "The weapon you began with rings twice. Every weapon swings slower.",
    flags: ARCANA_FLAG.mirroredStarter,
    unlock: always,
    modifier: {
      id: "arcana.twinToll",
      wireId: ARCANA_WIRE_BASE + 0,
      name: "Twin Toll",
      description: "Your starting weapon is mirrored. All weapons are slower.",
      source: MODIFIER_SOURCE.arcana,
      deltas: [{ stat: STAT.cooldown, mul: 1200 }],
    },
  },
  {
    id: "graveBloom",
    wireId: ARCANA_WIRE_BASE + 1,
    numeral: "II",
    name: "Grave Bloom",
    blurb: "You mend faster, and mending burns whatever stands too close.",
    flags: ARCANA_FLAG.healingBurns,
    unlock: anywhere(600),
    modifier: {
      id: "arcana.graveBloom",
      wireId: ARCANA_WIRE_BASE + 1,
      name: "Grave Bloom",
      description: "Regeneration is tripled and healing damages nearby enemies.",
      source: MODIFIER_SOURCE.arcana,
      deltas: [
        { stat: STAT.regen, mul: 3000 },
        { stat: STAT.maxHealth, mul: 900 },
      ],
    },
  },
  {
    id: "foolsVigil",
    wireId: ARCANA_WIRE_BASE + 2,
    numeral: "III",
    name: "Fool's Vigil",
    blurb: "Untouched, you cannot miss. Hurt, you are made of paper.",
    flags: ARCANA_FLAG.critAtFullHealth,
    unlock: inStage(1, 900),
    modifier: {
      id: "arcana.foolsVigil",
      wireId: ARCANA_WIRE_BASE + 2,
      name: "Fool's Vigil",
      description: "Every hit is critical at full health. Maximum health is halved.",
      source: MODIFIER_SOURCE.arcana,
      deltas: [
        { stat: STAT.maxHealth, mul: 500 },
        { stat: STAT.critDamage, mul: 1300 },
      ],
    },
  },
  {
    id: "theLongHour",
    wireId: ARCANA_WIRE_BASE + 3,
    numeral: "IV",
    name: "The Long Hour",
    blurb: "Your weapons come round faster. So does everything hunting you.",
    flags: 0,
    unlock: anywhere(1200),
    modifier: {
      id: "arcana.theLongHour",
      wireId: ARCANA_WIRE_BASE + 3,
      name: "The Long Hour",
      description: "Weapon cooldowns are much shorter. Enemies are faster and arrive sooner.",
      source: MODIFIER_SOURCE.arcana,
      deltas: [
        { stat: STAT.cooldown, mul: 700 },
        { stat: STAT.enemySpeed, mul: 1200 },
        { stat: STAT.spawnRate, mul: 1250 },
      ],
    },
  },
  {
    id: "paupersPurse",
    wireId: ARCANA_WIRE_BASE + 4,
    numeral: "V",
    name: "Pauper's Purse",
    blurb: "Coins are worth double and count as experience. Gems are worth much less.",
    flags: ARCANA_FLAG.coinsFeedTheLevel,
    unlock: inStage(2, 900),
    modifier: {
      id: "arcana.paupersPurse",
      wireId: ARCANA_WIRE_BASE + 4,
      name: "Pauper's Purse",
      description: "Gold is doubled and feeds your level. Gems are worth far less.",
      source: MODIFIER_SOURCE.arcana,
      deltas: [
        { stat: STAT.goldGain, mul: 2000 },
        { stat: STAT.gemValue, mul: 600 },
        { stat: STAT.magnet, mul: 1300 },
      ],
    },
  },
  {
    id: "ironLitany",
    wireId: ARCANA_WIRE_BASE + 5,
    numeral: "VI",
    name: "Iron Litany",
    blurb: "Almost nothing gets through. You will not be outrunning anything either.",
    flags: 0,
    unlock: anywhere(1500),
    modifier: {
      id: "arcana.ironLitany",
      wireId: ARCANA_WIRE_BASE + 5,
      name: "Iron Litany",
      description: "Heavy armour and longer mercy after a hit. You move much slower.",
      source: MODIFIER_SOURCE.arcana,
      deltas: [
        { stat: STAT.armor, add: 8 },
        { stat: STAT.iFrames, mul: 1500 },
        { stat: STAT.moveSpeed, mul: 750 },
      ],
    },
  },
  {
    id: "reapersBargain",
    wireId: ARCANA_WIRE_BASE + 6,
    numeral: "VII",
    name: "Reaper's Bargain",
    blurb: "Everything dies easily. Everything comes, all at once, forever.",
    flags: 0,
    unlock: inStage(3, 1200),
    modifier: {
      id: "arcana.reapersBargain",
      wireId: ARCANA_WIRE_BASE + 6,
      name: "Reaper's Bargain",
      description: "Enemies are far frailer and far more numerous. Gems are worth more.",
      source: MODIFIER_SOURCE.arcana,
      deltas: [
        { stat: STAT.enemyHealth, mul: 550 },
        { stat: STAT.spawnRate, mul: 1800 },
        { stat: STAT.gemValue, mul: 1250 },
      ],
    },
  },
  {
    id: "shatteredReliquary",
    wireId: ARCANA_WIRE_BASE + 7,
    numeral: "VIII",
    name: "Shattered Reliquary",
    blurb: "Large gems break like glass. Cards will only ever offer you weapons.",
    flags: ARCANA_FLAG.gemBurst | ARCANA_FLAG.weaponsOnlyCards,
    unlock: anywhere(1800),
    modifier: {
      id: "arcana.shatteredReliquary",
      wireId: ARCANA_WIRE_BASE + 7,
      name: "Shattered Reliquary",
      description: "Large gems detonate. Cards offer weapons only. Effects are larger.",
      source: MODIFIER_SOURCE.arcana,
      deltas: [
        { stat: STAT.area, mul: 1250 },
        { stat: STAT.xpGain, mul: 850 },
      ],
    },
  },
];

/** How many arcanas one run can hold. Three offers, three keeps — every offer is a real decision. */
export const MAX_ARCANAS = 3;

/** Choices shown per offer. Three fits a phone card row and still forces a trade. */
export const ARCANA_OFFERS = 3;

/**
 * Run seconds at which an offer is due.
 *
 * Length must equal `MAX_ARCANAS`: the deck opens once per entry and keeps nothing spare, so a
 * mismatch would either strand a slot or open a fourth screen with nowhere to put the card.
 */
export const ARCANA_MINUTE_MARKS: readonly number[] = [240, 720, 1320];

export const ARCANA_BY_WIRE: ReadonlyMap<number, ArcanaType> = new Map(
  ARCANA_TYPES.map((a) => [a.wireId, a]),
);

/** Every flag any shipped arcana can turn on — used by the content lint below. */
const ALL_FLAGS = Object.values(ARCANA_FLAG).reduce((a, b) => a | b, 0);

/** Index lookup by id, for the dev menu and the unlock bridge. Never used in a hot loop. */
export function arcanaIndexOf(id: string): number {
  return ARCANA_TYPES.findIndex((a) => a.id === id);
}

/** Clamped read, so a stale index from a save file or a link can never throw. */
export function arcanaAt(index: number): ArcanaType {
  const i = index < 0 ? 0 : index >= ARCANA_TYPES.length ? ARCANA_TYPES.length - 1 : index;
  return ARCANA_TYPES[i];
}

/**
 * Whether the profile has met an arcana's condition.
 *
 * Note what this does *not* look at: whether the arcana is already marked unlocked. A stored mark
 * outranks the condition everywhere else in the game, and it does so precisely because this function
 * is the only thing allowed to set one — if it consulted the mark, the mark would justify itself.
 */
export function arcanaConditionMet(arcana: ArcanaType, progress: ArcanaProgress): boolean {
  const u = arcana.unlock;
  if (u.kind === ARCANA_UNLOCK.always) return true;
  if (u.kind === ARCANA_UNLOCK.surviveAnywhere) return progress.bestAnywhereSeconds >= u.seconds;
  const i = u.stageIndex;
  if (i < 0 || i >= progress.bestByStageIndex.length) return false;
  return progress.bestByStageIndex[i] >= u.seconds;
}

/** The sentence shown on a locked card. Written here so the words cannot disagree with the rule. */
export function arcanaUnlockText(arcana: ArcanaType, stageNames: readonly string[]): string {
  const u = arcana.unlock;
  if (u.kind === ARCANA_UNLOCK.always) return "Available from the start.";
  const minutes = Math.floor(u.seconds / 60);
  if (u.kind === ARCANA_UNLOCK.surviveAnywhere) return `Survive ${minutes} minutes in any place.`;
  const name = stageNames[u.stageIndex] ?? "a later place";
  return `Survive ${minutes} minutes in ${name}.`;
}

/**
 * Content lint. Returns a list of faults, empty when the catalog is sound.
 *
 * This runs in a test rather than at import time on purpose: a throw at import would take the whole
 * game down on a phone, and a content mistake should fail a build, not a player's launch.
 */
export function arcanaContentFaults(): string[] {
  const faults: string[] = [];
  const ids = new Set<string>();
  const wires = new Set<number>();
  const names = new Set<string>();
  let flagsSeen = 0;

  for (let i = 0; i < ARCANA_TYPES.length; i++) {
    const a = ARCANA_TYPES[i];
    if (ids.has(a.id)) faults.push(`duplicate arcana id ${a.id}`);
    ids.add(a.id);
    if (wires.has(a.wireId)) faults.push(`duplicate arcana wireId ${a.wireId}`);
    wires.add(a.wireId);
    if (names.has(a.name)) faults.push(`duplicate arcana name ${a.name}`);
    names.add(a.name);
    if (a.wireId < ARCANA_WIRE_BASE) faults.push(`${a.id} wireId is below the arcana range`);
    if (a.modifier.wireId !== a.wireId) faults.push(`${a.id} modifier wireId does not match`);
    if (a.modifier.source !== MODIFIER_SOURCE.arcana) faults.push(`${a.id} is not sourced as arcana`);
    if (a.modifier.deltas.length === 0 && a.flags === 0) faults.push(`${a.id} does nothing`);
    if ((a.flags & ~ALL_FLAGS) !== 0) faults.push(`${a.id} carries an unknown flag`);
    if (a.blurb.trim().length === 0) faults.push(`${a.id} has no blurb`);
    if (a.unlock.kind === ARCANA_UNLOCK.surviveStage && a.unlock.stageIndex < 0) {
      faults.push(`${a.id} asks for a place that cannot exist`);
    }
    if (a.unlock.kind !== ARCANA_UNLOCK.always && a.unlock.seconds <= 0) {
      faults.push(`${a.id} has a condition that is met before the run starts`);
    }
    flagsSeen |= a.flags;
  }

  if (ARCANA_TYPES.length === 0) faults.push("no arcanas");
  if (ARCANA_TYPES[0].unlock.kind !== ARCANA_UNLOCK.always) {
    faults.push("the first arcana must be available from the start");
  }
  if (ARCANA_MINUTE_MARKS.length !== MAX_ARCANAS) {
    faults.push("there must be exactly one offer mark per arcana slot");
  }
  for (let i = 1; i < ARCANA_MINUTE_MARKS.length; i++) {
    if (ARCANA_MINUTE_MARKS[i] <= ARCANA_MINUTE_MARKS[i - 1]) {
      faults.push("offer marks must be in ascending order");
    }
  }
  // Every drawn symbol has to be reachable, and every behaviour we wrote code for has to be used by
  // something — an unused flag is dead sim code that nobody will ever delete.
  if (flagsSeen !== ALL_FLAGS) faults.push("some arcana behaviour is never used by any arcana");
  if (ARCANA_TYPES.length < ARCANA_OFFERS) faults.push("fewer arcanas than a single offer shows");

  return faults;
}

/**
 * One run's arcanas: what is available, what has been offered, what is held.
 *
 * One deck per run, not per player. In co-op the host owns the deck and the pick is authoritative,
 * for the same reason the host owns the wave table — four players silently holding different arcanas
 * is the kind of desync that only shows up in the numbers, hours later.
 */
export class ArcanaDeck {
  /** True while an offer screen is up and the run should be paused. */
  open = false;

  /** How many of the offer slots are populated. */
  offerCount = 0;
  /** Arcana index per offer slot; `-1` when empty. */
  readonly offerIndex = new Int32Array(ARCANA_OFFERS).fill(-1);

  /** Arcana indices held, in the order they were taken. */
  readonly heldIndex = new Int32Array(MAX_ARCANAS).fill(-1);
  heldCount = 0;

  /** OR of every held arcana's flags. The one integer the sim reads. */
  flags = 0;

  /** How many offers have already happened, including the one on screen. */
  offersMade = 0;

  /** Indices the profile has unlocked, as given to `begin`. */
  private readonly pool = new Int32Array(256);
  private poolCount = 0;
  /** Scratch for the draw, so a draw allocates nothing. */
  private readonly bag = new Int32Array(256);

  /**
   * Start a run.
   *
   * `available` is the unlocked pool. An empty pool is legal and simply means no offer ever opens —
   * better than inventing a card the player has not earned, which is what a fallback would do.
   */
  begin(available: readonly number[]): void {
    this.reset();
    for (const i of available) {
      if (i < 0 || i >= ARCANA_TYPES.length) continue;
      if (this.poolCount >= this.pool.length) break;
      // Guard against a caller handing the same index twice, which would double its draw odds.
      let seen = false;
      for (let k = 0; k < this.poolCount; k++) if (this.pool[k] === i) seen = true;
      if (seen) continue;
      this.pool[this.poolCount++] = i;
    }
  }

  reset(): void {
    this.open = false;
    this.offerCount = 0;
    this.offerIndex.fill(-1);
    this.heldIndex.fill(-1);
    this.heldCount = 0;
    this.flags = 0;
    this.offersMade = 0;
    this.poolCount = 0;
  }

  get poolSize(): number {
    return this.poolCount;
  }

  /** Whether the run currently holds a given arcana index. */
  holds(index: number): boolean {
    for (let i = 0; i < this.heldCount; i++) if (this.heldIndex[i] === index) return true;
    return false;
  }

  /** Whether a behaviour bit is switched on by anything held. */
  has(flag: number): boolean {
    return (this.flags & flag) !== 0;
  }

  /** The run second at which the next offer is due, or `-1` when there are no more. */
  nextMarkSecond(): number {
    if (this.offersMade >= ARCANA_MINUTE_MARKS.length) return -1;
    return ARCANA_MINUTE_MARKS[this.offersMade];
  }

  /**
   * Advance to `second`. Opens an offer when one is due.
   *
   * Returns true when an offer opened on this call. The mark is compared with `>=` and consumed, so
   * a run resumed from a save or a replay that jumps past a mark still gets its offer rather than
   * silently skipping it — the same bug the wave director had with a boss that came due late.
   */
  update(second: number, rng: Rng): boolean {
    if (this.open) return false;
    if (this.heldCount >= MAX_ARCANAS) return false;
    const mark = this.nextMarkSecond();
    if (mark < 0 || second < mark) return false;
    this.offersMade++;
    return this.draw(rng);
  }

  /**
   * Fill the offer slots from the pool, skipping anything already held.
   *
   * Returns false and stays closed when there is nothing left to offer. A screen with no cards on it
   * would be a dead-end the player cannot dismiss, and a filler card would hand out an arcana the
   * profile has not unlocked.
   */
  draw(rng: Rng): boolean {
    let n = 0;
    for (let i = 0; i < this.poolCount; i++) {
      const idx = this.pool[i];
      if (this.holds(idx)) continue;
      this.bag[n++] = idx;
    }
    if (n === 0) {
      this.offerCount = 0;
      this.offerIndex.fill(-1);
      return false;
    }

    // Partial Fisher-Yates over the front of the bag. Drawing by repeated rejection would burn a
    // varying number of values out of the stream depending on collisions, and a replay needs the
    // stream position after a draw to be a function of the pool size alone.
    const want = n < ARCANA_OFFERS ? n : ARCANA_OFFERS;
    for (let i = 0; i < want; i++) {
      const j = i + rng.nextInt(n - i);
      const t = this.bag[i];
      this.bag[i] = this.bag[j];
      this.bag[j] = t;
    }

    this.offerIndex.fill(-1);
    for (let i = 0; i < want; i++) this.offerIndex[i] = this.bag[i];
    this.offerCount = want;
    this.open = true;
    return true;
  }

  /**
   * Take the card in `slot`. Returns the arcana index taken, or `-1` when the slot is not a real
   * offer — a guest echoing a stale pick must be refused, not allowed to invent a card.
   */
  take(slot: number): number {
    if (!this.open) return -1;
    if (slot < 0 || slot >= this.offerCount) return -1;
    const index = this.offerIndex[slot];
    if (index < 0 || index >= ARCANA_TYPES.length) return -1;
    if (this.holds(index)) return -1;
    if (this.heldCount >= MAX_ARCANAS) return -1;

    this.heldIndex[this.heldCount++] = index;
    this.flags |= ARCANA_TYPES[index].flags;
    this.close();
    return index;
  }

  /** Close without taking anything. The offer is spent — an arcana refused is an arcana refused. */
  close(): void {
    this.open = false;
    this.offerCount = 0;
    this.offerIndex.fill(-1);
  }

  /**
   * Push every held arcana into the modifier stack's loadout.
   *
   * The caller clears the loadout and rebuilds it from scratch — passives do the same. Rebuilding
   * rather than patching is what stops "I took an arcana and my damage went down" bugs, because
   * there is no undo path to get wrong.
   */
  applyTo(stack: ModifierStack): number {
    let added = 0;
    for (let i = 0; i < this.heldCount; i++) {
      const a = ARCANA_TYPES[this.heldIndex[i]];
      if (!stack.addLoadout(a.modifier)) break;
      added++;
    }
    return added;
  }

  /** Restore a known set of held arcanas — replay resume and co-op resync both need this. */
  restore(held: readonly number[]): void {
    this.heldIndex.fill(-1);
    this.heldCount = 0;
    this.flags = 0;
    for (const index of held) {
      if (index < 0 || index >= ARCANA_TYPES.length) continue;
      if (this.holds(index)) continue;
      if (this.heldCount >= MAX_ARCANAS) break;
      this.heldIndex[this.heldCount++] = index;
      this.flags |= ARCANA_TYPES[index].flags;
    }
    this.close();
  }

  /** Wire ids of what is held, for a co-op join packet. Returns how many were written. */
  wireIds(out: Int32Array): number {
    const n = this.heldCount < out.length ? this.heldCount : out.length;
    for (let i = 0; i < n; i++) out[i] = ARCANA_TYPES[this.heldIndex[i]].wireId;
    return n;
  }
}
