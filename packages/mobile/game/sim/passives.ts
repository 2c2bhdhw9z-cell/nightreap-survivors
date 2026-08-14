/**
 * Passive items — the other half of the level-up card pool.
 *
 * WHY A PASSIVE IS DATA, NOT CODE
 * A passive changes numbers and nothing else. Every one of them is a name plus five rows of stat
 * deltas, so adding the twentieth passive is a row in `PASSIVE_TYPES`, never a branch in a hot loop.
 * That is the same rule weapons follow, and it is what keeps the 20-passive target from turning into
 * twenty special cases in the stat code.
 *
 * WHY EACH LEVEL IS ITS OWN MODIFIER RECORD
 * Owning a passive at level 3 means levels 1, 2 and 3 are all folded in. Rather than storing "the
 * total at level 3" (which would have to be recomputed and diffed on every pick), each level is a
 * standalone `RunModifier` built once at module load, and the loadout is rebuilt by adding one record
 * per owned level. Consequences that matter:
 *   - Folding is additive and order-independent, so a replay or a co-op guest that took the same
 *     levels in a different order reaches byte-identical stats.
 *   - Nothing allocates when a passive levels: the records already exist.
 *   - The card text and the stat effect come from the same row, so the card can never lie.
 *
 * WHY THE RECORDS ARE "LOADOUT" MODIFIERS
 * They resolve through `ModifierStack` exactly like Hurry or an Ascension tier — one resolution path
 * for every number in the game — but they sit in the stack's loadout list so they never appear in the
 * replay header. A replay reconstructs passives by replaying the card picks; recording them twice
 * would be two sources of truth for the same fact.
 */

import { MODIFIER_SOURCE, type RunModifier, type StatDelta } from "./modifiers";
import { STAT, STAT_SCALE, type StatId } from "./stats";

/** Passive slots per player. Matches the weapon loadout so the UI is symmetrical. */
export const MAX_PASSIVES = 6;

/** Levels a passive can reach. Level 1 is the pickup itself. */
export const MAX_PASSIVE_LEVEL = 5;

/** One level of a passive: what it does, and the words the card shows for it. */
export interface PassiveLevel {
  /** Player-facing card copy. Written next to the deltas so the two can never drift apart. */
  readonly text: string;
  readonly deltas: readonly StatDelta[];
}

/** A passive item, as content. */
export interface PassiveType {
  /** Stable string id used in content files and dev tooling. */
  readonly id: string;
  /** Player-facing name. */
  readonly name: string;
  /**
   * Append-only numeric id. Written into saves and co-op packets. Never reuse, never renumber.
   */
  readonly wireId: number;
  /** One-line description for the card and the collection screen. */
  readonly blurb: string;
  /** Atlas frame index. Visual only. */
  readonly sprite: number;
  /** Exactly `MAX_PASSIVE_LEVEL` entries, level 1 first. */
  readonly levels: readonly PassiveLevel[];
}

/** Shorthand: a flat permille bump repeated for every level of a percentage passive. */
function percentLevels(stat: StatId, perLevel: number, label: string): PassiveLevel[] {
  const out: PassiveLevel[] = [];
  for (let i = 0; i < MAX_PASSIVE_LEVEL; i++) {
    out.push({ text: label, deltas: [{ stat, add: perLevel }] });
  }
  return out;
}

/**
 * The twenty launch passives.
 *
 * The first six came first on purpose: one that raises damage, one that survives, one that moves, one
 * that collects, one that fires faster, one that regenerates. Those six proved the system, and every
 * one of the fourteen after them is a variation on one of the six against a different stat.
 *
 * WHY TWENTY AND NOT SOME LATER
 * Passives are the cheapest content in the game — a name, a line of text and a column of numbers — and
 * they are what evolutions ask for. Shipping only some of them would mean either evolutions that ask for
 * an item the player cannot yet be offered, or a second pass over every weapon later to repoint it. All
 * twenty exist now so weapons can ask for any of them from here on.
 *
 * WIRE IDS ARE APPEND-ONLY
 * A wire id is written into save files and sent to other players. New passives take the next free number
 * and nothing already written down ever moves, so an old save keeps meaning what it meant.
 *
 * EVERY LEVEL HAS TO GIVE SOMETHING
 * A level that reads "no change" on the card is a level that feels like a bug. Passives whose natural
 * step is too strong to repeat five times alternate between two effects instead of standing still.
 */
export const PASSIVE_TYPES: readonly PassiveType[] = [
  {
    id: "grimSigil",
    name: "Grim Sigil",
    wireId: 1,
    blurb: "Everything you own hits harder.",
    sprite: 0,
    levels: percentLevels(STAT.damage, 100, "Damage +10%"),
  },
  {
    id: "boneCharm",
    name: "Bone Charm",
    wireId: 2,
    blurb: "Bone shrugs off what flesh cannot.",
    sprite: 1,
    levels: [
      { text: "Armour +1", deltas: [{ stat: STAT.armor, add: 1 }] },
      { text: "Armour +1", deltas: [{ stat: STAT.armor, add: 1 }] },
      { text: "Armour +1", deltas: [{ stat: STAT.armor, add: 1 }] },
      { text: "Armour +2", deltas: [{ stat: STAT.armor, add: 2 }] },
      {
        text: "Armour +2, knockback +20%",
        deltas: [
          { stat: STAT.armor, add: 2 },
          { stat: STAT.knockback, add: 200 },
        ],
      },
    ],
  },
  {
    id: "wanderersBoots",
    name: "Wanderer's Boots",
    wireId: 3,
    blurb: "Outrun the horde, or die in it.",
    sprite: 2,
    levels: percentLevels(STAT.moveSpeed, 80, "Move speed +8%"),
  },
  {
    id: "hollowLantern",
    name: "Hollow Lantern",
    wireId: 4,
    blurb: "Draws the light of the fallen toward you.",
    sprite: 3,
    levels: [
      { text: "Pickup range +40%", deltas: [{ stat: STAT.magnet, add: 400 }] },
      { text: "Pickup range +40%", deltas: [{ stat: STAT.magnet, add: 400 }] },
      { text: "Pickup range +40%", deltas: [{ stat: STAT.magnet, add: 400 }] },
      { text: "Pickup range +40%", deltas: [{ stat: STAT.magnet, add: 400 }] },
      {
        text: "Pickup range +40%, experience +10%",
        deltas: [
          { stat: STAT.magnet, add: 400 },
          { stat: STAT.xpGain, add: 100 },
        ],
      },
    ],
  },
  {
    id: "ashHourglass",
    name: "Ash Hourglass",
    wireId: 5,
    blurb: "Your weapons come around sooner.",
    sprite: 4,
    // Cooldown is a multiplier where lower is faster, so the delta is negative. The stat's floor
    // (100 = 0.1x) is what stops a stack of these from reaching a divide-by-zero fire rate.
    levels: percentLevels(STAT.cooldown, -60, "Cooldown -6%"),
  },
  {
    id: "gravemossRoot",
    name: "Gravemoss Root",
    wireId: 6,
    blurb: "The grave gives a little back.",
    sprite: 5,
    levels: [
      {
        text: "Max health +20, regeneration +0.3/s",
        deltas: [
          { stat: STAT.maxHealth, add: 20 * STAT_SCALE },
          { stat: STAT.regen, add: 300 },
        ],
      },
      {
        text: "Max health +20, regeneration +0.3/s",
        deltas: [
          { stat: STAT.maxHealth, add: 20 * STAT_SCALE },
          { stat: STAT.regen, add: 300 },
        ],
      },
      {
        text: "Max health +20, regeneration +0.3/s",
        deltas: [
          { stat: STAT.maxHealth, add: 20 * STAT_SCALE },
          { stat: STAT.regen, add: 300 },
        ],
      },
      {
        text: "Max health +20, regeneration +0.3/s",
        deltas: [
          { stat: STAT.maxHealth, add: 20 * STAT_SCALE },
          { stat: STAT.regen, add: 300 },
        ],
      },
      {
        text: "Max health +40, regeneration +0.6/s",
        deltas: [
          { stat: STAT.maxHealth, add: 40 * STAT_SCALE },
          { stat: STAT.regen, add: 600 },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------------------------------------
  // The fourteen that complete the launch set. Same shape, one per remaining stat a player can feel.
  // ---------------------------------------------------------------------------------------------

  {
    id: "hollowedCrown",
    name: "Hollowed Crown",
    wireId: 7,
    blurb: "Everything you do reaches wider.",
    sprite: 6,
    levels: percentLevels(STAT.area, 80, "Area +8%"),
  },
  {
    id: "splinteredQuiver",
    name: "Splintered Quiver",
    wireId: 8,
    blurb: "What you throw leaves faster.",
    sprite: 7,
    levels: percentLevels(STAT.projectileSpeed, 100, "Projectile speed +10%"),
  },
  {
    id: "widowsVeil",
    name: "Widow's Veil",
    wireId: 9,
    blurb: "What you leave behind lingers.",
    sprite: 8,
    levels: percentLevels(STAT.duration, 100, "Duration +10%"),
  },
  {
    id: "reapersTally",
    name: "Reaper's Tally",
    wireId: 10,
    // Amount is flat and the strongest number in the game — every weapon fires one more of everything.
    // Three of them across five levels, with pierce filling the two gaps so no level reads as nothing.
    blurb: "One more of everything you throw.",
    sprite: 9,
    levels: [
      { text: "Projectiles +1", deltas: [{ stat: STAT.amount, add: 1 }] },
      { text: "Pierce +1", deltas: [{ stat: STAT.pierce, add: 1 }] },
      { text: "Projectiles +1", deltas: [{ stat: STAT.amount, add: 1 }] },
      { text: "Pierce +1", deltas: [{ stat: STAT.pierce, add: 1 }] },
      { text: "Projectiles +1", deltas: [{ stat: STAT.amount, add: 1 }] },
    ],
  },
  {
    id: "gildedOssuary",
    name: "Gilded Ossuary",
    wireId: 11,
    blurb: "The dead pay better.",
    sprite: 10,
    levels: percentLevels(STAT.goldGain, 150, "Gold +15%"),
  },
  {
    id: "marrowLedger",
    name: "Marrow Ledger",
    wireId: 12,
    blurb: "You learn faster from each one you put down.",
    sprite: 11,
    levels: percentLevels(STAT.xpGain, 100, "Experience +10%"),
  },
  {
    id: "blackCatSkull",
    name: "Black Cat Skull",
    wireId: 13,
    blurb: "The rolls lean your way.",
    sprite: 12,
    levels: percentLevels(STAT.luck, 100, "Luck +10%"),
  },
  {
    id: "gravediggersWedge",
    name: "Gravedigger's Wedge",
    wireId: 14,
    blurb: "Your shots pass through one more of them.",
    sprite: 13,
    levels: [
      { text: "Pierce +1", deltas: [{ stat: STAT.pierce, add: 1 }] },
      { text: "Pierce +1", deltas: [{ stat: STAT.pierce, add: 1 }] },
      { text: "Pierce +1", deltas: [{ stat: STAT.pierce, add: 1 }] },
      { text: "Pierce +1", deltas: [{ stat: STAT.pierce, add: 1 }] },
      {
        text: "Pierce +2, damage +5%",
        deltas: [
          { stat: STAT.pierce, add: 2 },
          { stat: STAT.damage, add: 50 },
        ],
      },
    ],
  },
  {
    id: "ironWake",
    name: "Iron Wake",
    wireId: 15,
    blurb: "They go further when you hit them.",
    sprite: 14,
    levels: percentLevels(STAT.knockback, 200, "Knockback +20%"),
  },
  {
    id: "deathlessAsh",
    name: "Deathless Ash",
    wireId: 16,
    // A revive is the single most valuable thing a passive can hand over, so it arrives twice and the
    // levels between it pay armour instead. Two is the ceiling the run economy is balanced around.
    blurb: "Death is not always the end of it.",
    sprite: 15,
    levels: [
      { text: "Revive +1", deltas: [{ stat: STAT.revives, add: 1 }] },
      { text: "Armour +1", deltas: [{ stat: STAT.armor, add: 1 }] },
      { text: "Armour +1", deltas: [{ stat: STAT.armor, add: 1 }] },
      { text: "Revive +1", deltas: [{ stat: STAT.revives, add: 1 }] },
      {
        text: "Armour +2, max health +30",
        deltas: [
          { stat: STAT.armor, add: 2 },
          { stat: STAT.maxHealth, add: 30 * STAT_SCALE },
        ],
      },
    ],
  },
  {
    id: "butchersMark",
    name: "Butcher's Mark",
    wireId: 17,
    blurb: "Some blows land where it matters.",
    sprite: 16,
    levels: percentLevels(STAT.critChance, 40, "Critical chance +4%"),
  },
  {
    id: "ruinousEdge",
    name: "Ruinous Edge",
    wireId: 18,
    blurb: "When it matters, it matters more.",
    sprite: 17,
    levels: percentLevels(STAT.critDamage, 150, "Critical damage +15%"),
  },
  {
    id: "shroudOfVigil",
    name: "Shroud of Vigil",
    wireId: 19,
    // iFrames are counted in ticks, not permille: this is a flat window, the same on every device.
    blurb: "You stay untouchable a moment longer.",
    sprite: 18,
    levels: [
      { text: "Invulnerable longer", deltas: [{ stat: STAT.iFrames, add: 8 }] },
      { text: "Invulnerable longer", deltas: [{ stat: STAT.iFrames, add: 8 }] },
      { text: "Invulnerable longer", deltas: [{ stat: STAT.iFrames, add: 8 }] },
      { text: "Invulnerable longer", deltas: [{ stat: STAT.iFrames, add: 8 }] },
      {
        text: "Invulnerable longer, move speed +5%",
        deltas: [
          { stat: STAT.iFrames, add: 12 },
          { stat: STAT.moveSpeed, add: 50 },
        ],
      },
    ],
  },
  {
    id: "paleFeast",
    name: "Pale Feast",
    wireId: 20,
    blurb: "There is more of you to lose.",
    sprite: 19,
    levels: [
      { text: "Max health +25", deltas: [{ stat: STAT.maxHealth, add: 25 * STAT_SCALE }] },
      { text: "Max health +25", deltas: [{ stat: STAT.maxHealth, add: 25 * STAT_SCALE }] },
      { text: "Max health +25", deltas: [{ stat: STAT.maxHealth, add: 25 * STAT_SCALE }] },
      { text: "Max health +25", deltas: [{ stat: STAT.maxHealth, add: 25 * STAT_SCALE }] },
      {
        text: "Max health +50, regeneration +0.2/s",
        deltas: [
          { stat: STAT.maxHealth, add: 50 * STAT_SCALE },
          { stat: STAT.regen, add: 200 },
        ],
      },
    ],
  },
];

/** Content guards: a malformed row here would silently mislabel or under-apply a passive. */
for (const p of PASSIVE_TYPES) {
  if (p.levels.length !== MAX_PASSIVE_LEVEL) {
    throw new Error(`passive ${p.id} has ${p.levels.length} levels, expected ${MAX_PASSIVE_LEVEL}`);
  }
}

export const PASSIVE_BY_ID: ReadonlyMap<string, number> = new Map(
  PASSIVE_TYPES.map((p, i) => [p.id, i]),
);

export const PASSIVE_BY_WIRE_ID: ReadonlyMap<number, number> = new Map(
  PASSIVE_TYPES.map((p, i) => [p.wireId, i]),
);

if (PASSIVE_BY_WIRE_ID.size !== PASSIVE_TYPES.length) {
  throw new Error("PASSIVE_TYPES contains duplicate wireId values");
}

/**
 * One `RunModifier` per passive per level, built once.
 *
 * Indexed `[typeIndex][level - 1]`. Wire ids are namespaced well clear of the run-modifier catalog
 * so that a bug which leaked one of these into the replay header would fail to decode loudly instead
 * of decoding as Hurry.
 */
export const PASSIVE_MODIFIERS: readonly (readonly RunModifier[])[] = PASSIVE_TYPES.map((p) =>
  p.levels.map((lvl, li) => ({
    id: `passive.${p.id}.${li + 1}`,
    wireId: 100_000 + p.wireId * 100 + (li + 1),
    name: `${p.name} ${li + 1}`,
    description: lvl.text,
    source: MODIFIER_SOURCE.passive,
    deltas: lvl.deltas,
  })),
);

/** Interface the card system needs from a stack, so tests can hand in a stub. */
export interface LoadoutSink {
  clearLoadout(): void;
  addLoadout(mod: RunModifier): boolean;
}

/**
 * Every passive every player is carrying.
 *
 * Flat arrays indexed `player * MAX_PASSIVES + slot`, mirroring `WeaponStore` exactly — same shape,
 * same `grant` contract, so the card system treats a weapon and a passive as the same kind of thing
 * with a different store behind it.
 */
export class PassiveStore {
  readonly maxPlayers: number;
  /** Passive type index, or -1 for an empty slot. */
  readonly typeIndex: Int32Array;
  readonly level: Int32Array;

  playerCount = 1;

  constructor(maxPlayers = 4) {
    this.maxPlayers = maxPlayers;
    const n = maxPlayers * MAX_PASSIVES;
    this.typeIndex = new Int32Array(n).fill(-1);
    this.level = new Int32Array(n);
  }

  reset(playerCount: number): void {
    this.playerCount =
      playerCount < 1 ? 1 : playerCount > this.maxPlayers ? this.maxPlayers : playerCount;
    this.typeIndex.fill(-1);
    this.level.fill(0);
  }

  /** Slots a player is carrying. */
  countFor(player: number): number {
    const base = player * MAX_PASSIVES;
    let n = 0;
    for (let i = 0; i < MAX_PASSIVES; i++) if (this.typeIndex[base + i] >= 0) n++;
    return n;
  }

  /** Which slot holds this passive for this player, or -1. */
  slotOf(player: number, passiveTypeIndex: number): number {
    const base = player * MAX_PASSIVES;
    for (let i = 0; i < MAX_PASSIVES; i++) {
      if (this.typeIndex[base + i] === passiveTypeIndex) return base + i;
    }
    return -1;
  }

  /**
   * Give a player a passive, or level the one they already have. Returns the new level, or 0 when
   * they are full and do not already carry it — a full loadout is a normal situation the card system
   * asks about, not an error.
   */
  grant(player: number, passiveTypeIndex: number): number {
    const existing = this.slotOf(player, passiveTypeIndex);
    if (existing >= 0) {
      if (this.level[existing] >= MAX_PASSIVE_LEVEL) return this.level[existing];
      this.level[existing]++;
      return this.level[existing];
    }
    const base = player * MAX_PASSIVES;
    for (let i = 0; i < MAX_PASSIVES; i++) {
      if (this.typeIndex[base + i] >= 0) continue;
      this.typeIndex[base + i] = passiveTypeIndex;
      this.level[base + i] = 1;
      return 1;
    }
    return 0;
  }

  isMaxed(player: number, passiveTypeIndex: number): boolean {
    const slot = this.slotOf(player, passiveTypeIndex);
    return slot >= 0 && this.level[slot] >= MAX_PASSIVE_LEVEL;
  }

  isFull(player: number): boolean {
    return this.countFor(player) >= MAX_PASSIVES;
  }

  levelOf(player: number, passiveTypeIndex: number): number {
    const slot = this.slotOf(player, passiveTypeIndex);
    return slot < 0 ? 0 : this.level[slot];
  }

  /** Set a level outright. Dev menu and `RUN_FLAG.preMaxed` only. */
  devSetLevel(player: number, passiveTypeIndex: number, level: number): void {
    const target = Math.max(0, Math.min(MAX_PASSIVE_LEVEL, Math.trunc(level)));
    if (target === 0) return;
    let slot = this.slotOf(player, passiveTypeIndex);
    if (slot < 0) {
      if (this.grant(player, passiveTypeIndex) === 0) return;
      slot = this.slotOf(player, passiveTypeIndex);
    }
    this.level[slot] = target;
  }

  /**
   * Rebuild the stack's loadout from what this player owns.
   *
   * Called after every pick and on every resync, immediately before `resolve`. Rebuilding rather
   * than patching is the whole point: there is no code path that tries to subtract a passive, so
   * there is no code path that can subtract it wrongly.
   */
  applyTo(sink: LoadoutSink, player: number): void {
    sink.clearLoadout();
    const base = player * MAX_PASSIVES;
    for (let i = 0; i < MAX_PASSIVES; i++) {
      const type = this.typeIndex[base + i];
      if (type < 0) continue;
      const levels = PASSIVE_MODIFIERS[type];
      const owned = this.level[base + i];
      for (let l = 0; l < owned; l++) sink.addLoadout(levels[l]);
    }
  }
}
