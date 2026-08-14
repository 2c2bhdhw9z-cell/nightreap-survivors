/**
 * Turning a stored run into words a person can read.
 *
 * Kept apart from the screen itself so it can be checked on its own, without a browser. Everything here is
 * a plain function of one row: same row in, same words out, no clock and no state involved. Nothing here
 * decides anything about a run — the server already did that, and a screen that recomputed a verdict would
 * eventually disagree with the record.
 */

/** Ticks are the only honest length: they were counted while the run was played, not claimed afterwards. */
export function lengthText(ticks: number): string {
  const whole = ticks < 0 ? 0 : Math.floor(ticks);
  const seconds = Math.floor(whole / 60);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${mm}:${ss < 10 ? "0" : ""}${ss}`;
}

/** Sizes as a person reads them. */
export function sizeText(bytes: number): string {
  const whole = bytes < 0 ? 0 : Math.floor(bytes);
  if (whole < 1024) return `${whole} bytes`;
  if (whole < 1024 * 1024) return `${(whole / 1024).toFixed(1)} KB`;
  return `${(whole / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * When the upload arrived, in one fixed shape.
 *
 * Always the same wording wherever the operator is sitting, because two people comparing notes on an
 * incident must be reading the same timestamp rather than their own local one.
 */
export function whenText(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

/** True when the server kept this run as a result. Refusal zero means nothing was wrong. */
export function wasKept(refusal: number): boolean {
  return refusal === 0;
}

/** The short tags shown beside a row. Purely a reading of the row: none of these is a decision. */
export function tagsFor(row: {
  refusal: number;
  flagCount: number;
  tainted: number;
  ladderEligible: boolean;
}): string[] {
  const kept = wasKept(row.refusal);
  const tags = [kept ? "Kept" : "Turned away"];
  if (row.flagCount > 0) tags.push(`${row.flagCount} worth a look`);
  if (row.tainted !== 0) tags.push("Dev tools were open");
  if (kept && !row.ladderEligible) tags.push("Not for the boards");
  return tags;
}
