/**
 * One sync, start to finish: pull the cloud copy, merge it, keep it, push it back.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE THING THAT TALKS TO THE NETWORK
 *
 * Everything that can go wrong with a sync is an ORDERING problem, not a networking problem: merging before
 * writing, writing before merging, pushing a copy that was never kept, giving up on a race instead of
 * retrying it once. Those are the bugs that silently halve a player's profile, and none of them need a
 * network to reproduce. So the order lives here, behind an injected transport, and is tested against a fake
 * locker that can be made to do every rude thing a real one can — refuse, vanish, lose a race, come back
 * with a save from a newer build. `lib/cloud-sync.ts` is the twenty lines that plug a real server in.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER
 *
 *   1. Check the local copy first. A profile with a number nobody can explain is not pushed anywhere; the
 *      cloud copy is the good one in that case and overwriting it would be the last mistake we ever make.
 *   2. Pull. An empty locker is the normal first-run answer, not a failure.
 *   3. Merge into a THIRD profile. Never into either input — `mergeSaves` refuses that outright.
 *   4. Keep it locally BEFORE pushing. If the push then fails the device still has everything it gained,
 *      and the next sync merges again; merging is idempotent, so a repeat costs nothing. The other order
 *      loses the merge whenever the write fails.
 *   5. Push. A refused push means somebody else pushed while we were merging: merge THEIR copy in and push
 *      once more. Exactly once more — a third attempt against a phone that is pushing in a loop is a
 *      battery drain that never ends, and the next sync will pick it up anyway.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 *
 * It will not overwrite a cloud copy written by a newer build. A save from a newer version is a save this
 * build cannot read every field of, and a merge that quietly drops fields it does not recognise is how an
 * update loses a player's progress. That answer is `REMOTE_TOO_NEW`, and the honest thing to tell the
 * player is to update the game.
 *
 * It will not delete anything, anywhere, ever. There is no path through this file that removes a save, a
 * bit or a row.
 */

import { decodeSave, encodeSave, SAVE_ERROR } from "./codec";
import { fromBase64, toBase64 } from "./base64";
import type { SaveData } from "./schema";
import { createMergeReport, faultIn, goldWouldDrop, mergeSaves, type MergeReport, SYNC, unlockBits } from "./sync";

/** How the whole sync ended. Append-only: these numbers reach bug reports and support screens. */
export const CLOUD = {
  /** Merged, kept, and the merged copy is now the one in the locker. The happy path. */
  OK: 0,
  /** The locker was empty. This device's copy is now in it, unchanged. */
  SEEDED: 1,
  /** Nothing to do: the locker already held this exact copy. */
  UP_TO_DATE: 2,
  /** Merged and kept on this device, but the locker still has the older copy. Safe to retry later. */
  KEPT_NOT_PUSHED: 3,
  /** The network did not answer. Nothing was changed anywhere. */
  OFFLINE: 4,
  /** The server refused us: wrong profile, or wrong device secret. Nothing was changed. */
  REFUSED: 5,
  /** This device's copy has a value that cannot be trusted. Nothing was sent. */
  BAD_LOCAL: 6,
  /** The cloud copy could not be read, or would not merge. Nothing local was changed. */
  BAD_REMOTE: 7,
  /** The cloud copy was written by a newer build. Left alone on purpose. */
  REMOTE_TOO_NEW: 8,
  /** Two devices pushed while we merged, twice running. Nothing lost; the next sync will finish it. */
  RACED_OUT: 9,
  /** The merged copy could not be written to this device, so it was not pushed either. */
  KEEP_FAILED: 10,
} as const;

export type CloudCode = (typeof CLOUD)[keyof typeof CLOUD];

/** Plain English, for a support screen and for a log line. Not marketing copy — accuracy first. */
export const CLOUD_NAMES: Readonly<Record<CloudCode, string>> = {
  [CLOUD.OK]: "synced",
  [CLOUD.SEEDED]: "this profile is now backed up",
  [CLOUD.UP_TO_DATE]: "already up to date",
  [CLOUD.KEPT_NOT_PUSHED]: "kept on this device, not yet backed up",
  [CLOUD.OFFLINE]: "no connection",
  [CLOUD.REFUSED]: "that profile does not belong to this device",
  [CLOUD.BAD_LOCAL]: "this device's save could not be trusted, so nothing was sent",
  [CLOUD.BAD_REMOTE]: "the backed-up save could not be read",
  [CLOUD.REMOTE_TOO_NEW]: "the backed-up save needs a newer version of the game",
  [CLOUD.RACED_OUT]: "another device was saving at the same time",
  [CLOUD.KEEP_FAILED]: "the merged save could not be written to this device",
};

export function describeCloud(code: number): string {
  return CLOUD_NAMES[code as CloudCode] ?? `unknown sync code ${code}`;
}

/** A stored copy as the locker hands it back. `blob` is base64 of the save bytes. */
export interface StoredCopy {
  blob: string;
  generation: number;
  saveVersion: number;
  updatedAt: number;
}

/** What gets sent up. Everything except `blob` is a summary the server files but never reads into. */
export interface PushPayload {
  blob: string;
  bytes: number;
  generation: number;
  saveVersion: number;
  buildId: number;
  unlockBits: number;
  goldLifetime: number;
}

export type PullAnswer =
  | { kind: "empty" }
  | { kind: "copy"; copy: StoredCopy }
  | { kind: "refused" }
  | { kind: "offline" };

export type PushAnswer =
  | { kind: "stored"; generation: number }
  | { kind: "stale"; copy: StoredCopy }
  | { kind: "refused" }
  | { kind: "offline" };

/**
 * The three things this file needs from the outside world.
 *
 * Nothing here may throw. A transport that throws is a transport whose failure mode nobody chose, and the
 * whole point of this seam is that every failure is one of the answers above.
 */
export interface CloudTransport {
  pull(): Promise<PullAnswer>;
  push(payload: PushPayload): Promise<PushAnswer>;
  /** Write the merged profile to this device. `false` means it did not land. */
  keep(save: SaveData): Promise<boolean>;
}

/** What a sync did, in figures a screen can print without doing any arithmetic of its own. */
export interface CloudReport {
  code: CloudCode;
  /** The merge's own report, for the gold and unlock figures. */
  merge: MergeReport;
  pulls: number;
  pushes: number;
  /** True when the first push lost a race and a second was needed. */
  retried: boolean;
  /** Generation of the copy that was in the locker when we started, or -1 for an empty locker. */
  remoteGeneration: number;
  /** Generation of what is in the locker now, or -1 if nothing was stored. */
  storedGeneration: number;
  /** True when the merged copy reached this device's storage. */
  kept: boolean;
  /**
   * True when a second merge was needed, which is the only case where the merged profile ends up in the
   * object that arrived as `local`. Nobody should have to work that out at a call site — `liveProfile` reads
   * this flag and answers with the right object.
   */
  secondMerge: boolean;
  /** How many unlock bits this device held before the sync. The baseline `unlocksGained` is measured from. */
  unlocksBefore: number;
  /**
   * True when merging would have made the visible gold balance go DOWN.
   *
   * Not an error and not refused — it is the honest consequence of a balance being rebuilt from lifetime
   * earnings minus what the shop is holding, when the other device spent more than this one did. It is here
   * so the sync prompt can say so before the player notices their gold shrank.
   */
  goldDrops: boolean;
  /** How many unlocks this device did not have before the sync. The number worth showing. */
  unlocksGained: number;
}

export function createCloudReport(): CloudReport {
  return {
    code: CLOUD.OK,
    merge: createMergeReport(),
    pulls: 0,
    pushes: 0,
    retried: false,
    remoteGeneration: -1,
    storedGeneration: -1,
    kept: false,
    secondMerge: false,
    unlocksBefore: 0,
    goldDrops: false,
    unlocksGained: 0,
  };
}

/**
 * Empty a report, including the merge report inside it.
 *
 * Every field, not just the code. A report is reused between syncs and a stale figure sitting behind a
 * refusal is a lie a support screen will happily print.
 */
export function resetCloudReport(report: CloudReport): void {
  report.code = CLOUD.OK;
  report.merge.code = SYNC.OK;
  report.merge.badField = "";
  report.merge.goldReconstructed = false;
  report.merge.goldLocal = 0;
  report.merge.goldRemote = 0;
  report.merge.goldMerged = 0;
  report.merge.invested = 0;
  report.merge.unlocksLocal = 0;
  report.merge.unlocksRemote = 0;
  report.merge.unlocksMerged = 0;
  report.merge.unlocksGained = 0;
  report.merge.settingsFrom = "local";
  report.merge.generation = 0;
  report.pulls = 0;
  report.pushes = 0;
  report.retried = false;
  report.remoteGeneration = -1;
  report.storedGeneration = -1;
  report.kept = false;
  report.secondMerge = false;
  report.unlocksBefore = 0;
  report.goldDrops = false;
  report.unlocksGained = 0;
}

/** Build the payload for a profile. The summary fields are derived, never passed in and trusted. */
export function payloadFor(save: SaveData): PushPayload {
  const bytes = encodeSave(save);
  const blob = toBase64(bytes);
  return {
    blob,
    bytes: blob.length,
    generation: save.generation,
    saveVersion: save.version,
    buildId: save.buildId,
    unlockBits: unlockBits(save),
    goldLifetime: save.goldLifetime,
  };
}

/**
 * Read a stored copy into a profile.
 *
 * Returns the decode error, so a copy from a newer build can be told apart from a corrupt one — those two
 * want completely different answers from the caller, and "it did not work" would hide the difference.
 */
export function readCopy(copy: StoredCopy): { error: number; save: SaveData } {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(copy.blob);
  } catch {
    return { error: SAVE_ERROR.BAD_MAGIC, save: decodeSave(undefined).save };
  }
  const out = decodeSave(bytes);
  return { error: out.error, save: out.save };
}

/** Which of our codes a decode error becomes. Only one of them is worth a different sentence. */
function codeForDecode(error: number): CloudCode {
  return error === SAVE_ERROR.FUTURE_VERSION ? CLOUD.REMOTE_TOO_NEW : CLOUD.BAD_REMOTE;
}

/**
 * Merge a stored copy into `out` and report. Returns a code, `CLOUD.OK` meaning `out` is now the merge.
 *
 * Split out because it happens twice: once for the copy we pulled, and again for the copy a lost race hands
 * back. Doing it twice by hand is how the second one ends up subtly different from the first.
 */
function mergeCopy(local: SaveData, copy: StoredCopy, out: SaveData, report: CloudReport): CloudCode {
  const read = readCopy(copy);
  if (read.error !== SAVE_ERROR.NONE) return codeForDecode(read.error);
  report.goldDrops = report.goldDrops || goldWouldDrop(local, read.save);
  const merged = mergeSaves(local, read.save, out, report.merge);
  if (merged !== SYNC.OK) {
    return merged === SYNC.VERSION_TOO_NEW ? CLOUD.REMOTE_TOO_NEW : CLOUD.BAD_REMOTE;
  }
  // Measured against what this device held when the sync STARTED, not against the input to this particular
  // merge. A sync can merge twice, and the second merge's own figure would forget the first one's gains.
  report.unlocksGained = report.merge.unlocksMerged - report.unlocksBefore;
  return CLOUD.OK;
}

/**
 * Do one sync.
 *
 * `local` is this device's profile and is never written to — the merge goes into `out`, and `out` is what the
 * caller should treat as the live profile afterwards, but only when the report says it was kept. `report` is
 * caller-owned and reused.
 */
export async function syncProfile(
  local: SaveData,
  out: SaveData,
  transport: CloudTransport,
  report: CloudReport,
): Promise<CloudCode> {
  resetCloudReport(report);
  report.unlocksBefore = unlockBits(local);

  // A local copy we cannot vouch for is not pushed over a cloud copy that might be fine.
  const fault = faultIn(local);
  if (fault !== "") {
    report.merge.badField = fault;
    report.code = CLOUD.BAD_LOCAL;
    return report.code;
  }

  const pulled = await transport.pull();
  report.pulls++;
  if (pulled.kind === "offline") {
    report.code = CLOUD.OFFLINE;
    return report.code;
  }
  if (pulled.kind === "refused") {
    report.code = CLOUD.REFUSED;
    return report.code;
  }

  // An empty locker: back the profile up as it stands. No merge, because there is nothing to merge with.
  if (pulled.kind === "empty") {
    const answer = await transport.push(payloadFor(local));
    report.pushes++;
    if (answer.kind === "stored") {
      report.storedGeneration = answer.generation;
      report.code = CLOUD.SEEDED;
      return report.code;
    }
    if (answer.kind === "offline") {
      report.code = CLOUD.OFFLINE;
      return report.code;
    }
    if (answer.kind === "refused") {
      report.code = CLOUD.REFUSED;
      return report.code;
    }
    // Somebody filled the locker between our pull and our push. Fall through to the merge path with the
    // copy they gave us rather than pretending the locker was empty.
    report.retried = true;
    return await mergeAndPush(local, out, transport, report, answer.copy);
  }

  report.remoteGeneration = pulled.copy.generation;
  return await mergeAndPush(local, out, transport, report, pulled.copy);
}

/**
 * Merge a copy in, keep the result, push it, and handle losing one race.
 *
 * The retry is deliberately capped at one. A phone that keeps losing is a phone whose next sync will win;
 * looping here would spend a battery arguing.
 */
async function mergeAndPush(
  local: SaveData,
  out: SaveData,
  transport: CloudTransport,
  report: CloudReport,
  copy: StoredCopy,
): Promise<CloudCode> {
  const merged = mergeCopy(local, copy, out, report);
  if (merged !== CLOUD.OK) {
    report.code = merged;
    return report.code;
  }

  // Nothing new to say, and nothing to push: the locker already holds everything this device has. Checked
  // by unlock count and totals rather than by bytes, because two devices with identical progress can still
  // write different bytes — a settings tweak, a different save time.
  const same =
    report.merge.unlocksGained === 0 &&
    report.merge.goldMerged === report.merge.goldRemote &&
    copy.generation >= local.generation &&
    report.merge.unlocksMerged === report.merge.unlocksRemote;

  // Kept BEFORE pushing, always. See the ordering note at the top of the file.
  const kept = await transport.keep(out);
  report.kept = kept;
  if (!kept) {
    report.code = CLOUD.KEEP_FAILED;
    return report.code;
  }

  if (same) {
    report.storedGeneration = copy.generation;
    report.code = CLOUD.UP_TO_DATE;
    return report.code;
  }

  const first = await transport.push(payloadFor(out));
  report.pushes++;
  if (first.kind === "stored") {
    report.storedGeneration = first.generation;
    report.code = CLOUD.OK;
    return report.code;
  }
  if (first.kind === "offline" || first.kind === "refused") {
    // The merge is safe on this device. The locker is behind, and the next sync will catch it up.
    report.code = first.kind === "offline" ? CLOUD.KEPT_NOT_PUSHED : CLOUD.REFUSED;
    return report.code;
  }

  // Lost a race. Merge whatever landed while we were working — into `local`'s place this time, since `out`
  // already holds everything `local` had — and try exactly once more.
  report.retried = true;
  report.secondMerge = true;
  const second = mergeCopy(out, first.copy, local, report);
  if (second !== CLOUD.OK) {
    report.code = second;
    return report.code;
  }
  const keptAgain = await transport.keep(local);
  report.kept = keptAgain;
  if (!keptAgain) {
    report.code = CLOUD.KEEP_FAILED;
    return report.code;
  }
  const again = await transport.push(payloadFor(local));
  report.pushes++;
  if (again.kind === "stored") {
    report.storedGeneration = again.generation;
    report.code = CLOUD.OK;
    return report.code;
  }
  report.code = again.kind === "refused" ? CLOUD.REFUSED : again.kind === "offline" ? CLOUD.KEPT_NOT_PUSHED : CLOUD.RACED_OUT;
  return report.code;
}

/**
 * Which profile the caller should treat as live after `syncProfile`.
 *
 * Two merges can happen in one sync and the second writes into the object that came in as `local`, which
 * reads like a trap and is exactly why nobody should work this out at the call site.
 */
export function liveProfile(local: SaveData, out: SaveData, report: CloudReport): SaveData {
  if (!report.kept) return local;
  return report.secondMerge ? local : out;
}
