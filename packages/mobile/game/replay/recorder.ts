/**
 * Records a run as a tick log, and reads one back.
 *
 * ALLOCATION DISCIPLINE
 * The recorder runs inside the game loop, so it obeys the same rule as everything else in `game/`: no
 * allocation per tick. It owns one growable byte buffer, doubles it when needed (an O(log n) number of
 * allocations across a whole run, all of them off the hot path), and run-length encodes so that the
 * common case — the player holding a direction — costs literally zero bytes per tick.
 *
 * WHY RECORD ALWAYS, NOT ON REQUEST
 * Recording is cheap enough to leave on for every run, and a bug report or a ladder submission is
 * always retrospective — nobody knows a run was worth keeping until it is over. The buffer is capped so
 * an Endless run cannot grow without bound; past the cap the oldest records are dropped and the log
 * becomes a tail-only log, which still serves bug reports even though it can no longer be revalidated.
 */

import {
  HDR,
  HEADER_BYTES,
  MAX_REPLAY_MODIFIERS,
  MAX_REPLAY_PLAYERS,
  REPLAY_ERROR,
  REPLAY_MAGIC,
  REPLAY_VERSION,
  RLE_MAX_COUNT,
  type ReplayError,
  type RunHeader,
  createRunHeader,
  rleRecordBytes,
} from "./format";

/** Initial input-stream capacity: ~4 minutes of solo play at a realistic change rate. */
const INITIAL_STREAM_BYTES = 16 * 1024;

/**
 * Hard ceiling on the input stream, 8MB.
 *
 * At the observed compression this is many hours of play even in four-player Endless. It exists so a
 * pathological run — an input-playback loop left running overnight in the dev menu — cannot be the
 * thing that finally OOMs the app. Given we spent this session chasing an iOS jetsam kill, an unbounded
 * buffer inside the game loop is not a risk worth carrying for elegance.
 */
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;

export class ReplayRecorder {
  readonly header: RunHeader = createRunHeader();

  private stream: Uint8Array;
  private streamLength = 0;
  private playerCount = 1;
  private recordBytes = 4;

  /** Last frame written, per player: x, y, buttons. Compared to decide whether to extend the run. */
  private readonly lastFrame = new Int32Array(MAX_REPLAY_PLAYERS * 3);
  /** Offset of the in-progress RLE record, or -1 when there is none. */
  private openRecord = -1;
  private openCount = 0;

  /** True once the stream hit the cap and started dropping the head. Log is then tail-only. */
  truncatedHead = false;

  constructor(capacity = INITIAL_STREAM_BYTES) {
    this.stream = new Uint8Array(capacity);
  }

  /**
   * Begin a run. Everything the simulation needs to be reproduced is fixed at this moment — that is
   * what makes the log a complete description rather than a hint.
   */
  begin(options: {
    seed: number;
    stageId: number;
    buildId: number;
    contentVersion: number;
    characterIds: readonly number[];
    /**
     * How many players are actually in the run.
     *
     * Explicit, because inferring it from `characterIds.length` was a bug: a caller that keeps a
     * fixed four-slot character array — which the run config does — silently recorded every solo run
     * as a four-player run, and a four-player header cannot be revalidated by a one-player world.
     */
    playerCount?: number;
    modifiers?: Int32Array;
    modifierCount?: number;
    startedAtUnixSec?: number;
    tainted?: number;
  }): void {
    const h = this.header;
    h.replayVersion = REPLAY_VERSION;
    h.contentVersion = options.contentVersion;
    h.buildId = options.buildId;
    h.seed = options.seed;
    h.tainted = options.tainted ?? 0;
    h.stageId = options.stageId;
    const declared = options.playerCount ?? options.characterIds.length;
    h.characterCount = Math.min(Math.max(1, declared | 0), MAX_REPLAY_PLAYERS);
    for (let i = 0; i < h.characterCount; i++) h.characterIds[i] = options.characterIds[i] ?? 0;
    h.modifierCount = Math.min(options.modifierCount ?? 0, MAX_REPLAY_MODIFIERS);
    if (options.modifiers) {
      for (let i = 0; i < h.modifierCount; i++) h.modifiers[i] = options.modifiers[i] as number;
    }
    h.startedAtUnixSec = options.startedAtUnixSec ?? 0;
    h.tickCount = 0;
    h.finalStateHash = 0;

    this.playerCount = h.characterCount;
    this.recordBytes = rleRecordBytes(this.playerCount);
    this.streamLength = 0;
    this.openRecord = -1;
    this.openCount = 0;
    this.truncatedHead = false;
    this.lastFrame.fill(0);
  }

  /**
   * Set taint bits. Additive and irreversible within a run — there is no `clearTaint`, deliberately.
   *
   * Clearing taint is the single highest-value thing a cheat would want to call, so the function simply
   * does not exist on the client. Only a SYSTEM-tier server tool can clear it, and doing so is written
   * to the append-only event log with an actor and a timestamp.
   */
  taint(bits: number): void {
    this.header.tainted |= bits;
  }

  get tainted(): number {
    return this.header.tainted;
  }

  get tickCount(): number {
    return this.header.tickCount;
  }

  /** Bytes the encoded log currently occupies, header and all. */
  get byteLength(): number {
    return this.headerAndTableBytes() + this.streamLength;
  }

  private headerAndTableBytes(): number {
    return HEADER_BYTES + this.header.characterCount * 2 + this.header.modifierCount * 4;
  }

  /**
   * Record one tick of input for every player.
   *
   * `axes` is `playerCount * 2` int8s and `buttons` is `playerCount` u8s — the same quantised values
   * the simulation consumed, taken after quantisation on purpose. Recording the pre-quantised analog
   * value would produce a log that replays to a slightly different run, which is the exact class of bug
   * this whole file exists to detect.
   */
  recordTick(axes: Int8Array, buttons: Uint8Array): void {
    const n = this.playerCount;

    let same = this.openRecord >= 0 && this.openCount < RLE_MAX_COUNT;
    if (same) {
      for (let p = 0; p < n; p++) {
        if (
          this.lastFrame[p * 3] !== axes[p * 2] ||
          this.lastFrame[p * 3 + 1] !== axes[p * 2 + 1] ||
          this.lastFrame[p * 3 + 2] !== buttons[p]
        ) {
          same = false;
          break;
        }
      }
    }

    if (same) {
      this.openCount++;
      this.stream[this.openRecord] = this.openCount;
      this.header.tickCount++;
      return;
    }

    if (!this.ensure(this.recordBytes)) return;

    this.openRecord = this.streamLength;
    this.openCount = 1;
    this.stream[this.streamLength++] = 1;
    for (let p = 0; p < n; p++) {
      const x = axes[p * 2] as number;
      const y = axes[p * 2 + 1] as number;
      const b = buttons[p] as number;
      // Int8 values are stored in a Uint8Array, so mask to their two's-complement byte.
      this.stream[this.streamLength++] = x & 0xff;
      this.stream[this.streamLength++] = y & 0xff;
      this.stream[this.streamLength++] = b;
      this.lastFrame[p * 3] = x;
      this.lastFrame[p * 3 + 1] = y;
      this.lastFrame[p * 3 + 2] = b;
    }
    this.header.tickCount++;
  }

  /**
   * Make room for `n` more bytes, growing or dropping the head.
   *
   * Returns false only when the log has become tail-only and the caller should stop assuming the log is
   * complete. Ticks are still counted in that case, because the tick count is what tells us the log is
   * partial.
   */
  private ensure(n: number): boolean {
    if (this.streamLength + n <= this.stream.length) return true;

    if (this.stream.length * 2 <= MAX_STREAM_BYTES) {
      const grown = new Uint8Array(Math.max(this.stream.length * 2, this.streamLength + n));
      grown.set(this.stream.subarray(0, this.streamLength));
      this.stream = grown;
      return true;
    }

    // At the cap: drop the oldest quarter and slide, so this costs one memmove per quarter-buffer
    // rather than one per record.
    this.truncatedHead = true;
    const drop = Math.floor(this.stream.length / 4);
    this.stream.set(this.stream.subarray(drop, this.streamLength));
    this.streamLength -= drop;
    this.openRecord = -1;
    this.openCount = 0;
    return this.streamLength + n <= this.stream.length;
  }

  /**
   * Bytes of input log recorded so far.
   *
   * This is the used length, not the buffer's capacity — a mid-run snapshot stores only what has
   * actually been played, or an eight-megabyte buffer would be written to disk every thirty seconds.
   */
  get streamBytes(): number {
    return this.streamLength;
  }

  /** A view of the recorded input log. Borrowed, not copied — do not hold it across a tick. */
  streamView(): Uint8Array {
    return this.stream.subarray(0, this.streamLength);
  }

  /**
   * Stop extending the current run-length record, so the next recorded frame starts a fresh one.
   *
   * Called when a snapshot is taken. Closing a record costs at most four bytes and cannot be wrong,
   * whereas carrying an open record across a snapshot would mean the restored recorder had to trust
   * that the next frame it sees is identical to the one from before the interruption. Closing on
   * capture as well as on restore is what makes a captured run and a restored run agree byte for byte,
   * which is the invariant the snapshot test relies on.
   */
  closeRecord(): void {
    this.openRecord = -1;
    this.openCount = 0;
    this.lastFrame.fill(0);
  }

  /**
   * Put a snapshotted input log back, so a resumed run continues one log rather than starting a second.
   *
   * The RLE record that was open when the snapshot was taken is deliberately closed rather than
   * reopened — see `closeRecord`. Everything a validator checks — tick count, frame sequence, final
   * hash — is unaffected.
   */
  restoreStream(bytes: Uint8Array): void {
    if (bytes.byteLength > this.stream.length) {
      this.stream = new Uint8Array(Math.min(bytes.byteLength, MAX_STREAM_BYTES));
    }
    const n = Math.min(bytes.byteLength, this.stream.length);
    this.stream.set(bytes.subarray(0, n));
    this.streamLength = n;
    this.closeRecord();
    this.playerCount = this.header.characterCount;
    this.recordBytes = rleRecordBytes(this.playerCount);
  }

  /** Close the run and stamp the final state hash, which is what a validator compares against. */
  end(finalStateHash: number): void {
    this.header.finalStateHash = finalStateHash | 0;
  }

  /**
   * Serialise to a single buffer.
   *
   * Allocates — but this is called once, when a run ends, never inside the loop.
   */
  encode(): Uint8Array {
    const h = this.header;
    const prefix = this.headerAndTableBytes();
    const out = new Uint8Array(prefix + this.streamLength);
    const view = new DataView(out.buffer);

    view.setUint32(HDR.MAGIC, REPLAY_MAGIC, true);
    view.setUint16(HDR.REPLAY_VERSION, h.replayVersion, true);
    view.setUint16(HDR.CONTENT_VERSION, h.contentVersion, true);
    view.setUint32(HDR.BUILD_ID, h.buildId >>> 0, true);
    view.setUint32(HDR.SEED, h.seed >>> 0, true);
    view.setUint32(HDR.TAINTED, h.tainted >>> 0, true);
    view.setUint16(HDR.STAGE_ID, h.stageId, true);
    view.setUint8(HDR.CHARACTER_COUNT, h.characterCount);
    view.setUint8(HDR.MODIFIER_COUNT, h.modifierCount);
    view.setUint32(HDR.STARTED_AT, h.startedAtUnixSec >>> 0, true);
    view.setUint32(HDR.TICK_COUNT, h.tickCount >>> 0, true);
    view.setInt32(HDR.FINAL_HASH, h.finalStateHash | 0, true);
    view.setUint32(HDR.RESERVED0, 0, true);
    view.setUint32(HDR.RESERVED1, 0, true);
    view.setUint32(HDR.RESERVED2, 0, true);

    let at = HEADER_BYTES;
    for (let i = 0; i < h.characterCount; i++) {
      view.setUint16(at, h.characterIds[i] as number, true);
      at += 2;
    }
    for (let i = 0; i < h.modifierCount; i++) {
      view.setInt32(at, h.modifiers[i] as number, true);
      at += 4;
    }
    out.set(this.stream.subarray(0, this.streamLength), prefix);
    return out;
  }
}

/** A decoded log: its header plus a view of the raw input stream, ready to be walked tick by tick. */
export interface DecodedReplay {
  header: RunHeader;
  stream: Uint8Array;
  error: ReplayError;
}

/**
 * Parse a log without simulating it.
 *
 * Validates structure before anything trusts the contents, because the caller may be a server handling
 * an arbitrary upload. Nothing here throws — a malformed log is a value, not an exception, so the
 * validation path never needs a try/catch around it.
 */
export function decodeReplay(bytes: Uint8Array, into?: RunHeader): DecodedReplay {
  const header = into ?? createRunHeader();
  const fail = (error: ReplayError): DecodedReplay => ({
    header,
    stream: bytes.subarray(0, 0),
    error,
  });

  if (bytes.byteLength < HEADER_BYTES) return fail(REPLAY_ERROR.TRUNCATED);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(HDR.MAGIC, true) !== REPLAY_MAGIC) return fail(REPLAY_ERROR.BAD_MAGIC);

  header.replayVersion = view.getUint16(HDR.REPLAY_VERSION, true);
  if (header.replayVersion !== REPLAY_VERSION) return fail(REPLAY_ERROR.VERSION_MISMATCH);

  header.contentVersion = view.getUint16(HDR.CONTENT_VERSION, true);
  header.buildId = view.getUint32(HDR.BUILD_ID, true);
  header.seed = view.getUint32(HDR.SEED, true);
  header.tainted = view.getUint32(HDR.TAINTED, true);
  header.stageId = view.getUint16(HDR.STAGE_ID, true);
  header.characterCount = view.getUint8(HDR.CHARACTER_COUNT);
  header.modifierCount = view.getUint8(HDR.MODIFIER_COUNT);
  header.startedAtUnixSec = view.getUint32(HDR.STARTED_AT, true);
  header.tickCount = view.getUint32(HDR.TICK_COUNT, true);
  header.finalStateHash = view.getInt32(HDR.FINAL_HASH, true);

  if (header.characterCount < 1 || header.characterCount > MAX_REPLAY_PLAYERS) {
    return fail(REPLAY_ERROR.BAD_PLAYER_COUNT);
  }
  if (header.modifierCount > MAX_REPLAY_MODIFIERS) return fail(REPLAY_ERROR.TRUNCATED);

  const prefix = HEADER_BYTES + header.characterCount * 2 + header.modifierCount * 4;
  if (bytes.byteLength < prefix) return fail(REPLAY_ERROR.TRUNCATED);

  let at = HEADER_BYTES;
  for (let i = 0; i < header.characterCount; i++) {
    header.characterIds[i] = view.getUint16(at, true);
    at += 2;
  }
  for (let i = 0; i < header.modifierCount; i++) {
    header.modifiers[i] = view.getInt32(at, true);
    at += 4;
  }

  // Walk the RLE stream to confirm it supplies exactly the advertised number of ticks. A log whose
  // header claims more ticks than it holds is the cheapest possible forgery, so it is rejected here
  // rather than surfacing later as a hash mismatch that looks like a determinism bug.
  const stream = bytes.subarray(prefix);
  const recordBytes = rleRecordBytes(header.characterCount);
  let ticks = 0;
  let cursor = 0;
  while (cursor + recordBytes <= stream.byteLength) {
    const count = stream[cursor] as number;
    if (count === 0) return fail(REPLAY_ERROR.TRUNCATED);
    ticks += count;
    cursor += recordBytes;
  }
  if (cursor !== stream.byteLength) return fail(REPLAY_ERROR.TRUNCATED);
  if (ticks !== header.tickCount) return fail(REPLAY_ERROR.TICK_COUNT_MISMATCH);

  return { header, stream, error: REPLAY_ERROR.NONE };
}
