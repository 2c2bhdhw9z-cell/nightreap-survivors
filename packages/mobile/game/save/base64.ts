/**
 * Base64, by hand.
 *
 * WHY BY HAND
 *
 * The save file is raw bytes and the phone's key-value store holds strings, so something has to convert
 * between them. The obvious candidates are all wrong for this job: `btoa` does not exist on Android's
 * JavaScript engine, `Buffer` is a Node thing that only appears in a React Native app by accident of
 * bundling, and a library would be a dependency on the one code path that must never fail — the one that
 * loads a player's progress.
 *
 * It is also forty lines, and it is the kind of forty lines that is either exactly right or obviously
 * broken, which is what the test is for.
 *
 * The encoder is standard base64 with padding. The decoder ignores anything that is not part of the
 * alphabet rather than throwing, because a save string that picked up a stray newline somewhere should
 * still load — and a decoder that throws inside a load is a decoder that loses a save.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reverse lookup, built once. 255 means "not part of base64". */
const VALUES = ((): Uint8Array => {
  const table = new Uint8Array(128).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += ALPHABET[(n >>> 18) & 63];
    out += ALPHABET[(n >>> 12) & 63];
    out += ALPHABET[(n >>> 6) & 63];
    out += ALPHABET[n & 63];
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHABET[(n >>> 18) & 63];
    out += ALPHABET[(n >>> 12) & 63];
    out += "==";
  } else if (left === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += ALPHABET[(n >>> 18) & 63];
    out += ALPHABET[(n >>> 12) & 63];
    out += ALPHABET[(n >>> 6) & 63];
    out += "=";
  }
  return out;
}

/**
 * Decode. Never throws.
 *
 * Anything outside the alphabet — padding, whitespace, a character that got in somehow — is skipped, and
 * a trailing group too short to be a byte is dropped. The worst case is a shorter array than expected,
 * which the save's own length and checksum checks then refuse properly, with a message.
 */
export function fromBase64(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let length = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? (VALUES[code] as number) : 255;
    if (value === 255) continue;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (acc >>> bits) & 0xff;
    }
  }
  return out.subarray(0, length);
}
