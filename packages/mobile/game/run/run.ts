/**
 * The run — the thing that owns every simulation system and ticks them in one fixed order.
 *
 * WHY THIS FILE EXISTS
 * Every other file in `game/sim/` is a self-contained system that knows nothing about the others:
 * enemies do not know what a weapon is, pickups do not know what a level is. That is what makes them
 * testable and what keeps the co-op path and the solo path identical. Something still has to decide
 * *what happens in what order*, and that decision is the whole game. It lives here, once.
 *
 * THE ORDER IS THE CONTRACT
 * Change the order and you change the game — and worse, you desync co-op and invalidate every replay
 * ever recorded, because a guest ticking the same inputs in a different order produces a different
 * world. So the order is written out explicitly in `tick`, one numbered step at a time, and the
 * reason for each position is in a comment next to it.
 *
 * ONE REBUILD OF THE ENEMY GRID PER TICK
 * The spatial hash is rebuilt exactly once, after the crowd has moved and after the tick's spawns
 * have landed, and before anything asks it a question. That means enemy separation reads a grid that
 * is one tick old (perfectly fine — it is steering, not collision) while every damage test reads a
 * grid built from this tick's real positions (not fine to get wrong — a stale grid drops hits).
 *
 * NO ALLOCATION IN A TICK
 * Every buffer, every scratch object and every reusable record is built in the constructor. A `new`
 * inside `tick` — including a string, including an array literal, including a closure — is a bug on
 * a 4GB phone, because the garbage it makes is what stalls a frame fifteen minutes into a run.
 *
 * PAUSED MEANS PAUSED
 * While a level-up screen is open the simulation does not advance at all. The card screen is a modal
 * decision, and letting the crowd keep walking while a player reads four upgrades is how you get
 * killed by a menu.
 */

import { hashByte, hashFloat, hashFloat32Range, hashUint8Range, hashWord } from "../net/state-hash";
import { quantiseStick } from "../net/input";
import { ReplayRecorder } from "../replay/recorder";
import { ArcanaDeck } from "../sim/arcanas";
import { CardDraw } from "../sim/cards";
import {
  CHEST_REWARD,
  createChestReport,
  openChest,
  resetChestReport,
  type ChestReport,
} from "../sim/chests";
import { CUE, CueBus } from "../sim/cues";
import { ENEMY_FLAG, ENEMY_TYPES, ENEMY_TYPE_BY_ID, EnemyStore, REAPER_ENEMY_ID } from "../sim/enemies";
import { ModifierStack, RUN_FLAG, type RunModifier } from "../sim/modifiers";
import {
  BOSS_DROP_RULE,
  DEFAULT_DROP_RULE,
  PICKUP,
  PickupStore,
  rollDrops,
} from "../sim/pickups";
import { PassiveStore } from "../sim/passives";
import {
  MAX_PROP_RADIUS,
  PROP_HIT_COOLDOWN,
  PROP_HIT_PAD,
  PROP_STREAM_EVERY,
  PropField,
  payOutBreaks,
} from "../sim/props";
import { MAX_PLAYERS, PlayerStore } from "../sim/player";
import { Progression } from "../sim/progression";
import { ProjectileStore, type OwnerPositions } from "../sim/projectiles";
import { RUN_END, RunSummary, summariseRun, type RunEnd, type RunTotals } from "../sim/results";
import { EGGS_PER_REAPER_KILL } from "../sim/eggs";
import { STAT, STAT_COUNT, STAT_SCALE, Stats } from "../sim/stats";
import { stageAt, wavesForStage } from "../sim/stages";
import { TICKS_PER_SECOND, WaveDirector } from "../sim/waves";
import { WEAPON_BY_ID, WeaponStore } from "../sim/weapons";
import { RNG_STREAMS, Rng, RngSet, hashName } from "../core/rng";

/** Where the players stand at the start of a co-op run, so four of them do not begin overlapping. */
export const SPAWN_RING_RADIUS = 12;

/**
 * How long the White Hand takes to close after a Reaper is killed.
 *
 * Twelve seconds, because the bell tolls twelve times. This window is the hard-path ending — it does
 * NOT start when the first Reaper arrives (that would leave no time to fight, and no room for one more
 * Reaper every minute). Dying to a Reaper is a normal stage clear; killing one starts this sequence.
 */
export const WHITE_HAND_TICKS = 12 * TICKS_PER_SECOND;

/** Radius a bomb pickup clears. Generous on purpose: a bomb that does not feel decisive is litter. */
export const BOMB_RADIUS = 160;

/** Damage a bomb applies. Far above any enemy's health, so "clears the screen" is literally true. */
export const BOMB_DAMAGE = 1_000_000;

/**
 * Coins a chest pays when it is opened by a player who is not in the run's loadout at all.
 *
 * A real chest hands out upgrades — see `chests.ts`. This is only the floor: a chest picked up by a
 * player the run has no loadout for still has to be worth something rather than silently doing
 * nothing, because a chest that does nothing reads as a bug every single time.
 */
export const CHEST_GOLD = 100;

// The Reaper's id now lives in sim/enemies alongside the enemy table, so the stage validator and this
// file cannot disagree about which enemy the Reaper is. Imported above as REAPER_ENEMY_ID.

/** Configuration for one run. Everything here is fixed at run start and never changes mid-run. */
export interface RunConfig {
  seed: number;
  playerCount: number;
  stageId: number;
  /** Character per player. Cosmetic in Phase 1; characters carry modifiers from Phase 4. */
  characterIds: readonly number[];
  /** Mode, ascension, stage and live-ops records. The simulation never sees a mode enum. */
  modifiers: readonly RunModifier[];
  /** Weapon every player starts holding. A run with no weapon is not a run. */
  startingWeaponId: string;
  /** Record the input log. Off for throwaway sandbox runs, on for anything that could be submitted. */
  record: boolean;
  /** End the run as a survival when the clock reaches this many ticks. 0 means "until you die". */
  timeLimitTicks: number;
  /** Take the first offer on every card screen automatically. For headless tests and bot players. */
  autoPick: boolean;
  buildId: number;
  contentVersion: number;
  /** Taint bits carried in from the dev menu before the run even starts. */
  tainted: number;
  /**
   * Ranks bought in the PowerUps shop, already turned into modifier records by the shop layer.
   *
   * Separate from `modifiers` even though both end up in the same stack, because they come from different
   * places and mean different things: `modifiers` is what this run *is* (mode, stage, ascension), and this
   * is what the account has permanently bought. Keeping them apart means a screen can say "your purchases
   * are worth this much" without unpicking the mode out of the same list, and means a future rule like
   * "this event ignores shop upgrades" is one line rather than a filter over a mixed array.
   *
   * They are records rather than a save file on purpose: `run.ts` knows nothing about saves, and the
   * records carry wire ids, so the run's purchases travel into replay headers and co-op joins with
   * everything else instead of being silently dropped there.
   */
  powerUps: readonly RunModifier[];
  /**
   * The chosen characters' own starting shifts, already turned into modifier records by the character layer.
   *
   * Records rather than character ids because `run.ts` knows nothing about the roster, and because a record
   * carries a wire id — so the character's numbers travel into the replay header, a co-op join message and a
   * snapshot restore with every other rule. `characterIds` above is what the *screens* and the replay header
   * call the choice; this is what the simulation resolves.
   */
  characters: readonly RunModifier[];
  /**
   * The chosen character's growth quirk as a ladder of records, indexed by how many steps have landed.
   *
   * Entry 0 is one step, entry 1 is two, and so on, each carrying every step folded together. The run picks
   * the right rung as the player levels; it never adds rungs together.
   *
   * These are deliberately NOT on the wire. The wire list is written once, at level one, when no step has
   * landed — so a record added at level twenty would be missing from it, and a header that changed as a run
   * played would put a co-op host and guest into disagreement mid-run. Instead the rung is derived from the
   * character and the level, both of which any resync restores, so the other side recomputes it.
   */
  characterGrowth: readonly RunModifier[];
  /** Levels between growth steps for the chosen character. Must be at least 1. */
  characterGrowthEvery: number;
  /**
   * PER-SLOT character choice, for co-op where every seat picks its own survivor.
   *
   * When present, entry `slot` supplies that seat's character records, growth ladder, growth spacing and
   * starting weapon, overriding the shared `characters`/`characterGrowth`/`characterGrowthEvery`/
   * `startingWeaponId` fields above for that seat. A slot left `undefined` (or a shorter array than the
   * party) falls back to the shared fields, so a solo run — which never sets these — is byte-identical to
   * before: its one seat resolves from `characters` exactly as it always did.
   *
   * These are the character half of the same idea the party already runs on: every seat's choice is on
   * every phone (the host published the roster before launch), so every phone builds the identical world
   * from seed + records. Each seat's character record wire id lands on `modifierWire`, so a snapshot
   * restore, a joining guest and a server replay all rebuild every seat's character, not just seat 0's.
   */
  charactersBySlot?: readonly (readonly RunModifier[])[];
  /** Per-slot growth ladders. Entry `slot` is that seat's ladder; a missing slot uses `characterGrowth`. */
  characterGrowthBySlot?: readonly (readonly RunModifier[])[];
  /** Per-slot growth spacing. Entry `slot` is that seat's `everyLevels`; a missing slot uses the shared one. */
  characterGrowthEveryBySlot?: readonly number[];
  /** Per-slot starting weapon id. Entry `slot` is that seat's weapon; a missing slot uses `startingWeaponId`. */
  startingWeaponIdBySlot?: readonly string[];
  /**
   * Which arcanas this profile has unlocked, as indices into the arcana catalog.
   *
   * Indices rather than records, because unlike a mode or a shop rank an arcana is not applied at run
   * start — it is a pool the run draws offers from, and the run only learns which record it needs when
   * the player takes a card. Empty is legal and simply means no offer ever opens, which is what a
   * profile that has unlocked nothing should get rather than a free card it never earned.
   */
  arcanaPool: readonly number[];
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
  seed: 1,
  playerCount: 1,
  stageId: 0,
  characterIds: [0, 0, 0, 0],
  modifiers: [],
  startingWeaponId: "reapersLash",
  record: true,
  timeLimitTicks: 0,
  autoPick: false,
  buildId: 1,
  contentVersion: 1,
  tainted: 0,
  powerUps: [],
  characters: [],
  characterGrowth: [],
  characterGrowthEvery: 1,
  arcanaPool: [],
};

export class Run {
  // --- Systems, all owned here and all reused between runs ---------------------------------
  readonly stats = new Stats();
  readonly stack = new ModifierStack();
  readonly players = new PlayerStore();
  readonly enemies = new EnemyStore();
  readonly projectiles = new ProjectileStore();
  readonly pickups = new PickupStore();
  readonly props = new PropField();
  readonly weapons = new WeaponStore(MAX_PLAYERS);
  readonly passives = new PassiveStore(MAX_PLAYERS);
  /**
   * Per-player progression and card draws.
   *
   * These used to be one `Progression` and one `CardDraw` shared by the whole party, which is why a
   * co-op guest's level-up did nothing: everyone levelled off one bar and picked from one screen that
   * only player 0's loadout ever received. Now each seat has its own, so each player levels on their
   * own gems and picks their own upgrades onto their own already-per-player weapon/passive store.
   *
   * Held as a plain object keyed by slot rather than an array on purpose: the snapshot walker descends
   * into a plain object and captures each `Progression`/`CardDraw`'s fields automatically, exactly as
   * it did for the single instances, but it deliberately skips arrays-of-objects (they are content
   * data). So this shape is what keeps per-player progression and card state in the resume snapshot
   * for free. `get prog()`/`get cards()` return slot 0 so every existing solo call site is unchanged.
   */
  readonly progAll: { [slot: number]: Progression } = {
    0: new Progression(),
    1: new Progression(),
    2: new Progression(),
    3: new Progression(),
  };
  readonly cardsAll: { [slot: number]: CardDraw } = {
    0: new CardDraw(),
    1: new CardDraw(),
    2: new CardDraw(),
    3: new CardDraw(),
  };
  /**
   * The run's arcanas. One deck per run rather than per player: in co-op the host owns the pick, for
   * the same reason the host owns the wave table.
   */
  readonly arcanas = new ArcanaDeck();
  readonly waves = new WaveDirector();
  readonly summary = new RunSummary();
  /** Last chest's payout. Caller-owned and refilled per chest, so opening one allocates nothing. */
  readonly chestReport: ChestReport = createChestReport();
  readonly recorder = new ReplayRecorder();

  /**
   * What happened this tick, for audio, particles and damage numbers to read.
   *
   * Write-only from the simulation's point of view. Nothing in here may ever be read back by a
   * system, and it is deliberately absent from `hashState` — see `cues.ts`.
   */
  readonly cues = new CueBus();

  /** Seeded streams. Reseeded per run rather than rebuilt, so starting a run allocates nothing. */
  readonly rng: RngSet;

  // --- Run state ---------------------------------------------------------------------------
  /** Ticks actually simulated. Not the same as the run clock, which time scale can run faster. */
  ticks = 0;
  end: RunEnd = RUN_END.running;
  seed = 0;
  stageId = 0;
  tainted = 0;
  recording = false;
  autoPick = false;
  timeLimitTicks = 0;

  /** Run totals the results screen needs and no single system owns. */
  kills = 0;
  /** Chests opened this run, and evolutions they produced, for the results screen. */
  chestsOpened = 0;
  evolutionsEarned = 0;
  damageDealt = 0;
  revives = 0;

  /** Ticks left in the White Hand sequence, or -1 when it has not begun. */
  whiteHandTicks = -1;

  /** How many Reapers this run has killed. First kill starts the White Hand and unlocks the secret. */
  reaperKills = 0;

  /** Golden Eggs earned this run (banked onto the save after the results screen). */
  eggsEarned = 0;

  /** Character the player picked for this run (seat 0). Eggs bank onto this index. */
  primaryCharacterId = 0;

  /** Resolved run flags — endless, early reaper, no card draw. Read every tick, never per entity. */
  private flags = 0;

  // --- Input, quantised at the boundary so every machine simulates the identical number -----
  readonly axes = new Int8Array(MAX_PLAYERS * 2);
  readonly buttons = new Uint8Array(MAX_PLAYERS);

  // --- Preallocated scratch ----------------------------------------------------------------
  private readonly targetX = new Float32Array(MAX_PLAYERS);
  private readonly targetY = new Float32Array(MAX_PLAYERS);
  private readonly owners: { count: number; x: Float32Array; y: Float32Array };
  private readonly totals: RunTotals = {
    kills: 0,
    damageDealt: 0,
    downs: 0,
    revives: 0,
    screensShown: 0,
    picksMade: 0,
    stageId: 0,
    seed: 0,
    tainted: 0,
  };
  /** Last tick's health and standing, so "took damage" and "went down" can be announced as events. */
  private readonly prevHealth = new Float32Array(MAX_PLAYERS);
  private readonly prevUpright = new Uint8Array(MAX_PLAYERS);
  /** Last tick's level per player, so a level-up can be announced and a growth step folded in. */
  private readonly prevLevel = new Int32Array(MAX_PLAYERS).fill(1);
  /**
   * The run's modifiers as wire ids, filled at `begin` whether or not the run is being recorded.
   *
   * Two things need these numbers rather than the records themselves: the replay header, and a snapshot
   * restore, which has to rebuild the modifier stack from a byte buffer that cannot hold object
   * references. Filling it unconditionally costs a handful of integer writes once per run.
   *
   * Widened from 64 to 128 for co-op per-slot characters: a four-player party puts each seat's character
   * base record on this list (four ids that used to be one), on top of the mode, ascension, stage and shop
   * records the list already carried. Growth records are NOT here — they are derived from character-and-
   * level on every phone — so the ceiling only has to hold four characters plus modes plus purchases, which
   * 128 clears with room to spare. If a future run ever needs more, widen here and nowhere else: everything
   * that reads the list is bounded by `modifierCount`, not by this length.
   */
  private readonly modifierWire = new Int32Array(128);
  private modifierCount = 0;
  /**
   * Each seat's growth ladder, and how far apart its steps are, indexed by slot.
   *
   * Per-slot rather than one shared ladder because in co-op every seat can be a different character with a
   * different growth quirk on a different level. A solo run fills every slot from its single character, so
   * slot 0 is identical to the shared ladder it used before — which is what keeps the determinism guard
   * bit-identical.
   *
   * Held on the run rather than looked up, because `run.ts` has no dependency on the character layer, and
   * because they survive a snapshot restore for free: the run object is reused, so the ladders are still
   * here when the stack is rebuilt from wire ids.
   */
  private readonly growthLadders: (readonly RunModifier[])[] = [[], [], [], []];
  private readonly growthEverys: number[] = [1, 1, 1, 1];
  /** How many growth steps are currently folded in, per slot. `-1` means "not established yet". */
  private readonly growthTiers = new Int32Array(MAX_PLAYERS).fill(-1);
  private readonly bombScratch = new Int32Array(1024);

  private spawnRng: Rng;
  private dropRng: Rng;
  private cardRng: Rng;
  /**
   * Per-player card draw streams, one per seat.
   *
   * Slot 0 is `this.cardRng` (`RNG_STREAMS.cardDraw`) verbatim, so every existing solo replay and
   * ladder hash draws the exact same four cards it always has — the determinism-guard test pins this.
   * Slots 1..3 are the seed-derived `cardDraw1..cardDraw3` streams, reseeded the same way every other
   * stream is (`seed ^ hashName(name)`), so they are identical on every phone and never touch a
   * wall-clock or an object-iteration order. See `sim/cards.ts` for the one-seeded-stream discipline.
   */
  private readonly cardRngs: Rng[] = [];
  private critRng: Rng;
  private arcanaRng: Rng;
  private chestRng: Rng;

  constructor(seed = 1) {
    this.rng = new RngSet(seed);
    this.spawnRng = this.rng.get("spawn");
    this.dropRng = this.rng.get("drop");
    this.cardRng = this.rng.get("cardDraw");
    this.cardRngs.push(this.cardRng);
    this.cardRngs.push(this.rng.get("cardDraw1"));
    this.cardRngs.push(this.rng.get("cardDraw2"));
    this.cardRngs.push(this.rng.get("cardDraw3"));
    this.chestRng = this.rng.get("chest");
    this.critRng = this.rng.get("crit");
    this.arcanaRng = this.rng.get("arcana");
    this.owners = { count: 1, x: this.players.x, y: this.players.y };
  }

  /** Player 0's progression. The alias every solo call site — HUD, summary, dev menu — keeps using. */
  get prog(): Progression {
    return this.progAll[0] as Progression;
  }

  /** One player's progression. Slots outside 0..MAX_PLAYERS-1 clamp to slot 0. */
  progFor(player: number): Progression {
    if (player < 0 || player >= MAX_PLAYERS) return this.progAll[0] as Progression;
    return this.progAll[player] as Progression;
  }

  /** Player 0's card draw. The alias the solo card UI and tests keep using. */
  get cards(): CardDraw {
    return this.cardsAll[0] as CardDraw;
  }

  /** One player's card draw. Slots outside 0..MAX_PLAYERS-1 clamp to slot 0. */
  cardsFor(player: number): CardDraw {
    if (player < 0 || player >= MAX_PLAYERS) return this.cardsAll[0] as CardDraw;
    return this.cardsAll[player] as CardDraw;
  }

  /**
   * True while ANY player has a screen open. The simulation is frozen for the whole party until every
   * open screen is answered.
   *
   * The co-op rule, stated once: the shared world freezes while anyone is choosing. A level-up taken
   * while the crowd closes in is not a decision, and freezing only the chooser's slot would let the
   * others keep fighting a world the chooser cannot see — and, worse, would advance the sim on some
   * phones and not others on the same tick, which is a desync. So one player's open screen stops
   * every sim step on every phone, and the tick still counts so the numbering stays shared.
   */
  get paused(): boolean {
    if (this.arcanas.open) return true;
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if ((this.cardsAll[p] as CardDraw).open) return true;
    }
    return false;
  }

  /** True while this specific player has a card screen open. Used by the host to gate each card byte. */
  pausedFor(player: number): boolean {
    if (this.arcanas.open) return true;
    if (player < 0 || player >= MAX_PLAYERS) return false;
    return (this.cardsAll[player] as CardDraw).open;
  }

  /** True while any player has a card screen open, ignoring arcanas. */
  private anyCardOpen(): boolean {
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if ((this.cardsAll[p] as CardDraw).open) return true;
    }
    return false;
  }

  /** Run clock in ticks, which time scale can advance faster than real ticks. */
  get runTicks(): number {
    return this.waves.runTicks;
  }

  get runSeconds(): number {
    return this.waves.runSeconds;
  }

  get over(): boolean {
    return this.end !== RUN_END.running;
  }

  /**
   * Start a run.
   *
   * This is the only place allowed to be expensive. Everything after it runs sixty times a second.
   */
  begin(config: Partial<RunConfig> = {}): void {
    const c: RunConfig = { ...DEFAULT_RUN_CONFIG, ...config };

    this.seed = c.seed >>> 0;
    this.stageId = c.stageId;
    const stage = stageAt(this.stageId);
    this.tainted = c.tainted;
    this.recording = c.record;
    this.autoPick = c.autoPick;
    this.timeLimitTicks = c.timeLimitTicks;
    this.ticks = 0;
    this.end = RUN_END.running;
    this.kills = 0;
    this.damageDealt = 0;
    this.revives = 0;
    this.whiteHandTicks = -1;
    this.reaperKills = 0;
    this.eggsEarned = 0;
    this.primaryCharacterId = (c.characterIds[0] ?? 0) | 0;
    this.chestsOpened = 0;
    this.evolutionsEarned = 0;
    resetChestReport(this.chestReport);

    this.reseedStreams(this.seed);

    // How many seats are in play. Resolved before the stack is folded because the character records are
    // now per-seat: a four-player party puts four survivors' shifts on one shared stat table, and which
    // seats exist decides which characters get added.
    const playerCount = Math.min(Math.max(1, c.playerCount | 0), MAX_PLAYERS);

    // Per-seat character choice, resolved once here. In solo every slot falls back to the single shared
    // `characters`/`characterGrowth`/`characterGrowthEvery`/`startingWeaponId`, so a solo run's slot 0 is
    // exactly what it was before this became per-seat — the determinism guard pins it. In co-op each seat
    // reads its own entry from the `*BySlot` arrays, which every phone agrees on because the host published
    // the roster before launch.
    for (let p = 0; p < MAX_PLAYERS; p++) {
      this.growthLadders[p] = c.characterGrowthBySlot?.[p] ?? c.characterGrowth;
      this.growthEverys[p] = Math.max(1, (c.characterGrowthEveryBySlot?.[p] ?? c.characterGrowthEvery) | 0);
      this.growthTiers[p] = 0;
    }

    // Stats first: how much health a player starts with is a resolved stat, so the modifier stack has
    // to be folded before anybody is placed on the map.
    this.stack.clear();
    this.stack.clearLoadout();
    for (let i = 0; i < c.modifiers.length; i++) this.stack.add(c.modifiers[i]);
    // Shop purchases join the same stack, deliberately after the run's own modifiers. Resolution is
    // order-independent by design, so this is only about which records get dropped first if a stack ever
    // overflows: a mode the player chose for this run matters more than a rank they bought last week.
    for (let i = 0; i < c.powerUps.length; i++) this.stack.add(c.powerUps[i]);
    // The characters join the same stack, ahead of the shop for the same overflow reason: who the players
    // picked for this run matters more than a rank they bought last week. One seat at a time, in slot
    // order, so the far side rebuilds the identical stack — and so a solo run adds exactly slot 0's
    // records once, byte-identical to before. The stat table is shared across the party (one set of
    // numbers), so every seat's shifts fold into it together; what is genuinely per-seat is the growth
    // ladder above and the starting weapon below.
    for (let p = 0; p < playerCount; p++) {
      const records = c.charactersBySlot?.[p] ?? c.characters;
      for (let i = 0; i < records.length; i++) this.stack.add(records[i]);
    }
    const resolved = this.stack.resolve(this.stats);
    this.flags = resolved.flags;
    if (resolved.tainted) this.tainted |= 1;

    this.players.reset(playerCount, this.stats, playerCount > 1 ? SPAWN_RING_RADIUS : 0);
    this.owners.count = playerCount;
    this.enemies.clear();
    this.projectiles.clear();
    this.pickups.clear();
    // Scenery is derived from the stage seed, so pointing the field at the seed is the whole of
    // placing every crate and gravestone on the map. Nothing about the floor is stored in a save.
    // How cluttered the floor is belongs to the stage: the marsh is choked with scenery and the
    // gallows is bare, and that is the whole of the difference as far as the simulation is concerned.
    this.props.setSeed(this.seed | 0, stage.propChance);
    // Streamed once here as well as in the tick, so the first frame the player ever sees already has
    // scenery standing on it instead of popping in a moment later.
    this.props.stream(this.players.x[0], this.players.y[0]);
    this.weapons.reset(playerCount);
    this.passives.reset(playerCount);
    // Every seat resets, not just the ones in play: a slot that never joins still has to hold a clean
    // progression and card draw so the snapshot's per-player fields are deterministic on every phone.
    for (let p = 0; p < MAX_PLAYERS; p++) {
      (this.progAll[p] as Progression).reset();
      (this.cardsAll[p] as CardDraw).resetRun(this.stats);
    }
    // The pool is what the profile has earned, decided outside the simulation. An empty pool means no
    // offer ever opens — the deck never invents a card to fill a screen.
    this.arcanas.begin(c.arcanaPool);
    // The stage owns its own monsters, its own pacing and its own named fights. Nothing below this
    // line asks which stage it is — a stage is a row in a table, not a special case in the code.
    this.waves.begin(wavesForStage(this.stageId), stage.reaperSecond);
    this.summary.reset();
    this.cues.resetRun();
    for (let p = 0; p < MAX_PLAYERS; p++) {
      this.prevLevel[p] = (this.progAll[p] as Progression).level;
      this.prevHealth[p] = this.players.health[p];
      this.prevUpright[p] = this.players.upright[p];
    }

    this.axes.fill(0);
    this.buttons.fill(0);

    // Each seat starts holding ITS OWN character's weapon, not one weapon handed to the whole party.
    // A solo run's one seat reads `startingWeaponId` exactly as before; a co-op seat reads its own entry,
    // falling back to the shared weapon when its slot is missing. The weapon store is already per-player,
    // so this is a grant per seat into that seat's own slot.
    for (let p = 0; p < playerCount; p++) {
      const weaponId = c.startingWeaponIdBySlot?.[p] ?? c.startingWeaponId;
      const starting = WEAPON_BY_ID.get(weaponId);
      if (starting !== undefined) this.weapons.grant(p, starting);
    }

    // Both lists go on the wire, and the shop's records go on it for the same reason the mode's do: a
    // snapshot restore, a joining guest and a server revalidating a replay all rebuild the stack from
    // these numbers and nothing else. A purchase left off the wire is a purchase that quietly stops
    // applying the moment anybody resyncs. Each seat's character base record goes on the list too — in
    // slot order, matching the order they were added to the stack — so the far side rebuilds every seat's
    // survivor, not just seat 0's. (Growth records are derived from character-and-level and are
    // deliberately absent, exactly as they were before.)
    let count = 0;
    for (let i = 0; i < c.modifiers.length && count < this.modifierWire.length; i++) {
      this.modifierWire[count++] = c.modifiers[i].wireId;
    }
    for (let i = 0; i < c.powerUps.length && count < this.modifierWire.length; i++) {
      this.modifierWire[count++] = c.powerUps[i].wireId;
    }
    for (let p = 0; p < playerCount; p++) {
      const records = c.charactersBySlot?.[p] ?? c.characters;
      for (let i = 0; i < records.length && count < this.modifierWire.length; i++) {
        this.modifierWire[count++] = records[i].wireId;
      }
    }
    this.modifierCount = count;

    if (this.recording) {
      this.recorder.begin({
        seed: this.seed,
        stageId: this.stageId,
        buildId: c.buildId,
        contentVersion: c.contentVersion,
        characterIds: c.characterIds,
        playerCount,
        modifiers: this.modifierWire,
        modifierCount: count,
        tainted: this.tainted,
        timeLimitTicks: this.timeLimitTicks,
      });
    }
  }

  /**
   * Rebuild the few things that are object references rather than numbers, after a snapshot restore.
   *
   * A snapshot is a buffer of numbers. Almost the entire simulation already *is* numbers, which is why
   * snapshotting works at all — but three things are not, and they are rebuilt here from numbers that
   * were snapshotted:
   *
   *   1. The modifier stack holds references to content records. Rebuilt from the wire ids.
   *   2. The loadout — the passives folded into the stats — is rebuilt from what each player owns,
   *      exactly the way picking a passive card rebuilds it. Never patched, always rebuilt.
   *   3. Card text is looked up from content rows, so an open card screen gets its words back.
   *
   * Resolved stats are deliberately NOT recomputed here. `stats.values` was restored byte-for-byte, and
   * recomputing would replace a known-correct number with a freshly derived one — turning any future
   * disagreement between the two into a silent behaviour change instead of a test failure. The test
   * asserts they agree; production trusts the bytes.
   *
   * Called by `restoreRun`. The registry — and the growth-ladder resolver below — are passed in rather
   * than imported so that `run.ts` keeps no dependency on the save or character layer, and the dependency
   * arrow keeps pointing one way.
   *
   * `growthByWireId`, when supplied, closes the one gap the co-op review flagged: each seat's growth ladder
   * and spacing used to be established only by `begin()`, so a phone that reached a live run WITHOUT
   * `begin()`'s per-slot config would restore correct current stats yet drift on the next growth step. The
   * ladder is not on the wire — but the character *base* record that names it is — so a resync can recover
   * the ladder from the same wire ids it already restored to the stack. Given the resolver, `rehydrate`
   * re-establishes each seat's ladder from the base record wire ids on `modifierWire`, in slot order, so
   * every path into a live run (join, resync, snapshot restore) holds the same ladders `begin()` would have.
   * Omitting it keeps the old behaviour — the run trusts the ladders `begin()` left on the object — so a
   * caller that has just called `begin()` on this same object (the shipped flow) is unaffected.
   */
  rehydrate(
    byWireId: ReadonlyMap<number, RunModifier>,
    growthByWireId?: (wireId: number) => { ladder: readonly RunModifier[]; everyLevels: number } | undefined,
  ): void {
    this.stack.clear();
    this.stack.clearLoadout();
    for (let i = 0; i < this.modifierCount; i++) {
      const mod = byWireId.get(this.modifierWire[i]);
      if (mod !== undefined) this.stack.add(mod);
    }
    // Re-establish each seat's growth ladder from the character base record wire ids on the list. The base
    // records were written in slot order at `begin()`, so walking the list and handing each one to the next
    // seat rebuilds the identical per-slot ladders — no matter whether `begin()` ran with the per-slot config
    // on this phone. A wire id that is not a character base record (a mode, a shop rank, a growth tier) is
    // skipped by the resolver, so only genuine survivor identities claim a slot.
    if (growthByWireId !== undefined) {
      let slot = 0;
      for (let i = 0; i < this.modifierCount && slot < MAX_PLAYERS; i++) {
        const found = growthByWireId(this.modifierWire[i]);
        if (found === undefined) continue;
        this.growthLadders[slot] = found.ladder;
        this.growthEverys[slot] = Math.max(1, found.everyLevels | 0);
        slot++;
      }
    }
    this.rebuildLoadout();
    // Each open per-player card screen relabels for its OWN slot, so a restored co-op run gets every
    // player's card text back from the content rows rather than only player 0's.
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const cards = this.cardsAll[p] as CardDraw;
      if (cards.open) cards.relabel(this.weapons, this.passives, p);
    }
  }

  /**
   * Copy this run's modifier wire ids into `out` and report how many were written.
   *
   * A joining guest has to be told which modifiers the run is carrying, and a network message cannot
   * carry object references — only numbers. The wire id is that number, and it is the same reason the
   * snapshot stores ids rather than objects: whoever reads it looks the id up in their own registry.
   * Writing into a caller-owned array keeps this allocation-free on the send path.
   */
  writeModifierWireIds(out: Int32Array): number {
    const n = Math.min(this.modifierCount, out.length);
    for (let i = 0; i < n; i++) out[i] = this.modifierWire[i];
    return n;
  }

  /**
   * Fold the modifier stack into a fresh set of stats and report whether it agrees with the live ones.
   *
   * This exists for one reason: to let a test prove that a restored run's stats could have been derived
   * from its restored modifiers and passives. If it ever returns false, a snapshot has restored a world
   * whose numbers do not follow from its contents, and no amount of matching state hashes would make
   * that safe.
   */
  loadoutAgreesWithStats(scratch: Stats): boolean {
    this.stack.resolve(scratch);
    for (let i = 0; i < STAT_COUNT; i++) {
      if (scratch.values[i] !== this.stats.values[i]) return false;
    }
    return true;
  }

  /** Reseed every stream to this run's seed without rebuilding the stream objects. */
  private reseedStreams(seed: number): void {
    for (let i = 0; i < RNG_STREAMS.length; i++) {
      const name = RNG_STREAMS[i];
      this.rng.get(name).reseed((seed ^ hashName(name)) >>> 0);
    }
  }

  // --- Input -------------------------------------------------------------------------------

  /**
   * Feed one player's stick. Raw analog in -1..1; quantised here and nowhere else.
   *
   * Quantising at the boundary is what lets a local run, a co-op guest and a server-side revalidation
   * all consume the identical number. If the local sim read the float and the wire carried the byte,
   * the two would part company on the first frame.
   */
  setStick(player: number, x: number, y: number): void {
    if (player < 0 || player >= MAX_PLAYERS) return;
    quantiseStick(x, y, this.axes, player * 2);
  }

  setButtons(player: number, bits: number): void {
    if (player < 0 || player >= MAX_PLAYERS) return;
    this.buttons[player] = bits & 0xff;
  }

  // --- The tick ----------------------------------------------------------------------------

  /**
   * One simulation tick. Fixed 60Hz. Does nothing when the run is over or a card screen is open.
   *
   * Returns true when the world actually advanced, so a caller can tell "paused" from "finished".
   */
  tick(): boolean {
    if (this.end !== RUN_END.running) return false;

    // The cue list is cleared before the paused check, not after it. A frame spent on a card screen
    // has no news of its own, and if the list were left standing the reader would see last tick's
    // hits and deaths again on every paused frame — twelve times over for a screen held one second.
    this.cues.beginTick();

    // A card screen owed by autoPick resolves itself here so a headless run never deadlocks — and it
    // resolves EVERY open player's screen, not just player 0's, or a headless party with two players
    // owed cards would freeze forever waiting on the second one.
    let anyCardOpen = false;
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if ((this.cardsAll[p] as CardDraw).open) {
        anyCardOpen = true;
        if (this.autoPick) this.pickCard(0, p);
      }
    }
    if (anyCardOpen) return false;

    // An arcana offer freezes the run exactly like a card screen does, and for the same reason: it is a
    // decision, and a decision taken while the crowd is closing in is not a decision.
    if (this.arcanas.open) {
      if (this.autoPick) this.pickArcana(0);
      return false;
    }

    const stats = this.stats;
    const players = this.players;

    // 1. Progression opens the tick — every player's, so each seat's per-tick gain counters reset.
    for (let p = 0; p < players.count; p++) (this.progAll[p] as Progression).beginTick();

    // 2. The input log records what the simulation is about to consume — after quantisation, never
    //    before, or the log would replay to a slightly different run.
    if (this.recording) this.recorder.recordTick(this.axes, this.buttons);

    // 3. Apply input. Deadzone lives in the deterministic path, not in the UI.
    for (let p = 0; p < players.count; p++) {
      const ax = this.axes[p * 2];
      const ay = this.axes[p * 2 + 1];
      const dx = ax > 12 || ax < -12 ? ax / 127 : 0;
      const dy = ay > 12 || ay < -12 ? ay / 127 : 0;
      players.setMove(p, dx, dy);
    }

    // 4. The clock and the spawner. Time scale lives inside here, which is the whole of Hurry.
    const upright = players.writeTargets(this.targetX, this.targetY);
    this.waves.update(
      this.enemies,
      stats,
      this.spawnRng,
      this.targetX[0],
      this.targetY[0],
      (this.flags & RUN_FLAG.endless) !== 0,
    );

    // 5. The Reaper, and the ending it brings with it.
    this.tickReaper();

    // 6. The crowd moves. Separation reads last tick's grid on purpose — it is steering, and a
    //    one-tick-old neighbour list is invisible, while a second rebuild per tick is not free.
    this.enemies.update(this.targetX, this.targetY, upright, stats);

    // 7. Rebuild the grid once, now: after the crowd moved and after this tick's spawns landed, so
    //    every damage test below reads real positions.
    this.enemies.rebuildGrid();

    // 8. Weapons fire, projectiles move and collide. Stats are read at fire time, not pickup time.
    this.weapons.update(
      this.owners as OwnerPositions,
      players.aimX,
      players.aimY,
      players.upright,
      this.enemies,
      this.projectiles,
      stats,
      this.critRng,
    );
    this.projectiles.update(this.owners as OwnerPositions, this.enemies, stats, this.critRng);

    // 8b. Scenery. Streamed, smashed by whatever the weapons put on the floor, and paid out. Props
    //     are not enemies: they do not move, do not block, do not hurt anybody, and are not in the
    //     enemy grid. They only ever hand out pickups, which is why they can sit at the end of the
    //     weapon step rather than inside it.
    this.tickScenery();

    // 9. Drain this tick's damage and death events into totals and loot.
    this.drainCombatEvents();

    // 10. Pickups: scatter, magnet, collection.
    this.pickups.update(players, stats, this.critRng);
    this.applyCollections();

    // 11. A level-up screen opens between ticks, never in the middle of one. Run per player: each
    //     seat announces its own level-ups, earns its own growth step, and opens its own card screen
    //     from its own card RNG onto its own weapon/passive store.
    let growthChanged = false;
    for (let p = 0; p < players.count; p++) {
      const prog = this.progAll[p] as Progression;
      if (prog.level > this.prevLevel[p]) {
        for (let l = this.prevLevel[p] + 1; l <= prog.level; l++) {
          this.cues.emit(CUE.levelUp, players.x[p], players.y[p], l, p);
        }
        this.prevLevel[p] = prog.level;
        // A level can earn THAT SEAT's next growth step. Each seat climbs its own character's ladder off
        // its own level, so a level-up on one seat only rebuilds the loadout when that seat's tier
        // actually moved. Guard the rebuild so an ordinary level-up costs one integer division rather than
        // a full resolve. A solo run has one seat on slot 0's ladder, byte-identical to before.
        if (this.growthTierAt(p, prog.level) !== this.growthTiers[p]) growthChanged = true;
      }
    }
    if (growthChanged) {
      this.rebuildLoadout();
      this.stack.resolve(this.stats);
    }

    for (let p = 0; p < players.count; p++) {
      const prog = this.progAll[p] as Progression;
      if (!prog.owesCards) continue;
      const cards = this.cardsAll[p] as CardDraw;
      cards.beginScreen(p, prog, this.weapons, this.passives, stats, this.cardRngs[p] as Rng, this.flags);
      if (cards.open) {
        this.cues.emit(CUE.cardScreenOpened, players.x[p], players.y[p], cards.picksRemaining, p);
      }
    }

    // 11b. Arcana offers are owed by the run clock, not by levelling, so they are checked after the card
    //      screen rather than inside it — a level-up and an arcana mark landing on the same tick queue up
    //      one behind the other instead of fighting over the screen. The deck compares with `>=` and
    //      consumes the mark, so a mark passed during a card screen is still owed rather than skipped.
    if (!this.anyCardOpen() && this.arcanas.update(this.waves.runSeconds, this.arcanaRng)) {
      this.cues.emit(CUE.cardScreenOpened, players.x[0], players.y[0], this.arcanas.offerCount);
    }

    // 12. Players last: movement resolution, regen, contact damage, downs and revives. Contact
    //     damage comes after the crowd has moved, so a player is hurt by where enemies *are*.
    players.update(stats, this.enemies);
    this.announcePlayerChanges();

    // 13. Heals owed by cards are applied outside the card screen, so a meal taken during a batch
    //     of eight picks still lands exactly once. Each player's own food card heals that player.
    for (let p = 0; p < players.count; p++) {
      const cards = this.cardsAll[p] as CardDraw;
      if (cards.healPending > 0) {
        players.heal(p, cards.healPending, stats);
        cards.clearHeal();
      }
    }

    this.ticks++;

    // 14. Did the run end?
    this.checkEnd();
    return true;
  }

  /**
   * Bring scenery in, let the weapons break it, and turn every break into pickups on the floor.
   *
   * WHY PROJECTILES AND NOT "WEAPON DAMAGE"
   * A prop is broken by something visibly touching it, and in this engine everything a weapon puts
   * into the world is a projectile — a knife, a whip's arc, an aura. Reading positions out of the
   * projectile store means scenery needs no cooperation from any weapon, so a new weapon breaks
   * crates on the day it is added without anybody remembering to wire it up.
   *
   * WHY THE BREAKS ARE PAID BEFORE THE REPORT IS CLEARED
   * The break report is a fixed-size list. It is read and paid in the same tick it was written and
   * cleared immediately afterwards, so a row can never be seen twice and loot can never double.
   */
  private tickScenery(): void {
    const props = this.props;
    const players = this.players;

    if (this.ticks % PROP_STREAM_EVERY === 0) props.stream(players.x[0], players.y[0]);
    props.update();
    props.rebuildGrid();

    const proj = this.projectiles;
    const pSlots = proj.pool.slots;
    const pCount = proj.pool.count;
    for (let i = 0; i < pCount; i++) {
      const ps = pSlots[i];
      const px = proj.x[ps];
      const py = proj.y[ps];
      const pr = proj.radius[ps];
      const found = props.queryNear(px, py, pr + MAX_PROP_RADIUS + PROP_HIT_PAD);
      for (let j = 0; j < found; j++) {
        const slot = props.neighbourScratch[j];
        if (props.hitAge[slot] < PROP_HIT_COOLDOWN) continue;
        const dx = props.x[slot] - px;
        const dy = props.y[slot] - py;
        const reach = pr + props.radius[slot] + PROP_HIT_PAD;
        if (dx * dx + dy * dy > reach * reach) continue;
        const bx = props.x[slot];
        const by = props.y[slot];
        const kind = props.typeIndex[slot];
        if (props.damageAt(slot, 1)) this.cues.emit(CUE.propBroken, bx, by, kind);
      }
    }

    payOutBreaks(props, this.pickups, this.stats, this.dropRng);
    props.resetBreaks();
  }

  /**
   * Spawn Reapers when due, and run the White Hand countdown once a Reaper has been killed.
   *
   * Arrival does NOT start the Hand — that was the bug that ended every run ~12s after the first
   * spawn and made "+1 per minute" and "kill for eggs" impossible. The Hand starts on a kill.
   */
  private tickReaper(): void {
    if (this.whiteHandTicks >= 0) {
      this.whiteHandTicks--;
      // Twelve tolls, one per second, counted up so the audio layer knows which toll it is playing.
      if (this.whiteHandTicks > 0 && this.whiteHandTicks % TICKS_PER_SECOND === 0) {
        const toll = 12 - Math.trunc(this.whiteHandTicks / TICKS_PER_SECOND);
        this.cues.emit(CUE.bellTolled, this.players.x[0], this.players.y[0], toll);
      }
      if (this.whiteHandTicks <= 0) this.finish(RUN_END.whiteHand);
      return;
    }
    if (!this.waves.reaperDue(this.stats, (this.flags & RUN_FLAG.earlyReaper) !== 0)) return;

    this.waves.noteReaperSpawned();
    this.cues.emit(CUE.reaperArrived, this.players.x[0], this.players.y[0]);
    const type = ENEMY_TYPE_BY_ID.get(REAPER_ENEMY_ID);
    if (type !== undefined) {
      // Spawn above the player, same place the original Reaper used — readable, not on top of them.
      this.enemies.spawn(type, this.players.x[0], this.players.y[0] - 120, this.stats);
    }
    // Deliberately no White Hand here. Fight, flee, or die — the Hand waits for a kill.
  }

  /**
   * Test helper: kill every live nightreaper through the combat drain path.
   *
   * Headless tests cannot aim weapons reliably at a 900hp boss in one tick, so they call this after
   * spawning. Production code never calls it.
   */
  forceKillReapersForTest(): void {
    const type = ENEMY_TYPE_BY_ID.get(REAPER_ENEMY_ID);
    if (type === undefined) return;
    const slots = this.enemies.slots;
    const doomed: number[] = [];
    for (let i = 0; i < this.enemies.count; i++) {
      const s = slots[i] as number;
      if (this.enemies.typeIndex[s] === type) doomed.push(s);
    }
    for (const s of doomed) {
      const x = this.enemies.x[s] as number;
      const y = this.enemies.y[s] as number;
      this.enemies.kill(s);
      this.onReaperKilled(x, y);
    }
  }

  /** Shared kill payoff: eggs, unlock fact, and the White Hand. */
  private onReaperKilled(x: number, y: number): void {
    this.reaperKills++;
    this.eggsEarned += EGGS_PER_REAPER_KILL;
    this.kills++;
    this.cues.emit(CUE.bossDied, x, y, ENEMY_TYPE_BY_ID.get(REAPER_ENEMY_ID) ?? 0);
    // First kill this run starts the Hand. Further kills during the countdown still pay eggs.
    if (this.whiteHandTicks < 0) {
      this.whiteHandTicks = WHITE_HAND_TICKS;
    }
  }

  /** Fold this tick's hits and deaths into run totals, and turn deaths into loot. */
  private drainCombatEvents(): void {
    const proj = this.projectiles;

    for (let i = 0; i < proj.hitCount; i++) {
      this.damageDealt += proj.hitAmount[i];
      this.cues.emit(CUE.hit, proj.hitX[i], proj.hitY[i], proj.hitAmount[i], proj.hitCrit[i]);
    }

    const kills = proj.killCount;
    const reaperType = ENEMY_TYPE_BY_ID.get(REAPER_ENEMY_ID);
    for (let i = 0; i < kills; i++) {
      const type = proj.killType[i];
      // Reaper kills take the special path: eggs + White Hand. They still count as kills.
      if (reaperType !== undefined && type === reaperType) {
        this.onReaperKilled(proj.killX[i], proj.killY[i]);
        // Eggs are meta, not floor loot — no rollDrops. The bossDied cue is emitted inside onReaperKilled.
        continue;
      }
      const boss = (ENEMY_TYPES[type].flags & ENEMY_FLAG.boss) !== 0;
      this.cues.emit(
        boss ? CUE.bossDied : CUE.enemyDied,
        proj.killX[i],
        proj.killY[i],
        type,
      );
      rollDrops(
        this.pickups,
        boss ? BOSS_DROP_RULE : DEFAULT_DROP_RULE,
        proj.killX[i],
        proj.killY[i],
        this.stats,
        this.dropRng,
      );
      this.kills++;
    }
  }

  /** Apply everything collected this tick. Collection is an event; this is where it takes effect. */
  private applyCollections(): void {
    const pickups = this.pickups;
    const stats = this.stats;

    // Experience and coins are credited to the player who actually collected the gem or coin, so each
    // seat levels on its own pickups rather than pouring the whole party's experience into player 0.
    // The gold cue still fires from player 0's position and reports the party-wide total, because the
    // coin flash is a single HUD readout for the run, not a per-player event.
    for (let p = 0; p < this.players.count; p++) {
      const xp = pickups.xpBankedBy[p];
      if (xp > 0) {
        (this.progAll[p] as Progression).addXp(xp, stats);
        this.cues.emit(CUE.xpCollected, this.players.x[p], this.players.y[p], xp, p);
      }
      const gold = pickups.goldBankedBy[p];
      if (gold > 0) (this.progAll[p] as Progression).addGold(gold, stats);
    }
    if (pickups.goldBanked > 0) {
      this.cues.emit(CUE.goldCollected, this.players.x[0], this.players.y[0], pickups.goldBanked);
    }
    if (pickups.vacuumsTaken > 0) pickups.startVacuum();

    if (pickups.collectCount === 0) return;

    // Health and bombs are per-player events: which player picked it up decides who it affects.
    for (let i = 0; i < pickups.collectCount; i++) {
      const kind = pickups.collectKind[i];
      const who = pickups.collectPlayer[i];
      this.cues.emit(CUE.pickupTaken, pickups.collectX[i], pickups.collectY[i], kind, who);
      if (kind === PICKUP.health) {
        this.players.heal(who, pickups.collectValue[i], stats);
      } else if (kind === PICKUP.bomb) {
        this.detonate(pickups.collectX[i], pickups.collectY[i]);
      } else if (kind === PICKUP.chest) {
        // Opened for whoever walked into it. In co-op a chest is not shared: the upgrades go into one
        // player's loadout, and pretending otherwise would mean deciding whose build to change.
        this.openChestFor(who, pickups.collectX[i], pickups.collectY[i]);
      }
    }
  }

  /**
   * Open one chest for one player.
   *
   * The decision of what is inside lives in `chests.ts`; this is only the part that has to touch the
   * rest of the run — banking coins for rewards that could not be given, rebuilding the modifier stack
   * when a passive changed, and telling the presentation layer that something happened. The chest
   * stream is used rather than the drop stream so that retuning what enemies drop can never change
   * what a chest in a replay contained.
   */
  private openChestFor(player: number, x: number, y: number): void {
    if (player < 0 || player >= this.players.count) {
      // No loadout to put anything into. Pay coins rather than eat the chest — to player 0, since
      // there is no valid opener to credit.
      this.prog.addGold(CHEST_GOLD, this.stats);
      this.cues.emit(CUE.chestOpened, x, y);
      return;
    }

    // Coins from the chest go to the player who opened it, the same rule the gems follow.
    const prog = this.progAll[player] as Progression;
    const report = this.chestReport;
    openChest(player, this.weapons, this.passives, this.stats, this.chestRng, report);
    this.chestsOpened++;

    let passiveChanged = false;
    for (let r = 0; r < report.count; r++) {
      const kind = report.kind[r];
      if (kind === CHEST_REWARD.gold) {
        prog.addGold(report.value[r], this.stats);
      } else if (kind === CHEST_REWARD.passiveLevel) {
        passiveChanged = true;
      } else if (kind === CHEST_REWARD.evolution) {
        this.evolutionsEarned++;
      }
    }
    // Rebuilt from what the player owns rather than patched, for the same reason a card pick is.
    if (passiveChanged) {
      this.passives.applyTo(this.stack, player);
      this.stack.resolve(this.stats);
    }

    this.cues.emit(CUE.chestOpened, x, y, report.count, player);
  }

  /** Clear the crowd around a point, and pay out for everything it killed. */
  private detonate(x: number, y: number): void {
    this.cues.emit(CUE.bombDetonated, x, y, BOMB_RADIUS);
    const found = this.enemies.queryNear(x, y, BOMB_RADIUS);
    const scratch = this.enemies.neighbourScratch;
    const limit = Math.min(found, this.bombScratch.length);
    for (let i = 0; i < limit; i++) this.bombScratch[i] = scratch[i];
    for (let i = 0; i < limit; i++) {
      const slot = this.bombScratch[i];
      const ex = this.enemies.x[slot];
      const ey = this.enemies.y[slot];
      if (this.enemies.damageAt(slot, BOMB_DAMAGE)) {
        this.kills++;
        this.cues.emit(CUE.enemyDied, ex, ey, this.enemies.typeIndex[slot]);
        rollDrops(this.pickups, DEFAULT_DROP_RULE, ex, ey, this.stats, this.dropRng);
      }
    }
  }

  /**
   * Turn "health is different from last tick" into events.
   *
   * Done by comparison rather than by the player store calling us, so `player.ts` stays a system that
   * knows nothing about audio and can still be tested entirely on its own.
   */
  private announcePlayerChanges(): void {
    const players = this.players;
    for (let p = 0; p < players.count; p++) {
      const now = players.health[p];
      const was = this.prevHealth[p];
      if (now < was) this.cues.emit(CUE.playerHurt, players.x[p], players.y[p], was - now, p);
      else if (now > was) this.cues.emit(CUE.playerHealed, players.x[p], players.y[p], now - was, p);
      this.prevHealth[p] = now;

      const up = players.upright[p];
      if (up !== this.prevUpright[p]) {
        if (up === 0) {
          this.cues.emit(CUE.playerDowned, players.x[p], players.y[p], 0, p);
        } else {
          this.revives++;
          this.cues.emit(CUE.playerRevived, players.x[p], players.y[p], 0, p);
        }
        this.prevUpright[p] = up;
      }
    }
  }

  /** Decide whether the run is over, and why. */
  private checkEnd(): void {
    if (this.end !== RUN_END.running) return;
    if (this.players.runOver) {
      // Dying after the Reaper has arrived is a stage clear — you lasted the night. The White Hand
      // is reserved for the kill path; a silent defeat at 30:01 would be the wrong reading.
      this.finish(this.waves.reaperSpawned ? RUN_END.survived : RUN_END.defeat);
      return;
    }
    if (this.timeLimitTicks > 0 && this.waves.runTicks >= this.timeLimitTicks) {
      this.finish(RUN_END.survived);
    }
  }

  // --- Card screen -------------------------------------------------------------------------

  pickCard(index: number, player = 0): boolean {
    const took = (this.cardsAll[player] as CardDraw).pick(
      index,
      player,
      this.weapons,
      this.passives,
      this.progAll[player] as Progression,
      this.stats,
      this.stack,
      this.cardRngs[player] as Rng,
    );
    // A passive pick rebuilds the loadout from scratch, which throws the character's growth record away with
    // everything else in it. Putting it back here — rather than trusting the card layer to know about
    // characters — means there is one place that owns what the loadout contains. The loadout is shared
    // across the party (one stat table), so any player's passive pick rebuilds it.
    if (took) this.restoreGrowthAfterPick();
    return took;
  }

  /**
   * Put the growth record back into the loadout and re-resolve, if a card pick cleared it.
   *
   * Cheap when there is nothing to do: no ladder, or no step earned yet, and this returns without touching
   * the stats table. When there is, it rebuilds rather than patches, for the same reason a snapshot restore
   * rebuilds the loadout: a patched list can disagree with what a fresh rebuild would produce, and that
   * disagreement is invisible until two devices compare state hashes.
   */
  private restoreGrowthAfterPick(): void {
    // Nothing to put back only when no seat has earned a step yet. As soon as any seat is on its ladder, a
    // rebuild is the safe move — it re-adds every seat's growth from its own level, so one seat's card pick
    // cannot quietly drop another seat's growth.
    let anyStep = false;
    for (let p = 0; p < this.players.count; p++) if (this.growthTiers[p] > 0) anyStep = true;
    if (!anyStep) return;
    this.rebuildLoadout();
    this.stack.resolve(this.stats);
  }

  /**
   * Rebuild the loadout list: every player's passives, then EACH SEAT's own growth step.
   *
   * Order inside the list does not matter — resolution is order-independent by design — but rebuilding in one
   * place does, because `passives.applyTo` clears the whole list on every call. Anything that lives in the
   * loadout has to be re-added by whoever calls it, and this is that whoever.
   *
   * Growth is per seat: each seat's tier is read off ITS character's ladder and ITS own level, and every
   * seat's earned rung is added to the one shared loadout. A solo run has a single seat on slot 0's ladder,
   * so the list it builds is identical to before.
   */
  private rebuildLoadout(): void {
    for (let p = 0; p < this.players.count; p++) this.passives.applyTo(this.stack, p);
    for (let p = 0; p < this.players.count; p++) {
      const level = (this.progAll[p] as Progression).level;
      const tier = this.growthTierAt(p, level);
      this.growthTiers[p] = tier;
      if (tier > 0) this.stack.addLoadout((this.growthLadders[p] as readonly RunModifier[])[tier - 1]);
    }
    // Arcanas last, and rebuilt with everything else rather than added once when taken: `applyTo` on the
    // passive store clears the whole loadout, so anything that lives there has to be put back by the one
    // function that owns what the loadout contains.
    this.arcanas.applyTo(this.stack);
  }

  // --- Arcana offers -----------------------------------------------------------------------

  /**
   * Take the arcana in `slot`. Returns which arcana was taken, or -1 when the slot is not a real offer.
   *
   * The loadout is rebuilt and re-resolved rather than patched, for the same reason a card pick and a
   * snapshot restore rebuild it: a patched stat table can disagree with a freshly derived one, and that
   * disagreement is invisible until two devices compare state hashes hours later.
   */
  pickArcana(slot: number): number {
    const took = this.arcanas.take(slot);
    if (took < 0) return -1;
    this.rebuildLoadout();
    this.stack.resolve(this.stats);
    return took;
  }

  /** Refuse the offer on screen. The mark is spent — an arcana turned down is turned down. */
  closeArcanaOffer(): void {
    this.arcanas.close();
  }

  /** OR of every held arcana's rule bits. The one integer the rest of the simulation reads. */
  get arcanaFlags(): number {
    return this.arcanas.flags;
  }

  /**
   * How many growth steps a seat's level has earned, clamped to that seat's character's ladder.
   *
   * Per seat because every seat can be a different character on a different level. A solo run asks this for
   * slot 0 with slot 0's ladder and `everyLevels`, which is exactly the single-ladder arithmetic it did
   * before.
   */
  private growthTierAt(player: number, level: number): number {
    const ladder = this.growthLadders[player] as readonly RunModifier[] | undefined;
    if (ladder === undefined || ladder.length === 0) return 0;
    const every = this.growthEverys[player] ?? 1;
    const steps = Math.floor((Math.max(1, level | 0) - 1) / Math.max(1, every));
    return Math.min(steps, ladder.length);
  }

  rerollCards(player = 0): boolean {
    return (this.cardsAll[player] as CardDraw).reroll(
      player,
      this.weapons,
      this.passives,
      this.cardRngs[player] as Rng,
    );
  }

  skipCard(player = 0): boolean {
    return (this.cardsAll[player] as CardDraw).skip(
      player,
      this.weapons,
      this.passives,
      this.cardRngs[player] as Rng,
    );
  }

  banishCard(index: number, player = 0): boolean {
    return (this.cardsAll[player] as CardDraw).banish(
      index,
      player,
      this.weapons,
      this.passives,
      this.cardRngs[player] as Rng,
    );
  }

  // --- Ending ------------------------------------------------------------------------------

  /** Player asked to leave. Still banks gold and time played, because it was still played. */
  quit(): RunSummary {
    return this.finish(RUN_END.quit);
  }

  /**
   * Close the run out: write the summary, close the input log.
   *
   * Calling it twice is harmless and returns the same summary, because a UI that fires both "you
   * died" and "you quit" in the same frame must not produce two different records of one run.
   */
  finish(end: RunEnd): RunSummary {
    if (this.end !== RUN_END.running) return this.summary;
    this.end = end;
    this.cues.emit(CUE.runEnded, this.players.x[0], this.players.y[0], end);

    const t = this.totals;
    t.kills = this.kills;
    t.damageDealt = Math.trunc(this.damageDealt);
    t.downs = this.players.downs;
    t.revives = this.revives;
    t.screensShown = this.cards.screensShown;
    t.picksMade = this.cards.picksMade;
    t.stageId = this.stageId;
    t.seed = this.seed;
    t.tainted = this.tainted;

    summariseRun(
      this.summary,
      end,
      this.waves.runTicks,
      0,
      this.players,
      this.weapons,
      this.prog,
      t,
    );
    this.summary.eggsEarned = this.eggsEarned;
    this.summary.reaperKills = this.reaperKills;
    this.summary.characterId = this.primaryCharacterId;

    if (this.recording) this.recorder.end(this.hashState(0x811c9dc5));
    return this.summary;
  }

  // --- Determinism -------------------------------------------------------------------------

  /**
   * Mix the whole world into one number.
   *
   * Only simulation state, in a fixed order, read from pool order rather than from any iteration of
   * object keys. Anything device-specific in here would make every healthy session look desynced.
   */
  hashState(hash: number): number {
    let h = hashWord(hash, this.ticks);
    h = hashWord(h, this.waves.runTicks);
    h = hashWord(h, this.end);

    const players = this.players;
    h = hashByte(h, players.count);
    h = hashFloat32Range(h, players.x, 0, players.count);
    h = hashFloat32Range(h, players.y, 0, players.count);
    h = hashFloat32Range(h, players.health, 0, players.count);
    h = hashUint8Range(h, players.upright, 0, players.count);

    // Entity stores are hashed ORDER-INDEPENDENTLY.
    //
    // WHY, AND WHY IT IS NOT JUST DENSE ORDER
    // `pool.slots` is the pool's dense list of live slots, and its order is a function of the
    // free/alloc history, not of the world: `freeSlot` swap-removes, so two clients that agree on
    // exactly which entities are alive can still hold the same slots in a different dense order —
    // and after a resync or a restore they can even land the SAME world on a DIFFERENT set of
    // slots. Folding entities into the running hash in dense order therefore invents a desync
    // between two phones that actually agree, and the odds of that grow with slot churn (i.e. with
    // run length — worst exactly where Endless lives).
    //
    // THE FIX: build a self-contained per-entity digest (seeded from a fixed constant, with the
    // entity's slot mixed in first, then its fields exactly as before) and COMBINE the digests
    // with unsigned 32-bit addition, which is commutative — so iteration order cannot matter.
    // Folding the slot into each digest is what stops the commutative combine's cancellation
    // weakness: two identical entities in different slots produce different digests and so do not
    // annihilate under addition. This allocates NOTHING (no scratch buffer, no sort), which is the
    // only safe shape in a per-tick hot path under the engine's no-allocation-inside-a-tick rule.
    //
    // The slot mixed in is the RAW slot index `s`, never the packed handle: a handle carries a
    // per-slot generation counter, and a resynced client and a fresh one reach the same world with
    // different generation counts, which would reintroduce exactly the divergence we are removing.
    // The slot index is the entity's within-tick identity (every field array is indexed by it), so
    // it is the right stable key and it is generation-free.
    //
    // Props (below) stay as they are: their positions come out of the stage seed identically on
    // every device and their pool barely churns, so they were never exposed to this.
    const enemies = this.enemies;
    const eSlots = enemies.pool.slots;
    const eCount = enemies.pool.count;
    let eAcc = 0;
    for (let i = 0; i < eCount; i++) {
      const s = eSlots[i] as number;
      let d = hashWord(0x9e3779b1, s);
      d = hashFloat(d, enemies.x[s] as number);
      d = hashFloat(d, enemies.y[s] as number);
      d = hashFloat(d, enemies.health[s] as number);
      eAcc = (eAcc + d) >>> 0;
    }
    h = hashWord(h, eCount);
    h = hashWord(h, eAcc);

    const proj = this.projectiles;
    const pSlots = proj.pool.slots;
    const pCount = proj.pool.count;
    let pAcc = 0;
    for (let i = 0; i < pCount; i++) {
      const s = pSlots[i] as number;
      let d = hashWord(0x9e3779b1, s);
      d = hashFloat(d, proj.x[s] as number);
      d = hashFloat(d, proj.y[s] as number);
      d = hashWord(d, proj.ttl[s] as number);
      pAcc = (pAcc + d) >>> 0;
    }
    h = hashWord(h, pCount);
    h = hashWord(h, pAcc);

    const pick = this.pickups;
    const kSlots = pick.pool.slots;
    const kCount = pick.pool.count;
    let kAcc = 0;
    for (let i = 0; i < kCount; i++) {
      const s = kSlots[i] as number;
      let d = hashWord(0x9e3779b1, s);
      d = hashFloat(d, pick.x[s] as number);
      d = hashFloat(d, pick.y[s] as number);
      d = hashFloat(d, pick.value[s] as number);
      kAcc = (kAcc + d) >>> 0;
    }
    h = hashWord(h, kCount);
    h = hashWord(h, kAcc);

    // Scenery folds in as integers only — which cells are still standing and how many were broken.
    // Prop positions come out of the stage seed identically on every device, so hashing a float here
    // would only ever invent a disagreement between two phones that actually agree.
    h = this.props.hashInto(h);

    // Per-player progression. Hashed for every live seat, in slot order, so a guest that levelled a
    // fraction differently from the host is caught on the very next hash rather than hours later.
    //
    // Solo hashes EXACTLY as before: with a single player this folds in player 0's level/xp/gold/
    // pending in the same order the old single-progression hash used, so existing replays and the
    // ladder revalidation boundary do not shift by a bit. Card-open state is deliberately NOT hashed:
    // it is derived (the sim freezes identically on every phone while a screen is up, and a pick's
    // effect already shows in the weapon/passive/level state that is hashed), and adding it would move
    // the solo hash and invalidate every replay recorded before this change.
    for (let p = 0; p < players.count; p++) {
      const prog = this.progAll[p] as Progression;
      h = hashWord(h, prog.level);
      h = hashWord(h, prog.xp);
      h = hashWord(h, prog.gold);
      h = hashWord(h, prog.pending);
    }
    h = hashWord(h, this.kills);
    // Chests opened is simulation state: it is how many times the loadout was changed by something
    // other than a card, and two devices disagreeing about it is a desync worth catching.
    h = hashWord(h, this.chestsOpened);

    for (let p = 0; p < players.count; p++) {
      for (let i = 0; i < 6; i++) {
        h = hashWord(h, this.weapons.typeIndex[p * 6 + i] as number);
        h = hashWord(h, this.weapons.level[p * 6 + i] as number);
        h = hashWord(h, this.weapons.timer[p * 6 + i] as number);
      }
    }

    return h;
  }

  /** Human-readable one-liner for the dev menu and for test failures. */
  describe(): string {
    const seconds = Math.trunc(this.waves.runSeconds);
    return `t=${seconds}s lvl=${this.prog.level} enemies=${this.enemies.count} proj=${this.projectiles.count} gems=${this.pickups.pool.count} kills=${this.kills} hp=${Math.round(this.players.health[0])}/${Math.round(this.stats.get(STAT.maxHealth) / STAT_SCALE)}`;
  }
}
