/**
 * Tick-log format — the single most load-bearing file in the anti-cheat design.
 *
 * WHAT A TICK LOG IS
 * A run is a pure function of (seed, stage, modifier stack, per-player inputs per tick). Nothing else.
 * So a run can be stored as its inputs and replayed exactly, which is what makes all four of these
 * possible from one artefact:
 *
 *   1. Ladder revalidation  — the server resimulates the log and compares the final state hash. This
 *                             is MANDATORY for Daily/Weekly/seeded race/global ladders (plan.md §5b
 *                             addendum). It is the *only* real integrity boundary in the game.
 *   2. Determinism testing  — replay one log on iOS, Android and Node and report the first tick where
 *                             the hashes part company.
 *   3. The soak test        — a 3-hour CI run needs no human and no device.
 *   4. Bug reports          — "attach the last N seconds of input log" is a reproducible repro.
 *
 * WHY THE TAINT FLAG LIVES IN THE HEADER
 * The `tainted` bitfield goes into version 1 of this format, before there is any dev menu to set it.
 * If it were added later every existing log would need a migration, and worse, the code path that
 * *forgets* to set it would be the code path that already existed. Reserving it now means a dev toggle
 * physically cannot be written without a field to record itself in.
 *
 * And to be exact about what it is worth: `tainted` is a courtesy signal, not a security boundary. It
 * is written by the client, so a patched binary can lie about it. Ladder integrity rests on
 * revalidation, full stop. The flag exists so that honest clients self-report and so the vast majority
 * of dev-menu use never has to be adjudicated at all.
 *
 * SIZE
 * Four players at 60Hz for a 30-minute run is 108,000 ticks × 4 bytes × 4 players = ~1.7MB raw. The
 * run-length encoding below cuts that by roughly an order of magnitude in practice, because a survivors
 * player holds one direction for long stretches. That matters: it is the difference between a bug
 * report we can attach and one we cannot.
 */

/** Bump on any layout change. Old logs then fail validation loudly instead of replaying as nonsense. */
export const REPLAY_VERSION = 1;

/** Magic so a truncated or foreign file is rejected before we try to simulate it. "NRRP". */
export const REPLAY_MAGIC = 0x5052_524e;

/**
 * Taint bits. Each one records *why* a run stopped counting, because "tainted" alone is useless when
 * triaging a report or deciding whether a bug is real. Never renumber.
 */
export const TAINT = {
  /** A SELF-tier dev toggle was used. The broad case. */
  DEV_TOGGLE: 1 << 0,
  /** Godmode or damage immunity. */
  INVULNERABLE: 1 << 1,
  /** Damage, gold, XP or stats were granted directly. */
  GRANTED: 1 << 2,
  /** Time scale was changed — slow-mo or fast-forward. */
  TIME_SCALE: 1 << 3,
  /** Entities were spawned or removed by hand. */
  SPAWN_EDIT: 1 << 4,
  /** RNG was rerolled or a stream was reseeded mid-run. */
  RNG_EDIT: 1 << 5,
  /** The modifier stack was edited after the run began. */
  MODIFIER_EDIT: 1 << 6,
  /** Inputs came from the dev menu's playback, not a human. */
  SYNTHETIC_INPUT: 1 << 7,
  /** The run was resumed from a snapshot or jumped to a timestamp. */
  TIME_TRAVEL: 1 << 8,
  /** A device profile was emulated, so perf numbers are not from this hardware. */
  EMULATED_DEVICE: 1 << 9,
  /** This client was a guest in a co-op session whose host was itself tainted. */
  TAINTED_HOST: 1 << 10,
  /** Guest-side plausibility checks tripped on the host. */
  IMPLAUSIBLE_HOST: 1 << 11,
  /** The run happened during a Chaos Sandbox Day event. Always set, by design. */
  CHAOS_EVENT: 1 << 12,
  /** The build was an internal dev-channel build. */
  DEV_CHANNEL: 1 << 13,
} as const;

export type TaintBit = (typeof TAINT)[keyof typeof TAINT];

/** Human-readable reasons, for the dev menu and the run-recap screen. Order matches the bits above. */
export const TAINT_LABELS: readonly [TaintBit, string][] = [
  [TAINT.DEV_TOGGLE, "dev toggle used"],
  [TAINT.INVULNERABLE, "invulnerability"],
  [TAINT.GRANTED, "resources granted"],
  [TAINT.TIME_SCALE, "time scale changed"],
  [TAINT.SPAWN_EDIT, "spawns edited"],
  [TAINT.RNG_EDIT, "rng rerolled"],
  [TAINT.MODIFIER_EDIT, "modifiers edited mid-run"],
  [TAINT.SYNTHETIC_INPUT, "synthetic input"],
  [TAINT.TIME_TRAVEL, "jumped in time"],
  [TAINT.EMULATED_DEVICE, "emulated device profile"],
  [TAINT.TAINTED_HOST, "tainted co-op host"],
  [TAINT.IMPLAUSIBLE_HOST, "implausible co-op host"],
  [TAINT.CHAOS_EVENT, "chaos sandbox event"],
  [TAINT.DEV_CHANNEL, "internal build"],
];

export function describeTaint(tainted: number): string {
  if (tainted === 0) return "clean";
  const parts: string[] = [];
  for (const [bit, label] of TAINT_LABELS) {
    if ((tainted & bit) !== 0) parts.push(label);
  }
  return parts.join(", ");
}

/** Whether a run may be submitted to any competitive surface. The one question the flag exists to answer. */
export function isLadderEligible(tainted: number): boolean {
  return tainted === 0;
}

/**
 * Run header. Fixed 48 bytes, little-endian.
 *
 *   0  u32  magic
 *   4  u16  replayVersion
 *   6  u16  contentVersion   — which versioned content set this run used
 *   8  u32  buildId
 *  12  u32  seed
 *  16  u32  tainted
 *  20  u16  stageId
 *  22  u8   characterCount   — 1..4
 *  23  u8   modifierCount
 *  24  u32  startedAtUnixSec — wall clock, informational only, NEVER hashed
 *  28  u32  tickCount
 *  32  i32  finalStateHash
 *  36  u32  timeLimitTicks   — 0 means "no limit", which is what every log written before this field
 *                              existed meant, so no version bump was needed to add it
 *  40  u32  reserved1
 *  44  u32  reserved2
 *
 * Then `characterCount` × u16 character ids, then `modifierCount` × i32 modifier records, then the
 * run-length-encoded input stream.
 *
 * The reserved words are there because bumping the version costs us every log in the wild. Three spare
 * u32s buy several future fields for free, and this is the first one spent.
 *
 * WHY A TIME LIMIT IS PART OF THE RUN AND NOT PART OF THE SIMULATION
 * A timed mode ends the run the moment the clock runs out, and "the run is over" is state: it stops the
 * world, seals the result and is inside the state hash. A replay that did not know about the limit would
 * simulate straight past it and finish in a world that is still running, so the hashes could not match
 * and an honest timed run would be refused. Storing the limit next to the seed makes the run reproducible
 * from the log alone, which is the whole promise of the format.
 */
export const HEADER_BYTES = 48;

export const HDR = {
  MAGIC: 0,
  REPLAY_VERSION: 4,
  CONTENT_VERSION: 6,
  BUILD_ID: 8,
  SEED: 12,
  TAINTED: 16,
  STAGE_ID: 20,
  CHARACTER_COUNT: 22,
  MODIFIER_COUNT: 23,
  STARTED_AT: 24,
  TICK_COUNT: 28,
  FINAL_HASH: 32,
  TIME_LIMIT_TICKS: 36,
  RESERVED1: 40,
  RESERVED2: 44,
} as const;

export interface RunHeader {
  replayVersion: number;
  contentVersion: number;
  buildId: number;
  seed: number;
  /** Bitfield of TAINT.* — see the note above on exactly what this is worth. */
  tainted: number;
  stageId: number;
  characterCount: number;
  characterIds: Uint16Array;
  modifierCount: number;
  modifiers: Int32Array;
  startedAtUnixSec: number;
  tickCount: number;
  finalStateHash: number;
  /** Ticks after which the run ends itself. 0 means the run has no limit. */
  timeLimitTicks: number;
}

export const MAX_REPLAY_MODIFIERS = 64;
export const MAX_REPLAY_PLAYERS = 4;

export function createRunHeader(): RunHeader {
  return {
    replayVersion: REPLAY_VERSION,
    contentVersion: 0,
    buildId: 0,
    seed: 0,
    tainted: 0,
    stageId: 0,
    characterCount: 1,
    characterIds: new Uint16Array(MAX_REPLAY_PLAYERS),
    modifierCount: 0,
    modifiers: new Int32Array(MAX_REPLAY_MODIFIERS),
    startedAtUnixSec: 0,
    tickCount: 0,
    finalStateHash: 0,
    timeLimitTicks: 0,
  };
}

/**
 * Input stream encoding — run-length over "the frame did not change".
 *
 * Per record: `u8 count, i8 stickX, i8 stickY, u8 buttons` per player, where `count` is how many
 * consecutive ticks share this frame, 1..255. Players are interleaved per record so a seek to tick N
 * walks one stream rather than four.
 *
 * `flags` from the live input frame is deliberately NOT stored. PREDICTED and UI_OPEN are properties of
 * how a frame arrived over the network, not of the run, and including them would make an identical run
 * hash differently depending on packet timing — which would break replay validation for exactly the
 * honest co-op players it is meant to protect. SYNTHETIC is recorded once in the header's taint field
 * instead of per frame.
 */
export const RLE_MAX_COUNT = 255;
export const RLE_BYTES_PER_PLAYER = 3;

export function rleRecordBytes(playerCount: number): number {
  return 1 + playerCount * RLE_BYTES_PER_PLAYER;
}

/** Validation outcomes. Distinct values because "why did this log fail" drives very different actions. */
export const REPLAY_ERROR = {
  NONE: 0,
  BAD_MAGIC: 1,
  VERSION_MISMATCH: 2,
  TRUNCATED: 3,
  /** Header claims a tick count the input stream cannot supply. */
  TICK_COUNT_MISMATCH: 4,
  /** Replayed cleanly but the final hash disagreed. The interesting one. */
  HASH_MISMATCH: 5,
  /** Content version is not one this build can simulate. Requires the archived build to validate. */
  CONTENT_VERSION_UNSUPPORTED: 6,
  BAD_PLAYER_COUNT: 7,
} as const;

export type ReplayError = (typeof REPLAY_ERROR)[keyof typeof REPLAY_ERROR];

export function describeReplayError(code: number): string {
  switch (code) {
    case REPLAY_ERROR.NONE:
      return "ok";
    case REPLAY_ERROR.BAD_MAGIC:
      return "not a Nightreap replay";
    case REPLAY_ERROR.VERSION_MISMATCH:
      return "replay format version not supported by this build";
    case REPLAY_ERROR.TRUNCATED:
      return "replay is truncated";
    case REPLAY_ERROR.TICK_COUNT_MISMATCH:
      return "input stream is shorter than the header claims";
    case REPLAY_ERROR.HASH_MISMATCH:
      return "replayed to a different state than recorded";
    case REPLAY_ERROR.CONTENT_VERSION_UNSUPPORTED:
      return "content version requires an archived build to validate";
    case REPLAY_ERROR.BAD_PLAYER_COUNT:
      return "player count out of range";
    default:
      return `unknown replay error ${code}`;
  }
}
