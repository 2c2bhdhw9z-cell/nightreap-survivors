/**
 * The chest opening, as arithmetic.
 *
 * WHAT THIS IS FOR
 *
 * Walking into a chest used to change your loadout silently. The most valuable thing that happens in a
 * run had less ceremony than picking up a coin, and on a phone — where the chest is under your thumb and
 * the screen is full of enemies — a lot of people never noticed it had happened at all.
 *
 * This file is the whole sequence, expressed as "given how long ago the chest was opened, what does the
 * screen look like right now". Nothing in it draws, nothing in it reads a clock, and nothing in it keeps
 * a variable between frames. Hand it the same time twice and it answers the same thing twice.
 *
 * WHY IT IS BUILT THAT WAY
 *
 * An effect written the usual way — a pile of counters ticking themselves forward inside the draw loop —
 * cannot be checked without watching it, and "watch it and see" is not a test. It also cannot be paused,
 * cannot be rewound, and gets a frame ahead of itself the moment the phone drops a frame. Asking a pure
 * function what second 1.4 looks like has none of those problems: pausing is not advancing the time,
 * a dropped frame simply skips to the right place, and every beat can be checked at its edges.
 *
 * THE BEATS
 *
 * Read off a real chest opening, frame by frame, then re-timed to fit a phone where the fight does not
 * stop while you watch:
 *
 *   1. LIGHT     a column of light climbs out of the chest. Says "something is happening here"
 *                before anything else moves.
 *   2. SPRAY     coins and gems fire outward and arc back down under gravity.
 *   3. COUNT     the gold total ticks up. Runs alongside the spray, not after it, so the number is
 *                still moving while coins are still landing.
 *   4. RIBBON    a bright ribbon orbits the chest while the count finishes.
 *   5. FLASH     one short white flash. The punctuation mark between "you got stuff" and "here it is".
 *   6. BURST     a star bursts out of the flash and fades.
 *   7. CARD      the reward card slides in and stays until it is dismissed.
 *
 * Beats overlap on purpose. Played strictly one after another the whole thing takes twice as long and
 * reads as a slideshow.
 *
 * THE ONE HARD RULE
 *
 * The sequence is DECORATION. The rewards are already applied by the time it starts — the chest rules
 * did that, and they did it without asking this file anything. Nothing here can change a level, a
 * weapon or a gold total. If a phone dies halfway through this animation the player keeps everything
 * the chest gave them, because the animation was never how they got it.
 */

/** Seconds. Each beat is a window; several are open at once. */
export const BEAT = {
  lightStart: 0.0,
  lightEnd: 0.75,
  sprayStart: 0.18,
  sprayEnd: 1.7,
  countStart: 0.3,
  countEnd: 1.8,
  ribbonStart: 0.5,
  ribbonEnd: 2.15,
  flashStart: 1.8,
  flashEnd: 2.0,
  burstStart: 1.88,
  burstEnd: 2.4,
  cardStart: 2.05,
  cardEnd: 2.65,
} as const;

/** When the moving part is over. After this the card is simply up, waiting to be dismissed. */
export const SEQUENCE_SECONDS = BEAT.cardEnd;

/** How many coins and gems fly out. Fixed, because a pool that grows during an effect allocates. */
export const SPARK_COUNT = 28;

/** How far out a spark is thrown, in world units, before gravity wins. */
export const SPARK_SPEED_MIN = 90;
export const SPARK_SPEED_MAX = 200;

/** Downward pull on a thrown spark, world units per second squared. */
export const SPARK_GRAVITY = 320;

/** How high the column of light climbs, in world units. */
export const LIGHT_HEIGHT = 96;
/** How wide it is at the base. */
export const LIGHT_WIDTH = 22;

/** How far out the ribbon orbits, and how many turns it makes across its beat. */
export const RIBBON_RADIUS = 46;
export const RIBBON_TURNS = 2.5;

/** How far the card travels as it slides in, in points, and where it comes from. Positive is upward. */
export const CARD_TRAVEL = 90;

/** Alphas are 0..255 so they can be handed straight to the batcher without a second conversion. */
export const ALPHA_MAX = 255;

/**
 * A whole-number hash. Same input, same output, on every phone.
 *
 * The sparks need to look scattered without being random: two players watching the same replay have to
 * see the same chest. `Math.random` is banned everywhere under `game/` for exactly this reason, so the
 * scatter comes from hashing the spark's own index instead.
 */
export function sparkHash(index: number, seed: number): number {
  let h = (0x9e3779b9 ^ ((index | 0) * 0x27d4eb2d)) | 0;
  h = (h ^ ((seed | 0) * 0x165667b1)) | 0;
  h ^= h >>> 15;
  h = (h * 0x2545f491) | 0;
  h ^= h >>> 13;
  h = (h * 0x27d4eb2d) | 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A hashed value as a fraction from 0 up to but not including 1. */
export function hashUnit(index: number, seed: number, salt: number): number {
  return sparkHash(index * 31 + salt, seed) / 4294967296;
}

/** How far through a window, 0 before it opens and 1 after it shuts. Junk time reads as "not started". */
export function progress(t: number, start: number, end: number): number {
  if (!Number.isFinite(t)) return 0;
  if (end <= start) return t >= end ? 1 : 0;
  if (t <= start) return 0;
  if (t >= end) return 1;
  return (t - start) / (end - start);
}

/** Fast then slow. The curve everything that lands uses. */
export function easeOut(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p >= 1) return 1;
  const inv = 1 - p;
  return 1 - inv * inv * inv;
}

/** Slow then fast. Used only by the card, which should look like it is being thrown at you. */
export function easeIn(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p >= 1) return 1;
  return p * p;
}

/** Up and back down across a window: 0 at both ends, 1 in the middle. Every fade in this file uses it. */
export function pulse(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return p < 0.5 ? p * 2 : (1 - p) * 2;
}

/** A 0..1 fraction as an alpha the batcher can take. Always a whole number. */
export function alphaOf(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  if (fraction >= 1) return ALPHA_MAX;
  return Math.round(fraction * ALPHA_MAX);
}

/** What a chest is worth, handed in by whoever opened it. This file never works any of it out. */
export interface ChestOpenSpec {
  /** Where the chest was, in world units. Everything is drawn relative to this. */
  x: number;
  y: number;
  /** Gold before and after. Equal means no gold, and the counter does not appear. */
  goldFrom: number;
  goldTo: number;
  /** How many reward rows the card will show. Only used to decide the card's height. */
  rows: number;
  /** True when the chest was spent on an evolution. Evolutions get the bigger, slower flash. */
  evolved: boolean;
  /** Fixes the scatter. The run's own seed, so a replay opens the same chest the same way. */
  seed: number;
}

export function createChestOpenSpec(): ChestOpenSpec {
  return { x: 0, y: 0, goldFrom: 0, goldTo: 0, rows: 0, evolved: false, seed: 0 };
}

/** One thrown coin or gem, written into rather than returned, so a frame allocates nothing. */
export interface Spark {
  x: number;
  y: number;
  /** 0..255. Zero means do not draw it at all. */
  alpha: number;
  scale: number;
  /** Which of the three pickup pictures to draw. Decided by the hash, not by what the chest contained. */
  kind: number;
  /** Turn, in radians. Coins tumble; it is the difference between thrown and slid. */
  spin: number;
}

export function createSpark(): Spark {
  return { x: 0, y: 0, alpha: 0, scale: 1, kind: 0, spin: 0 };
}

/**
 * Where one spark is at time `t`.
 *
 * Thrown outward at a hashed angle and speed, then pulled down. A spark that has not been thrown yet, or
 * whose beat is over, comes back with an alpha of zero — the caller checks that and skips it, rather than
 * this file keeping a list of which sparks are alive.
 *
 * Each spark starts a little later than the last, spread across the first third of the beat, so they leave
 * the chest as a stream rather than a single ring.
 */
/**
 * How one spark is thrown: which way, how hard, and how much of the throw is upward.
 *
 * Pulled out of the drawing on purpose. Inside `sparkAt` these three numbers are tangled up with the
 * time and the gravity, and a fault in them — every coin leaving in the same direction, or the fast
 * coins all flying one way because direction and speed were hashed off the same number — is invisible
 * in a still frame and nearly invisible in motion. Out here they can simply be measured.
 */
export interface SparkThrow {
  /** Radians, anywhere in the full circle. */
  angle: number;
  /** World units per second. */
  speed: number;
  /** How much of the throw goes upward rather than outward, 0..1-ish. */
  lift: number;
  /** Seconds after the spray beat opens that this spark leaves. */
  delay: number;
}

export function createSparkThrow(): SparkThrow {
  return { angle: 0, speed: 0, lift: 0, delay: 0 };
}

/**
 * The four decisions, each off its own salt.
 *
 * Separate salts matter more than it looks: hash direction and speed off the same number and the two
 * stop being independent, so every fast coin flies the same way and the spray reads as a spiral
 * instead of a scatter.
 */
export function sparkThrow(index: number, spec: ChestOpenSpec, out: SparkThrow): SparkThrow {
  out.angle = hashUnit(index, spec.seed, 1) * Math.PI * 2;
  out.speed = SPARK_SPEED_MIN + hashUnit(index, spec.seed, 2) * (SPARK_SPEED_MAX - SPARK_SPEED_MIN);
  // Biased upward, because a coin that leaves a chest flat along the floor reads as one that fell out.
  out.lift = 0.55 + hashUnit(index, spec.seed, 4) * 0.45;
  out.delay = hashUnit(index, spec.seed, 3) * (BEAT.sprayEnd - BEAT.sprayStart) * 0.33;
  return out;
}

/** Scratch for the drawing path, so a frame of twenty-eight sparks still allocates nothing. */
const throwScratch: SparkThrow = createSparkThrow();

export function sparkAt(index: number, t: number, spec: ChestOpenSpec, out: Spark): Spark {
  const thrown = sparkThrow(index, spec, throwScratch);
  const start = BEAT.sprayStart + thrown.delay;
  const life = BEAT.sprayEnd - start;
  const age = t - start;

  if (age <= 0 || age >= life || life <= 0) {
    out.alpha = 0;
    out.x = spec.x;
    out.y = spec.y;
    out.scale = 1;
    out.kind = 0;
    out.spin = 0;
    return out;
  }

  const angle = thrown.angle;
  const speed = thrown.speed;
  const lift = thrown.lift;

  out.x = spec.x + Math.cos(angle) * speed * age;
  out.y = spec.y + Math.sin(angle) * speed * age * 0.45 - speed * lift * age + 0.5 * SPARK_GRAVITY * age * age;

  // Full strength for most of its life, then out. Fading a coin in as it leaves the chest looks like a
  // rendering fault rather than a throw, so the fade is only at the end.
  const p = age / life;
  out.alpha = alphaOf(p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3);
  out.scale = 0.5 + hashUnit(index, spec.seed, 5) * 0.35;
  out.kind = sparkHash(index, spec.seed) % 3;
  out.spin = (hashUnit(index, spec.seed, 6) - 0.5) * 12 * age;
  return out;
}

/** Everything the screen needs for one frame of the sequence. Filled in, never allocated per frame. */
export interface ChestOpenFrame {
  /** True while any part of the sequence is still visible. */
  active: boolean;
  /** The column of light: how tall it currently is and how strong. */
  lightHeight: number;
  lightWidth: number;
  lightAlpha: number;
  /** The gold number to print, and whether to print it at all. */
  goldShown: number;
  goldVisible: boolean;
  /** The orbiting ribbon: where it is and how strong. Angle is radians from straight up. */
  ribbonAngle: number;
  ribbonX: number;
  ribbonY: number;
  ribbonAlpha: number;
  /** The full-screen flash. */
  flashAlpha: number;
  /** The burst star: how big and how strong. */
  burstScale: number;
  burstAlpha: number;
  /** The card: how far in it has slid, 0 fully out and 1 fully in, and how strong. */
  cardSlide: number;
  cardOffsetY: number;
  cardAlpha: number;
  /** True once the moving part is over and the card is simply waiting. */
  settled: boolean;
}

export function createChestOpenFrame(): ChestOpenFrame {
  return {
    active: false,
    lightHeight: 0,
    lightWidth: 0,
    lightAlpha: 0,
    goldShown: 0,
    goldVisible: false,
    ribbonAngle: 0,
    ribbonX: 0,
    ribbonY: 0,
    ribbonAlpha: 0,
    flashAlpha: 0,
    burstScale: 0,
    burstAlpha: 0,
    cardSlide: 0,
    cardOffsetY: 0,
    cardAlpha: 0,
    settled: false,
  };
}

/**
 * How much gold to print at time `t`.
 *
 * Two guarantees, both of which a hand-rolled counter usually breaks. It never shows more than the
 * player actually has — a counter that overshoots and settles back is a counter nobody trusts — and its
 * last frame is the real total exactly, not a rounded approximation that leaves the shop disagreeing
 * with the screen the player just watched.
 */
export function goldAt(t: number, spec: ChestOpenSpec): number {
  const from = Math.max(0, Math.trunc(spec.goldFrom));
  const to = Math.max(0, Math.trunc(spec.goldTo));
  if (to <= from) return to;
  const p = easeOut(progress(t, BEAT.countStart, BEAT.countEnd));
  if (p >= 1) return to;
  return from + Math.floor((to - from) * p);
}

/**
 * The whole frame at time `t`.
 *
 * `t` is seconds since the chest was opened and is allowed to be anything: negative reads as "not yet",
 * and anything past the end reads as the settled card. That matters more than it sounds — a phone that
 * stalls for half a second lands here with a `t` well past a beat's end, and the sequence has to arrive
 * at the right place rather than replaying what it missed.
 */
export function chestOpenAt(t: number, spec: ChestOpenSpec, out: ChestOpenFrame): ChestOpenFrame {
  const time = Number.isFinite(t) ? t : 0;

  out.active = time >= 0;
  out.settled = time >= SEQUENCE_SECONDS;

  // 1. the light column. Climbs quickly, then goes out as the spray takes over.
  const lightP = progress(time, BEAT.lightStart, BEAT.lightEnd);
  out.lightHeight = easeOut(lightP) * LIGHT_HEIGHT;
  out.lightWidth = LIGHT_WIDTH * (1 - lightP * 0.4);
  out.lightAlpha = alphaOf(lightP >= 1 ? 0 : lightP < 0.25 ? lightP / 0.25 : 1 - (lightP - 0.25) / 0.75);

  // 3. the gold counter. Present only when this chest actually paid gold.
  out.goldShown = goldAt(time, spec);
  out.goldVisible = spec.goldTo > spec.goldFrom && time >= BEAT.countStart && time < BEAT.cardStart;

  // 4. the ribbon. Two and a half turns, brightest in the middle of its beat.
  const ribbonP = progress(time, BEAT.ribbonStart, BEAT.ribbonEnd);
  out.ribbonAngle = ribbonP * Math.PI * 2 * RIBBON_TURNS;
  const ribbonR = RIBBON_RADIUS * (0.35 + easeOut(ribbonP) * 0.65);
  out.ribbonX = spec.x + Math.sin(out.ribbonAngle) * ribbonR;
  // Squashed vertically so it reads as orbiting the chest on the floor rather than spinning on a wall.
  out.ribbonY = spec.y + Math.cos(out.ribbonAngle) * ribbonR * 0.4 - 10;
  out.ribbonAlpha = ribbonP <= 0 || ribbonP >= 1 ? 0 : alphaOf(pulse(ribbonP));

  // 5. the flash. An evolution gets a stronger one, because it is the rarest thing a chest can do.
  const flashP = progress(time, BEAT.flashStart, BEAT.flashEnd);
  const flashPeak = spec.evolved ? 0.85 : 0.55;
  out.flashAlpha = flashP <= 0 || flashP >= 1 ? 0 : alphaOf(pulse(flashP) * flashPeak);

  // 6. the burst. Grows out of the flash and fades as it grows; it never shrinks back.
  const burstP = progress(time, BEAT.burstStart, BEAT.burstEnd);
  out.burstScale = burstP <= 0 ? 0 : 0.6 + easeOut(burstP) * 2.6;
  out.burstAlpha = burstP <= 0 || burstP >= 1 ? 0 : alphaOf(1 - burstP);

  // 7. the card. Slides up into place and stays.
  const cardP = progress(time, BEAT.cardStart, BEAT.cardEnd);
  out.cardSlide = easeOut(cardP);
  out.cardOffsetY = (1 - out.cardSlide) * CARD_TRAVEL;
  out.cardAlpha = alphaOf(easeIn(Math.min(1, cardP * 1.6)));

  return out;
}

/**
 * Whether the card can be dismissed yet.
 *
 * Not until it has finished arriving. A card that can be tapped away while it is still sliding gets
 * dismissed by the same thumb press that walked into the chest, and the player never sees what they got.
 */
export function cardDismissable(t: number): boolean {
  return Number.isFinite(t) && t >= BEAT.cardEnd;
}

/**
 * Content self-check, run by the test rather than at import.
 *
 * The beats have to be in order and they have to overlap in the ways the sequence depends on. Two beats
 * accidentally swapped would still animate — it would simply look wrong, which is the hardest kind of
 * fault to find by looking.
 */
export function beatFaults(): readonly string[] {
  const faults: string[] = [];
  const pairs: [string, number, number][] = [
    ["light", BEAT.lightStart, BEAT.lightEnd],
    ["spray", BEAT.sprayStart, BEAT.sprayEnd],
    ["count", BEAT.countStart, BEAT.countEnd],
    ["ribbon", BEAT.ribbonStart, BEAT.ribbonEnd],
    ["flash", BEAT.flashStart, BEAT.flashEnd],
    ["burst", BEAT.burstStart, BEAT.burstEnd],
    ["card", BEAT.cardStart, BEAT.cardEnd],
  ];
  for (const [name, start, end] of pairs) {
    if (!(end > start)) faults.push(`${name} ends before it starts`);
    if (start < 0) faults.push(`${name} starts before the chest opens`);
  }
  if (!(BEAT.sprayStart > BEAT.lightStart)) faults.push("the spray must start after the light does");
  if (!(BEAT.countStart < BEAT.countEnd)) faults.push("the count must run for a while");
  if (!(BEAT.countEnd <= BEAT.cardStart)) faults.push("the count must finish before the card arrives");
  if (!(BEAT.flashStart >= BEAT.countEnd)) faults.push("the flash must not land while the count is running");
  if (!(BEAT.burstStart > BEAT.flashStart)) faults.push("the burst must come out of the flash");
  if (!(BEAT.cardStart > BEAT.flashStart)) faults.push("the card must arrive after the flash");
  if (!(BEAT.cardEnd >= BEAT.burstEnd - 0.001)) faults.push("the card must still be arriving while the burst fades");
  if (!(SEQUENCE_SECONDS <= 3)) faults.push("the whole thing must be under three seconds");
  return faults;
}
