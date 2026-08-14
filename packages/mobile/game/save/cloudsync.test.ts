/**
 * Sync self-check. Run headless: `bun packages/mobile/game/save/cloudsync.test.ts`
 *
 * This file exists because the sync order is the part of the game where a bug costs a player something they
 * cannot get back. Every check below is one way of losing progress, written down and then made impossible:
 *
 *   - Pushing before keeping, so a failed write throws away everything the merge just gained.
 *   - Overwriting a cloud copy from a newer build, so an update turns into a rollback.
 *   - Pushing a local copy we already know has a number nobody can explain.
 *   - Treating a lost race as a failure instead of merging the winner in and going again.
 *   - Leaving last sync's figures on the report so a support screen prints them after a refusal.
 *
 * The locker here is a fake, and it is deliberately a nasty one: it can be offline, it can refuse, it can be
 * made to steal the race at exactly the wrong moment, and it can hand back a corrupt or future-version copy.
 * All of those are things a real server does on a bad day, and none of them need a network to test.
 */

import { decodeSave, encodeSave, SAVE_ERROR } from "./codec";
import { toBase64 } from "./base64";
import { bitSet, createSaveData, SAVE_VERSION, type SaveData } from "./schema";
import {
  CLOUD,
  type CloudReport,
  type CloudTransport,
  type PullAnswer,
  type PushAnswer,
  type PushPayload,
  type StoredCopy,
  createCloudReport,
  describeCloud,
  liveProfile,
  payloadFor,
  readCopy,
  syncProfile,
} from "./cloudsync";
import { unlockBits } from "./sync";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/* ---- profiles ------------------------------------------------------------------------------------ */

/** A profile with some progress on it. `characters` are roster positions to mark as unlocked. */
function profile(opts: {
  gold?: number;
  lifetime?: number;
  generation?: number;
  characters?: number[];
  runs?: number;
  best?: number;
}): SaveData {
  const save = createSaveData(0x1234, 1);
  // Gold defaults to the lifetime total, because that is what a profile that has never shopped looks like
  // and what the merge rebuilds a balance as. A fixture that disagrees with the rule would make a correct
  // merge look like a change and this file would test the fixture instead of the code.
  save.goldLifetime = opts.lifetime ?? 1_000;
  save.gold = opts.gold ?? save.goldLifetime;
  save.generation = opts.generation ?? 1;
  save.runsCompleted = opts.runs ?? 2;
  save.runsStarted = (opts.runs ?? 2) + 3;
  save.bestSurvivalSeconds = opts.best ?? 300;
  save.secondsPlayed = 4_000;
  for (const i of opts.characters ?? [0, 1, 2]) bitSet(save.unlockedCharacters, i);
  return save;
}

/** A stored copy of a profile, as the locker would hold it. */
function copyOf(save: SaveData, at = 1_700_000_000): StoredCopy {
  return {
    blob: toBase64(encodeSave(save)),
    generation: save.generation,
    saveVersion: save.version,
    updatedAt: at,
  };
}

/* ---- the fake locker ----------------------------------------------------------------------------- */

/**
 * A locker that behaves like the real endpoint, plus switches for every way it can misbehave.
 *
 * `stealRaces` is the interesting one: it makes the locker bump its own copy the instant before it answers a
 * push, which is exactly what a second phone pushing at the same moment looks like from here.
 */
class FakeLocker implements CloudTransport {
  stored: StoredCopy | null = null;
  offline = false;
  refuse = false;
  /** How many more pushes should lose the race. */
  stealRaces = 0;
  /** Set to make `keep` fail. */
  keepFails = false;

  pulls = 0;
  pushes = 0;
  keeps = 0;
  kept: SaveData | null = null;

  async pull(): Promise<PullAnswer> {
    this.pulls++;
    if (this.offline) return { kind: "offline" };
    if (this.refuse) return { kind: "refused" };
    if (this.stored === null) return { kind: "empty" };
    return { kind: "copy", copy: this.stored };
  }

  async push(payload: PushPayload): Promise<PushAnswer> {
    this.pushes++;
    if (this.offline) return { kind: "offline" };
    if (this.refuse) return { kind: "refused" };
    if (this.stealRaces > 0) {
      this.stealRaces--;
      // Somebody else got there first, with a copy a generation above ours.
      const thief = decodeSave(this.decoded(payload)).save;
      thief.generation = payload.generation + 1;
      bitSet(thief.unlockedCharacters, 7);
      this.stored = copyOf(thief);
      return { kind: "stale", copy: this.stored };
    }
    if (this.stored !== null && payload.generation <= this.stored.generation) {
      return { kind: "stale", copy: this.stored };
    }
    this.stored = {
      blob: payload.blob,
      generation: payload.generation,
      saveVersion: payload.saveVersion,
      updatedAt: 1_700_000_500,
    };
    return { kind: "stored", generation: payload.generation };
  }

  async keep(save: SaveData): Promise<boolean> {
    this.keeps++;
    if (this.keepFails) return false;
    this.kept = save;
    return true;
  }

  /** The bytes behind a payload, for the race thief. */
  private decoded(payload: PushPayload): Uint8Array {
    const raw = atobLike(payload.blob);
    return raw;
  }

  /** What the locker is holding, decoded. Throws if it is empty — a test asking has already checked. */
  held(): SaveData {
    if (this.stored === null) throw new Error("the locker is empty");
    const out = readCopy(this.stored);
    if (out.error !== SAVE_ERROR.NONE) throw new Error(`the locker holds an unreadable copy: ${out.error}`);
    return out.save;
  }
}

/** base64 back to bytes, using the same decoder the game uses. Kept local so the import list stays honest. */
function atobLike(text: string): Uint8Array {
  // `readCopy` already does exactly this and is tested below; reusing it keeps one decoder in play.
  const out = readCopy({ blob: text, generation: 0, saveVersion: SAVE_VERSION, updatedAt: 0 });
  return encodeSave(out.save);
}

function heldCharacters(save: SaveData): number {
  return unlockBits(save);
}

console.log("cloud sync self-check");

/* ---- an empty locker ----------------------------------------------------------------------------- */

section("a phone that has never synced");
{
  const locker = new FakeLocker();
  const local = profile({ gold: 250, characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("it backs the profile up", code === CLOUD.SEEDED, describeCloud(code));
  check("with one pull and one push", report.pulls === 1 && report.pushes === 1, `${report.pulls}/${report.pushes}`);
  check("there was nothing to merge, so nothing was written locally", report.kept === false && locker.keeps === 0);
  check("the live profile is still this device's", liveProfile(local, out, report) === local);
  check("and the locker now holds this profile", heldCharacters(locker.held()) === heldCharacters(local), `${heldCharacters(locker.held())}`);
  check("with its gold intact", locker.held().gold === 250, `${locker.held().gold}`);
}

/* ---- the ordinary two-device case ---------------------------------------------------------------- */

section("two phones with different progress");
{
  const locker = new FakeLocker();
  const local = profile({ gold: 200, lifetime: 3_000, characters: [0, 1, 2, 3], runs: 4, best: 600 });
  const remote = profile({ gold: 50, lifetime: 5_000, characters: [0, 1, 2, 6], runs: 9, best: 1_200, generation: 4 });
  locker.stored = copyOf(remote);

  const out = createSaveData();
  const report = createCloudReport();
  const code = await syncProfile(local, out, locker, report);

  check("it synced", code === CLOUD.OK, describeCloud(code));
  check("the merge was written to this device before anything was pushed", report.kept && locker.keeps === 1);
  check("the live profile is the merged one", liveProfile(local, out, report) === out);
  check("unlocks came from both sides", heldCharacters(out) === 5, `${heldCharacters(out)}`);
  check("and it says how many are new here", report.unlocksGained === 1, `${report.unlocksGained}`);
  check("the higher lifetime total wins", out.goldLifetime === 5_000, `${out.goldLifetime}`);
  check("the higher run count wins", out.runsCompleted === 9, `${out.runsCompleted}`);
  check("the better time wins", out.bestSurvivalSeconds === 1_200, `${out.bestSurvivalSeconds}`);
  check("the merged copy outranks both inputs", out.generation > local.generation && out.generation > remote.generation, `${out.generation}`);
  check("and it is what the locker holds now", locker.held().generation === out.generation, `${locker.held().generation}`);
  check("the report says what was stored", report.storedGeneration === out.generation, `${report.storedGeneration}`);
  check("this device's own copy was not written over", local.goldLifetime === 3_000, `${local.goldLifetime}`);
}

section("a phone syncing twice in a row");
{
  const locker = new FakeLocker();
  const local = profile({ characters: [0, 1, 2] });
  const out = createSaveData();
  const report = createCloudReport();

  await syncProfile(local, out, locker, report);
  const stored = locker.stored;
  const pushesAfterFirst = locker.pushes;

  const second = createSaveData();
  const code = await syncProfile(local, second, locker, report);
  check("the second sync finds nothing to do", code === CLOUD.UP_TO_DATE, describeCloud(code));
  check("and pushes nothing", locker.pushes === pushesAfterFirst, `${locker.pushes}`);
  check("the locker is untouched", locker.stored === stored);
  check("it still kept the merged copy locally", report.kept);
  check("and reports no new unlocks", report.unlocksGained === 0, `${report.unlocksGained}`);
}

/* ---- the network being the network --------------------------------------------------------------- */

section("a phone with no connection");
{
  const locker = new FakeLocker();
  locker.offline = true;
  const local = profile({ gold: 777 });
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("it says so plainly", code === CLOUD.OFFLINE, describeCloud(code));
  check("nothing was pushed", locker.pushes === 0);
  check("nothing was written", locker.keeps === 0 && !report.kept);
  check("the profile is untouched", local.gold === 777);
  check("and the live profile is this device's", liveProfile(local, out, report) === local);
}

section("a profile that is not this device's");
{
  const locker = new FakeLocker();
  locker.refuse = true;
  const local = profile({});
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("it says so", code === CLOUD.REFUSED, describeCloud(code));
  check("and does not try to push anyway", locker.pushes === 0);
}

section("a push that fails after the merge was kept");
{
  const locker = new FakeLocker();
  locker.stored = copyOf(profile({ characters: [0, 1, 2, 6], generation: 3 }));
  const local = profile({ characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report = createCloudReport();

  // Offline switched on only once the merge has been kept, which is the moment the ordering matters.
  const realKeep = locker.keep.bind(locker);
  locker.keep = async (save: SaveData) => {
    const ok = await realKeep(save);
    locker.offline = true;
    return ok;
  };

  const code = await syncProfile(local, out, locker, report);
  check("the player keeps what they gained", code === CLOUD.KEPT_NOT_PUSHED, describeCloud(code));
  check("the merge is on this device", report.kept && heldCharacters(out) === 5, `${heldCharacters(out)}`);
  check("and the live profile is the merged one", liveProfile(local, out, report) === out);
  check("the locker still holds the older copy", locker.stored?.generation === 3, `${locker.stored?.generation}`);
}

section("a merge that cannot be written to this device");
{
  const locker = new FakeLocker();
  locker.stored = copyOf(profile({ characters: [0, 1, 2, 6], generation: 3 }));
  locker.keepFails = true;
  const local = profile({ characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("it stops there", code === CLOUD.KEEP_FAILED, describeCloud(code));
  check("nothing was pushed, because nothing was kept", locker.pushes === 0);
  check("and the live profile is this device's untouched one", liveProfile(local, out, report) === local);
}

/* ---- races ---------------------------------------------------------------------------------------- */

section("another phone pushing at the same moment");
{
  const locker = new FakeLocker();
  locker.stored = copyOf(profile({ characters: [0, 1, 2, 6], generation: 3 }));
  locker.stealRaces = 1;
  const local = profile({ characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("the race is merged in, not reported as a failure", code === CLOUD.OK, describeCloud(code));
  check("it took two pushes", report.pushes === 2, `${report.pushes}`);
  check("and it says it retried", report.retried && report.secondMerge);
  check("the winner's unlock survived", heldCharacters(locker.held()) === 6, `${heldCharacters(locker.held())}`);
  check("along with both of ours", heldCharacters(liveProfile(local, out, report)) === 6);
  check("the live profile is the second merge", liveProfile(local, out, report) === local);
  // Two merges happened, each handing over one character this device did not have. The figure the player is
  // shown has to be both of them: a second merge that reports only its own gain forgets the first one.
  check("both gains are counted, not just the last merge's", report.unlocksGained === 2, `${report.unlocksGained}`);
  check("which is what the locker holds", locker.held().generation === local.generation, `${locker.held().generation}`);
}

section("a phone that keeps losing the race");
{
  const locker = new FakeLocker();
  locker.stored = copyOf(profile({ characters: [0, 1, 2, 6], generation: 3 }));
  locker.stealRaces = 5;
  const local = profile({ characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("it gives up rather than looping", code === CLOUD.RACED_OUT, describeCloud(code));
  check("after exactly two pushes", report.pushes === 2, `${report.pushes}`);
  check("but everything it merged is on this device", report.kept);
  check("so nothing was lost", heldCharacters(liveProfile(local, out, report)) >= 5);
}

section("a locker that fills up between the pull and the push");
{
  const locker = new FakeLocker();
  const local = profile({ characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report = createCloudReport();

  // Empty when pulled, occupied by the time we push. Without the fall-through this would report a failure
  // and leave the other phone's progress to be discovered by somebody else later.
  locker.stealRaces = 1;
  const code = await syncProfile(local, out, locker, report);
  check("it merges instead of failing", code === CLOUD.OK, describeCloud(code));
  check("and the other phone's unlock is kept", heldCharacters(locker.held()) >= 5, `${heldCharacters(locker.held())}`);
  check("the merge was written locally", report.kept);
}

/* ---- copies we must not touch --------------------------------------------------------------------- */

section("a cloud copy from a newer version of the game");
{
  const locker = new FakeLocker();
  const bytes = encodeSave(profile({ characters: [0, 1, 2, 6], generation: 9 }));
  new DataView(bytes.buffer).setUint16(4, SAVE_VERSION + 1, true);
  locker.stored = { blob: toBase64(bytes), generation: 9, saveVersion: SAVE_VERSION + 1, updatedAt: 1 };
  const before = locker.stored;
  const local = profile({ characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("it is left alone", code === CLOUD.REMOTE_TOO_NEW, describeCloud(code));
  check("not overwritten", locker.stored === before);
  check("and nothing was written locally either", !report.kept && locker.keeps === 0);
}

section("a cloud copy that is damaged");
{
  const locker = new FakeLocker();
  const bytes = encodeSave(profile({ characters: [0, 1, 2, 6], generation: 9 }));
  bytes[70] = (bytes[70] as number) ^ 0xff;
  locker.stored = { blob: toBase64(bytes), generation: 9, saveVersion: SAVE_VERSION, updatedAt: 1 };
  const local = profile({ characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("it is reported, not merged", code === CLOUD.BAD_REMOTE, describeCloud(code));
  check("nothing local changed", !report.kept && local.gold === 1_000, `${local.gold}`);
  check("and nothing was pushed over it", locker.pushes === 0);
}

section("a local profile with a number nobody can explain");
{
  const locker = new FakeLocker();
  locker.stored = copyOf(profile({ characters: [0, 1, 2, 6], generation: 3 }));
  const local = profile({ characters: [0, 1, 2, 3] });
  local.gold = -1;
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("it refuses before touching the network", code === CLOUD.BAD_LOCAL, describeCloud(code));
  check("nothing was pulled or pushed", report.pulls === 0 && locker.pushes === 0);
  check("and the report names the field", report.merge.badField === "gold", report.merge.badField);
  check("the good cloud copy is untouched", locker.stored?.generation === 3);
}

/* ---- the report ----------------------------------------------------------------------------------- */

section("the report never carries figures from last time");
{
  const locker = new FakeLocker();
  locker.stored = copyOf(profile({ characters: [0, 1, 2, 6], generation: 3, lifetime: 9_000 }));
  const local = profile({ characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report: CloudReport = createCloudReport();

  const first = await syncProfile(local, out, locker, report);
  check("the first sync worked", first === CLOUD.OK, describeCloud(first));
  check("and filled the report", report.unlocksGained > 0 && report.pushes > 0 && report.kept);

  locker.offline = true;
  const second = await syncProfile(local, createSaveData(), locker, report);
  check("the second sync is offline", second === CLOUD.OFFLINE, describeCloud(second));
  check("the push count was wiped", report.pushes === 0, `${report.pushes}`);
  check("the unlock figure was wiped", report.unlocksGained === 0, `${report.unlocksGained}`);
  check("the kept flag was wiped", !report.kept);
  check("the retry flags were wiped", !report.retried && !report.secondMerge);
  check("the stored generation was wiped", report.storedGeneration === -1, `${report.storedGeneration}`);
  check("and so was the merge inside it", report.merge.goldMerged === 0 && report.merge.unlocksMerged === 0);
}

section("a sync that will make the visible balance drop says so");
{
  const locker = new FakeLocker();
  // The other phone spent its gold in the shop, so the rebuilt balance is lower than this phone's.
  const remote = profile({ gold: 0, lifetime: 4_000, characters: [0, 1, 2, 6], generation: 3 });
  remote.powerUpLevels[0] = 3;
  locker.stored = copyOf(remote);
  const local = profile({ gold: 3_500, lifetime: 4_000, characters: [0, 1, 2, 3] });
  const out = createSaveData();
  const report = createCloudReport();

  const code = await syncProfile(local, out, locker, report);
  check("the sync still happens", code === CLOUD.OK, describeCloud(code));
  check("but the drop is flagged for the prompt", report.goldDrops, `${out.gold} from ${local.gold}`);
  check("and the balance never goes below nothing", out.gold >= 0, `${out.gold}`);
}

/* ---- the small parts ------------------------------------------------------------------------------ */

section("the payload is derived, never taken on trust");
{
  const local = profile({ gold: 1, lifetime: 2_222, characters: [0, 1, 2, 3, 6], generation: 12 });
  const payload = payloadFor(local);
  check("the generation is the profile's", payload.generation === 12, `${payload.generation}`);
  check("the lifetime total is the profile's", payload.goldLifetime === 2_222, `${payload.goldLifetime}`);
  check("the unlock count is counted, not passed in", payload.unlockBits === unlockBits(local), `${payload.unlockBits}`);
  check("the byte count matches the blob", payload.bytes === payload.blob.length, `${payload.bytes}`);
  check("and the blob reads back as the same profile", readCopy({ blob: payload.blob, generation: 12, saveVersion: payload.saveVersion, updatedAt: 0 }).save.goldLifetime === 2_222);
}

section("reading a copy tells damage apart from a newer version");
{
  const good = copyOf(profile({}));
  check("a good copy reads", readCopy(good).error === SAVE_ERROR.NONE, `${readCopy(good).error}`);

  const bytes = encodeSave(profile({}));
  new DataView(bytes.buffer).setUint16(4, SAVE_VERSION + 1, true);
  const future = { blob: toBase64(bytes), generation: 1, saveVersion: SAVE_VERSION + 1, updatedAt: 0 };
  check("a newer one is named as newer", readCopy(future).error === SAVE_ERROR.FUTURE_VERSION, `${readCopy(future).error}`);

  const nonsense = { blob: "not base64 at all!!", generation: 1, saveVersion: SAVE_VERSION, updatedAt: 0 };
  check("nonsense does not throw", readCopy(nonsense).error !== SAVE_ERROR.NONE, `${readCopy(nonsense).error}`);
}

section("the codes are usable in a bug report");
{
  const seen = new Set<number>();
  for (const [name, code] of Object.entries(CLOUD)) {
    check(`${name} has a distinct number`, !seen.has(code), `${code}`);
    seen.add(code);
    check(`  and a sentence`, describeCloud(code).length > 0 && !describeCloud(code).startsWith("unknown"), describeCloud(code));
  }
  check("an unknown code does not crash", describeCloud(99).startsWith("unknown"), describeCloud(99));
}

console.log(`\n${checks - failures}/${checks} checks passed`);

if (failures > 0) {
  console.log(`FAIL — ${failures} problem(s) in cloud sync`);
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`cloud sync: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
console.log("PASS — cloud sync");
