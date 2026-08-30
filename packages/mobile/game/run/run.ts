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
import { ENEMY_FLAG, ENEMY_TYPES, ENEMY_TYPE_BY_ID, EnemyStore } from "../sim/enemies";
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
import { STAT, STAT_COUNT, STAT_SCALE, Stats } from "../sim/stats";
import { stageAt, wavesForStage } from "../sim/stages";
import { TICKS_PER_SECOND, WaveDirector } from "../sim/waves";
import { WEAPON_BY_ID, WeaponStore } from "../sim/weapons";
import { RNG_STREAMS, Rng, RngSet, hashName } from "../core/rng";

/** Where the players stand at the start of a co-op run, so four of them do not begin overlapping. */
export const SPAWN_RING_RADIUS = 12;

/**
 * How long the White Hand takes to close after the Reaper is due.
 *
 * Twelve seconds, because the bell tolls twelve times. The run is already over at this point — this
 * window exists so the ending is a moment rather than a cut to a results screen.
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

/** Enemy the Reaper uses until it gets its own record in Phase 4. */
const REAPER_ENEMY_ID = "gravewarden";

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
  readonly prog = new Progression();
  readonly cards = new CardDraw();
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
  private prevLevel = 1;
  /**
   * The run's modifiers as wire ids, filled at `begin` whether or not the run is being recorded.
   *
   * Two things need these numbers rather than the records themselves: the replay header, and a snapshot
   * restore, which has to rebuild the modifier stack from a byte buffer that cannot hold object
   * references. Filling it unconditionally costs a handful of integer writes once per run.
   */
  private readonly modifierWire = new Int32Array(64);
  private modifierCount = 0;
  /**
   * The chosen character's growth ladder, and how far apart its steps are.
   *
   * Held on the run rather than looked up, because `run.ts` has no dependency on the character layer, and
   * because it survives a snapshot restore for free: the run object is reused, so the ladder is still here
   * when the stack is rebuilt from wire ids.
   */
  private growthLadder: readonly RunModifier[] = [];
  private growthEvery = 1;
  /** How many growth steps are currently folded into the loadout. `-1` means "not established yet". */
  private growthTier = -1;
  private readonly bombScratch = new Int32Array(1024);

  private spawnRng: Rng;
  private dropRng: Rng;
  private cardRng: Rng;
  private critRng: Rng;
  private arcanaRng: Rng;
  private chestRng: Rng;

  constructor(seed = 1) {
    this.rng = new RngSet(seed);
    this.spawnRng = this.rng.get("spawn");
    this.dropRng = this.rng.get("drop");
    this.cardRng = this.rng.get("cardDraw");
    this.chestRng = this.rng.get("chest");
    this.critRng = this.rng.get("crit");
    this.arcanaRng = this.rng.get("arcana");
    this.owners = { count: 1, x: this.players.x, y: this.players.y };
  }

  /** True while a level-up screen is open. The simulation is frozen until it is answered. */
  get paused(): boolean {
    return this.cards.open || this.arcanas.open;
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
    this.chestsOpened = 0;
    this.evolutionsEarned = 0;
    resetChestReport(this.chestReport);

    this.reseedStreams(this.seed);

    // Stats first: how much health a player starts with is a resolved stat, so the modifier stack has
    // to be folded before anybody is placed on the map.
    this.stack.clear();
    this.stack.clearLoadout();
    for (let i = 0; i < c.modifiers.length; i++) this.stack.add(c.modifiers[i]);
    // Shop purchases join the same stack, deliberately after the run's own modifiers. Resolution is
    // order-independent by design, so this is only about which records get dropped first if a stack ever
    // overflows: a mode the player chose for this run matters more than a rank they bought last week.
    for (let i = 0; i < c.powerUps.length; i++) this.stack.add(c.powerUps[i]);
    // The character joins the same stack, ahead of the shop for the same overflow reason: who the player
    // picked for this run matters more than a rank they bought last week.
    for (let i = 0; i < c.characters.length; i++) this.stack.add(c.characters[i]);
    this.growthLadder = c.characterGrowth;
    this.growthEvery = Math.max(1, c.characterGrowthEvery | 0);
    this.growthTier = 0;
    const resolved = this.stack.resolve(this.stats);
    this.flags = resolved.flags;
    if (resolved.tainted) this.tainted |= 1;

    const playerCount = Math.min(Math.max(1, c.playerCount | 0), MAX_PLAYERS);
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
    this.prog.reset();
    this.cards.resetRun(this.stats);
    // The pool is what the profile has earned, decided outside the simulation. An empty pool means no
    // offer ever opens — the deck never invents a card to fill a screen.
    this.arcanas.begin(c.arcanaPool);
    // The stage owns its own monsters, its own pacing and its own named fights. Nothing below this
    // line asks which stage it is — a stage is a row in a table, not a special case in the code.
    this.waves.begin(wavesForStage(this.stageId), stage.reaperSecond);
    this.summary.reset();
    this.cues.resetRun();
    this.prevLevel = this.prog.level;
    for (let p = 0; p < MAX_PLAYERS; p++) {
      this.prevHealth[p] = this.players.health[p];
      this.prevUpright[p] = this.players.upright[p];
    }

    this.axes.fill(0);
    this.buttons.fill(0);

    const starting = WEAPON_BY_ID.get(c.startingWeaponId);
    if (starting !== undefined) {
      for (let p = 0; p < playerCount; p++) this.weapons.grant(p, starting);
    }

    // Both lists go on the wire, and the shop's records go on it for the same reason the mode's do: a
    // snapshot restore, a joining guest and a server revalidating a replay all rebuild the stack from
    // these numbers and nothing else. A purchase left off the wire is a purchase that quietly stops
    // applying the moment anybody resyncs.
    let count = 0;
    for (let i = 0; i < c.modifiers.length && count < this.modifierWire.length; i++) {
      this.modifierWire[count++] = c.modifiers[i].wireId;
    }
    for (let i = 0; i < c.powerUps.length && count < this.modifierWire.length; i++) {
      this.modifierWire[count++] = c.powerUps[i].wireId;
    }
    for (let i = 0; i < c.characters.length && count < this.modifierWire.length; i++) {
      this.modifierWire[count++] = c.characters[i].wireId;
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
   * Called by `restoreRun`. The registry is passed in rather than imported so that `run.ts` keeps no
   * dependency on the save layer, and the dependency arrow keeps pointing one way.
   */
  rehydrate(byWireId: ReadonlyMap<number, RunModifier>): void {
    this.stack.clear();
    this.stack.clearLoadout();
    for (let i = 0; i < this.modifierCount; i++) {
      const mod = byWireId.get(this.modifierWire[i]);
      if (mod !== undefined) this.stack.add(mod);
    }
    this.rebuildLoadout();
    if (this.cards.open) this.cards.relabel(this.weapons, this.passives, 0);
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

    if (this.cards.open) {
      // A card screen owed by autoPick resolves itself here so a headless run never deadlocks.
      if (this.autoPick) this.pickCard(0);
      return false;
    }

    // An arcana offer freezes the run exactly like a card screen does, and for the same reason: it is a
    // decision, and a decision taken while the crowd is closing in is not a decision.
    if (this.arcanas.open) {
      if (this.autoPick) this.pickArcana(0);
      return false;
    }

    const stats = this.stats;
    const players = this.players;

    // 1. Progression opens the tick.
    this.prog.beginTick();

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

    // 11. A level-up screen opens between ticks, never in the middle of one.
    if (this.prog.level > this.prevLevel) {
      for (let l = this.prevLevel + 1; l <= this.prog.level; l++) {
        this.cues.emit(CUE.levelUp, players.x[0], players.y[0], l);
      }
      this.prevLevel = this.prog.level;
      // A level can earn the character's next growth step. Only rebuild when the step count actually
      // changed, so an ordinary level-up costs one integer division rather than a full resolve.
      if (this.growthTierAt(this.prog.level) !== this.growthTier) {
        this.rebuildLoadout();
        this.stack.resolve(this.stats);
      }
    }

    if (this.prog.owesCards) {
      this.cards.beginScreen(
        0,
        this.prog,
        this.weapons,
        this.passives,
        stats,
        this.cardRng,
        this.flags,
      );
      if (this.cards.open) {
        this.cues.emit(CUE.cardScreenOpened, players.x[0], players.y[0], this.cards.picksRemaining);
      }
    }

    // 11b. Arcana offers are owed by the run clock, not by levelling, so they are checked after the card
    //      screen rather than inside it — a level-up and an arcana mark landing on the same tick queue up
    //      one behind the other instead of fighting over the screen. The deck compares with `>=` and
    //      consumes the mark, so a mark passed during a card screen is still owed rather than skipped.
    if (!this.cards.open && this.arcanas.update(this.waves.runSeconds, this.arcanaRng)) {
      this.cues.emit(CUE.cardScreenOpened, players.x[0], players.y[0], this.arcanas.offerCount);
    }

    // 12. Players last: movement resolution, regen, contact damage, downs and revives. Contact
    //     damage comes after the crowd has moved, so a player is hurt by where enemies *are*.
    players.update(stats, this.enemies);
    this.announcePlayerChanges();

    // 13. Heals owed by cards are applied outside the card screen, so a meal taken during a batch
    //     of eight picks still lands exactly once.
    if (this.cards.healPending > 0) {
      for (let p = 0; p < players.count; p++) players.heal(p, this.cards.healPending, stats);
      this.cards.clearHeal();
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

  /** Spawn the Reaper when it is due, then count down to the White Hand. */
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

    this.waves.reaperSpawned = true;
    this.cues.emit(CUE.reaperArrived, this.players.x[0], this.players.y[0]);
    const type = ENEMY_TYPE_BY_ID.get(REAPER_ENEMY_ID);
    if (type !== undefined) {
      this.enemies.spawn(type, this.players.x[0], this.players.y[0] - 120, this.stats);
    }
    this.whiteHandTicks = WHITE_HAND_TICKS;
  }

  /** Fold this tick's hits and deaths into run totals, and turn deaths into loot. */
  private drainCombatEvents(): void {
    const proj = this.projectiles;

    for (let i = 0; i < proj.hitCount; i++) {
      this.damageDealt += proj.hitAmount[i];
      this.cues.emit(CUE.hit, proj.hitX[i], proj.hitY[i], proj.hitAmount[i], proj.hitCrit[i]);
    }

    const kills = proj.killCount;
    for (let i = 0; i < kills; i++) {
      const type = proj.killType[i];
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
    }
    this.kills += kills;
  }

  /** Apply everything collected this tick. Collection is an event; this is where it takes effect. */
  private applyCollections(): void {
    const pickups = this.pickups;
    const stats = this.stats;

    const px = this.players.x[0];
    const py = this.players.y[0];
    if (pickups.xpBanked > 0) {
      this.prog.addXp(pickups.xpBanked, stats);
      this.cues.emit(CUE.xpCollected, px, py, pickups.xpBanked);
    }
    if (pickups.goldBanked > 0) {
      this.prog.addGold(pickups.goldBanked, stats);
      this.cues.emit(CUE.goldCollected, px, py, pickups.goldBanked);
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
      // No loadout to put anything into. Pay coins rather than eat the chest.
      this.prog.addGold(CHEST_GOLD, this.stats);
      this.cues.emit(CUE.chestOpened, x, y);
      return;
    }

    const report = this.chestReport;
    openChest(player, this.weapons, this.passives, this.stats, this.chestRng, report);
    this.chestsOpened++;

    let passiveChanged = false;
    for (let r = 0; r < report.count; r++) {
      const kind = report.kind[r];
      if (kind === CHEST_REWARD.gold) {
        this.prog.addGold(report.value[r], this.stats);
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
      this.finish(RUN_END.defeat);
      return;
    }
    if (this.timeLimitTicks > 0 && this.waves.runTicks >= this.timeLimitTicks) {
      this.finish(RUN_END.survived);
    }
  }

  // --- Card screen -------------------------------------------------------------------------

  pickCard(index: number): boolean {
    const took = this.cards.pick(
      index,
      0,
      this.weapons,
      this.passives,
      this.prog,
      this.stats,
      this.stack,
      this.cardRng,
    );
    // A passive pick rebuilds the loadout from scratch, which throws the character's growth record away with
    // everything else in it. Putting it back here — rather than trusting the card layer to know about
    // characters — means there is one place that owns what the loadout contains.
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
    if (this.growthTier <= 0) return;
    this.rebuildLoadout();
    this.stack.resolve(this.stats);
  }

  /**
   * Rebuild the loadout list: every player's passives, then the character's growth step.
   *
   * Order inside the list does not matter — resolution is order-independent by design — but rebuilding in one
   * place does, because `passives.applyTo` clears the whole list on every call. Anything that lives in the
   * loadout has to be re-added by whoever calls it, and this is that whoever.
   */
  private rebuildLoadout(): void {
    for (let p = 0; p < this.players.count; p++) this.passives.applyTo(this.stack, p);
    const tier = this.growthTierAt(this.prog.level);
    this.growthTier = tier;
    if (tier > 0) this.stack.addLoadout(this.growthLadder[tier - 1]);
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

  /** How many growth steps a level has earned, clamped to the ladder the character actually has. */
  private growthTierAt(level: number): number {
    if (this.growthLadder.length === 0) return 0;
    const steps = Math.floor((Math.max(1, level | 0) - 1) / this.growthEvery);
    return Math.min(steps, this.growthLadder.length);
  }

  rerollCards(): boolean {
    return this.cards.reroll(0, this.weapons, this.passives, this.cardRng);
  }

  skipCard(): boolean {
    return this.cards.skip(0, this.weapons, this.passives, this.cardRng);
  }

  banishCard(index: number): boolean {
    return this.cards.banish(index, 0, this.weapons, this.passives, this.cardRng);
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

    h = hashWord(h, this.prog.level);
    h = hashWord(h, this.prog.xp);
    h = hashWord(h, this.prog.gold);
    h = hashWord(h, this.prog.pending);
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
