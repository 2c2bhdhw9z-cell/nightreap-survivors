/**
 * The level-up card draw — the moment the whole game is actually about.
 *
 * WHAT THIS OWNS AND WHAT IT DOES NOT
 * This file decides *what is offered* and *what happens when a card is taken*. It does not draw
 * anything, does not know a screen exists, and does not touch health, enemies or projectiles. The
 * run loop asks "am I owed a screen", shows whatever `offer*` arrays say, and reports a choice back.
 * Keeping it that way is what lets the same code drive a real card screen, a replay re-simulation and
 * a co-op guest applying the host's authoritative pick.
 *
 * WHY EVERY DRAW COMES OUT OF ONE SEEDED STREAM
 * Offers are pulled from `RNG_STREAMS.cardDraw` and nothing else. A replay that re-runs the same
 * seed and the same picks must see the same four cards, or revalidation fails and every ladder run is
 * a false positive. That also means the draw may never consult wall-clock time, iteration order of a
 * Map, or any other stream.
 *
 * WHY OFFERS ARE PARALLEL ARRAYS AND NOT OBJECTS
 * A card screen happens hundreds of times in a long run and the batch path can redraw sixteen times
 * back to back. Building objects per card would put allocation on a path the player is watching. The
 * offer arrays are allocated once; a draw only writes into them. Card *text* is assigned by reference
 * straight from the weapon or passive row, which is also why the words on the card can never disagree
 * with the effect it applies.
 *
 * WHY CHARGES LIVE HERE FOR THE WHOLE RUN
 * Reroll, skip and banish are counts (never permille) read from `STAT.rerolls` / `skips` / `banishes`
 * at run start. They are spent across the whole run, not refilled per screen — refilling per screen
 * would make a deep batch queue an infinite reroll machine.
 *
 * WHY A BANISH LASTS THE RUN
 * Banishing is the player saying "never show me this again", and a banish that expired at the end of
 * the screen would be worthless. The banish lists are cleared only by `resetRun`.
 */

import type { Rng } from "../core/rng";
import { RUN_FLAG, type ModifierStack } from "./modifiers";
import { MAX_PASSIVE_LEVEL, PASSIVE_TYPES, type PassiveStore } from "./passives";
import { batchSizeFor, type Progression } from "./progression";
import { STAT, type Stats } from "./stats";
import { MAX_WEAPON_LEVEL, WEAPON_TYPES, type WeaponStore } from "./weapons";

/** What a single offered card is. */
export const CARD_KIND = {
  /** A weapon the player does not carry yet. */
  newWeapon: 0,
  /** A weapon they carry, one level higher. */
  weaponLevel: 1,
  /** A passive they do not carry yet. */
  newPassive: 2,
  /** A passive they carry, one level higher. */
  passiveLevel: 3,
  /** Filler: coins. Offered when there is genuinely nothing left to improve. */
  gold: 4,
  /** Filler: food. Heals on pick. */
  food: 5,
} as const;

export type CardKind = (typeof CARD_KIND)[keyof typeof CARD_KIND];

/** Cards shown per screen. Four reads well on a phone in portrait and still feels like a choice. */
export const OFFERS_PER_SCREEN = 4;

/** Coins a filler gold card pays. */
export const FILLER_GOLD = 50;

/** Health a filler food card restores. */
export const FILLER_HEAL = 30;

/** Coins paid per level when the run has card draws switched off entirely. */
export const NO_CARD_GOLD = 10;

/** Upper bound on candidates: every weapon and every passive can contribute at most one. */
const CANDIDATE_CAP = WEAPON_TYPES.length + PASSIVE_TYPES.length;

/**
 * One player's level-up draw.
 *
 * Instantiated per player rather than per run so a four-player co-op game has four independent
 * screens — everyone levels at once off shared experience, but they are not choosing from the same
 * four cards.
 */
export class CardDraw {
  /** True while a screen is up and the sim should be paused for this player. */
  open = false;

  /** How many of the offer slots are populated. Always at least one while `open`. */
  offerCount = 0;
  /** `CARD_KIND` per slot. */
  readonly offerKind = new Int32Array(OFFERS_PER_SCREEN);
  /** Weapon or passive type index per slot; -1 for filler. */
  readonly offerType = new Int32Array(OFFERS_PER_SCREEN).fill(-1);
  /** The level the player would end up at, for level cards. 1 for a new pickup, 0 for filler. */
  readonly offerLevel = new Int32Array(OFFERS_PER_SCREEN);
  /** Card title per slot. Assigned by reference from content. */
  readonly offerName: string[] = Array.from<string>({ length: OFFERS_PER_SCREEN }).fill("");
  /** Card body per slot. Assigned by reference from content. */
  readonly offerText: string[] = Array.from<string>({ length: OFFERS_PER_SCREEN }).fill("");

  /** Picks still owed on the current screen. A batch screen owes several. */
  picksRemaining = 0;
  /** Levels this screen consumed off the queue. */
  levelsThisScreen = 0;

  rerollsLeft = 0;
  skipsLeft = 0;
  banishesLeft = 0;

  /** Coins and health granted by filler cards, for the run loop to apply and the HUD to flash. */
  goldFromCards = 0;
  healPending = 0;

  /** Screens shown this run, for the results screen. */
  screensShown = 0;
  /** Picks made this run. */
  picksMade = 0;

  /** Per-run banish state, one byte per content row. */
  private readonly banishedWeapon = new Uint8Array(WEAPON_TYPES.length);
  private readonly banishedPassive = new Uint8Array(PASSIVE_TYPES.length);

  /** Unlock state. All ones by default; the meta save narrows it in Phase 3. */
  readonly weaponUnlocked = new Uint8Array(WEAPON_TYPES.length).fill(1);
  readonly passiveUnlocked = new Uint8Array(PASSIVE_TYPES.length).fill(1);

  /** Candidate scratch, refilled per draw. Never reallocated. */
  private readonly candKind = new Int32Array(CANDIDATE_CAP);
  private readonly candType = new Int32Array(CANDIDATE_CAP);
  private candCount = 0;

  /** Run flags captured at screen start, so a mid-screen resolve cannot change the rules. */
  private flags = 0;

  /**
   * Start a run. Charges come from the resolved stats, so a character or an Ascension tier that
   * grants rerolls has already been folded in by the time this is called.
   */
  resetRun(stats: Stats): void {
    this.open = false;
    this.offerCount = 0;
    this.picksRemaining = 0;
    this.levelsThisScreen = 0;
    this.rerollsLeft = stats.get(STAT.rerolls);
    this.skipsLeft = stats.get(STAT.skips);
    this.banishesLeft = stats.get(STAT.banishes);
    this.goldFromCards = 0;
    this.healPending = 0;
    this.screensShown = 0;
    this.picksMade = 0;
    this.banishedWeapon.fill(0);
    this.banishedPassive.fill(0);
    this.offerType.fill(-1);
    this.offerLevel.fill(0);
  }

  /** The run loop calls this after applying `healPending`. */
  clearHeal(): void {
    this.healPending = 0;
  }

  /**
   * Open a screen if one is owed.
   *
   * Returns true when a screen is now open. When the run has `noCardDraw` set the whole queue is
   * drained here into coins instead — the mode still wants the level-ups to be worth something, and
   * this is the one place that decision belongs.
   */
  beginScreen(
    player: number,
    prog: Progression,
    weapons: WeaponStore,
    passives: PassiveStore,
    stats: Stats,
    rng: Rng,
    flags = 0,
  ): boolean {
    if (this.open) return true;
    if (prog.pending <= 0) return false;

    if ((flags & RUN_FLAG.noCardDraw) !== 0) {
      const levels = prog.spend(prog.pending);
      const paid = prog.addGold(NO_CARD_GOLD * levels, stats);
      this.goldFromCards += paid;
      return false;
    }

    this.flags = flags;
    const batch = batchSizeFor(prog.pending);
    const taken = prog.spend(batch);
    if (taken <= 0) return false;

    this.levelsThisScreen = taken;
    this.picksRemaining = taken;
    this.open = true;
    this.screensShown++;
    this.draw(player, weapons, passives, rng);
    return true;
  }

  /**
   * Spend a reroll and redraw the same screen. Returns false when there is no charge left, which the
   * UI shows as a disabled button rather than an error.
   */
  reroll(player: number, weapons: WeaponStore, passives: PassiveStore, rng: Rng): boolean {
    if (!this.open || this.rerollsLeft <= 0) return false;
    this.rerollsLeft--;
    this.draw(player, weapons, passives, rng);
    return true;
  }

  /**
   * Spend a skip: give up one pick and take nothing for it. Skipping is how a player holds a weapon
   * slot open for an evolution, so it consumes the level exactly like a pick does.
   */
  skip(player: number, weapons: WeaponStore, passives: PassiveStore, rng: Rng): boolean {
    if (!this.open || this.skipsLeft <= 0) return false;
    this.skipsLeft--;
    this.advance(player, weapons, passives, rng);
    return true;
  }

  /**
   * Spend a banish: remove that item from this run's pool entirely and redraw. Does not consume the
   * pick — the player still gets to choose something.
   */
  banish(
    index: number,
    player: number,
    weapons: WeaponStore,
    passives: PassiveStore,
    rng: Rng,
  ): boolean {
    if (!this.open || this.banishesLeft <= 0) return false;
    if (index < 0 || index >= this.offerCount) return false;
    const kind = this.offerKind[index];
    const type = this.offerType[index];
    if (type < 0) return false; // filler cannot be banished; there is nothing to remove
    if (kind === CARD_KIND.newWeapon || kind === CARD_KIND.weaponLevel) {
      this.banishedWeapon[type] = 1;
    } else {
      this.banishedPassive[type] = 1;
    }
    this.banishesLeft--;
    this.draw(player, weapons, passives, rng);
    return true;
  }

  /**
   * Take a card.
   *
   * Passive picks rebuild the loadout and re-resolve the stat table immediately, so a might upgrade
   * is live for the very next shot. Weapon picks do not touch stats at all, because weapons read the
   * stat table at fire time rather than caching it at pickup.
   */
  pick(
    index: number,
    player: number,
    weapons: WeaponStore,
    passives: PassiveStore,
    prog: Progression,
    stats: Stats,
    stack: ModifierStack,
    rng: Rng,
  ): boolean {
    if (!this.open) return false;
    if (index < 0 || index >= this.offerCount) return false;

    const kind = this.offerKind[index];
    const type = this.offerType[index];

    if (kind === CARD_KIND.newWeapon || kind === CARD_KIND.weaponLevel) {
      weapons.grant(player, type);
    } else if (kind === CARD_KIND.newPassive || kind === CARD_KIND.passiveLevel) {
      passives.grant(player, type);
      passives.applyTo(stack, player);
      stack.resolve(stats);
    } else if (kind === CARD_KIND.gold) {
      this.goldFromCards += prog.addGold(FILLER_GOLD, stats);
    } else {
      this.healPending += FILLER_HEAL;
    }

    this.picksMade++;
    this.advance(player, weapons, passives, rng);
    return true;
  }

  /** Close out one pick and either redraw for the next one or close the screen. */
  private advance(player: number, weapons: WeaponStore, passives: PassiveStore, rng: Rng): void {
    this.picksRemaining--;
    if (this.picksRemaining > 0) {
      this.draw(player, weapons, passives, rng);
      return;
    }
    this.open = false;
    this.offerCount = 0;
    this.picksRemaining = 0;
  }

  /**
   * Fill the offer slots.
   *
   * Selection is uniform over the candidate pool, without replacement, by swap-removing the chosen
   * candidate — the same trick the pickup pool uses, and the reason a draw allocates nothing. Rarity
   * weighting and `STAT.luck` arrive with the real content set in Phase 4; the hook is the candidate
   * list, not this loop.
   */
  private draw(player: number, weapons: WeaponStore, passives: PassiveStore, rng: Rng): void {
    this.collectCandidates(player, weapons, passives);

    let slot = 0;
    while (slot < OFFERS_PER_SCREEN && this.candCount > 0) {
      const pickIdx = rng.nextInt(this.candCount);
      const kind = this.candKind[pickIdx];
      const type = this.candType[pickIdx];
      // swap-remove so the same card cannot appear twice on one screen
      this.candCount--;
      this.candKind[pickIdx] = this.candKind[this.candCount];
      this.candType[pickIdx] = this.candType[this.candCount];
      this.writeOffer(slot, kind, type, weapons, passives, player);
      slot++;
    }

    // A screen with nothing on it would deadlock the run loop: it is waiting for a pick that can
    // never come. Filler is the guarantee that a pick always exists, however maxed the player is.
    while (slot < OFFERS_PER_SCREEN) {
      const kind = slot % 2 === 0 ? CARD_KIND.gold : CARD_KIND.food;
      this.writeOffer(slot, kind, -1, weapons, passives, player);
      slot++;
    }

    this.offerCount = OFFERS_PER_SCREEN;
  }

  /**
   * Rewrite the name and description of every live offer from its kind and type.
   *
   * Card text is content, not state: it is looked up from the same row that supplies the effect, which
   * is what stops the words on a card from drifting away from what the card does. So a restored snapshot
   * stores the *choice* — which weapon, which level — and asks for the words back here, rather than
   * serialising English into a save file.
   */
  relabel(weapons: WeaponStore, passives: PassiveStore, player: number): void {
    for (let slot = 0; slot < this.offerCount; slot++) {
      this.writeOffer(slot, this.offerKind[slot], this.offerType[slot], weapons, passives, player);
    }
  }

  private writeOffer(
    slot: number,
    kind: number,
    type: number,
    weapons: WeaponStore,
    passives: PassiveStore,
    player: number,
  ): void {
    this.offerKind[slot] = kind;
    this.offerType[slot] = type;

    if (kind === CARD_KIND.newWeapon) {
      const w = WEAPON_TYPES[type];
      this.offerLevel[slot] = 1;
      this.offerName[slot] = w.name;
      this.offerText[slot] = w.blurb;
      return;
    }
    if (kind === CARD_KIND.weaponLevel) {
      const w = WEAPON_TYPES[type];
      const next = weapons.levelOf(player, type) + 1;
      this.offerLevel[slot] = next;
      this.offerName[slot] = w.name;
      // `levels` holds levels 2..MAX, so the row for level N sits at N - 2.
      this.offerText[slot] = w.levels[next - 2].text;
      return;
    }
    if (kind === CARD_KIND.newPassive) {
      const p = PASSIVE_TYPES[type];
      this.offerLevel[slot] = 1;
      this.offerName[slot] = p.name;
      this.offerText[slot] = p.levels[0].text;
      return;
    }
    if (kind === CARD_KIND.passiveLevel) {
      const p = PASSIVE_TYPES[type];
      const next = passives.levelOf(player, type) + 1;
      this.offerLevel[slot] = next;
      this.offerName[slot] = p.name;
      this.offerText[slot] = p.levels[next - 1].text;
      return;
    }
    this.offerLevel[slot] = 0;
    if (kind === CARD_KIND.gold) {
      this.offerName[slot] = "Grave Coins";
      this.offerText[slot] = "A small purse of gold.";
    } else {
      this.offerName[slot] = "Rotten Bread";
      this.offerText[slot] = "Restores some health.";
    }
  }

  /**
   * Build the pool of everything that could legally be offered right now.
   *
   * The rules, in one place so they cannot disagree with themselves:
   *   - A carried item is a level-up candidate unless it is maxed.
   *   - An uncarried item is a new candidate only if there is a free slot for it and it is unlocked.
   *   - A banished item is neither, for the rest of the run.
   */
  private collectCandidates(player: number, weapons: WeaponStore, passives: PassiveStore): void {
    const ignoreUnlocks = (this.flags & RUN_FLAG.ignoreUnlocks) !== 0;
    let n = 0;

    const weaponsFull = weapons.isFull(player);
    for (let i = 0; i < WEAPON_TYPES.length; i++) {
      if (this.banishedWeapon[i] === 1) continue;
      const level = weapons.levelOf(player, i);
      if (level > 0) {
        if (level >= MAX_WEAPON_LEVEL) continue;
        this.candKind[n] = CARD_KIND.weaponLevel;
        this.candType[n] = i;
        n++;
        continue;
      }
      if (weaponsFull) continue;
      if (!ignoreUnlocks && this.weaponUnlocked[i] === 0) continue;
      this.candKind[n] = CARD_KIND.newWeapon;
      this.candType[n] = i;
      n++;
    }

    const passivesFull = passives.isFull(player);
    for (let i = 0; i < PASSIVE_TYPES.length; i++) {
      if (this.banishedPassive[i] === 1) continue;
      const level = passives.levelOf(player, i);
      if (level > 0) {
        if (level >= MAX_PASSIVE_LEVEL) continue;
        this.candKind[n] = CARD_KIND.passiveLevel;
        this.candType[n] = i;
        n++;
        continue;
      }
      if (passivesFull) continue;
      if (!ignoreUnlocks && this.passiveUnlocked[i] === 0) continue;
      this.candKind[n] = CARD_KIND.newPassive;
      this.candType[n] = i;
      n++;
    }

    this.candCount = n;
  }

  /** True when this item is out of the pool for the rest of the run. Dev menu and tests. */
  isBanished(kind: number, type: number): boolean {
    if (kind === CARD_KIND.newWeapon || kind === CARD_KIND.weaponLevel) {
      return this.banishedWeapon[type] === 1;
    }
    return this.banishedPassive[type] === 1;
  }
}
