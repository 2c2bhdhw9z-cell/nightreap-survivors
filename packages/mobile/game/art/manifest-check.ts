/**
 * Does the written list of picture positions actually describe the sheet we are about to hand the game?
 *
 * The packer already refuses to write a sheet and a list that disagree. This is the other end of the same
 * worry: the sheet and the list are two committed files, and nothing stops somebody replacing one of them
 * on its own. When that happens every sprite in the game is a few pixels out — which reads as "the art is
 * bad" rather than as "a file is stale", and it is a horrible thing to chase.
 *
 * So the game checks the pairing once at load and refuses loudly. Loudly matters: a silent fall back to
 * placeholder squares would let a broken build look like a finished one.
 */

export interface CheckedManifest {
  width: number;
  height: number;
  frames: Record<string, { x: number; y: number; w: number; h: number }>;
}

/** The largest sheet the oldest phones we support are guaranteed to hold. */
export const MAX_SHEET = 2048;

/**
 * Everything wrong with a manifest, in plain words, or an empty list.
 *
 * A list rather than the first problem found: if a sheet is stale, dozens of pictures are wrong at once
 * and seeing them together says "wrong file", where seeing one at a time says "one bad picture".
 */
export function checkManifest(manifest: CheckedManifest, sheetWidth: number, sheetHeight: number): string[] {
  const wrong: string[] = [];

  if (!isWhole(manifest.width) || !isWhole(manifest.height)) {
    wrong.push("the list does not say how big the sheet is");
    return wrong;
  }
  if (manifest.width !== sheetWidth || manifest.height !== sheetHeight) {
    wrong.push(
      `the list describes a sheet ${manifest.width}x${manifest.height} but the sheet loaded is ${sheetWidth}x${sheetHeight}`,
    );
  }
  if (manifest.width > MAX_SHEET || manifest.height > MAX_SHEET) {
    wrong.push(`the sheet is bigger than ${MAX_SHEET} across, which the oldest phones cannot hold`);
  }

  const names = Object.keys(manifest.frames);
  if (names.length === 0) wrong.push("the list names no pictures at all");

  for (const name of names) {
    const f = manifest.frames[name];
    if (!f || !isWhole(f.x) || !isWhole(f.y) || !isWhole(f.w) || !isWhole(f.h)) {
      wrong.push(`${name} has no proper position on the sheet`);
      continue;
    }
    if (f.w <= 0 || f.h <= 0) {
      wrong.push(`${name} is listed as having no size`);
      continue;
    }
    if (f.x < 0 || f.y < 0 || f.x + f.w > manifest.width || f.y + f.h > manifest.height) {
      wrong.push(`${name} is listed as sitting off the edge of the sheet`);
    }
  }

  return wrong;
}

function isWhole(value: number): boolean {
  return Number.isInteger(value);
}
