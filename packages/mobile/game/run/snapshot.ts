/**
 * Run snapshot and restore — the whole live simulation to a flat byte buffer and back.
 *
 * WHY THIS EXISTS
 * A phone takes a call, the OS reclaims memory, a player force-quits on the subway. Without this file
 * every one of those events destroys a thirty-minute run, and "the game threw away my best run" is the
 * kind of thing a player never forgives. With it, the run comes back on the same tick, with the same
 * random position, and — this is the part that matters — still counts for the leaderboard, because the
 * input log is restored alongside the world and the replay stays continuous.
 *
 * It also pays for itself three more times over: co-op host migration hands a running world to a new
 * host, the dev menu gets save states, and a crash report can carry the exact world that crashed.
 *
 * HOW IT WORKS, AND WHY IT IS REFLECTIVE
 * The obvious implementation is a hand-written serialiser listing every field of every system. That
 * implementation is also guaranteed to rot: the day somebody adds a field to `EnemyStore` and forgets to
 * add a line here, snapshots silently start restoring a subtly different world, and the bug surfaces
 * weeks later as an unreproducible desync. So instead this walks the live object graph and discovers
 * every fixed-length typed array and every numeric scalar automatically. A new field is snapshotted the
 * moment it exists, with no second place to remember.
 *
 * The walk is made deterministic by sorting keys, and its shape is hashed into a *schema fingerprint*
 * stored in the header. Add, remove or resize a field and the fingerprint changes, so an old snapshot is
 * refused rather than misread. That is the cross-version guard, and nobody has to remember to bump a
 * version number for it to work.
 *
 * WHAT IS DELIBERATELY NOT WALKED
 *   - `cues`: presentation only, excluded from the state hash, worthless a tick later.
 *   - `summary`: derived at run end from things that are snapshotted.
 *   - `recorder.stream`: variable-length by design, so it would churn the fingerprint. Handled by hand
 *     as a length-prefixed block, because the input log is exactly what keeps a resumed run legal.
 *   - Strings and arrays of content records: immutable content, re-derived on restore.
 *
 * NOT A PORTABLE FORMAT
 * Typed arrays are copied as raw platform bytes, so a snapshot is only valid on the machine and build
 * that wrote it. That is the right trade: snapshots are a local resume mechanism with a lifetime of
 * minutes. The portable, archival, cross-machine format is the replay, and it already exists.
 */

import { MODIFIERS_BY_WIRE_ID, type RunModifier } from "../sim/modifiers";
import { POWERUP_MODIFIERS_BY_WIRE_ID } from "../shop/loadout";
import { CHARACTER_MODIFIERS_BY_WIRE_ID, characterGrowthLadderForWireId } from "../characters/loadout";
import { EGG_WIRE_BASE, eggModifierFromWire } from "../sim/eggs";

/**
 * Every modifier a wire id can name: the mode catalogue plus the generated shop and character records.
 *
 * Merged here rather than in either source, so neither list has to know the other exists. The two id
 * ranges cannot overlap by construction — modes are under a hundred, shop records start at 200,000, and
 * characters start at 300,000 — and
 * the size check below is what proves that claim rather than assuming it.
 */
const BASE_MODIFIERS_BY_WIRE_ID: ReadonlyMap<number, RunModifier> = (() => {
  const map = new Map<number, RunModifier>(MODIFIERS_BY_WIRE_ID);
  for (const [id, mod] of POWERUP_MODIFIERS_BY_WIRE_ID) map.set(id, mod);
  for (const [id, mod] of CHARACTER_MODIFIERS_BY_WIRE_ID) map.set(id, mod);
  const expected =
    MODIFIERS_BY_WIRE_ID.size + POWERUP_MODIFIERS_BY_WIRE_ID.size + CHARACTER_MODIFIERS_BY_WIRE_ID.size;
  if (map.size !== expected) {
    throw new Error("a wire id collides across the mode, shop and character ranges");
  }
  for (const id of map.keys()) {
    if (id >= EGG_WIRE_BASE) {
      throw new Error(`wire id ${id} collides with the Golden Egg range`);
    }
  }
  return map;
})();

/** Resolve a wire id across modes, shop, characters, and Golden Eggs. */
function modifierForWireId(id: number): RunModifier | undefined {
  return BASE_MODIFIERS_BY_WIRE_ID.get(id) ?? eggModifierFromWire(id);
}

/** Map-shaped view so `rehydrate` keeps its existing signature. */
const ALL_MODIFIERS_BY_WIRE_ID: ReadonlyMap<number, RunModifier> = {
  get: (id: number) => modifierForWireId(id),
  has: (id: number) => modifierForWireId(id) !== undefined,
  get size() {
    return BASE_MODIFIERS_BY_WIRE_ID.size;
  },
  keys: () => BASE_MODIFIERS_BY_WIRE_ID.keys(),
  values: () => BASE_MODIFIERS_BY_WIRE_ID.values(),
  entries: () => BASE_MODIFIERS_BY_WIRE_ID.entries(),
  forEach: (cb) => BASE_MODIFIERS_BY_WIRE_ID.forEach(cb as never),
  [Symbol.iterator]: () => BASE_MODIFIERS_BY_WIRE_ID[Symbol.iterator](),
} as ReadonlyMap<number, RunModifier>;

import type { Run } from "../run/run";

/** "NRSS" — Nightreap Survivors, snapshot. */
export const SNAPSHOT_MAGIC = 0x4e525353;

/**
 * Format version, bumped only when the *container* changes.
 *
 * Changes to the simulation's fields do not need a bump — the schema fingerprint catches those.
 */
export const SNAPSHOT_VERSION = 1;

export const SNAPSHOT_HEADER_BYTES = 40;

/** Header field offsets, so the reader and writer cannot disagree about the layout. */
const SNAP = {
  magic: 0,
  version: 4,
  flags: 6,
  fingerprint: 8,
  /** Bytes actually stored after the header — compressed, if the compressed flag is set. */
  storedBytes: 12,
  checksum: 16,
  tick: 20,
  seed: 24,
  fieldCount: 28,
  /** Bytes the payload occupies once expanded. Always the uncompressed size. */
  rawBytes: 32,
  reserved: 36,
} as const;

/** Header flag bits. */
const SNAP_FLAG = {
  compressed: 1,
} as const;

/**
 * Zero-run compression, and why it is worth sixty lines.
 *
 * A snapshot is dominated by entity pools sized for the worst case — two thousand enemy slots, fifteen
 * hundred projectile slots — and in a typical mid-run moment most of those slots are empty, which in a
 * flat typed array means long runs of zero bytes. Raw, a snapshot is around half a megabyte. Writing
 * half a megabyte to storage every thirty seconds on a four-gigabyte phone is exactly the kind of
 * background cost that shows up later as a stutter nobody can explain.
 *
 * The scheme is the simplest thing that exploits the actual shape of the data: runs of zeros become a
 * count, everything else is copied verbatim. No dictionary, no entropy coding, no allocation beyond the
 * two buffers, and it decompresses at memcpy speed. A general-purpose compressor would do better on
 * ratio and worse on every other axis that matters here.
 */
const ZERO_TOKEN = 0x00;
const LITERAL_TOKEN = 0x01;
/** Shorter zero runs than this are cheaper to copy verbatim than to describe. */
const MIN_ZERO_RUN = 4;

function writeVarint(out: Uint8Array, offset: number, value: number): number {
  let v = value;
  let at = offset;
  while (v >= 0x80) {
    out[at++] = (v & 0x7f) | 0x80;
    v = Math.floor(v / 128);
  }
  out[at++] = v;
  return at;
}

function varintBytes(value: number): number {
  let v = value;
  let n = 1;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

/** Compress `raw[0..n)` into `out`, returning bytes written, or -1 when it would not be smaller. */
function compressZeroRuns(raw: Uint8Array, n: number, out: Uint8Array): number {
  let at = 0;
  let i = 0;
  while (i < n) {
    if (raw[i] === 0) {
      let end = i;
      while (end < n && raw[end] === 0) end++;
      const run = end - i;
      if (run >= MIN_ZERO_RUN) {
        if (at + 1 + varintBytes(run) > out.length) return -1;
        out[at++] = ZERO_TOKEN;
        at = writeVarint(out, at, run);
        i = end;
        continue;
      }
    }
    // Literal run: everything up to the next zero run long enough to be worth describing.
    let end = i;
    while (end < n) {
      if (raw[end] === 0) {
        let z = end;
        while (z < n && raw[z] === 0) z++;
        if (z - end >= MIN_ZERO_RUN) break;
        end = z;
        continue;
      }
      end++;
    }
    const length = end - i;
    if (at + 1 + varintBytes(length) + length > out.length) return -1;
    out[at++] = LITERAL_TOKEN;
    at = writeVarint(out, at, length);
    out.set(raw.subarray(i, end), at);
    at += length;
    i = end;
  }
  return at;
}

/** Expand into `out`. Returns bytes written, or -1 if the stream is malformed or overruns. */
function expandZeroRuns(src: Uint8Array, from: number, to: number, out: Uint8Array): number {
  let at = 0;
  let i = from;
  while (i < to) {
    const token = src[i++];
    let length = 0;
    let shift = 1;
    for (;;) {
      if (i >= to) return -1;
      const byte = src[i++];
      length += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) break;
      shift *= 128;
    }
    if (token === ZERO_TOKEN) {
      if (at + length > out.length) return -1;
      out.fill(0, at, at + length);
      at += length;
      continue;
    }
    if (token !== LITERAL_TOKEN) return -1;
    if (i + length > to || at + length > out.length) return -1;
    out.set(src.subarray(i, i + length), at);
    i += length;
    at += length;
  }
  return at;
}

export const SNAPSHOT_ERROR = {
  NONE: 0,
  TOO_SHORT: 1,
  BAD_MAGIC: 2,
  BAD_VERSION: 3,
  SCHEMA_MISMATCH: 4,
  BAD_CHECKSUM: 5,
  TRUNCATED: 6,
  RUN_OVER: 7,
} as const;

export type SnapshotError = (typeof SNAPSHOT_ERROR)[keyof typeof SNAPSHOT_ERROR];

/** Plain-English reason, for the log and for the "we could not bring your run back" screen. */
export function describeSnapshotError(code: SnapshotError): string {
  switch (code) {
    case SNAPSHOT_ERROR.NONE:
      return "ok";
    case SNAPSHOT_ERROR.TOO_SHORT:
      return "not enough bytes to be a snapshot";
    case SNAPSHOT_ERROR.BAD_MAGIC:
      return "not a snapshot file";
    case SNAPSHOT_ERROR.BAD_VERSION:
      return "snapshot container is from a different version of the game";
    case SNAPSHOT_ERROR.SCHEMA_MISMATCH:
      return "snapshot was written by a different build of the simulation";
    case SNAPSHOT_ERROR.BAD_CHECKSUM:
      return "snapshot is corrupt";
    case SNAPSHOT_ERROR.TRUNCATED:
      return "snapshot is incomplete";
    case SNAPSHOT_ERROR.RUN_OVER:
      return "snapshot is of a run that had already ended";
    default:
      return "unknown snapshot error";
  }
}

/**
 * Paths the walker never descends into. Compared against the dotted path built during the walk.
 *
 * Keep this list short and keep a reason next to every entry — an entry here is a field that is NOT
 * restored, and getting that wrong is how a snapshot restores a world that plays differently.
 */
const SKIP_PATHS: ReadonlySet<string> = new Set([
  // Presentation-only, cleared every tick, deliberately absent from the state hash.
  "cues",
  // Derived at run end by `summariseRun` from state that is snapshotted.
  "summary",
  // Variable-length by design; written by hand below so the fingerprint stays stable.
  "recorder.stream",
]);

/** How deep the walk is willing to go. Nothing legitimate in the simulation nests this far. */
const MAX_DEPTH = 8;

const KIND = {
  scalar: 0,
  i8: 1,
  u8: 2,
  i16: 3,
  u16: 4,
  i32: 5,
  u32: 6,
  f32: 7,
  f64: 8,
  u8c: 9,
} as const;

type Kind = (typeof KIND)[keyof typeof KIND];

interface Field {
  readonly path: string;
  readonly kind: Kind;
  /** The object holding the value, so a scalar can be written straight back. */
  readonly owner: Record<string, unknown>;
  readonly key: string;
  /** Element count for arrays, 1 for scalars. */
  readonly length: number;
  readonly bytes: number;
}

/** A walk result, cached per `Run` instance because the shape cannot change at runtime. */
interface Schema {
  readonly fields: readonly Field[];
  readonly fingerprint: number;
  readonly payloadBytes: number;
}

function kindOf(value: object): Kind | -1 {
  if (value instanceof Int8Array) return KIND.i8;
  if (value instanceof Uint8Array) return KIND.u8;
  if (value instanceof Uint8ClampedArray) return KIND.u8c;
  if (value instanceof Int16Array) return KIND.i16;
  if (value instanceof Uint16Array) return KIND.u16;
  if (value instanceof Int32Array) return KIND.i32;
  if (value instanceof Uint32Array) return KIND.u32;
  if (value instanceof Float32Array) return KIND.f32;
  if (value instanceof Float64Array) return KIND.f64;
  return -1;
}

function bytesPerElement(kind: Kind): number {
  switch (kind) {
    case KIND.i8:
    case KIND.u8:
    case KIND.u8c:
      return 1;
    case KIND.i16:
    case KIND.u16:
      return 2;
    case KIND.i32:
    case KIND.u32:
    case KIND.f32:
      return 4;
    default:
      return 8;
  }
}

/** FNV-1a over bytes. Fast, adequate for "did this buffer get mangled", not a security hash. */
function fnvBytes(bytes: Uint8Array, from: number, to: number, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = from; i < to; i++) {
    h = (h ^ bytes[i]) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function fnvString(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ (text.charCodeAt(i) & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Walk the run and collect every snapshottable field, in a stable order.
 *
 * Sorted keys rather than insertion order: insertion order is stable in practice but it is not a
 * guarantee anybody wrote down, and a format whose field order depends on the order somebody happened
 * to declare class members is a format waiting to break during a refactor.
 */
function buildSchema(run: Run): Schema {
  const fields: Field[] = [];
  const seen = new Set<object>();
  let fingerprint = 0x811c9dc5;
  let payloadBytes = 0;

  const visit = (node: Record<string, unknown>, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const keys = Object.keys(node).sort();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (SKIP_PATHS.has(path)) continue;
      const value = node[key];

      if (typeof value === "number" || typeof value === "boolean") {
        const field: Field = { path, kind: KIND.scalar, owner: node, key, length: 1, bytes: 8 };
        fields.push(field);
        fingerprint = fnvString(`${path}:0:1;`, fingerprint);
        payloadBytes += 8;
        continue;
      }

      if (value === null || typeof value !== "object") continue;
      const obj = value as object;
      // Two paths pointing at the same array — `owners.x` and `players.x` are the same buffer — must be
      // stored once. First path in sorted order wins, which is deterministic.
      if (seen.has(obj)) continue;

      const kind = kindOf(obj);
      if (kind !== -1) {
        seen.add(obj);
        const length = (obj as { length: number }).length;
        const bytes = length * bytesPerElement(kind);
        fields.push({ path, kind, owner: node, key, length, bytes });
        fingerprint = fnvString(`${path}:${kind}:${length};`, fingerprint);
        payloadBytes += bytes;
        continue;
      }

      // Anything array-like holding objects is content data — weapon rows, modifier records, stat
      // deltas. Immutable, shared, and re-derived on restore. Descending into it would make the
      // fingerprint depend on how many passives a player happens to be carrying.
      if (Array.isArray(obj)) continue;
      if (typeof (obj as { length?: unknown }).length === "number") continue;

      seen.add(obj);
      visit(obj as Record<string, unknown>, path, depth + 1);
    }
  };

  visit(run as unknown as Record<string, unknown>, "", 0);
  return { fields, fingerprint: fingerprint >>> 0, payloadBytes };
}

const schemaCache = new WeakMap<Run, Schema>();

function schemaFor(run: Run): Schema {
  let schema = schemaCache.get(run);
  if (schema === undefined) {
    schema = buildSchema(run);
    schemaCache.set(run, schema);
  }
  return schema;
}

/**
 * Fingerprint of the simulation's shape for this build.
 *
 * Exposed so the dev menu can show it and so a test can assert it is stable across a run — if this
 * number changes while a run is in progress, something is resizing a buffer mid-run and that is a bug
 * regardless of snapshots.
 */
export function snapshotSchemaFingerprint(run: Run): number {
  return schemaFor(run).fingerprint;
}

/** How many fields the walker found. Useful as a canary in tests: it should never silently shrink. */
export function snapshotFieldCount(run: Run): number {
  return schemaFor(run).fields.length;
}

/** Every discovered field path, for the dev menu's snapshot inspector. Allocates; not for the loop. */
export function snapshotFieldPaths(run: Run): string[] {
  return schemaFor(run).fields.map((f) => f.path);
}

/** Uncompressed payload size — the upper bound on what a snapshot can cost. */
export function snapshotRawBytes(run: Run): number {
  return schemaFor(run).payloadBytes + 4 + run.recorder.streamBytes;
}

/**
 * Capture the whole run.
 *
 * Allocates, and is allowed to: this is called when the app backgrounds, when the player pauses, and on
 * a rolling autosave measured in tens of seconds — never inside the tick.
 *
 * `compressPayload` is on by default. Turning it off trades roughly ten times the bytes for a slightly
 * faster capture, which only makes sense for an in-memory dev save state that is never written to disk.
 */
export function snapshotRun(run: Run, compressPayload = true): Uint8Array {
  // The one thing capture changes about the live run: the input log's current run-length record is
  // closed, so the recorder is in the same state a restored recorder will be in. Without this, a
  // captured run and the run restored from it would differ by a few bytes of log bookkeeping forever.
  run.recorder.closeRecord();
  const schema = schemaFor(run);
  const streamBytes = run.recorder.streamBytes;
  const rawBytes = schema.payloadBytes + 4 + streamBytes;
  const raw = new Uint8Array(rawBytes);
  const view = new DataView(raw.buffer);

  let offset = 0;
  const fields = schema.fields;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.kind === KIND.scalar) {
      const value = field.owner[field.key];
      view.setFloat64(offset, typeof value === "boolean" ? (value ? 1 : 0) : (value as number), true);
      offset += 8;
      continue;
    }
    const array = field.owner[field.key] as ArrayBufferView;
    raw.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    offset += field.bytes;
  }

  // The input log, length-prefixed. Without this a resumed run could not be revalidated, which would
  // quietly turn "resume your run" into "resume your run but it no longer counts".
  view.setUint32(offset, streamBytes, true);
  offset += 4;
  raw.set(run.recorder.streamView(), offset);
  offset += streamBytes;

  // Try compression, and keep it only if it actually won. A snapshot of a world with every slot full
  // compresses to slightly more than it started as, and in that case the raw bytes are what we store.
  const scratch = compressPayload ? new Uint8Array(rawBytes) : raw;
  const packed = compressPayload ? compressZeroRuns(raw, rawBytes, scratch) : -1;
  const compressed = packed > 0 && packed < rawBytes;
  const storedBytes = compressed ? packed : rawBytes;

  const out = new Uint8Array(SNAPSHOT_HEADER_BYTES + storedBytes);
  out.set(compressed ? scratch.subarray(0, packed) : raw, SNAPSHOT_HEADER_BYTES);

  const head = new DataView(out.buffer);
  head.setUint32(SNAP.magic, SNAPSHOT_MAGIC, true);
  head.setUint16(SNAP.version, SNAPSHOT_VERSION, true);
  head.setUint16(SNAP.flags, compressed ? SNAP_FLAG.compressed : 0, true);
  head.setUint32(SNAP.fingerprint, schema.fingerprint, true);
  head.setUint32(SNAP.storedBytes, storedBytes, true);
  head.setUint32(SNAP.tick, run.ticks, true);
  head.setUint32(SNAP.seed, run.seed, true);
  head.setUint32(SNAP.fieldCount, fields.length, true);
  head.setUint32(SNAP.rawBytes, rawBytes, true);
  head.setUint32(SNAP.reserved, 0, true);
  head.setUint32(
    SNAP.checksum,
    fnvBytes(out, SNAPSHOT_HEADER_BYTES, SNAPSHOT_HEADER_BYTES + storedBytes),
    true,
  );

  return out;
}

/** Read a snapshot's header without touching the run. For "do we have a run to resume?" screens. */
export interface SnapshotInfo {
  readonly error: SnapshotError;
  readonly tick: number;
  readonly seed: number;
  readonly fingerprint: number;
  readonly fieldCount: number;
  /** Bytes on disk after the header. Smaller than `rawBytes` when compression won. */
  readonly storedBytes: number;
  /** Bytes the payload expands to. */
  readonly rawBytes: number;
  readonly compressed: boolean;
}

export function inspectSnapshot(bytes: Uint8Array): SnapshotInfo {
  const blank = {
    tick: 0,
    seed: 0,
    fingerprint: 0,
    fieldCount: 0,
    storedBytes: 0,
    rawBytes: 0,
    compressed: false,
  };
  if (bytes.byteLength < SNAPSHOT_HEADER_BYTES) {
    return { error: SNAPSHOT_ERROR.TOO_SHORT, ...blank };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(SNAP.magic, true) !== SNAPSHOT_MAGIC) {
    return { error: SNAPSHOT_ERROR.BAD_MAGIC, ...blank };
  }
  if (view.getUint16(SNAP.version, true) !== SNAPSHOT_VERSION) {
    return { error: SNAPSHOT_ERROR.BAD_VERSION, ...blank };
  }
  return {
    error: SNAPSHOT_ERROR.NONE,
    tick: view.getUint32(SNAP.tick, true),
    seed: view.getUint32(SNAP.seed, true),
    fingerprint: view.getUint32(SNAP.fingerprint, true),
    fieldCount: view.getUint32(SNAP.fieldCount, true),
    storedBytes: view.getUint32(SNAP.storedBytes, true),
    rawBytes: view.getUint32(SNAP.rawBytes, true),
    compressed: (view.getUint16(SNAP.flags, true) & SNAP_FLAG.compressed) !== 0,
  };
}

/**
 * Check a snapshot's integrity without needing a run to put it into.
 *
 * Header, length, then checksum. Separate from `restoreRun` because the two callers that need it most
 * do not have a run yet: the write path, confirming that what came back off storage is what went down,
 * and the resume screen, which must never offer to bring back a run it cannot actually bring back.
 * Offering a resume that fails at the moment the player accepts it is worse than not offering one.
 */
export function verifySnapshot(bytes: Uint8Array): SnapshotError {
  const info = inspectSnapshot(bytes);
  if (info.error !== SNAPSHOT_ERROR.NONE) return info.error;
  const storedEnd = SNAPSHOT_HEADER_BYTES + info.storedBytes;
  if (bytes.byteLength < storedEnd) return SNAPSHOT_ERROR.TRUNCATED;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fnvBytes(bytes, SNAPSHOT_HEADER_BYTES, storedEnd) !== view.getUint32(SNAP.checksum, true)) {
    return SNAPSHOT_ERROR.BAD_CHECKSUM;
  }
  return SNAPSHOT_ERROR.NONE;
}

/**
 * Put a captured run back.
 *
 * Every rejection path here is deliberate and silent-failure-free: a snapshot we cannot fully trust is
 * refused outright rather than partially applied, because half a restored world is worse than none.
 * The caller's fallback is always the same and always safe — start a fresh run.
 */
export function restoreRun(run: Run, bytes: Uint8Array): SnapshotError {
  const info = inspectSnapshot(bytes);
  if (info.error !== SNAPSHOT_ERROR.NONE) return info.error;

  const schema = schemaFor(run);
  if (info.fingerprint !== schema.fingerprint) return SNAPSHOT_ERROR.SCHEMA_MISMATCH;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const storedEnd = SNAPSHOT_HEADER_BYTES + info.storedBytes;
  if (bytes.byteLength < storedEnd) return SNAPSHOT_ERROR.TRUNCATED;
  // The payload must at least cover every discovered field plus the input-log length prefix.
  if (info.rawBytes < schema.payloadBytes + 4) return SNAPSHOT_ERROR.TRUNCATED;

  // Checksummed over the *stored* bytes, so corruption is caught before we try to expand anything.
  if (fnvBytes(bytes, SNAPSHOT_HEADER_BYTES, storedEnd) !== view.getUint32(SNAP.checksum, true)) {
    return SNAPSHOT_ERROR.BAD_CHECKSUM;
  }

  let payload: Uint8Array;
  if (info.compressed) {
    const expanded = new Uint8Array(info.rawBytes);
    const written = expandZeroRuns(bytes, SNAPSHOT_HEADER_BYTES, storedEnd, expanded);
    if (written !== info.rawBytes) return SNAPSHOT_ERROR.TRUNCATED;
    payload = expanded;
  } else {
    if (info.storedBytes !== info.rawBytes) return SNAPSHOT_ERROR.TRUNCATED;
    payload = bytes.subarray(SNAPSHOT_HEADER_BYTES, storedEnd);
  }
  const body = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  let offset = 0;
  const fields = schema.fields;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.kind === KIND.scalar) {
      const before = field.owner[field.key];
      const value = body.getFloat64(offset, true);
      field.owner[field.key] = typeof before === "boolean" ? value !== 0 : value;
      offset += 8;
      continue;
    }
    const array = field.owner[field.key] as ArrayBufferView;
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(
      payload.subarray(offset, offset + field.bytes),
    );
    offset += field.bytes;
  }

  const streamBytes = body.getUint32(offset, true);
  offset += 4;
  if (offset + streamBytes > info.rawBytes) return SNAPSHOT_ERROR.TRUNCATED;
  run.recorder.restoreStream(payload.subarray(offset, offset + streamBytes));

  // Everything above restored the *numbers*. This rebuilds the handful of things that are object
  // references rather than numbers — which modifier records are folded in, the text on any card screen
  // that was open, and each seat's growth ladder — from those numbers. The growth resolver lets a restore
  // re-establish every seat's ladder from the character base record wire ids it just restored, so a resync
  // never depends on `begin()` having stashed the ladders on this phone.
  run.rehydrate(ALL_MODIFIERS_BY_WIRE_ID, characterGrowthLadderForWireId);

  return SNAPSHOT_ERROR.NONE;
}
