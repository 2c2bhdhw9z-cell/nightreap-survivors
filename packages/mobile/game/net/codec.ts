/**
 * Binary framing. `DataView` over a preallocated `ArrayBuffer`, never JSON.
 *
 * WHY NOT JSON
 * At 60Hz with four players, JSON input batches alone would be tens of kilobytes a second of string
 * building and parsing, all of it garbage. The freeze bug we already fixed in the sprite batcher was
 * caused by ~18k small allocations a minute; a JSON netcode would be an order of magnitude worse and
 * would show up as exactly the same symptom — a game that plays fine for a minute then stutters.
 *
 * ENDIANNESS
 * Little-endian everywhere, stated explicitly on every call. `DataView` defaults to big-endian,
 * which would work but costs a byte swap on every field on every platform we ship to.
 *
 * ALLOCATION
 * A `Writer` owns one buffer for its lifetime and is reset per message. `finish()` returns a
 * subarray view — cached per power-of-two length, the same trick that fixed the batcher, because a
 * fresh `subarray` per message is a fresh object per message.
 */

import { HDR_FLAGS, HDR_PLAYER, HDR_RESERVED, HDR_TYPE, HEADER_BYTES, MAX_MESSAGE_BYTES } from "./protocol";

export class Writer {
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly viewCache = new Map<number, Uint8Array>();
  private cursor = 0;
  /** Set when a write would have overflowed. The message is then invalid, not silently truncated. */
  overflowed = false;

  constructor(capacity = MAX_MESSAGE_BYTES) {
    this.buffer = new ArrayBuffer(capacity);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  get length(): number {
    return this.cursor;
  }

  get capacity(): number {
    return this.buffer.byteLength;
  }

  /** Remaining space in bytes. Callers batching variable-length records check this before adding. */
  get remaining(): number {
    return this.buffer.byteLength - this.cursor;
  }

  /** Start a new message: resets the cursor and writes the 4-byte header. */
  begin(type: number, playerId: number, flags = 0): this {
    this.cursor = 0;
    this.overflowed = false;
    this.bytes[HDR_TYPE] = type;
    this.bytes[HDR_FLAGS] = flags;
    this.bytes[HDR_PLAYER] = playerId;
    this.bytes[HDR_RESERVED] = 0;
    this.cursor = HEADER_BYTES;
    return this;
  }

  private fits(n: number): boolean {
    if (this.cursor + n > this.buffer.byteLength) {
      this.overflowed = true;
      return false;
    }
    return true;
  }

  u8(v: number): this {
    if (this.fits(1)) this.view.setUint8(this.cursor++, v & 0xff);
    return this;
  }

  i8(v: number): this {
    if (this.fits(1)) this.view.setInt8(this.cursor++, v | 0);
    return this;
  }

  u16(v: number): this {
    if (this.fits(2)) {
      this.view.setUint16(this.cursor, v & 0xffff, true);
      this.cursor += 2;
    }
    return this;
  }

  i16(v: number): this {
    if (this.fits(2)) {
      this.view.setInt16(this.cursor, v | 0, true);
      this.cursor += 2;
    }
    return this;
  }

  u32(v: number): this {
    if (this.fits(4)) {
      this.view.setUint32(this.cursor, v >>> 0, true);
      this.cursor += 4;
    }
    return this;
  }

  i32(v: number): this {
    if (this.fits(4)) {
      this.view.setInt32(this.cursor, v | 0, true);
      this.cursor += 4;
    }
    return this;
  }

  /**
   * Length-prefixed UTF-8, used only for names and room codes — never inside a per-tick message.
   * Truncates at 255 bytes because nothing on the wire needs more and a u8 prefix keeps parsing
   * trivial.
   */
  str(s: string): this {
    let byteLength = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      byteLength += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
      if (byteLength > 255) {
        byteLength -= c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
        break;
      }
    }
    if (!this.fits(1 + byteLength)) return this;
    this.view.setUint8(this.cursor++, byteLength);
    let written = 0;
    for (let i = 0; i < s.length && written < byteLength; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) {
        this.bytes[this.cursor + written] = c;
        written += 1;
      } else if (c < 0x800) {
        this.bytes[this.cursor + written] = 0xc0 | (c >> 6);
        this.bytes[this.cursor + written + 1] = 0x80 | (c & 0x3f);
        written += 2;
      } else {
        this.bytes[this.cursor + written] = 0xe0 | (c >> 12);
        this.bytes[this.cursor + written + 1] = 0x80 | ((c >> 6) & 0x3f);
        this.bytes[this.cursor + written + 2] = 0x80 | (c & 0x3f);
        written += 3;
      }
    }
    this.cursor += written;
    return this;
  }

  /**
   * The finished message as a view over the internal buffer.
   *
   * The view is cached per power-of-two length and its `length` is the *bucket*, not the message —
   * so callers must use the returned `length` from `finishInto` when the exact size matters. For
   * WebSocket sends the exact size does matter, so `finish()` returns a right-sized cached view
   * keyed on the exact length instead; message sizes cluster tightly in practice, so the cache stays
   * small.
   */
  finish(): Uint8Array {
    const n = this.cursor;
    let v = this.viewCache.get(n);
    if (!v) {
      v = this.bytes.subarray(0, n);
      this.viewCache.set(n, v);
    }
    return v;
  }
}

export class Reader {
  private view: DataView;
  private bytes: Uint8Array;
  private cursor = 0;
  /** Set when a read ran past the end. The message should then be discarded, not acted on. */
  truncated = false;

  constructor(source: ArrayBuffer | Uint8Array) {
    if (source instanceof Uint8Array) {
      this.bytes = source;
      this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    } else {
      this.bytes = new Uint8Array(source);
      this.view = new DataView(source);
    }
    this.cursor = HEADER_BYTES;
  }

  /** Point an existing Reader at a new buffer, so the receive path allocates nothing per message. */
  reset(source: Uint8Array): this {
    this.bytes = source;
    this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    this.cursor = HEADER_BYTES;
    this.truncated = false;
    return this;
  }

  get type(): number {
    return this.bytes[HDR_TYPE] as number;
  }

  get flags(): number {
    return this.bytes[HDR_FLAGS] as number;
  }

  get playerId(): number {
    return this.bytes[HDR_PLAYER] as number;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.cursor;
  }

  private fits(n: number): boolean {
    if (this.cursor + n > this.bytes.byteLength) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  u8(): number {
    if (!this.fits(1)) return 0;
    return this.view.getUint8(this.cursor++);
  }

  i8(): number {
    if (!this.fits(1)) return 0;
    return this.view.getInt8(this.cursor++);
  }

  u16(): number {
    if (!this.fits(2)) return 0;
    const v = this.view.getUint16(this.cursor, true);
    this.cursor += 2;
    return v;
  }

  i16(): number {
    if (!this.fits(2)) return 0;
    const v = this.view.getInt16(this.cursor, true);
    this.cursor += 2;
    return v;
  }

  u32(): number {
    if (!this.fits(4)) return 0;
    const v = this.view.getUint32(this.cursor, true);
    this.cursor += 4;
    return v;
  }

  i32(): number {
    if (!this.fits(4)) return 0;
    const v = this.view.getInt32(this.cursor, true);
    this.cursor += 4;
    return v;
  }

  str(): string {
    if (!this.fits(1)) return "";
    const n = this.view.getUint8(this.cursor++);
    if (!this.fits(n)) return "";
    let out = "";
    let i = this.cursor;
    const end = this.cursor + n;
    while (i < end) {
      const b0 = this.bytes[i] as number;
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
        i += 1;
      } else if (b0 < 0xe0) {
        out += String.fromCharCode(((b0 & 0x1f) << 6) | ((this.bytes[i + 1] as number) & 0x3f));
        i += 2;
      } else {
        out += String.fromCharCode(
          ((b0 & 0x0f) << 12) |
            (((this.bytes[i + 1] as number) & 0x3f) << 6) |
            ((this.bytes[i + 2] as number) & 0x3f),
        );
        i += 3;
      }
    }
    this.cursor = end;
    return out;
  }
}
