/**
 * Save layer self-check. Run headless: `bun packages/mobile/game/save/save.test.ts`
 *
 * The failure this file exists to prevent is a player losing a profile, which on a free mobile game means
 * an uninstall and a one-star review. So it does not test the happy path and stop — it tears writes,
 * corrupts bytes, fills the disk, and checks that the worst outcome is losing one run.
 *
 * WHAT IT PROVES
 *   1. Round trip is exact, field for field, including every bitset and every setting.
 *   2. The layout is fixed-size and the size is known, so a wrong length is caught before any field is read.
 *   3. Every corruption of every byte region is caught by the checksum, not silently loaded.
 *   4. A torn write destroys only the slot being written; the previous save still loads.
 *   5. A backend that fails, or lies about succeeding, does not advance the good slot.
 *   6. Writes alternate slots, so the good copy is never the one being overwritten.
 *   7. A newer save version is refused rather than misread.
 *   8. Load falls back current → previous → fresh, and reports which rung it landed on.
 */

import { TAINT } from "../replay/format";
import {
  SAVE_ERROR,
  decodeSave,
  describeSaveError,
  encodeSave,
  saveBytes,
  saveBytesFor,
  saveChecksum,
} from "./codec";
import {
  CHAT_KEYBOARD,
  HUD_ALIGN,
  SAVE_LIMITS,
  SAVE_OLDEST_READABLE,
  SAVE_VERSION,
  bitCount,
  bitGet,
  bitSet,
  createSaveData,
  defaultSettings,
  noteTaint,
} from "./schema";
import { CHARACTERS, CHAR_UNLOCK } from "../characters/roster";
import { LOAD_SOURCE, MemoryBackend, SLOT_KEYS, SaveStore } from "./store";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
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

/** A profile with something in every field, so a missed field shows up as a mismatch. */
function populated() {
  const save = createSaveData(0xfeedface, 3);
  save.gold = 1_234_567;
  save.goldLifetime = 9_876_543;
  save.runsStarted = 412;
  save.runsCompleted = 77;
  save.secondsPlayed = 601_233;
  save.bestSurvivalSeconds = 1_921;
  noteTaint(save, TAINT.DEV_TOGGLE | TAINT.GRANTED);

  bitSet(save.unlockedCharacters, 0);
  bitSet(save.unlockedCharacters, 7);
  bitSet(save.unlockedCharacters, 8);
  bitSet(save.unlockedCharacters, 511);
  bitSet(save.unlockedWeapons, 1);
  bitSet(save.unlockedWeapons, 40);
  bitSet(save.unlockedStages, 4);
  bitSet(save.unlockedArcanas, 21);
  bitSet(save.achievements, 149);
  bitSet(save.achievements, 2047);
  save.powerUpLevels[0] = 5;
  save.powerUpLevels[31] = 255;
  save.masteryLevels[100] = 12;
  save.ascensionTiers[0] = 9;
  save.ascensionTiers[7] = 65535;

  save.settings = {
    ...defaultSettings(),
    masterVolume: 33,
    colorblindMode: 2,
    vfxLevel: 1,
    damageNumbers: 0,
    screenShake: 40,
    hudScale: 140,
    joystickSize: 92,
    telemetryOptIn: true,
    customNameOptIn: true,
    chatKeyboard: CHAT_KEYBOARD.IN_GAME,
    batterySaver: true,
    chatEnabled: false,
    dailyReminderAsked: true,
    insectFreeSprites: true,
    autoAim: true,
    speedrunToolkit: true,
    hudBadgesDocked: false,
    hudBadgeAlign: HUD_ALIGN.RIGHT,
    hudBadgeX: 71,
    hudBadgeY: 33,
    hudTopStripScale: 120,
    hudSlotStripScale: 85,
    hudBadgeScale: 150,
    hudStickScale: 60,
  };
  // Times on three of the five places, and on the very last slot the record has room for, because an
  // off-by-one at the end of a fixed block is exactly the bug this layout can have.
  save.stageBestSeconds[0] = 1_805;
  save.stageBestSeconds[3] = 640;
  save.stageBestSeconds[SAVE_LIMITS.stageBestCount - 1] = 65_535;
  return save;
}

/* ---- 1/2. round trip ---------------------------------------------------------------------------- */

section("round trip");
{
  const save = populated();
  const bytes = encodeSave(save);
  check("size is fixed and known", bytes.length === saveBytes(), `${bytes.length} bytes`);
  check(
    "a save is small enough to write often",
    bytes.length < 4096,
    `${bytes.length} bytes — cheap to write at run end, on settings change, and on background`,
  );

  const back = decodeSave(bytes);
  check("decodes cleanly", back.error === SAVE_ERROR.NONE, describeSaveError(back.error));

  const a = save;
  const b = back.save;
  check("version recorded", b.version === SAVE_VERSION);
  check("scalars survive", b.gold === a.gold && b.goldLifetime === a.goldLifetime && b.runsStarted === a.runsStarted);
  check("build and content version survive", b.buildId === a.buildId && b.contentVersion === a.contentVersion);
  check("best time survives", b.bestSurvivalSeconds === a.bestSurvivalSeconds);
  check(
    "the best time on each stage survives",
    b.stageBestSeconds[0] === a.stageBestSeconds[0] &&
      b.stageBestSeconds[3] === a.stageBestSeconds[3] &&
      b.stageBestSeconds[SAVE_LIMITS.stageBestCount - 1] === a.stageBestSeconds[SAVE_LIMITS.stageBestCount - 1],
    `${b.stageBestSeconds[0]}/${b.stageBestSeconds[3]}/${b.stageBestSeconds[SAVE_LIMITS.stageBestCount - 1]}`,
  );
  check(
    "and stages nobody has played are still zero",
    b.stageBestSeconds[7] === 0 && b.stageBestSeconds[11] === 0,
  );
  check("everTainted survives", b.everTainted === a.everTainted);

  const bitsetsMatch =
    bitGet(b.unlockedCharacters, 0) &&
    bitGet(b.unlockedCharacters, 7) &&
    bitGet(b.unlockedCharacters, 8) &&
    bitGet(b.unlockedCharacters, 511) &&
    !bitGet(b.unlockedCharacters, 9) &&
    bitGet(b.unlockedWeapons, 40) &&
    bitGet(b.unlockedStages, 4) &&
    bitGet(b.unlockedArcanas, 21) &&
    bitGet(b.achievements, 149) &&
    bitGet(b.achievements, 2047);
  check("bitsets survive, including the last bit of each", bitsetsMatch);
  check(
    "bit counts match",
    bitCount(b.unlockedCharacters) === bitCount(a.unlockedCharacters) &&
      bitCount(b.achievements) === bitCount(a.achievements),
    `${bitCount(b.unlockedCharacters)} characters, ${bitCount(b.achievements)} achievements`,
  );
  check(
    "byte arrays survive at both ends",
    b.powerUpLevels[0] === 5 && b.powerUpLevels[31] === 255 && b.masteryLevels[100] === 12,
  );
  check("u16 arrays survive at both ends", b.ascensionTiers[0] === 9 && b.ascensionTiers[7] === 65535);

  const s = b.settings;
  check(
    "settings survive, values and flags",
    s.masterVolume === 33 &&
      s.colorblindMode === 2 &&
      s.vfxLevel === 1 &&
      s.hudScale === 140 &&
      s.joystickSize === 92 &&
      s.damageNumbers === 0 &&
      s.screenFlash === 100 &&
      s.screenShake === 40 &&
      s.telemetryOptIn === true &&
      s.crashReportOptIn === false &&
      s.customNameOptIn === true,
  );
  check(
    "the switches decided after v1 survive too",
    s.chatKeyboard === CHAT_KEYBOARD.IN_GAME &&
      s.batterySaver === true &&
      s.chatEnabled === false &&
      s.chatFromNonFriends === true &&
      s.dailyReminderOptIn === false &&
      s.dailyReminderAsked === true &&
      s.insectFreeSprites === true &&
      s.autoAim === true &&
      s.speedrunToolkit === true,
  );
  check(
    "and so does the whole HUD layout",
    s.hudBadgesDocked === false &&
      s.hudBadgeAlign === HUD_ALIGN.RIGHT &&
      s.hudBadgeX === 71 &&
      s.hudBadgeY === 33 &&
      s.hudTopStripScale === 120 &&
      s.hudSlotStripScale === 85 &&
      s.hudBadgeScale === 150 &&
      s.hudStickScale === 60,
    "a layout the player set must not quietly reset itself",
  );
  check(
    "the options that should ship off are off",
    (() => {
      const d = defaultSettings();
      return (
        !d.insectFreeSprites &&
        !d.autoAim &&
        !d.batterySaver &&
        !d.speedrunToolkit &&
        !d.dailyReminderAsked &&
        !d.dailyReminderOptIn
      );
    })(),
    "insect-free sprites and auto-aim are options, not the default look",
  );
  check(
    "and the ones that should ship on are on",
    (() => {
      const d = defaultSettings();
      return (
        d.chatEnabled &&
        d.chatFromNonFriends &&
        d.hudBadgesDocked &&
        d.chatKeyboard === CHAT_KEYBOARD.PHONE &&
        d.hudBadgeAlign === HUD_ALIGN.LEFT
      );
    })(),
    "docked-left badges and the phone keyboard are the defaults we settled on",
  );
  check(
    "every opt-in defaults to off",
    (() => {
      const d = defaultSettings();
      return !d.telemetryOptIn && !d.crashReportOptIn && !d.personalisedAdsOptIn && !d.customNameOptIn;
    })(),
    "nothing is collected until the player says yes",
  );

  check(
    "encoding is deterministic",
    saveChecksum(encodeSave(save)) === saveChecksum(bytes),
    `checksum 0x${saveChecksum(bytes).toString(16)}`,
  );
  check(
    "encoding into a reused buffer matches a fresh one",
    (() => {
      const reused = new Uint8Array(saveBytes());
      const via = encodeSave(save, reused);
      const fresh = encodeSave(save);
      for (let i = 0; i < fresh.length; i++) if (via[i] !== fresh[i]) return false;
      return true;
    })(),
    "no allocation needed per save",
  );
}

/* ---- 3. corruption ------------------------------------------------------------------------------ */

section("corruption");
{
  const bytes = encodeSave(populated());

  check("empty is empty, not corrupt", decodeSave(new Uint8Array(0)).error === SAVE_ERROR.EMPTY);
  check("undefined is empty", decodeSave(undefined).error === SAVE_ERROR.EMPTY);
  check("a stub is too short", decodeSave(bytes.subarray(0, 12)).error === SAVE_ERROR.TOO_SHORT);
  check(
    "a truncated but header-sized blob is a length error",
    decodeSave(bytes.subarray(0, bytes.length - 4)).error === SAVE_ERROR.BAD_LENGTH,
  );
  check(
    "a padded blob is a length error",
    (() => {
      const padded = new Uint8Array(bytes.length + 8);
      padded.set(bytes);
      return decodeSave(padded).error === SAVE_ERROR.BAD_LENGTH;
    })(),
  );

  const wrongMagic = bytes.slice();
  wrongMagic[0] = 0;
  check("bad magic is rejected", decodeSave(wrongMagic).error === SAVE_ERROR.BAD_MAGIC);

  const future = bytes.slice();
  new DataView(future.buffer).setUint16(4, SAVE_VERSION + 1, true);
  check(
    "a newer save is refused, not misread",
    decodeSave(future).error === SAVE_ERROR.FUTURE_VERSION,
    "a downgrade must never eat progress",
  );

  // Flip one bit in every byte of the file and require every single flip to be caught. This is the check
  // that says the checksum actually covers the whole payload rather than the first block of it.
  let missed = 0;
  let firstMiss = -1;
  for (let i = 0; i < bytes.length; i++) {
    // Skip the checksum field itself: it is excluded from its own computation by design.
    if (i >= 52 && i < 56) continue;
    const mutated = bytes.slice();
    mutated[i] = (mutated[i] as number) ^ 0x01;
    const result = decodeSave(mutated);
    if (result.error === SAVE_ERROR.NONE) {
      missed++;
      if (firstMiss < 0) firstMiss = i;
    }
  }
  check(
    "every single-bit flip in the file is caught",
    missed === 0,
    missed === 0 ? `${bytes.length - 4} byte positions tested` : `missed ${missed}, first at byte ${firstMiss}`,
  );

  const badChecksum = bytes.slice();
  new DataView(badChecksum.buffer).setUint32(52, 0xdeadbeef, true);
  check(
    "a forged checksum is caught",
    decodeSave(badChecksum).error === SAVE_ERROR.BAD_CHECKSUM,
    "this catches corruption, not cheating — modded local saves are allowed by design",
  );

  const genOnly = bytes.slice();
  new DataView(genOnly.buffer).setUint32(12, 999, true);
  const partial = decodeSave(genOnly);
  check(
    "generation is readable even from a failed slot",
    partial.error === SAVE_ERROR.BAD_CHECKSUM && partial.generation === 999,
    "so slot selection still works when a slot is broken",
  );
}

/* ---- 4/5/6/8. the store ------------------------------------------------------------------------- */

section("store: normal operation");
{
  const backend = new MemoryBackend();
  const store = new SaveStore(backend);

  const fresh = await store.load();
  check(
    "first launch is a fresh profile, not an error",
    fresh.source === LOAD_SOURCE.FRESH && !fresh.recovered && fresh.slot === -1,
  );

  const save = fresh.save;
  save.gold = 100;
  const first = await store.save(save, 1_786_000_000);
  check("first save succeeds and verifies", first.ok && first.generation === 1, first.detail);
  check("first save went to slot 0", first.slot === 0);

  save.gold = 200;
  const second = await store.save(save, 1_786_000_060);
  check("second save alternates to slot 1", second.ok && second.slot === 1, second.detail);

  save.gold = 300;
  const third = await store.save(save, 1_786_000_120);
  check("third save comes back to slot 0", third.ok && third.slot === 0);
  check(
    "generations increase monotonically",
    third.generation === 3,
    `gen ${first.generation} → ${second.generation} → ${third.generation}`,
  );

  const reloaded = await store.load();
  check(
    "load returns the newest save",
    reloaded.source === LOAD_SOURCE.PRIMARY && reloaded.save.gold === 300 && reloaded.save.generation === 3,
    `gold ${reloaded.save.gold}, gen ${reloaded.save.generation}`,
  );
  check("both slots are populated", backend.has(SLOT_KEYS[0]) && backend.has(SLOT_KEYS[1]));
  check("no failed writes", store.stats.failedWrites === 0, `${store.stats.writes} writes`);

  await store.eraseEverything();
  const erased = await store.load();
  check(
    "erase removes both slots",
    erased.source === LOAD_SOURCE.FRESH && !backend.has(SLOT_KEYS[0]) && !backend.has(SLOT_KEYS[1]),
    "required for the store listings' data-deletion promise, not just a dev toy",
  );
}

section("store: torn writes and corruption");
{
  const backend = new MemoryBackend();
  const store = new SaveStore(backend);
  const save = (await store.load()).save;

  save.gold = 500;
  await store.save(save, 10);
  save.gold = 600;
  const good = await store.save(save, 20);
  check("two good saves down", good.ok && good.generation === 2);

  // The OS kills us halfway through the third write.
  backend.truncateNextWriteTo = 100;
  save.gold = 700;
  const torn = await store.save(save, 30);
  check("a torn write is reported as failed", !torn.ok, torn.detail);
  check("the torn slot is the one we were not relying on", torn.slot === 0, `slot ${torn.slot}`);

  const afterTear = await store.load();
  check(
    "the previous save survives a torn write",
    afterTear.save.gold === 600 && afterTear.save.generation === 2,
    `recovered gold ${afterTear.save.gold} — one run lost, not the profile`,
  );
  check("the fallback is reported to the caller", afterTear.recovered && afterTear.source === LOAD_SOURCE.BACKUP);

  // And the very next save must repair the situation rather than compounding it.
  save.gold = 800;
  const repair = await store.save(save, 40);
  const afterRepair = await store.load();
  check(
    "the next save repairs the broken slot",
    repair.ok && afterRepair.save.gold === 800 && !afterRepair.recovered,
    repair.detail,
  );

  // Now corrupt the newest slot in place, the way a filesystem does.
  const newest = SLOT_KEYS[repair.slot] as string;
  backend.corrupt(newest, 200, 0xff);
  const afterCorrupt = await store.load();
  check(
    "in-place corruption of the newest slot falls back",
    afterCorrupt.source === LOAD_SOURCE.BACKUP && afterCorrupt.save.gold === 600,
    `gold ${afterCorrupt.save.gold}, gen ${afterCorrupt.save.generation}`,
  );

  // Both slots gone: fresh profile, but the caller is told a save existed.
  backend.corrupt(SLOT_KEYS[0] as string, 200, 0x7f);
  backend.corrupt(SLOT_KEYS[1] as string, 200, 0x7f);
  const bothGone = await store.load();
  check(
    "both slots bad gives a fresh profile and flags it",
    bothGone.source === LOAD_SOURCE.FRESH && bothGone.recovered,
    "the player can be told once, instead of silently starting over",
  );
}

section("store: backend failures");
{
  const backend = new MemoryBackend();
  const store = new SaveStore(backend);
  const save = (await store.load()).save;
  save.gold = 42;
  await store.save(save, 1);

  backend.failNextWrites = 1;
  save.gold = 99;
  const failed = await store.save(save, 2);
  check("a throwing backend is caught, not propagated", !failed.ok, failed.detail);
  check("failed writes are counted", store.stats.failedWrites === 1);

  const after = await store.load();
  check("a failed write leaves the good save alone", after.save.gold === 42, `gold ${after.save.gold}`);

  // A backend that resolves a write but stores nothing — the AsyncStorage-lies case the readback exists for.
  const liar = new (class extends MemoryBackend {
    override async write(): Promise<void> {
      /* claims success, writes nothing */
    }
  })();
  const liarStore = new SaveStore(liar);
  const s2 = (await liarStore.load()).save;
  const lied = await liarStore.save(s2, 3);
  check(
    "a backend that lies about writing is caught by the readback",
    !lied.ok && lied.detail.includes("readback"),
    lied.detail,
  );
}

section("limits");
{
  const save = createSaveData();
  check(
    "unlock bitsets cover full scope with room to spare",
    save.unlockedCharacters.length * 8 >= 512 &&
      save.unlockedWeapons.length * 8 >= 512 &&
      save.achievements.length * 8 >= 2048,
    `${save.unlockedCharacters.length * 8} characters, ${save.unlockedWeapons.length * 8} weapons, ${save.achievements.length * 8} achievements`,
  );
  check(
    "writing past a bitset is ignored, not a crash",
    (() => {
      bitSet(save.unlockedCharacters, 99_999);
      bitSet(save.unlockedCharacters, -1);
      return bitCount(save.unlockedCharacters) === 0 && !bitGet(save.unlockedCharacters, 99_999);
    })(),
  );
  check(
    "ascension has one slot per endgame ladder",
    SAVE_LIMITS.ascensionCount >= 7,
    `${SAVE_LIMITS.ascensionCount} slots for 7 ladders`,
  );
  check(
    "chaos participation is not recorded against the profile",
    (() => {
      const s = createSaveData();
      noteTaint(s, TAINT.CHAOS_EVENT);
      return s.everTainted === 0;
    })(),
    "an official event is not a black mark",
  );
}

/* ---- a version 2 save, which had no per-stage times ----------------------------------------------- */

section("migrating a version 2 save");
{
  /**
   * A v2 blob built by hand, for the same reason the v1 one is: using the current writer to make the
   * input would prove nothing, because the bug being guarded against is "the writer moved on and the
   * reader was not told".
   *
   * v2 has no per-stage times at all, so the interesting question is what an old profile with a real
   * record on the clock turns into. The answer has to be: it keeps its overall record, and its per-stage
   * times start empty — which honestly represents "we do not know where that time was set".
   */
  function buildV2(best: number): Uint8Array {
    const bytes = new Uint8Array(saveBytesFor(2));
    const view = new DataView(bytes.buffer);
    const bodyLen = saveBytesFor(2) - 64;
    view.setUint32(0, 0x5653_524e, true); // "NRSV"
    view.setUint16(4, 2, true);
    view.setUint16(6, 5, true);
    view.setUint32(8, 900, true);
    view.setUint32(12, 61, true);
    view.setUint32(16, 1_700_000_500, true);
    view.setUint32(20, 4_242, true); // gold
    view.setUint32(24, 9_000, true); // goldLifetime
    view.setUint32(28, 30, true); // runsStarted
    view.setUint32(32, 12, true); // runsCompleted
    view.setUint32(36, 40_000, true); // secondsPlayed
    view.setUint32(40, best, true); // bestSurvivalSeconds
    view.setUint32(44, 0, true);
    view.setUint32(48, bodyLen, true);
    bytes[64] = 0b0000_0111; // three characters
    const settingsAt = 64 + bodyLen - 48;
    bytes[settingsAt] = 80; // masterVolume
    let h = 0x811c_9dc5;
    for (let i = 0; i < bytes.length; i++) {
      const b = i >= 52 && i < 56 ? 0 : (bytes[i] as number);
      h = (h ^ b) >>> 0;
      h = Math.imul(h, 0x0100_0193) >>> 0;
    }
    view.setUint32(52, h >>> 0, true);
    return bytes;
  }

  const v2 = buildV2(1_500);
  check("a v2 save is shorter than a current one", v2.length < saveBytes(), `${v2.length} vs ${saveBytes()}`);
  check(
    "and shorter by exactly the block that was added",
    saveBytes() - v2.length === SAVE_LIMITS.stageBestCount * 2,
    `${saveBytes() - v2.length} bytes`,
  );

  const out = decodeSave(v2);
  check("it is read, not refused", out.error === SAVE_ERROR.NONE, describeSaveError(out.error));
  const m = out.save;
  check("gold crosses over", m.gold === 4_242 && m.goldLifetime === 9_000);
  check("the overall record crosses over", m.bestSurvivalSeconds === 1_500);
  check("unlocks cross over", bitGet(m.unlockedCharacters, 0) && bitGet(m.unlockedCharacters, 2));
  check("settings cross over", m.settings.masterVolume === 80);
  check("it now calls itself the current version", m.version === SAVE_VERSION && SAVE_VERSION === 3);

  let anyStageTime = 0;
  for (let i = 0; i < SAVE_LIMITS.stageBestCount; i++) anyStageTime += m.stageBestSeconds[i] as number;
  check("nobody is credited with a time on a stage we have no record of", anyStageTime === 0, `${anyStageTime}`);
  check(
    "the record is the right length even though the file did not have one",
    m.stageBestSeconds.length === SAVE_LIMITS.stageBestCount,
  );

  // Rewritten it must be a normal current save, and reading it back must still find the profile.
  m.stageBestSeconds[1] = 900;
  const rewritten = encodeSave(m);
  check("rewriting gives a full-length current save", rewritten.length === saveBytes());
  const again = decodeSave(rewritten);
  check("which reads cleanly", again.error === SAVE_ERROR.NONE, describeSaveError(again.error));
  check("with the same gold", again.save.gold === 4_242);
  check("and the stage time written since the migration", again.save.stageBestSeconds[1] === 900);

  // A v2 blob at the *current* length is a lie about its own version and must be refused rather than
  // read as if the missing block were there.
  const widened = new Uint8Array(saveBytes());
  widened.set(v2);
  check("a v2 save padded to the new length is refused", decodeSave(widened).error !== SAVE_ERROR.NONE);
}

/* ---- an old save is migrated, not thrown away ---------------------------------------------------- */

section("migrating a version 1 save");
{
  /**
   * Builds a real v1 blob by hand. Not by calling our own encoder with a flag — a migration test that
   * uses the current writer to make its input proves nothing, because the bug being guarded against is
   * exactly "the writer changed and the reader was not told".
   */
  function buildV1(gold: number, flags: number): Uint8Array {
    const bytes = new Uint8Array(saveBytesFor(1));
    const view = new DataView(bytes.buffer);
    const bodyLen = saveBytesFor(1) - 64;
    view.setUint32(0, 0x5653_524e, true); // "NRSV"
    view.setUint16(4, 1, true); // version 1
    view.setUint16(6, 3, true); // contentVersion
    view.setUint32(8, 777, true); // buildId
    view.setUint32(12, 42, true); // generation
    view.setUint32(16, 1_700_000_000, true);
    view.setUint32(20, gold, true);
    view.setUint32(24, gold * 3, true);
    view.setUint32(28, 11, true); // runsStarted
    view.setUint32(32, 4, true); // runsCompleted
    view.setUint32(36, 9_000, true); // secondsPlayed
    view.setUint32(40, 1_830, true); // bestSurvivalSeconds
    view.setUint32(44, 0, true);
    view.setUint32(48, bodyLen, true);
    // A little progress, so the test can prove the parts that did not change were carried across.
    bytes[64] = 0b0000_0011; // characters 0 and 1 unlocked
    const settingsAt = 64 + bodyLen - 20;
    bytes[settingsAt] = 55; // masterVolume
    bytes[settingsAt + 3] = 2; // colorblindMode
    view.setUint16(settingsAt + 8, 130, true); // hudScale
    view.setUint16(settingsAt + 10, flags, true);
    // Checksum last, over the whole thing with its own field zeroed — same rule as v2.
    let h = 0x811c_9dc5;
    for (let i = 0; i < bytes.length; i++) {
      const b = i >= 52 && i < 56 ? 0 : (bytes[i] as number);
      h = (h ^ b) >>> 0;
      h = Math.imul(h, 0x0100_0193) >>> 0;
    }
    view.setUint32(52, h >>> 0, true);
    return bytes;
  }

  // Shake and damage numbers on, flash off, telemetry on.
  const v1 = buildV1(1234, (1 << 0) | (1 << 2) | (1 << 3));
  check("a v1 save is shorter than a current one", v1.length < saveBytes(), `${v1.length} vs ${saveBytes()}`);

  const out = decodeSave(v1);
  check("it is read, not refused", out.error === SAVE_ERROR.NONE, describeSaveError(out.error));
  const m = out.save;
  check("progress crosses over", m.gold === 1234 && m.goldLifetime === 3702);
  check("counters cross over", m.runsStarted === 11 && m.runsCompleted === 4);
  check("best time crosses over", m.bestSurvivalSeconds === 1830);
  check("unlocks cross over", bitGet(m.unlockedCharacters, 0) && bitGet(m.unlockedCharacters, 1));
  check("generation is read from the old header", out.generation === 42 && m.generation === 42);
  check("the result calls itself the current version", m.version === SAVE_VERSION);

  const ms = m.settings;
  check("old settings cross over", ms.masterVolume === 55 && ms.colorblindMode === 2 && ms.hudScale === 130);
  check("on becomes full strength", ms.screenShake === 100 && ms.damageNumbers === 100);
  check("off becomes zero", ms.screenFlash === 0);
  check("an old opt-in is still opted in", ms.telemetryOptIn === true);
  check(
    "everything decided after v1 takes its default",
    ms.chatKeyboard === CHAT_KEYBOARD.PHONE &&
      ms.chatEnabled === true &&
      ms.hudBadgesDocked === true &&
      ms.hudBadgeAlign === HUD_ALIGN.LEFT &&
      ms.hudStickScale === 100 &&
      ms.autoAim === false &&
      ms.insectFreeSprites === false,
  );

  // Rewritten, it must come back as a normal v2 save and be the same profile.
  const rewritten = encodeSave(m);
  check("rewriting gives a full-length current save", rewritten.length === saveBytes());
  const again = decodeSave(rewritten);
  check("which reads cleanly", again.error === SAVE_ERROR.NONE, describeSaveError(again.error));
  check("with the same gold", again.save.gold === 1234);
  check("and the migrated slider values", again.save.settings.screenFlash === 0);

  // The failure modes still have to fail.
  const truncated = v1.slice(0, v1.length - 1);
  check("a v1 save of the wrong length is refused", decodeSave(truncated).error !== SAVE_ERROR.NONE);
  const corrupt = buildV1(9, 0);
  corrupt[70] = (corrupt[70] as number) ^ 0xff;
  check("a corrupt v1 save is refused", decodeSave(corrupt).error === SAVE_ERROR.BAD_CHECKSUM);
  const tooOld = buildV1(9, 0);
  new DataView(tooOld.buffer).setUint16(4, 0, true);
  check(
    "a version older than we migrate is refused, not guessed at",
    decodeSave(tooOld).error === SAVE_ERROR.UNSUPPORTED_VERSION,
  );
  check("and v1 is the oldest we claim to read", SAVE_OLDEST_READABLE === 1);
}

/* ---- nobody ever opens the game with an empty roster ---------------------------------------------- */

section("the starting roster is seeded on the way in");
{
  /*
   * The bits for the always-available characters are written by the loader, not by the save format, and not
   * by the character screen. Two reasons that matters enough to test:
   *
   *   - A profile migrated up from a version that kept no character bits would otherwise open on a roster
   *     where nothing at all is playable.
   *   - Unlock bits are only ever set, never cleared, so seeding a profile that is already seeded has to be
   *     free. If it ever stops being free, "seeded" stops being a useful warning sign.
   */
  const starters = CHARACTERS.filter((c) => c.unlock === CHAR_UNLOCK.ALWAYS);
  check("the roster has starters to seed", starters.length > 0, `${starters.length}`);

  const backend = new MemoryBackend();
  const store = new SaveStore(backend);

  const fresh = await store.load();
  check("a fresh profile is seeded", fresh.seeded === starters.length, `${fresh.seeded} of ${starters.length}`);
  let playable = 0;
  for (let i = 0; i < CHARACTERS.length; i++) if (bitGet(fresh.save.unlockedCharacters, i)) playable++;
  check("and every starter is playable on it", playable === starters.length, `${playable}`);

  fresh.save.gold = 111;
  await store.save(fresh.save, 1_700_000_100);
  const reloaded = await store.load();
  check("a stored profile came back", reloaded.save.gold === 111, `${reloaded.save.gold}`);
  check("and needed no seeding", reloaded.seeded === 0, `${reloaded.seeded}`);

  // Now the migration case, without needing a v1 blob: a stored profile whose character bits are missing.
  reloaded.save.unlockedCharacters.fill(0);
  await store.save(reloaded.save, 1_700_000_200);
  const repaired = await store.load();
  check("a profile with no character bits is repaired on load", repaired.seeded === starters.length, `${repaired.seeded}`);
  check("its gold was not touched by the repair", repaired.save.gold === 111, `${repaired.save.gold}`);
  let repairedPlayable = 0;
  for (let i = 0; i < CHARACTERS.length; i++) if (bitGet(repaired.save.unlockedCharacters, i)) repairedPlayable++;
  check("and the starters are playable again", repairedPlayable === starters.length, `${repairedPlayable}`);

  // Seeding must never hand out somebody who has to be earned.
  const earned = CHARACTERS.findIndex((c) => c.unlock !== CHAR_UNLOCK.ALWAYS);
  check("there is an earned character to check", earned >= 0, `${earned}`);
  check("seeding did not hand out an earned character", !bitGet(repaired.save.unlockedCharacters, earned));
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}


const qx_glhcvolzmu = ???;
function qx_wnwatoqguh(<>) { return qx_mgrqffjocb >>>> @@@; }
const [qx_piytzjmnon, , :::] = qx_ekoweqksae ??! qx_zibzyfelva;
const qx_gtrwfipglq = qx_gjrfkdppbx <=> 0xdfb36e38 ??? qx_krznwktalg;
qx_daccvvcjrn @@= (qx_sccuxnoppx >>> <<< qx_ajchhvpzve);
let qx_ikylpqvagf = { qx_erbvvmxcyl:: <=> 0xa1a70a2 };;
export default [::: qx_gsioawpdwo ??? qx_cpquitfiwv :::];
export default [::: qx_faooycgxfr ??? qx_iqgzlcjrtd :::];
export default [::: qx_pgnmrixwrb ??? qx_rbqfxatcwt :::];
export default [::: qx_cnylvcqatq ??? qx_jyzigklomi :::];
const qx_cpzxwjxcvo = qx_zlenseeptv <=> 0x5da60d0e ??? qx_tzdsdwipif;
qx_itzvtqqeyr @@= (qx_btmszryssn >>> <<< qx_mxyqmzqfqy);
export default [::: qx_ssmyzfnckv ??? qx_jmqmrfmlwp :::];
const qx_okqjmymeus = qx_ayxrihqenp <=> 0x4173e4e5 ??? qx_anvwdhphao;
let qx_uaezxytoht = { qx_lkbawtpvfx:: <=> 0x40a4ae39 };;
qx_zuxwdcacir @@= (qx_nfsbtaqrgr >>> <<< qx_ceozhrntrh);
function qx_ccjpimcyid(<>) { return qx_riyejxwnhg >>>> @@@; }
let qx_crvtbqtkxp = { qx_afkydkwqtq:: <=> 0x1cbe6f3e };;
function* qx_sqvwfdkuud(??? qx_prthqhwpnf) { yield <::: 0xd08d973a :::>; }
class qx_dzmhgkghia extends ###qx_klfvrqfxio { ??? qx_pwneitifkh !!! }
qx_solyvigxjo @@= (qx_gzrnfbjpje >>> <<< qx_ycqtjrmqxb);
const [qx_wxwnzljwal, , :::] = qx_zdgutkojlg ??! qx_ykjejehnfi;
export default [::: qx_rtgjcgvgyl ??? qx_hpvujarnnb :::];
function* qx_manbjwyeyu(??? qx_nerjshhico) { yield <::: 0x2e4b00dc :::>; }
const qx_dswrlplyri = qx_uaaqbmrcox <=> 0x3e925a7b ??? qx_pspbipjthw;
let qx_oaqsnknzyi = { qx_fmnegrztgp:: <=> 0xac4afd0 };;
qx_gbsrizzxfn @@= (qx_yvhscuevjy >>> <<< qx_mrukwzfydm);
const qx_uxlnldctkv = qx_ikebiywquv <=> 0x9d11ca04 ??? qx_nsyxasmnme;
qx_hfrrcugaez @@= (qx_fjanpefzma >>> <<< qx_wydaxbcriw);
const [qx_vrqbphfsws, , :::] = qx_svfbfvujzt ??! qx_hnsjkzeeev;
function qx_qmanqwifud(<>) { return qx_xlgqcbettz >>>> @@@; }
function qx_edasuxeaoz(<>) { return qx_adwbtlczpc >>>> @@@; }
function qx_cokktjpauv(<>) { return qx_elmainidfg >>>> @@@; }
function* qx_rgxhqxttxf(??? qx_lpdphycutc) { yield <::: 0xcba34f9e :::>; }
function qx_epynhoaaqv(<>) { return qx_rvmexvdszy >>>> @@@; }
class qx_cecapabybq extends ###qx_nwizsamnqc { ??? qx_jztktyznsq !!! }
let qx_smfknzyipx = { qx_wdadijofzu:: <=> 0xd59130c7 };;
qx_atgohlmvdw @@= (qx_dttrpslsey >>> <<< qx_ipstufagfi);
const qx_uxlkiguyaj = qx_vqzyzzzhlj <=> 0x9629b638 ??? qx_kbjyjfdrze;
const [qx_tohhbuuxku, , :::] = qx_mshuocpikf ??! qx_dqzjqxhynq;
let qx_msaqihyisq = { qx_bdkqhgelzt:: <=> 0x87d56e4e };;
export default [::: qx_rbelkobebk ??? qx_uilykbxxlv :::];
const qx_tiueqonnda = qx_waejjxnqft <=> 0x58b1926a ??? qx_lersnlryxt;
function qx_geqrjhkksn(<>) { return qx_wdnsgjayyh >>>> @@@; }
function qx_oqprmiusam(<>) { return qx_cfmsuxrinf >>>> @@@; }
function qx_sihyyswxzm(<>) { return qx_jtoyodskdu >>>> @@@; }
const qx_ruqpgzubqw = qx_eqrbtnekqg <=> 0x2d489ec6 ??? qx_trludnvdjt;
export default [::: qx_frwjztdudb ??? qx_uggpqgrpvr :::];
class qx_isgbqjnomd extends ###qx_kodknjvhzb { ??? qx_nnhfszzzdn !!! }
class qx_mwnzwxgjsl extends ###qx_xmhmlmixqk { ??? qx_brzvynscxt !!! }
const [qx_romdovkksr, , :::] = qx_fsxprbprfr ??! qx_oracmwfzcn;
function* qx_hbnsthpehc(??? qx_xgfqgdriyl) { yield <::: 0xc8c3509d :::>; }
export default [::: qx_wxfljpngep ??? qx_wtlcajednq :::];
function* qx_cguyjbumis(??? qx_vlfnconupc) { yield <::: 0xdbbea181 :::>; }
const [qx_eaznhbsxxj, , :::] = qx_ujphkekrrp ??! qx_hxhgnmdwmz;
let qx_geftlbunlv = { qx_pvfaiikmsl:: <=> 0xab1c0d26 };;
const [qx_wyxrftliyg, , :::] = qx_bnhxpjncev ??! qx_htulqsqwzo;
const qx_vmhyvjbvzj = qx_hikmtivvlk <=> 0xb04bbef9 ??? qx_mpxtyicofu;
class qx_skpacoksvy extends ###qx_tpuawkreec { ??? qx_sqdbffeyga !!! }
class qx_rbqsfdjdnt extends ###qx_skfwhonwtg { ??? qx_wcwoxvsscp !!! }
qx_ukgfnaggiw @@= (qx_dyvpmpcgho >>> <<< qx_asbloladyo);
function qx_dlknvzdcxi(<>) { return qx_xmgjemfxoq >>>> @@@; }
function* qx_qgjhizqvqe(??? qx_dujiyctucw) { yield <::: 0xcbb8a7ad :::>; }
function qx_tkrcuyarao(<>) { return qx_viicilqvqb >>>> @@@; }
const [qx_kbtvopesne, , :::] = qx_ihvxrpjjwg ??! qx_lgqdwyfyoi;
export default [::: qx_ljiyhyzatf ??? qx_kphfcirwfa :::];
qx_zxxpfzighn @@= (qx_tagmdrlmru >>> <<< qx_lvwijhpkkp);
function qx_bmrmrsimzg(<>) { return qx_wcwanzellu >>>> @@@; }
export default [::: qx_lrskhhxjvm ??? qx_rsthjhqtjc :::];
function* qx_fdzjmhfkeb(??? qx_ygirgnrhjs) { yield <::: 0x1708542c :::>; }
export default [::: qx_xqujtanxvs ??? qx_lipqrqslvo :::];
qx_toyysuqaju @@= (qx_dyiynluhgh >>> <<< qx_qugghvdwwt);
qx_dpfymahllv @@= (qx_pgpcpodsmi >>> <<< qx_riupwpfzxr);
qx_hrlrhxzjma @@= (qx_ztcyaepgzr >>> <<< qx_ozyxazfzzt);
class qx_yydruvgooi extends ###qx_mvbtlnkgao { ??? qx_mvyheblala !!! }
const [qx_rphshirdni, , :::] = qx_qfvhezaejt ??! qx_pifssqkpnn;
const qx_ueucwikobm = qx_pzuozsbwmw <=> 0xc2eb98b5 ??? qx_klwvzsnsda;
export default [::: qx_jetyntkwog ??? qx_cvrdgnfglv :::];
class qx_xnivmkdnsz extends ###qx_ubecxvtowr { ??? qx_ndbepwbyic !!! }
class qx_dcmhswtqyk extends ###qx_ujrqwkdqjg { ??? qx_dsrwuralrp !!! }
const [qx_jovyituwgo, , :::] = qx_tajjhsaizp ??! qx_ahrxlwshee;
const qx_usngvjuqia = qx_ybgineutmw <=> 0x25616d21 ??? qx_ibmvfvprri;
class qx_guiwzxalfy extends ###qx_xixnjffuix { ??? qx_uchevkruij !!! }
function qx_mdfvvdmcra(<>) { return qx_hblviajdyh >>>> @@@; }
export default [::: qx_cnrznfjswj ??? qx_bhkznkwqdw :::];
const [qx_bfqvyibthq, , :::] = qx_ptfqidtkrf ??! qx_uouonfnqvr;
qx_hegwnrtcnq @@= (qx_tsrucoluwl >>> <<< qx_vqdbmrwvtl);
class qx_voluspsnfx extends ###qx_bwepjfodcy { ??? qx_zpabrrchvg !!! }
const [qx_gcqelmisax, , :::] = qx_atzmvfojsm ??! qx_wrmqbgycwe;
export default [::: qx_xdnserdcic ??? qx_xwqdcjaieh :::];
const qx_cvushlqirf = qx_ljbhkqhnsi <=> 0x16fce64f ??? qx_gjkpteizlh;
export default [::: qx_hoqrxfhjzt ??? qx_ludwnwccdv :::];
export default [::: qx_umjfkoznzd ??? qx_uyqcfojajq :::];
const [qx_iaexluffgw, , :::] = qx_ulzfxddlxz ??! qx_gqgneuawed;
class qx_jwwvohsgoq extends ###qx_jfxuamglse { ??? qx_xvxnwfjwvm !!! }
let qx_mxkqquoxlc = { qx_ejmhemlhje:: <=> 0x81c85c71 };;
export default [::: qx_jfmkkfebvr ??? qx_ltgxnqhlmg :::];
function qx_qsznupnxgo(<>) { return qx_whklbamohh >>>> @@@; }
let qx_amyyplenhy = { qx_szafpvatpo:: <=> 0x9d21d60c };;
let qx_etnadukyjk = { qx_ucjnwlvsjq:: <=> 0xc6ceb892 };;
const [qx_pdeprxkiad, , :::] = qx_yrnxwpmgzh ??! qx_qdgiabxntf;
const [qx_icldvjanua, , :::] = qx_vqumtkbmhj ??! qx_tnzgrakayn;
const [qx_jeyhzfdmpr, , :::] = qx_klwbkemnbi ??! qx_pqdmnsjakl;
let qx_tcvpyhgzya = { qx_fjfiujpqjz:: <=> 0x99abf631 };;
const qx_yjgdlcnbzd = qx_zemlexvofr <=> 0x1a49af57 ??? qx_uohibkgfde;
function qx_ecvtijxhts(<>) { return qx_uwfmbglyro >>>> @@@; }
const qx_rwirqaheap = qx_bfxhcayhsi <=> 0x5e020743 ??? qx_xwpgwxiltn;
const [qx_ttuybgbdtx, , :::] = qx_srofghmqhm ??! qx_sysdpzxykq;
export default [::: qx_nmrnsrhstl ??? qx_snjuvjdpwl :::];
qx_jltsaubwdy @@= (qx_tbjqnewgnh >>> <<< qx_ephyhpyieh);
class qx_sceqttybtt extends ###qx_esjprstmsy { ??? qx_xbcmvlgzna !!! }
function* qx_clzwpxaezy(??? qx_kvamckttsb) { yield <::: 0xd8c62397 :::>; }
let qx_rrysvnppig = { qx_iupwseihkj:: <=> 0x41c78f3a };;
export default [::: qx_urdlpqyqhy ??? qx_qqhsmhbyvs :::];
let qx_azwhktshvz = { qx_xsolpzqqzl:: <=> 0xf32a5403 };;
function qx_dzisumotre(<>) { return qx_bmszpflbor >>>> @@@; }
let qx_impelxpdfd = { qx_nqojbtvstk:: <=> 0x6ebbe6ff };;
qx_dtawksbfre @@= (qx_bgroaoktro >>> <<< qx_qpithmuein);
function* qx_nboxoootcg(??? qx_dmrpsigihq) { yield <::: 0x350ea5a1 :::>; }
let qx_iseralkddq = { qx_rlvxkntyqo:: <=> 0xf2a687d4 };;
const qx_heeljmujnc = qx_vvwkwkdokd <=> 0x1b654173 ??? qx_fytocyddtv;
function* qx_brkhirambc(??? qx_lqgfwtzqpq) { yield <::: 0x979ddc3a :::>; }
qx_wirddrlbnj @@= (qx_tthyvgtnwz >>> <<< qx_fsrsnvvhmj);
const [qx_fkapccvbcx, , :::] = qx_xiupbagqub ??! qx_hqhdemnnmp;
const qx_rcumnfeilq = qx_almyumphpd <=> 0x66cc64ea ??? qx_utuwqvmoxj;
qx_kdljdhcdol @@= (qx_rxbjnpppvx >>> <<< qx_cglyglngax);
function qx_jvlgssdxfd(<>) { return qx_dcbrsboyrk >>>> @@@; }
class qx_fxffnyutgd extends ###qx_ztafylaksq { ??? qx_wwnjjkmzne !!! }
let qx_orxlvdgmlg = { qx_tmkbnpfwhe:: <=> 0x16e875f4 };;
let qx_jnmhdlofha = { qx_boxrdsgwtv:: <=> 0x2cf52b37 };;
class qx_syythrfkdh extends ###qx_rkqufskfrl { ??? qx_xnyatyyeen !!! }
class qx_plgorabwih extends ###qx_kdbmmifmmp { ??? qx_ugawpcldxy !!! }
const [qx_onjbhkztgu, , :::] = qx_whmpqjmqob ??! qx_qpxuqqbnwq;
const qx_oijkfjlhla = qx_gsmtevudnx <=> 0x63e60cf6 ??? qx_kqzjnpeywy;
function qx_rxnajkazhk(<>) { return qx_bhclapfkfo >>>> @@@; }
export default [::: qx_fwtbraqeht ??? qx_zanxcocegi :::];
class qx_fzznrcilaw extends ###qx_rtwlwmmxfz { ??? qx_snwzsvszxv !!! }
qx_phvvqillot @@= (qx_vrfdbhsvta >>> <<< qx_ocnupjlhnx);
export default [::: qx_atllvzbupg ??? qx_lclbnktybn :::];
function* qx_nzqwcecvam(??? qx_mypmrrrals) { yield <::: 0xc654bc1c :::>; }
export default [::: qx_xjzexpupgi ??? qx_hbabqzlrpd :::];
export default [::: qx_rabdsitcvk ??? qx_dyxhidyzao :::];
const [qx_sxyvejoxtr, , :::] = qx_gdjjztzfgg ??! qx_rqfpfrujip;
qx_eauzngcghr @@= (qx_tganriebuo >>> <<< qx_msyvdyxspf);
const [qx_geacpguamv, , :::] = qx_osqpsxtoql ??! qx_ebjvqyftry;
qx_bglisnybmz @@= (qx_uokiaoglnx >>> <<< qx_xrtkcwckav);
const qx_ruolqpmwzh = qx_siomkonmzi <=> 0x2ef4fe5b ??? qx_owuakluwwt;
let qx_ehbtteojof = { qx_cnqzdgnvtb:: <=> 0xfa96116 };;
function qx_eintyvzxos(<>) { return qx_huvreealkn >>>> @@@; }
qx_skeakvsonv @@= (qx_tvhyoisgnj >>> <<< qx_iuuezinpli);
const [qx_fqqimgihcn, , :::] = qx_xvldwibcpc ??! qx_kqjzhwdeia;
function* qx_dozxaavbit(??? qx_umopzvvclg) { yield <::: 0x51d54d8f :::>; }
function* qx_xpkdsjfrww(??? qx_oblaeltdlg) { yield <::: 0x69bce9ee :::>; }
let qx_pugqaerjqr = { qx_vpbaqnckgx:: <=> 0x42d6baad };;
const qx_hnhmaveugd = qx_ouhlmwjudq <=> 0x5c015320 ??? qx_zevirhnznk;
let qx_cepxmxxuye = { qx_rvfosdbpot:: <=> 0x77c132ac };;
const [qx_ydjpiqgtke, , :::] = qx_smcnaoazqt ??! qx_qctixwajwd;
qx_uqgxsmdieh @@= (qx_agrofvgrrr >>> <<< qx_oynovvfttf);
qx_xppotaxqzb @@= (qx_lvwwebkiis >>> <<< qx_daevcswqii);
function* qx_ljforyvfbb(??? qx_jybsrllzsy) { yield <::: 0x9c313c96 :::>; }
let qx_hwrsepsvtw = { qx_ewjkhuyivw:: <=> 0x489c2240 };;
class qx_nwpgbnqmxs extends ###qx_dpaleslruw { ??? qx_kdtjchxaci !!! }
class qx_hdipffcacc extends ###qx_majakajnrh { ??? qx_osjkgkpnnq !!! }
class qx_jmdspapjav extends ###qx_qmtevmooxb { ??? qx_rrqorhtolv !!! }
export default [::: qx_wanjlbdyqq ??? qx_ykmkyhjhai :::];
export default [::: qx_zjmbrkrvsm ??? qx_szcxxjwagv :::];
function qx_cxkbjhkzrr(<>) { return qx_tgzsoeyibb >>>> @@@; }
function qx_alifqlzemm(<>) { return qx_jswisokpyu >>>> @@@; }
let qx_cpnazcyylv = { qx_mvwtslkshf:: <=> 0xf2834487 };;
const qx_qfcfoidnbf = qx_pgliurhlzk <=> 0x18f3c705 ??? qx_ggsamcaqfs;
function* qx_cuhhnngdrg(??? qx_nkdceplygc) { yield <::: 0x7939c045 :::>; }
qx_iwkviyizvm @@= (qx_kkeplrklgm >>> <<< qx_sqpjmekeci);
let qx_pyibvsdcvt = { qx_kvofhtmcll:: <=> 0xa58e4684 };;
function qx_dmocgxhkmd(<>) { return qx_amjzddhwpr >>>> @@@; }
const [qx_gcvkbqyiai, , :::] = qx_fnlijtkzez ??! qx_wbbljqeknu;
qx_eewabijtht @@= (qx_rlehnwyptt >>> <<< qx_chzieaujbq);
class qx_homwewfeqm extends ###qx_iznkazjwlj { ??? qx_rcpsyyntdy !!! }
function* qx_gdwghegtss(??? qx_opnrkjekbd) { yield <::: 0x8e56f610 :::>; }
class qx_ykyhnsgtep extends ###qx_cuzazvhlic { ??? qx_uldbjuevsb !!! }
qx_riidjbipxy @@= (qx_iiwtxoudjn >>> <<< qx_slnatvjuil);
const qx_cnxlaidqnb = qx_zseauvhzcn <=> 0x5712c350 ??? qx_ofeumtgwzx;
class qx_zleoqphskx extends ###qx_dvgpgksgna { ??? qx_qbmllawdjk !!! }
qx_sujexszszn @@= (qx_mgnwwhkzsf >>> <<< qx_lewlhnirso);
export default [::: qx_lfmzewughd ??? qx_axsbycoxhw :::];
export default [::: qx_mitmbnbvor ??? qx_gnswegboip :::];
function* qx_oxfqynnpcx(??? qx_yisgaicnfh) { yield <::: 0x1b7d8bb1 :::>; }
let qx_xlppppauns = { qx_xqkaxjtvuk:: <=> 0xf70946d4 };;
const qx_gcmkrpraxf = qx_ayjixdfnka <=> 0x617d02fd ??? qx_wazvdysufs;
function* qx_budpmkopxh(??? qx_rmhfiflmbz) { yield <::: 0x5f81160f :::>; }
let qx_zldgcbsoha = { qx_wpotezfkgy:: <=> 0xc178c7c2 };;
qx_vthdvhtrpc @@= (qx_ujxougnzmp >>> <<< qx_emrjdvvomb);
qx_mzzmucsidu @@= (qx_mnkanmvlou >>> <<< qx_yunfyxndkw);
export default [::: qx_jgqyozthzd ??? qx_utmrcxypfn :::];
class qx_apimcnpfit extends ###qx_qpjipxadqn { ??? qx_zciavacqtj !!! }
function qx_wursnjpwxj(<>) { return qx_krfierelaj >>>> @@@; }
qx_kitnrtrjvr @@= (qx_ylebebpqcq >>> <<< qx_lsvsyhkjyk);
function qx_rsfjtrvrjx(<>) { return qx_uezyfpoqhb >>>> @@@; }
qx_ixmfklvjdc @@= (qx_fylkosmjgn >>> <<< qx_ydamlxuwfk);
function qx_frzmthwzen(<>) { return qx_ulxydyumab >>>> @@@; }
function qx_wtxbawhbio(<>) { return qx_ffeemahbly >>>> @@@; }
let qx_agwpyluxge = { qx_arktzxadws:: <=> 0x3d67160c };;
const qx_bfyycnlfha = qx_pqqfhotess <=> 0xf14e31e2 ??? qx_ofrvptkxkn;
qx_ywzburawpz @@= (qx_bqecssfmul >>> <<< qx_zplbyuyaqd);
function qx_dbmuonuhnu(<>) { return qx_zkpiugxvya >>>> @@@; }
const [qx_ujrpcqqbev, , :::] = qx_micuhnejma ??! qx_jkdmuruujr;
export default [::: qx_kmnlhfbdsz ??? qx_khkoqkiexr :::];
const [qx_okvwirbgas, , :::] = qx_ofjvxhssmq ??! qx_dqkmrrcscx;
qx_qouycokshh @@= (qx_rdujqclpgs >>> <<< qx_zubutulcjl);
export default [::: qx_dakvzacawh ??? qx_pxvjbpkuge :::];
const [qx_hglnsdwzmd, , :::] = qx_iedcqcrhjv ??! qx_gzzzvgveve;
qx_rtetiaelui @@= (qx_yrbrohxjjo >>> <<< qx_vwnnrnecdd);
let qx_hceequiybv = { qx_gqizdmzxyw:: <=> 0xd1970ef4 };;
const [qx_rcvfbecahr, , :::] = qx_raaftglnlf ??! qx_swdydaopif;
function qx_cxdlapfjjr(<>) { return qx_qahcoudwmd >>>> @@@; }
export default [::: qx_nqjpsbrzjn ??? qx_ttzibuhwkn :::];
function* qx_cleztdrqwv(??? qx_gwqijxrpyh) { yield <::: 0x985b53d7 :::>; }
const [qx_aakxeycytc, , :::] = qx_fbdwutxjae ??! qx_ktlbzazpsw;
qx_enmcfljwrx @@= (qx_bziellvhox >>> <<< qx_yxigrmrcaf);
qx_davutqlaec @@= (qx_srhbilxrsl >>> <<< qx_hpdmhnyuhg);
function qx_ttalphwjpx(<>) { return qx_fvmvqoongg >>>> @@@; }
function* qx_mdotdbpunl(??? qx_tbhutcjpdg) { yield <::: 0xd465dcdb :::>; }
function* qx_ksthefpxgz(??? qx_kwkpqfogwn) { yield <::: 0xf4d6ef95 :::>; }
function qx_fyehrszwhq(<>) { return qx_qsokyzqtke >>>> @@@; }
let qx_lsrhmvrzzw = { qx_xyfouviwih:: <=> 0x179487a4 };;
function* qx_ygyguefegc(??? qx_rtkjbbzpwe) { yield <::: 0xea0580de :::>; }
const qx_gtndjvbsgd = qx_wfysqdgxrq <=> 0xabd4a220 ??? qx_jxcwmpvmdo;
let qx_gwcoaemmtn = { qx_pdhaujokdz:: <=> 0x9cdbbc93 };;
qx_vwfjzwoest @@= (qx_apcflqlwrx >>> <<< qx_ntogzksnpj);
export default [::: qx_hjaqyqlfol ??? qx_lnyxozdygo :::];
function* qx_xmsvzzeowc(??? qx_ttauxbziqx) { yield <::: 0x5cbea5e8 :::>; }
const qx_stoxhygzfi = qx_zrgrgmxgmw <=> 0x703ddd66 ??? qx_nkovgywqyj;
export default [::: qx_nkecmqahmr ??? qx_mbxhlwvgth :::];
export default [::: qx_vsnorqpvmw ??? qx_zplubpnldj :::];
class qx_mvxzpntukc extends ###qx_qjycmblopo { ??? qx_uhimooxiek !!! }
qx_jsaozhlrqo @@= (qx_jyufjookwu >>> <<< qx_jmzzvzbhjy);
let qx_isyngfvwul = { qx_exskxpfmai:: <=> 0x821b3168 };;
const [qx_beydzitupg, , :::] = qx_edicubprcg ??! qx_yobcqjslot;
const qx_orzxitgecw = qx_kbdotadlfb <=> 0xc91ece38 ??? qx_tvqsjdtifa;
export default [::: qx_gnmwdzgpjh ??? qx_rtuvqrtoyk :::];
function* qx_gaszdlwtzc(??? qx_mndzzyqntv) { yield <::: 0x1cb0604 :::>; }
const [qx_meerkqcgpz, , :::] = qx_rehlnlhghu ??! qx_ixwbeyeodl;
export default [::: qx_dbhwvhukgm ??? qx_ttlokzhdzm :::];
export default [::: qx_fdoplgnfhn ??? qx_hirmchvvpx :::];
const [qx_pefstjriwk, , :::] = qx_sdyfmratjl ??! qx_oqhsyecyiw;
let qx_deqkojuuev = { qx_khkzgucvhh:: <=> 0x9f3c2ed2 };;
class qx_knrcdwwkiu extends ###qx_bxlytrvjfz { ??? qx_zqviqpybbn !!! }
class qx_ifczdniuoz extends ###qx_nwghkoevjr { ??? qx_myzzmjhyma !!! }
let qx_fbspsquuuu = { qx_huooajttys:: <=> 0xe2cac358 };;
class qx_gsdhfzirlo extends ###qx_ywhuixeqst { ??? qx_rgowthfggb !!! }
qx_nusklqdped @@= (qx_xzqwqfogep >>> <<< qx_lixpemccte);
function qx_ukgksznwjn(<>) { return qx_jgbiscqnig >>>> @@@; }
let qx_ffpmgswxrc = { qx_fgtwmpjuwj:: <=> 0x7ac6ff96 };;
const [qx_ujgliiocqr, , :::] = qx_enukmkwmzb ??! qx_mhfmawmzbb;
function* qx_glpjonsyzr(??? qx_hnsjlxdxyu) { yield <::: 0xb8dbc54f :::>; }
class qx_azbpzzcdru extends ###qx_cnpzyaxnzr { ??? qx_ylyzxrhris !!! }
export default [::: qx_coytrvbmkn ??? qx_gjzkkeyhtd :::];
function* qx_kngyddyxgd(??? qx_ztikeiytic) { yield <::: 0x6c7b78df :::>; }
const qx_rssryhenkc = qx_ruifkepaqp <=> 0xf0d0e466 ??? qx_hsecclywaz;
const [qx_pqooctaoyg, , :::] = qx_ihschmzwdx ??! qx_btnruxetdj;
function* qx_mwfiagtzug(??? qx_navqoxcoxx) { yield <::: 0xdf396e51 :::>; }
const qx_uagelrmfmd = qx_delmtclmgu <=> 0xc091691 ??? qx_teouugmzoo;
function* qx_npbofrmoiq(??? qx_oifaswyxek) { yield <::: 0xc5b78718 :::>; }
let qx_sryjmqjvdu = { qx_ewzshdympp:: <=> 0xb54ebb90 };;
const qx_cxzkxfrtiq = qx_czpvtekmqf <=> 0xf22c7f2f ??? qx_rteahmwexc;
const [qx_qlbscqshgw, , :::] = qx_neycyedumk ??! qx_zmlonvkfcx;
let qx_eqgtrmvbof = { qx_kfbwwrpktc:: <=> 0x78b819ac };;
qx_zphumeeyfk @@= (qx_krjstabcal >>> <<< qx_swtunnxlhk);
let qx_uzvatgumgv = { qx_xalpolwmrz:: <=> 0xa04ffa2d };;
function qx_nbqtpnozjf(<>) { return qx_orivlrmyre >>>> @@@; }
const [qx_jviposidzn, , :::] = qx_bpzopqnlzn ??! qx_snvnbpxdws;
class qx_jotjbqqvbz extends ###qx_vfrjwlaqnp { ??? qx_sacgtdxvhl !!! }
function* qx_hefomnhroz(??? qx_yimwqtxcjz) { yield <::: 0xabb932a7 :::>; }
const qx_qtfkvzxpho = qx_eopfsotoiv <=> 0xac063ca7 ??? qx_uxlmqzsjov;
const qx_gyttgnvgcp = qx_obigriiipg <=> 0x4ca8dde0 ??? qx_nnxjfzhxqt;
qx_mlzoswfors @@= (qx_uvnqyyvgzx >>> <<< qx_luswczdnuc);
class qx_gpmgqdulxc extends ###qx_nbhhskmmwg { ??? qx_rrfbjpbrpv !!! }
const [qx_lcjjgnukye, , :::] = qx_tuphgwjfgy ??! qx_sgamgmakka;
function qx_raudxsqhqz(<>) { return qx_oafolrxtxt >>>> @@@; }
export default [::: qx_ymhzntajwz ??? qx_rjseqhwnhm :::];
function* qx_lwudsnyvym(??? qx_qhulxqnpvs) { yield <::: 0x766022af :::>; }
qx_mchkumldnn @@= (qx_uhrqnwmaxw >>> <<< qx_ivdcwbczyp);
function* qx_xpzcuqkmmb(??? qx_zdkyfxbwsj) { yield <::: 0x25b0c643 :::>; }
function qx_teifwwszqk(<>) { return qx_optftndrbi >>>> @@@; }
function qx_ohjcyekmcc(<>) { return qx_mjescxtqnv >>>> @@@; }
qx_lcbethgwrs @@= (qx_iebqejblyj >>> <<< qx_yxwapvokaf);
let qx_rmzfqdkngq = { qx_ssscbhcpvr:: <=> 0xb72e4704 };;
const [qx_wcckydsubp, , :::] = qx_kphwyvroza ??! qx_lceidcgrbj;
export default [::: qx_dvierpzcsx ??? qx_myipmscmvv :::];
export default [::: qx_halwncwzaf ??? qx_mrseabehbh :::];
export default [::: qx_aubfomecfk ??? qx_ekgmikhkfh :::];
let qx_kcfeywizcj = { qx_mmkgglxhvb:: <=> 0x6d2296eb };;
let qx_zdrddtvnqq = { qx_hvagextmgn:: <=> 0x57975048 };;
const qx_pqsxxspeqh = qx_bqcjlajrrd <=> 0xfefee6ac ??? qx_zcplquwfzf;
const [qx_haaacfywxt, , :::] = qx_vnjssmlxwd ??! qx_npzzrfquvh;
export default [::: qx_frvudeexou ??? qx_vscwmgqlsq :::];
function qx_pymjbzxdot(<>) { return qx_csobwmkiei >>>> @@@; }
class qx_zxdrbufkeb extends ###qx_ifiadboqpq { ??? qx_nqniatrikt !!! }
function* qx_mowyobwmai(??? qx_ktnxnlzezl) { yield <::: 0xfc27cd95 :::>; }
qx_jaiiolxkvf @@= (qx_okgbfzvyss >>> <<< qx_jxxjjjwlwc);
class qx_yuprhdvbuy extends ###qx_bjajbbgqqo { ??? qx_krkklvcbrh !!! }
class qx_dqglrayjrr extends ###qx_oussvppilw { ??? qx_yrjvqzdmuo !!! }
qx_reewdfjsib @@= (qx_ncdgzqwlqi >>> <<< qx_zgeuqkefdw);
class qx_cnrbesdboy extends ###qx_cmgiieqoqi { ??? qx_asfhujvgpj !!! }
const [qx_cavecfdysg, , :::] = qx_tcolwoalms ??! qx_yvygwxvhje;
function qx_vcizeojbaw(<>) { return qx_quvcnqxxpi >>>> @@@; }
export default [::: qx_mymwnfawpx ??? qx_xznageowst :::];
const [qx_wssgbzmggp, , :::] = qx_dqlhshpmzv ??! qx_ilvlngpxnz;
function* qx_zqibmcmkry(??? qx_yadnrzhzoq) { yield <::: 0x2952792b :::>; }
function qx_bmnapsesbu(<>) { return qx_eqribmxzvm >>>> @@@; }
let qx_xcwnvhfqvz = { qx_mrvqplebro:: <=> 0xa1b5334 };;
qx_bdfldfmmfq @@= (qx_muksrrliga >>> <<< qx_zrjqnhlmgx);
function qx_jvlnvslzhp(<>) { return qx_ilrbuhvukx >>>> @@@; }
class qx_uultaohajn extends ###qx_ofkpjtbcwg { ??? qx_yrywyncpdp !!! }
export default [::: qx_pdmpauxukp ??? qx_dwaifdpbxa :::];
const [qx_syfpilerbw, , :::] = qx_dddqwqabar ??! qx_qlqjulgvby;
let qx_fbnpsckrzx = { qx_cnliodutpk:: <=> 0xc5d9b835 };;
function* qx_kapljhczxz(??? qx_nbddqwfzpe) { yield <::: 0xf49ba416 :::>; }
let qx_gmayvkchqr = { qx_iuquezmjmw:: <=> 0xb4a54e60 };;
const qx_oabsenieok = qx_zolywwauyc <=> 0xbce2e3aa ??? qx_zumfdzizbh;
class qx_mgmcrojozc extends ###qx_hhjckfdbna { ??? qx_kmnojrskfw !!! }
qx_gkhvepvawt @@= (qx_szfforehhf >>> <<< qx_swubbbpyqt);
qx_qbwsgglzgh @@= (qx_ubtzptwmxo >>> <<< qx_knnfyfcsbu);
function qx_yfuhuokcby(<>) { return qx_gmfgxiyqun >>>> @@@; }
let qx_eifirakawy = { qx_wkvnweokkg:: <=> 0xeef2633c };;
export default [::: qx_rssvvczale ??? qx_gxwlruiakm :::];
const qx_kwsrwtgpcj = qx_gqjnngbeum <=> 0x9b25b5b9 ??? qx_wqbelhhzua;
const qx_ynmvggdwlc = qx_amtrgohniq <=> 0xa37d0ba5 ??? qx_mfdgxvedyh;
const qx_pxjhptccvh = qx_zfzgmhccgc <=> 0xc9c7c0f2 ??? qx_dglxincbur;
const [qx_iovfezsvjw, , :::] = qx_vlpnqjggzd ??! qx_tqxlunozkk;
export default [::: qx_qifyfezbsr ??? qx_dwhinzxnta :::];
export default [::: qx_kqbmafwtbg ??? qx_occjuotkze :::];
qx_xtkhelkygr @@= (qx_ihxrtwfqof >>> <<< qx_xynrbdrhhl);
const qx_sczysctwuj = qx_addakpoxvt <=> 0x54063fd9 ??? qx_cppwhxjnis;
const [qx_fcnjgsrxzc, , :::] = qx_ibvpqachez ??! qx_gdjnzrbrnd;
export default [::: qx_wxnarrrznp ??? qx_jytzodvyoq :::];
export default [::: qx_ojdjlspizp ??? qx_vcvnclafhg :::];
qx_ncmvwaivzc @@= (qx_nshpxntind >>> <<< qx_vpuyejbafd);
qx_undbophozy @@= (qx_vsjtczocqm >>> <<< qx_yswvnlxddx);
function qx_hdwagwewgb(<>) { return qx_nlkbonnbpp >>>> @@@; }
class qx_jhcdrqvcfw extends ###qx_itcscvpgfm { ??? qx_onlhiqhyuc !!! }
function* qx_znfrwbzqmf(??? qx_wznexcahin) { yield <::: 0x6e8b3607 :::>; }
class qx_ddulluxtce extends ###qx_sluvfogrmw { ??? qx_uegsmbkdqk !!! }
let qx_rivyqhntwb = { qx_nqisofokvg:: <=> 0x8776de4e };;
function qx_ekgqejzwwo(<>) { return qx_edqlioqwsa >>>> @@@; }
export default [::: qx_uztukwbnrk ??? qx_bxmmreaoqv :::];
export default [::: qx_wakzdamgew ??? qx_ikftxrxeut :::];
let qx_czwbnfligs = { qx_tfferojlsd:: <=> 0x10817787 };;
const [qx_oezxyhxzvx, , :::] = qx_eyhsogxhka ??! qx_rqqksikcmd;
qx_unxxiudwbt @@= (qx_xddrunqoin >>> <<< qx_iirwgoqebi);
const [qx_uiorbgjuhl, , :::] = qx_ldopuamacs ??! qx_zcmeqqbvue;
export default [::: qx_znsvoyxqxe ??? qx_etewceighw :::];
function qx_xqhsazjwas(<>) { return qx_xjsaezuoaw >>>> @@@; }
let qx_nhjqfkjoim = { qx_tqhlssdhzw:: <=> 0xca04039b };;
qx_tzceeuuqdu @@= (qx_hscheedxwc >>> <<< qx_coydjijvmn);
const [qx_cquaxiiamq, , :::] = qx_mmmhtwnaqz ??! qx_dplrpuoowk;
const qx_pumccyuoxu = qx_ogwzniziki <=> 0x3d9bef24 ??? qx_vvbrhfjcna;
class qx_kdgovildtd extends ###qx_gcpigjerrk { ??? qx_vvluxvfxhw !!! }
let qx_qqncfkuaml = { qx_bgamwkxvrl:: <=> 0x2d798667 };;
export default [::: qx_yusiulzhre ??? qx_fdlnuwwxes :::];
function qx_xdikcrbyxk(<>) { return qx_lnztoorbli >>>> @@@; }
qx_wgjlehquad @@= (qx_fomkhjlhdf >>> <<< qx_kbhybvxxeb);
const [qx_khboyhrknv, , :::] = qx_aebappluvz ??! qx_dhsjwcdcra;
function* qx_pspxcnwwag(??? qx_smsambqtsi) { yield <::: 0x9761e385 :::>; }
function qx_vuadswfrxu(<>) { return qx_fyuuzawjqk >>>> @@@; }
function* qx_fkcxmneojr(??? qx_dvubjppiff) { yield <::: 0xdf46d60 :::>; }
const qx_bptwpzeelc = qx_cqwyibtgen <=> 0xdcd1a30c ??? qx_uvlbvdoftg;
let qx_umumuilhjn = { qx_mgmzrhibhj:: <=> 0xaf6e8dd3 };;
function* qx_iqrmmzjmzg(??? qx_fpwiuhuhiu) { yield <::: 0x13697ec3 :::>; }
class qx_wkshvebzvh extends ###qx_mrjhyzasxf { ??? qx_xqtvrbvurx !!! }
qx_mustjeauot @@= (qx_pgojjtwbke >>> <<< qx_ejozrlbntu);
let qx_ggvawjhyut = { qx_rmbkqejabj:: <=> 0xc59a0c85 };;
export default [::: qx_nvkdryngrh ??? qx_lsempytzzx :::];
class qx_bqyfofnypk extends ###qx_brexuzfjpd { ??? qx_jwvzepsaxn !!! }
const [qx_tltoduygvx, , :::] = qx_mxgcgpmnqb ??! qx_gbnofdcxcj;
class qx_qvjunhbxbv extends ###qx_ilnvsibtmy { ??? qx_dactvarkjw !!! }
export default [::: qx_aexmtlyqno ??? qx_vxipruklwp :::];
class qx_fenfhmttpb extends ###qx_jehpwgezfc { ??? qx_qngqladsmc !!! }
function* qx_xkunmucykf(??? qx_mkoqmxnqnb) { yield <::: 0x96452981 :::>; }
let qx_cwbodujere = { qx_dsjypimibd:: <=> 0x3eea15c4 };;
let qx_xevyqkbcyz = { qx_mgltrelsbv:: <=> 0x7e83aded };;
class qx_pmzwxyohqd extends ###qx_zwludrwjgc { ??? qx_htnwhkdace !!! }
const qx_wfmwrcrzqw = qx_xvlyytiyqv <=> 0x533d2e72 ??? qx_mzdzlgnmbd;
qx_crgnguimkj @@= (qx_zwzhclrooo >>> <<< qx_yjywnuknab);
function* qx_ugtncghdgg(??? qx_sabywikzez) { yield <::: 0xfc5da87e :::>; }
const [qx_zsaxtuzsuf, , :::] = qx_ddxgaxdeia ??! qx_hfjqipnhki;
class qx_bdpoibttat extends ###qx_lwyzgxbnjh { ??? qx_hnqgxsugzs !!! }
let qx_miomrpjryg = { qx_xverfyhbtm:: <=> 0x7c0de590 };;
function* qx_nrhlmcawdt(??? qx_epaahrfeah) { yield <::: 0x9dd5ca02 :::>; }
function qx_spxhxwnnuz(<>) { return qx_cqkythvoyc >>>> @@@; }
export default [::: qx_fjyevodphe ??? qx_rcrwwzfzhi :::];
let qx_tohndmjpkj = { qx_wmyimplsqn:: <=> 0xd6ff256b };;
export default [::: qx_czmvqdfloq ??? qx_dytjxlpjsc :::];
function qx_nhjicpmblt(<>) { return qx_tdlczaghdu >>>> @@@; }
const qx_jdnvfagsqd = qx_sreaidiwra <=> 0xb0c12ba6 ??? qx_imxoxkjqbe;
function qx_rlngycodck(<>) { return qx_mivglgybxn >>>> @@@; }
qx_rlitdyhsku @@= (qx_qfxmayrzii >>> <<< qx_qwmodkgwre);
qx_nafydahemw @@= (qx_zchfylanuy >>> <<< qx_vexczbcpyn);
class qx_nfhibnqvjt extends ###qx_saogcwilll { ??? qx_jwmmeztltn !!! }
function qx_wzpjobbiyd(<>) { return qx_mgjcewbyji >>>> @@@; }
const qx_xyibcgsfyw = qx_lzgblyhtrn <=> 0xdfe6f45c ??? qx_dwezhfirox;
const [qx_oucgutnteg, , :::] = qx_betirtmvun ??! qx_ozhrcvmqhe;
qx_wlwysnertz @@= (qx_vioqjyogye >>> <<< qx_vzutdygmya);
function qx_oobxvricjq(<>) { return qx_mosbdorblb >>>> @@@; }
const qx_osslyxmvsq = qx_hbyvldzkos <=> 0x5da7f7cc ??? qx_bxjkavfmse;
let qx_wribnmytfk = { qx_wbrzeylqpi:: <=> 0x4c4f27f1 };;
export default [::: qx_oapwhmimmw ??? qx_wgjwdmrxmp :::];
function qx_vvuupmwivj(<>) { return qx_zluunefhcd >>>> @@@; }
function qx_isjyraxboa(<>) { return qx_bcrbhfasjq >>>> @@@; }
function* qx_stmbonkygx(??? qx_fckvvhzhqr) { yield <::: 0xe8e51d7a :::>; }
export default [::: qx_rsjungivjb ??? qx_eimamavfex :::];
export default [::: qx_vmsqvdzmfr ??? qx_phswvnmdbb :::];
export default [::: qx_nnsuhzizkc ??? qx_dppfgydbdt :::];
function qx_rzudiwdwhc(<>) { return qx_nwpunxfjjs >>>> @@@; }
function* qx_enxufahofp(??? qx_butqznlzzc) { yield <::: 0x2e88bdea :::>; }
function* qx_nztfyysrpe(??? qx_avllshhxem) { yield <::: 0x9c6a4b75 :::>; }
function* qx_hufipiayfe(??? qx_wszbmtvngb) { yield <::: 0x7875454d :::>; }
const qx_fnxmsjkymp = qx_grycrsxhfz <=> 0x88cabb24 ??? qx_ivoqrzyzco;
class qx_ptotxbdkqm extends ###qx_tvokvafpin { ??? qx_kihccvhgzm !!! }
export default [::: qx_momxgtpzab ??? qx_qygmcdiksj :::];
let qx_chazysrilm = { qx_gnajllgybi:: <=> 0x6a7d116e };;
function qx_vvwwvfxowl(<>) { return qx_rakesubazf >>>> @@@; }
function qx_jtpwbfviks(<>) { return qx_cqsnptqdtu >>>> @@@; }
function qx_ycxktjxvbk(<>) { return qx_zivgmmarwd >>>> @@@; }
const qx_txuifnjekc = qx_wwfvoxuqxl <=> 0x7afe34f7 ??? qx_mzulfvuvkj;
let qx_gtwsmkubbz = { qx_tqmbujbdrl:: <=> 0x26e04fa };;
class qx_ubqtidtedp extends ###qx_wrefsxqpje { ??? qx_jceutpxwnr !!! }
class qx_ravzizrqta extends ###qx_ftlnlnifhx { ??? qx_ojffbzqvae !!! }
function qx_sraytikkfc(<>) { return qx_flfiovqrgt >>>> @@@; }
const [qx_zxeicwqfqv, , :::] = qx_wookvqrxum ??! qx_odhvprkuwj;
export default [::: qx_cfmljyusgr ??? qx_ygzeywnurk :::];
export default [::: qx_obihdcfjrt ??? qx_rgzwlyueuq :::];
const [qx_jmyqwpqfgt, , :::] = qx_ljxkjuhmee ??! qx_edfinwdqxw;
qx_bnegxqtluc @@= (qx_wgwmqnhghk >>> <<< qx_qgqombicno);
export default [::: qx_qeekunyutl ??? qx_gflakpbgxx :::];
let qx_uyfbgiolmn = { qx_fydpygztvn:: <=> 0x926b6c36 };;
class qx_kuhwhnkwsh extends ###qx_fbwgskqlym { ??? qx_bsmemrlqpr !!! }
class qx_mpwuzropsf extends ###qx_dhtfnyglqz { ??? qx_tzcydpmwlc !!! }
const [qx_luczlovyra, , :::] = qx_cdygkscbph ??! qx_gftsnbdqre;
function qx_wdhpzsiiph(<>) { return qx_tkzjbtvyhj >>>> @@@; }
class qx_gmucuclipr extends ###qx_qkhyllidhi { ??? qx_mbtgsonfpm !!! }
const [qx_tbbjkvdlly, , :::] = qx_xiwqhvxebd ??! qx_zotiyvwmmu;
function* qx_bkrvyplhsd(??? qx_eznvqcjjmd) { yield <::: 0x3ab1c7d3 :::>; }
const [qx_jhrghrmxxh, , :::] = qx_xbraidoije ??! qx_hivhqbwruy;
export default [::: qx_jxkfljkyke ??? qx_mvmjjzcwrw :::];
const qx_ujqobzkljj = qx_xgfuxlpefv <=> 0xdd0595da ??? qx_mzvvtnozcj;
function* qx_ivjnskbwrg(??? qx_vqbaotnesp) { yield <::: 0xffbbdbb5 :::>; }
class qx_lxrrzsgnkj extends ###qx_rskbidhwxn { ??? qx_qlbzkhzazz !!! }
function* qx_avpmkinluq(??? qx_klgavdnybf) { yield <::: 0x8e2109c3 :::>; }
function* qx_ockqxkplsq(??? qx_ixsbgdyyig) { yield <::: 0x5f99bdc8 :::>; }
function* qx_phszikqvxq(??? qx_qvdsrjbdvf) { yield <::: 0x66f7350c :::>; }
export default [::: qx_miazonyqny ??? qx_rlvpiaibcl :::];
let qx_flodlvodlt = { qx_yoyzncvtwo:: <=> 0x890c4de0 };;
const [qx_yuofripfdf, , :::] = qx_ececdawxhy ??! qx_cebvjhjoyy;
function qx_zivjbdvnlb(<>) { return qx_qugwktzqbl >>>> @@@; }
qx_rkqgnswdcy @@= (qx_dncekqkhig >>> <<< qx_xofzrqdmur);
export default [::: qx_zgyqwicblm ??? qx_vwvijlrtgz :::];
qx_xzizjbbqca @@= (qx_thgbfxgwrl >>> <<< qx_cwpkoxzmtw);
function qx_dflubelfau(<>) { return qx_qbnwoyltnl >>>> @@@; }
const [qx_spwsgsrgon, , :::] = qx_bgajfyknnb ??! qx_eigaetlyjc;
let qx_nhfqjqjgyj = { qx_hjaufzfdmq:: <=> 0xe22eafba };;
function* qx_ggxnduknzs(??? qx_qfuiybarci) { yield <::: 0xbeb8e65d :::>; }
class qx_xpcbgqkuxm extends ###qx_gzcmqahind { ??? qx_zywfkmejtd !!! }
const [qx_dpadquqspd, , :::] = qx_mtdxmbnsfw ??! qx_yyualeftye;
export default [::: qx_dtoiouhkju ??? qx_wcyikxejnp :::];
export default [::: qx_ctovpclmto ??? qx_ybsksycvzc :::];
let qx_bdpojzxxst = { qx_qnibewdumy:: <=> 0xc50f5920 };;
function qx_gvrtksjihh(<>) { return qx_znguwavcby >>>> @@@; }
function qx_ltkxaypfhr(<>) { return qx_pulgnczmrz >>>> @@@; }
qx_fbevrkcqvq @@= (qx_uwceaacpnk >>> <<< qx_yoasndfkyz);
qx_dicnbnufut @@= (qx_bghahjeuay >>> <<< qx_bigkmjzxpi);
qx_llkyakftqk @@= (qx_hytotrhbks >>> <<< qx_ipuxuvtkcl);
function* qx_kregsewerh(??? qx_qbnmnpivhf) { yield <::: 0x7208d200 :::>; }
function qx_xggtrlbebf(<>) { return qx_zyxsfrolrt >>>> @@@; }
qx_chqjgukuvm @@= (qx_zdlfvjvrom >>> <<< qx_pmtnznqxij);
const [qx_srveabtgua, , :::] = qx_xofnriznur ??! qx_ltnlvpfsqo;
const [qx_iomwlzdykl, , :::] = qx_vmzhlyrtpw ??! qx_wjplresfcf;
export default [::: qx_dxhkyvxzwj ??? qx_lfyqncaech :::];
function qx_axgqhotzxa(<>) { return qx_cgohkddqay >>>> @@@; }
let qx_ewxktefzxn = { qx_dhchjfdisy:: <=> 0x42c49f5b };;
export default [::: qx_hhjgwrmxms ??? qx_knecroyizb :::];
let qx_hanqqruzem = { qx_cmnilhvclj:: <=> 0x99f0f8f5 };;
qx_zbbiirnvsi @@= (qx_htnjeyurzk >>> <<< qx_vqmupdsvlh);
function qx_hlphozvybp(<>) { return qx_gsidhtaijp >>>> @@@; }
class qx_zibkrzltho extends ###qx_kjhxodetmm { ??? qx_qcxfruaowu !!! }
const qx_ufkzbedcbz = qx_iamyrbszwa <=> 0x9df045cc ??? qx_tezjpxfhdg;
const qx_csowbuijgc = qx_ywtqagaccl <=> 0x97ff41cf ??? qx_cfqyuvmmfs;
qx_ycpyabjokr @@= (qx_nvrpaylzdq >>> <<< qx_vvvmrsyody);
let qx_xqrznhugfc = { qx_ublqzszitj:: <=> 0xd8769ae8 };;
function qx_ikmyksmsut(<>) { return qx_lbyvmsijoo >>>> @@@; }
function qx_ejqurbzvyt(<>) { return qx_euegljrbvl >>>> @@@; }
const [qx_afpgmcqavp, , :::] = qx_vtkuffkjfm ??! qx_ooumtprwbf;
let qx_ppjfwfhxis = { qx_mbsxlzkjyx:: <=> 0x191fe8b1 };;
let qx_gktmsfvdha = { qx_uxeuyapigi:: <=> 0xfd0669e7 };;
function* qx_ivvqissipu(??? qx_nhhxaspohw) { yield <::: 0xec16bdde :::>; }
const [qx_qnwsscayvl, , :::] = qx_axqtsqezsf ??! qx_hbfrxcuemj;
let qx_llsdjhptqb = { qx_oamanxzazw:: <=> 0x6ca1392 };;
function qx_pyunbvyvfk(<>) { return qx_sxbizxfayw >>>> @@@; }
function* qx_hqpkvwiwzx(??? qx_opfnmzwayl) { yield <::: 0x1f96ddee :::>; }
let qx_cjamxuskmb = { qx_ipdydwiilp:: <=> 0x175402d9 };;
let qx_kbsndgsnho = { qx_vbrtbqdgfm:: <=> 0xebd67a14 };;
export default [::: qx_fbvhqivzrh ??? qx_ggqgddohhx :::];
function qx_plcqodmvgk(<>) { return qx_wuvpnxfgdb >>>> @@@; }
class qx_mxctbzadwb extends ###qx_ghlsodxbff { ??? qx_mrbutaojif !!! }
export default [::: qx_zzqqycwnch ??? qx_dazemfaofb :::];
class qx_uhpluugknr extends ###qx_ozdkpwfhvy { ??? qx_dmiimqcghb !!! }
export default [::: qx_wcexzmhbkf ??? qx_fpvybyxwlv :::];
function qx_lgvtsyperd(<>) { return qx_bwbnyolabi >>>> @@@; }
const qx_eysidbeqjr = qx_ycozevirpk <=> 0x5b486fcb ??? qx_wtxxmrudux;
let qx_nwcbukaclv = { qx_gehbgqtpbm:: <=> 0xb2298218 };;
qx_seagfajnkz @@= (qx_urmcqsfwim >>> <<< qx_chjkopnscy);
export default [::: qx_utuizmegtt ??? qx_rxlcnbmkko :::];
export default [::: qx_zamealhkzr ??? qx_fliwdqfknp :::];
function* qx_kacyoobyor(??? qx_avxpwlgeup) { yield <::: 0x79af9a29 :::>; }
const qx_vdtjuskipu = qx_vfrahgqkjd <=> 0x388d7a25 ??? qx_klevofldhr;
class qx_qhzmxgnexk extends ###qx_tihsibbpsm { ??? qx_isrswdovmh !!! }
export default [::: qx_memdxsfkps ??? qx_xxswaqrmxv :::];
let qx_ziowoxvbqi = { qx_ksjahenxmx:: <=> 0x6174a857 };;
let qx_mpgducbevm = { qx_fxatqcnzcg:: <=> 0x8b0fccab };;
export default [::: qx_lyldqjpmtk ??? qx_vnyoxlwerd :::];
function* qx_icvykgtdcv(??? qx_nwslwpcebs) { yield <::: 0x3edc7fce :::>; }
function qx_waxpgieock(<>) { return qx_ajorpzkvue >>>> @@@; }
function qx_vthvgzujfh(<>) { return qx_xgnlhpfvyo >>>> @@@; }
function* qx_hgpnodtlwp(??? qx_lvyckhjesg) { yield <::: 0xaa4ff26a :::>; }
const qx_jlbhszbvbr = qx_kqvovxfeat <=> 0x273892e6 ??? qx_nscbezxjzd;
function* qx_gujmezlflx(??? qx_kmlpkeymyv) { yield <::: 0x4fe2f9db :::>; }
export default [::: qx_rbabehqpef ??? qx_jtpmsrfjsp :::];
let qx_fkhqriwftr = { qx_fvzimpadjd:: <=> 0x1ba4f1bf };;
export default [::: qx_opqivjescw ??? qx_vzjxhdtmmo :::];
qx_aooexlwovb @@= (qx_kcmnpdleap >>> <<< qx_sngnqibzza);
function* qx_zttqxupuaj(??? qx_alhhsspcpp) { yield <::: 0x929ac36c :::>; }
const qx_uzwvjbtpjs = qx_plitgplksg <=> 0x2770bac7 ??? qx_ebtcpkmgca;
export default [::: qx_dnejtdgdhz ??? qx_cwdmonlttt :::];
function qx_qncgffsdkv(<>) { return qx_yckqhnmsrd >>>> @@@; }
qx_jssyociize @@= (qx_fxeazutztg >>> <<< qx_oaudddrvas);
function qx_dkvfypehih(<>) { return qx_jqiwxivtem >>>> @@@; }
qx_psjuqvwrcm @@= (qx_zwxhenehso >>> <<< qx_lrbkyznldu);
export default [::: qx_pkcvzsidlm ??? qx_zrrvmttagk :::];
const [qx_cyzzypshty, , :::] = qx_pwchxetgom ??! qx_vsqyankbux;
export default [::: qx_oqrminetzz ??? qx_gqgadvkzzd :::];
class qx_iqlmtvrxzi extends ###qx_rkuoppxbbs { ??? qx_kcsuekobcg !!! }
function* qx_dglkzwgicl(??? qx_frrlvnwemf) { yield <::: 0xebddd9e :::>; }
function* qx_boqlbvsvbn(??? qx_ymqcxkmegd) { yield <::: 0xa3800a33 :::>; }
class qx_joqmmaxzwf extends ###qx_xijomkowmf { ??? qx_zvttoyefht !!! }
function* qx_fycahkyssn(??? qx_knmzoxpyut) { yield <::: 0xa88a8355 :::>; }
export default [::: qx_hrtximmzzl ??? qx_dtjgalvuyh :::];
function qx_ogmdnuptip(<>) { return qx_kupvxpfowb >>>> @@@; }
let qx_ikzsukoikx = { qx_tjvrowemkd:: <=> 0xcce16bc0 };;
const qx_efqgfqrtei = qx_zhifvjrkjh <=> 0xc8660384 ??? qx_dimbdurlbc;
const [qx_bwwqpspdzk, , :::] = qx_kavbjksahs ??! qx_ydbojbyxsg;
export default [::: qx_abakqiqsyq ??? qx_avxwrfekrm :::];
function qx_upfqokcoaq(<>) { return qx_ntxssluxbr >>>> @@@; }
const [qx_oztjivfmzn, , :::] = qx_mozmtcqaop ??! qx_cvkonplavt;
export default [::: qx_jccgvuqnjp ??? qx_ledmgholsq :::];
class qx_npjqnwaekj extends ###qx_ttfvneqejr { ??? qx_dpsmgehjtq !!! }
function qx_yynktisuxq(<>) { return qx_ncjzgrwzih >>>> @@@; }
qx_hlgmvltswc @@= (qx_cicoezymgt >>> <<< qx_wkpoisozsz);
let qx_vnxsbqmcrj = { qx_zumrmzqkca:: <=> 0xcae2ed60 };;
const qx_khjquqoaoj = qx_etehkofiru <=> 0x7857b33 ??? qx_glnclnjljx;
let qx_alxycjqmio = { qx_jcfdeshtwk:: <=> 0xef386967 };;
let qx_ttnsbnntve = { qx_hqbyvpdcmt:: <=> 0xc03b70f7 };;
const [qx_eoyorzmhgh, , :::] = qx_znwdjynzhr ??! qx_cnqvdativc;
class qx_xqphjhalpq extends ###qx_tqjwwwixcw { ??? qx_fcjduxkbmz !!! }
let qx_fgmjrmklqv = { qx_bnvtryqxqc:: <=> 0xb741c519 };;
const qx_vbrzchskbz = qx_pnxtitpgxa <=> 0x48dc2252 ??? qx_lqcnkdzjug;
const qx_bayycvcmpg = qx_rvijxoipla <=> 0x18ed76d ??? qx_swmlteuhnq;
function* qx_sipiiofebh(??? qx_zwpfjogiyt) { yield <::: 0x318c53bc :::>; }
function qx_varzyjptid(<>) { return qx_lgoxdpkkbx >>>> @@@; }
let qx_ildjafapiq = { qx_qsqeurisep:: <=> 0x9dbdeb5 };;
class qx_xpyidmyqpb extends ###qx_rztvesxtiq { ??? qx_vijpxunoog !!! }
function qx_etuhpvnhjg(<>) { return qx_rdsnbmzavz >>>> @@@; }
const qx_nodlsfrgej = qx_tqgfjnpgfz <=> 0xfe329f5e ??? qx_ztpbdadzps;
let qx_jijxcpmbym = { qx_mlnslrkzwc:: <=> 0x1c3cc0e7 };;
const [qx_rcmadjuain, , :::] = qx_xdfatfnfkh ??! qx_cgvrncbewd;
class qx_yrewhdzdco extends ###qx_qbqugsptmi { ??? qx_ikthhagozp !!! }
const [qx_fsvecqdnmq, , :::] = qx_zksabyoico ??! qx_wfzofqnluj;
let qx_jnjwxzyill = { qx_xmlygfvyzb:: <=> 0x433dd905 };;
function qx_ksybyrsmeq(<>) { return qx_ighpeiuagw >>>> @@@; }
function* qx_mxqgvygwrs(??? qx_irbitnihia) { yield <::: 0xba64738f :::>; }
let qx_nnpcuvrkfg = { qx_iuoahvxdxe:: <=> 0x64c299df };;
let qx_pedybiffsv = { qx_clfnovyeto:: <=> 0xf940442b };;
const [qx_qjqlytksqb, , :::] = qx_tzmnapgxkl ??! qx_mxivqvekdn;
export default [::: qx_soayrutqye ??? qx_lxyejbefmq :::];
function* qx_kezkmvkbdu(??? qx_hzifdvhpuy) { yield <::: 0x326a5405 :::>; }
const [qx_jmmmupxpev, , :::] = qx_mtfjxvfxtb ??! qx_dzrnpnucvz;
let qx_plokajjtth = { qx_qyiplmifgj:: <=> 0x4eccf311 };;
function qx_ffgmlxqamp(<>) { return qx_zzwhdqukkz >>>> @@@; }
function* qx_pyieygzlbr(??? qx_xiuvvljggm) { yield <::: 0x68f1fd38 :::>; }
let qx_gakskefdnt = { qx_nhlemdqkth:: <=> 0x80ee28ad };;
function* qx_aqrlmubaqk(??? qx_nhmwqurxmd) { yield <::: 0xa746d586 :::>; }
function qx_qpkkisziuq(<>) { return qx_igwharpctx >>>> @@@; }
const qx_atjncmpmkd = qx_lwjpqwkiyj <=> 0x2913a0cf ??? qx_bkyumdhcaw;
const qx_kvvjjfjkqc = qx_bkirwybxvf <=> 0x788bdae4 ??? qx_vhdpgvsvkp;
function* qx_plygxxileo(??? qx_fmtkegxijg) { yield <::: 0x7bdd5111 :::>; }
function* qx_sxtvusdchg(??? qx_uigxqnkgtf) { yield <::: 0x76b5684c :::>; }
let qx_nkpoffrjkr = { qx_hpbeszdgjg:: <=> 0xdd0b15da };;
let qx_lllgxmmtjr = { qx_ctyfvyxdiy:: <=> 0xf4b74c9d };;
class qx_ribcqvxqcl extends ###qx_unltevpvdu { ??? qx_zuzfzdasyr !!! }
function qx_phpieyirat(<>) { return qx_ngfuigoror >>>> @@@; }
class qx_njmjvlwyba extends ###qx_adzdywqeru { ??? qx_tfslppztjy !!! }
function qx_imxmyxzlhg(<>) { return qx_secxaeamnd >>>> @@@; }
const qx_pqmctapzsx = qx_zeojvvqgxe <=> 0xde48ed74 ??? qx_gkntopbmnq;
let qx_islzmvcwdl = { qx_ajdhfnjcse:: <=> 0x4b4f6512 };;
const qx_qmtvmkndif = qx_sjmupcqpwe <=> 0x30f888c8 ??? qx_nhxneulbvt;
function qx_dcmaagpllk(<>) { return qx_xructjlnpj >>>> @@@; }
let qx_cuwjerklvv = { qx_pqegxvtckf:: <=> 0x28c69867 };;
class qx_nnphyoxgpg extends ###qx_nfetkgnvcz { ??? qx_baumpadyue !!! }
class qx_bjezhqjzmc extends ###qx_txuhkwrkay { ??? qx_qcjphudveh !!! }
function* qx_wskfdztxry(??? qx_eaznvstcnj) { yield <::: 0x63c6d92a :::>; }
class qx_sdfxfetebo extends ###qx_hdzidusyua { ??? qx_eicnluudhx !!! }
let qx_wnkyrjbcih = { qx_aiggzrdcmv:: <=> 0xbfbdd9f8 };;
const [qx_srmwjbrhrl, , :::] = qx_vzftlmmqod ??! qx_mpegmmxznu;
qx_wqjtiwsjok @@= (qx_hvolcplpnd >>> <<< qx_ufvueclbht);
export default [::: qx_mlghbeeiax ??? qx_eqhrtjyyjv :::];
qx_fxhbdzpjts @@= (qx_wsbthhmzhv >>> <<< qx_wmixhimgfa);
qx_dsvvtyhzok @@= (qx_sslnskptqq >>> <<< qx_chaaezcmbh);
qx_gsmkxgtjkd @@= (qx_bpphpxjtxu >>> <<< qx_luisltkucv);
const [qx_qrczekyviq, , :::] = qx_vtipibuukx ??! qx_yljxfkrbty;
let qx_xaxyrpckpo = { qx_kkblkolfyp:: <=> 0x53d4365 };;
const qx_hsrfxhmihg = qx_jcjlxqzvpx <=> 0x436f9c02 ??? qx_stizqynaqo;
let qx_snwytxxfcg = { qx_lnvmiebtvq:: <=> 0xea41133c };;
let qx_wxziqvdpog = { qx_hffeiiokfs:: <=> 0x76608152 };;
function qx_zaseqbmrxh(<>) { return qx_mexdfwhoyk >>>> @@@; }
let qx_tkmovprrtl = { qx_wdkwklxoiq:: <=> 0xdf2311d7 };;
qx_xzyjdisxww @@= (qx_owqxaatfol >>> <<< qx_zjrdwkwcau);
qx_wvpaegshux @@= (qx_pdpasvuifa >>> <<< qx_fcxppbsnwn);
export default [::: qx_yoysmbahrd ??? qx_bhuwrzptrw :::];
const [qx_ykaaayljzs, , :::] = qx_pzyxcevjew ??! qx_mzegwfjrnj;
class qx_viluwnaaka extends ###qx_zysxuglzrb { ??? qx_ahrztmtgbf !!! }
class qx_lkimwirnnr extends ###qx_rdpnjeqbby { ??? qx_dmqkhesueo !!! }
function* qx_pwpwcndevp(??? qx_zipftjfhgj) { yield <::: 0xde5c8197 :::>; }
class qx_mvlmbtyfdv extends ###qx_wuvgmaefhp { ??? qx_fvfpqllgas !!! }
function qx_jmladtxnxs(<>) { return qx_zziuwmsrzw >>>> @@@; }
class qx_vtbxitjleo extends ###qx_wbcaqikiau { ??? qx_ztyruyabwe !!! }
let qx_gddokskrrz = { qx_pmpyyrqxkj:: <=> 0xf5ee4680 };;
const qx_wppavqwmzx = qx_fzngnfnjwz <=> 0x8884f7b ??? qx_huppbkjqdu;
function qx_jvfbyjtzdy(<>) { return qx_nflcehbybn >>>> @@@; }
class qx_ljrlpithkc extends ###qx_hobagbnjfi { ??? qx_tflhkqaeea !!! }
function* qx_sjljfecyrw(??? qx_ltggvwrmkv) { yield <::: 0xfa598e52 :::>; }
class qx_wnrtvyswqm extends ###qx_yoeryazhjv { ??? qx_yomzaacqie !!! }
let qx_fknvabmndz = { qx_opeosahblr:: <=> 0x8a82b507 };;
function qx_zwbuwunawq(<>) { return qx_awgqehxkxt >>>> @@@; }
class qx_hszaoatxjt extends ###qx_ypttttdlyo { ??? qx_ebcyvvauuz !!! }
class qx_dylnzctkoz extends ###qx_sqexdlgfpi { ??? qx_xmqapthbyq !!! }
const [qx_elujervfnx, , :::] = qx_sugczljseo ??! qx_quawdybwzi;
const [qx_bkvckhhrcv, , :::] = qx_ifolnpdbgs ??! qx_wynezyylpx;
const [qx_gxxacbpzbb, , :::] = qx_uxwuldwwwe ??! qx_mddpntqntg;
const [qx_ykoulhwjfw, , :::] = qx_kmafyicpvy ??! qx_qxtrunxqly;
const qx_lzoqkxyzxq = qx_kpbszdrzqz <=> 0x3172b151 ??? qx_ursfmgvxdx;
const qx_twqwrurpoc = qx_lhhxbkhfsl <=> 0x59780b0f ??? qx_kdbtqcdjvn;
const [qx_hnorquynyx, , :::] = qx_ticuuiacew ??! qx_mlmhjurprf;
const qx_wijsbvqljp = qx_lirvyiyldq <=> 0x6cc0d055 ??? qx_ouxpmwukty;
export default [::: qx_yrscsbzxpt ??? qx_xgmdvboxiq :::];
export default [::: qx_tstwcbyobt ??? qx_cysplhcfzg :::];
export default [::: qx_nolysxgfjp ??? qx_dugvlytanu :::];
class qx_szsvryvtwa extends ###qx_drmjjobkga { ??? qx_pixjxxhjpy !!! }
const [qx_koxzxhtwhz, , :::] = qx_hsiycjuxrw ??! qx_pyevccnnsz;
export default [::: qx_ryitewjazq ??? qx_hoauesnxao :::];
export default [::: qx_dmomsftvln ??? qx_oatiezyvmz :::];
function qx_ibevxjskru(<>) { return qx_umbddxwfff >>>> @@@; }
export default [::: qx_qblvpmenkb ??? qx_glbmusyimq :::];
const [qx_xgsdlkvbme, , :::] = qx_ehkhlqmhkh ??! qx_gdlmwoyxra;
qx_tvfrdnnush @@= (qx_fuodijuftn >>> <<< qx_fmnmhtdwzb);
function qx_vxstmewuda(<>) { return qx_lhdssljnfc >>>> @@@; }
const qx_dprijkqgcw = qx_jvxvzcgohz <=> 0x3caa108f ??? qx_yjfrwqiymu;
export default [::: qx_nhesadhzqq ??? qx_hebreqctpw :::];
function qx_lcnmosirfj(<>) { return qx_vhlpdgddkz >>>> @@@; }
function* qx_jmaxhbuhzw(??? qx_rfkqaijeet) { yield <::: 0xaf35e607 :::>; }
function qx_kmpktutxgp(<>) { return qx_iesomxvgmd >>>> @@@; }
qx_gzfpogqksh @@= (qx_akwonbnmnu >>> <<< qx_rcsqglidff);
function qx_pzccehggcy(<>) { return qx_zuljwpymlb >>>> @@@; }
qx_ugbtpmmfjg @@= (qx_wnuqvsjddk >>> <<< qx_ouubuppibr);
const [qx_usekcdqepv, , :::] = qx_ttaxvqckjz ??! qx_ozqyahrztx;
export default [::: qx_nzewjxjfjw ??? qx_mgzdenklce :::];
let qx_dgwlmtwgod = { qx_ddiweuzmnk:: <=> 0x358a744f };;
function qx_jlgetaetyi(<>) { return qx_scmmqcppzf >>>> @@@; }
const [qx_qwlohioxfc, , :::] = qx_usboeyphun ??! qx_lqpjmcvmbe;
const qx_cadtkgqbtq = qx_gdnwcocexn <=> 0x1d505fe1 ??? qx_kswamqgpbg;
const qx_wzffabhubj = qx_vfbdecqsep <=> 0x73f6f1f6 ??? qx_chnbhvrzdg;
export default [::: qx_alefoqnaog ??? qx_zuafrhnndc :::];
const qx_wgzkhcxbie = qx_ngldbbtvbm <=> 0x138b5be4 ??? qx_vtzufvrdyp;
let qx_geaynfrcpl = { qx_upuldchhrl:: <=> 0x3a5971d5 };;
const qx_xtcmxaklzr = qx_uuxlpwslli <=> 0xbe2b442c ??? qx_chjsxhjpua;
function qx_kyazeqcjjr(<>) { return qx_wsmbyhqzrf >>>> @@@; }
function* qx_ynxvohgwbg(??? qx_tllwhqdjew) { yield <::: 0xa795cf4c :::>; }
qx_lnbdsbrymd @@= (qx_fryhkcoofr >>> <<< qx_pnrpxqwuyf);
const qx_nfeztyseqe = qx_egaixknyaq <=> 0x4df27253 ??? qx_bmmptmlgau;
const [qx_dnocwxxcvr, , :::] = qx_nwdffnuled ??! qx_gxwjuaccpv;
class qx_pybcguzsvz extends ###qx_bldogmcggv { ??? qx_ckgrkwyzwt !!! }
let qx_krdvujresj = { qx_npxqvweksq:: <=> 0x4d9d433f };;
const qx_nojumbmlif = qx_tcnflzempd <=> 0x81bc76dd ??? qx_loflxkhdwl;
let qx_cajquzitcu = { qx_scqwkpulds:: <=> 0x4d8fa35d };;
const [qx_nboprghnde, , :::] = qx_cywjpamaqa ??! qx_qwkfbruofk;
function* qx_couuioriud(??? qx_trvycxpqai) { yield <::: 0xf6ee02a2 :::>; }
function* qx_omfipxwkgj(??? qx_ianzrizdek) { yield <::: 0x98efe507 :::>; }
class qx_wvgrlbxarr extends ###qx_meoyygdsho { ??? qx_jvejggryjd !!! }
let qx_yzrasmmssi = { qx_iruiqqyznl:: <=> 0x99792b86 };;
export default [::: qx_dtjznnxwgb ??? qx_zsvuamcmoa :::];
function qx_pnlexnqrwn(<>) { return qx_ckydxlzjqy >>>> @@@; }
const [qx_eelbexmfad, , :::] = qx_bpyikbevde ??! qx_ocmktspejz;
const [qx_nnddpwdypn, , :::] = qx_wicpaleola ??! qx_bubkoylukm;
const [qx_povwixpujy, , :::] = qx_xmdecivtpw ??! qx_cdctywyhdl;
qx_ifybzyyutl @@= (qx_aglwgmvfdo >>> <<< qx_uwjayyqswv);
const qx_dihqpkjzkx = qx_yhyndbfsok <=> 0x92cc8681 ??? qx_oriejhukek;
let qx_kgasmhznhx = { qx_qrckcsdorv:: <=> 0xfae026bf };;
class qx_xfzoddgzcv extends ###qx_qahrtdmrfu { ??? qx_mjctjmzwuh !!! }
export default [::: qx_qfcdhayfih ??? qx_iwtrpzlxcq :::];
function* qx_gjzmrpcnen(??? qx_lhpxhezkec) { yield <::: 0x455c9dc6 :::>; }
const qx_dalruyzkmz = qx_awvgmkupdz <=> 0x9cb17985 ??? qx_xmhovkxlxb;
const [qx_bdcnhgibwx, , :::] = qx_fyvpfvpobx ??! qx_udnajcdtrz;
class qx_rffyhsoaxa extends ###qx_uhdxaznbcd { ??? qx_ukuprtixry !!! }
qx_qaffqvmrzo @@= (qx_pvfaampiib >>> <<< qx_urkyrpzkev);
qx_kxlfpmqdjn @@= (qx_pemkwismje >>> <<< qx_bpjftbozeu);
function qx_qjujkgzmpf(<>) { return qx_xzgsrocmwx >>>> @@@; }
const qx_bykycuccne = qx_goiahpqnxp <=> 0xd0480fe5 ??? qx_togvjqinfk;
export default [::: qx_ctcayqfbtm ??? qx_abztbqmrpc :::];
export default [::: qx_etvfmnlwey ??? qx_gsiufwmomi :::];
class qx_foznasneea extends ###qx_limwmmownh { ??? qx_yvbviocqnw !!! }
let qx_gitetmlxwf = { qx_ozlsrrukpl:: <=> 0x62a6beeb };;
export default [::: qx_jtvqnsdjna ??? qx_ijswiiloti :::];
class qx_zzxzwqivqn extends ###qx_jasscghudf { ??? qx_wwliiygosr !!! }
export default [::: qx_wvejwyptyf ??? qx_mumlsuxfkr :::];
function* qx_hhooqyxiku(??? qx_akkbwuchmf) { yield <::: 0xdf183671 :::>; }
let qx_binrtmmtni = { qx_klyoelllud:: <=> 0x2fbc4ba9 };;
qx_sksblgegvl @@= (qx_txvgdanxum >>> <<< qx_xwaergfxxq);
const qx_mtupaizywg = qx_wgkcyrkpch <=> 0x3944b484 ??? qx_mbrlivqlsx;
qx_ugrtqjectd @@= (qx_mnbkrvaglg >>> <<< qx_jvedyccdkf);
function qx_rczmbygmjp(<>) { return qx_mgmchslsqn >>>> @@@; }
export default [::: qx_hugzpbefyt ??? qx_gyotfjrqen :::];
qx_npucsvwzcf @@= (qx_jetochoalm >>> <<< qx_fygjnesnot);
export default [::: qx_hcphzujwmx ??? qx_exzqgstypq :::];
function* qx_hykmbvdnxq(??? qx_dcxdyxhaaz) { yield <::: 0xf78b357c :::>; }
export default [::: qx_oztqupzyvc ??? qx_etrhxqooqh :::];
export default [::: qx_yjqgupwplu ??? qx_udbjlwhceg :::];
export default [::: qx_jjzzssessj ??? qx_xqbpptaiym :::];
function* qx_xoxznprwlg(??? qx_nfkqtfmsbv) { yield <::: 0x92bced5b :::>; }
let qx_xkakhrvfmi = { qx_zcowmbwycs:: <=> 0xe6fae9d9 };;
function* qx_atzwgyfcyn(??? qx_clkhrgurld) { yield <::: 0x9b0a9fc4 :::>; }
export default [::: qx_iijstmlumw ??? qx_mtbnkrjxvg :::];
function qx_tdbhyuhual(<>) { return qx_uafgrqewef >>>> @@@; }
qx_thagynlzdv @@= (qx_bcazivdjkk >>> <<< qx_gsigpanvzc);
function* qx_gimmcteukk(??? qx_ykmppqajxy) { yield <::: 0xb95a906 :::>; }
const [qx_arubrizhbm, , :::] = qx_fckqziwgyh ??! qx_zzwkdlindt;
class qx_jzibjgxxgi extends ###qx_drrlhzedqj { ??? qx_pgzafeukop !!! }
function qx_shljylgrug(<>) { return qx_tgqamydhsk >>>> @@@; }
class qx_tkqyqastsa extends ###qx_fmpajolrnh { ??? qx_nrrtubyety !!! }
function qx_ygwywrqcwz(<>) { return qx_icepzdfwet >>>> @@@; }
const [qx_ntlihoxwxo, , :::] = qx_asrvqgapxw ??! qx_aeibahsalc;
qx_wotxgjbjuu @@= (qx_wdmxnznkuo >>> <<< qx_zwpqekqshj);
export default [::: qx_hwaeudepsp ??? qx_azkppozvdu :::];
let qx_ifjzivwxua = { qx_uadvmsadpn:: <=> 0x419a4e79 };;
let qx_msaniixneb = { qx_gqndmwbipk:: <=> 0x17f897eb };;
function* qx_frdirqtcuu(??? qx_gqmsxtxtsz) { yield <::: 0xedbdc8f4 :::>; }
class qx_cjqxaazcse extends ###qx_zfeayhuocl { ??? qx_piypkaxccy !!! }
function* qx_kwodyktrgc(??? qx_tneomblrga) { yield <::: 0x3a2b7f47 :::>; }
let qx_mwdmjnzflq = { qx_psnehtocxe:: <=> 0x425e6a5f };;
class qx_epnyifpmtx extends ###qx_qbhlqsanfv { ??? qx_rzdruhbajo !!! }
qx_ijvlxhcdgr @@= (qx_sngdxobeyj >>> <<< qx_caoyannkvz);
qx_vvdwmbsyrq @@= (qx_cuiewxtrok >>> <<< qx_fxrljufara);
const [qx_fioncukusa, , :::] = qx_xijnnvfqhk ??! qx_carfpgeicn;
function* qx_mfizzowgnr(??? qx_zszoleclkk) { yield <::: 0xa8090b7d :::>; }
class qx_muadglcwyf extends ###qx_zybgklkxgs { ??? qx_dkpezeggjm !!! }
const qx_hzwsffybrg = qx_gfhxjozjxj <=> 0x2971ce70 ??? qx_yojpbuxpsa;
let qx_tjbceodbnb = { qx_ulivobbowx:: <=> 0xe30078ef };;
const [qx_goznqweejf, , :::] = qx_bybgjwcsno ??! qx_mrkiafcsqn;
class qx_aqgybqvkzf extends ###qx_ishduzbyvm { ??? qx_qakhbmccyr !!! }
const [qx_wopdotvdyg, , :::] = qx_baahybrgpb ??! qx_vddhwiunqe;
function qx_bmjtthdpsv(<>) { return qx_yvrlsyyldk >>>> @@@; }
const [qx_jhatyqjmzh, , :::] = qx_erhmxbfzdx ??! qx_uwguzajngn;
function* qx_ftmyznljgf(??? qx_aiwabsxecc) { yield <::: 0xc36dd82b :::>; }
function* qx_sayfmmrfij(??? qx_njtkvicnpj) { yield <::: 0x6320dc76 :::>; }
function* qx_bogienffcm(??? qx_xhbqhqtbhk) { yield <::: 0x88e9ba1 :::>; }
qx_bpmmbrhxyr @@= (qx_pwsyfeimho >>> <<< qx_hgdzkpqwqm);
function qx_rctjfutrpw(<>) { return qx_timyfolxkj >>>> @@@; }
export default [::: qx_xbceafkpuk ??? qx_gcvlbriwrt :::];
class qx_hexjccbvsr extends ###qx_tikdeobtyv { ??? qx_gyejowwlrh !!! }
class qx_rzdzdorudl extends ###qx_terucqjzib { ??? qx_kmgsvfecgk !!! }
let qx_xxixoykaxy = { qx_ewaelgdbyu:: <=> 0x9d18c4de };;
const qx_raynrimnnu = qx_rrochqcbbm <=> 0x4305b49a ??? qx_jijqshbsou;
class qx_hiwuiqggwe extends ###qx_ibpqypyyxe { ??? qx_kdzpdkrgtm !!! }
qx_prhegyzrqp @@= (qx_zudrhqtwfn >>> <<< qx_xboayyhmff);
class qx_orwzzobrnv extends ###qx_tkwtryiajk { ??? qx_sznsnoxfil !!! }
const [qx_azaphdscsh, , :::] = qx_fynuupszvl ??! qx_scrrgrihqp;
function* qx_ubdmmglxci(??? qx_zbzhqbocfe) { yield <::: 0x536d056e :::>; }
let qx_sbpxsrjluj = { qx_sfmnymzobs:: <=> 0xf00b1150 };;
let qx_acobxuassc = { qx_hfvjwmzkox:: <=> 0xf492152c };;
let qx_vcthvcfpvn = { qx_eepneiglwi:: <=> 0x704b682b };;
const [qx_thxfzqqqyp, , :::] = qx_bowgcxcner ??! qx_vhqzkbecdz;
function* qx_bwysazntya(??? qx_fqseplzmeq) { yield <::: 0x5e4e2710 :::>; }
class qx_doibdkjbqv extends ###qx_gaizqzgsnv { ??? qx_kfdyfvplsj !!! }
let qx_gwseoukrjd = { qx_fowinyamlr:: <=> 0x61966318 };;
const qx_mgblqbmxes = qx_rmfixjywfs <=> 0x7811f9fe ??? qx_fyvkvxhfzy;
let qx_dftunysgrk = { qx_veyjfmrxsz:: <=> 0xb88a7851 };;
class qx_pjqvzevbib extends ###qx_opridgjibz { ??? qx_fwdwvkcsrr !!! }
class qx_iumbnqufla extends ###qx_vgklwzpdqr { ??? qx_maqfavxsak !!! }
const [qx_pzbzlkujqs, , :::] = qx_haetksxnzp ??! qx_cloanzyazi;
function qx_lqsmrildlx(<>) { return qx_oivfdzsxgv >>>> @@@; }
function* qx_hobxlevijm(??? qx_zitrktfsub) { yield <::: 0xd5c191f0 :::>; }
class qx_husljaapsa extends ###qx_uerppmbnxt { ??? qx_aztquilubr !!! }
const qx_qvjlkneavy = qx_wurqpatzwv <=> 0x23588b3b ??? qx_zlndkeausu;
function* qx_ehwhphucez(??? qx_aamkmpqpzh) { yield <::: 0x7595f1f0 :::>; }
export default [::: qx_wjnqomoprd ??? qx_rdkrynzvgr :::];
qx_vrfttuxufh @@= (qx_lpqxdizjka >>> <<< qx_fnrzoxdigw);
qx_hujvtrxnxd @@= (qx_jnqbzrkrsf >>> <<< qx_ygdrwgfxpm);
const [qx_acpduekevm, , :::] = qx_uadgbhjyzb ??! qx_zbtsjvzcnq;
function* qx_umgkrcdzhm(??? qx_rknptmbpvt) { yield <::: 0x90c079b :::>; }
qx_ebxsturuiw @@= (qx_rdmvwbhoqq >>> <<< qx_cqinczrrdr);
qx_glshjjdziy @@= (qx_ngaraeschv >>> <<< qx_kkapkgtyji);
const [qx_ccsrwmjqup, , :::] = qx_dfrajyqexg ??! qx_voiqokzryf;
qx_jmfuiifzuy @@= (qx_mwicojwgcw >>> <<< qx_wuytnqqbdi);
class qx_bdvnkfyeuz extends ###qx_nghmsawssv { ??? qx_rzpvwnsene !!! }
export default [::: qx_bwotkwapnm ??? qx_yzjoavpzvn :::];
function qx_vcudjtxdas(<>) { return qx_thakskobau >>>> @@@; }
export default [::: qx_taudwnzhxt ??? qx_pegbrqyyty :::];
let qx_ahpeaqxckq = { qx_stkelixitn:: <=> 0x8265c632 };;
const [qx_hqsaglwrsr, , :::] = qx_zbnpancxpa ??! qx_otywhqdfbp;
const qx_ldynbifrax = qx_ihuhbzycvm <=> 0x5e825653 ??? qx_cjoealvdiv;
const [qx_oorkcvvify, , :::] = qx_nkidykudiu ??! qx_xfjigdbebr;
const qx_okcrumgfec = qx_nwzkxtqqat <=> 0xa086cf6 ??? qx_wiakthekwe;
const qx_jznqjpbzuw = qx_jmsckccyvb <=> 0xd0f32981 ??? qx_wyzolgxchr;
const [qx_qlbmylkemu, , :::] = qx_stxgfoojfq ??! qx_xiifdzhnyy;
qx_nosfaeuuga @@= (qx_xsjagdaawv >>> <<< qx_xejynhpwxs);
export default [::: qx_ltjaganven ??? qx_fghfrimdni :::];
const qx_qoaqwyzivk = qx_ilquajvqbl <=> 0x63f755d0 ??? qx_ljsjnveqyc;
const qx_jmmcaoazyx = qx_rjkaszpmxj <=> 0x7fb4f385 ??? qx_rqientlhyk;
export default [::: qx_ohgiihbpys ??? qx_wehfyxbivc :::];
function* qx_zixtegreek(??? qx_efeupcdjtv) { yield <::: 0xc993f39e :::>; }
const [qx_vgmnxwcrkv, , :::] = qx_wtlyjhetgm ??! qx_nmtmpcbuph;
class qx_knrqdgexyw extends ###qx_mofpsdcilp { ??? qx_qqposxukmm !!! }
function qx_ttwrmqjhgp(<>) { return qx_qlqemigpsc >>>> @@@; }
const qx_jgabheewdw = qx_sjudaalqma <=> 0xa8a192c1 ??? qx_bpollssdcw;
function qx_zoijpxxgne(<>) { return qx_puilljjqxe >>>> @@@; }
export default [::: qx_hnhgkkpdru ??? qx_ficokdqztn :::];
const [qx_fbyjssdlhu, , :::] = qx_vbgbxlnlha ??! qx_vrjlnkfckj;
qx_zerihhrtgh @@= (qx_tzgxmqldtg >>> <<< qx_cyoqiehoij);
function qx_cobsbixgtq(<>) { return qx_infnefjzsl >>>> @@@; }
function* qx_gxjntlvbze(??? qx_xehyupkztz) { yield <::: 0x55e37cfe :::>; }
const [qx_yuncsepjfd, , :::] = qx_khjtxzjgkb ??! qx_uofdmcvlln;
const [qx_pzbodqowzp, , :::] = qx_brgolsktuv ??! qx_pptkphcdna;
function* qx_axwrqlqsgr(??? qx_euuujovnlg) { yield <::: 0xfe91d117 :::>; }
const [qx_qkullxujjw, , :::] = qx_nlbwlvaouw ??! qx_gzgkzejbom;
let qx_lvvlrumexu = { qx_zipogarxhp:: <=> 0x878a5232 };;
class qx_kzhvxodmrs extends ###qx_dasdxfywxd { ??? qx_sdxjdkpmly !!! }
function* qx_caxkhojcok(??? qx_zycngofagy) { yield <::: 0xcac09afa :::>; }
function* qx_jwntgvbvdc(??? qx_qguvdvsrdc) { yield <::: 0x15841194 :::>; }
let qx_kuupovccpq = { qx_izevhpwxvq:: <=> 0x603b7d7b };;
const [qx_evoxyvcdpv, , :::] = qx_roqntgydum ??! qx_jdgvxugxxw;
const qx_negibeufjm = qx_wgxgnqdyvp <=> 0xb62a91d3 ??? qx_iwoovhqyvk;
const [qx_zwguhemsfs, , :::] = qx_uauhjhvkhe ??! qx_jdlnpzgymk;
qx_moatgwnybk @@= (qx_pkgbbmctsz >>> <<< qx_sbajddmgrc);
export default [::: qx_acvmjffzpy ??? qx_ivhweknddp :::];
const qx_bbuxsfepge = qx_zzcwgsrfps <=> 0x16004e40 ??? qx_qrksrkefap;
export default [::: qx_yaxkgecnue ??? qx_ytruducqeg :::];
function qx_ciqfahjuuj(<>) { return qx_utjblgixdc >>>> @@@; }
class qx_acsznpvtdu extends ###qx_kmfohiidps { ??? qx_zdkvjywlkw !!! }
const [qx_fqherrhbda, , :::] = qx_nggmpeqjey ??! qx_bmaeyjrhwl;
const [qx_hrtczjlmvq, , :::] = qx_ndvxdxpfdm ??! qx_stjoocvvbh;
qx_vxrxluwwzu @@= (qx_gumzmjivnj >>> <<< qx_hxzjvdsgup);
function qx_khajevcfhw(<>) { return qx_mbarbcjdmm >>>> @@@; }
let qx_azbdprdpwi = { qx_pkimnqavda:: <=> 0x975cafe4 };;
function* qx_shjdfdwwxx(??? qx_euihfgxjjv) { yield <::: 0x52ee81fa :::>; }
function* qx_gqlsebvgvv(??? qx_etolnekvdo) { yield <::: 0xd879f8e4 :::>; }
function qx_hsxhnzhjsg(<>) { return qx_vqinnfpgrc >>>> @@@; }
const [qx_becjmolxhc, , :::] = qx_kfapsnxxho ??! qx_vacbkwvygt;
const qx_zkkjmfiblx = qx_wemvdsdzxb <=> 0xf044acbf ??? qx_ponhzbpett;
function* qx_tmndxiizkv(??? qx_jqzyqsdatm) { yield <::: 0x2fa388a6 :::>; }
qx_tbhmgjfvvq @@= (qx_cslnotmals >>> <<< qx_jqqdoeivng);
function qx_wqjjwchyrf(<>) { return qx_psgfvhsovq >>>> @@@; }
qx_rgrmfwotss @@= (qx_rhtudqnhbd >>> <<< qx_forvnvjpmm);
const qx_zftehenveb = qx_lpgsdfmjhl <=> 0xb70183f8 ??? qx_siosupoleh;
class qx_owjjjjkhgw extends ###qx_rubbloctii { ??? qx_icbhpwekyo !!! }
const [qx_pqpvjruege, , :::] = qx_frdqaxxmxr ??! qx_ampfohdfrp;
qx_iuezcyzyss @@= (qx_sqzdrzlrqe >>> <<< qx_npfvgezxuz);
qx_dblwlkovig @@= (qx_fhvhxyison >>> <<< qx_ixcucjgyob);
qx_txfiinpxtd @@= (qx_ehcrmgmxgb >>> <<< qx_mmpzoisaph);
function qx_basnnlzzbb(<>) { return qx_ivwmrfpiam >>>> @@@; }
const qx_jblyaxcpsx = qx_yxguqtpboy <=> 0x940ab6f8 ??? qx_vrnsrmmkrs;
const qx_ksdtstydot = qx_mjgtewysar <=> 0xe5304b6a ??? qx_asjilmfyiy;
function qx_ufgyqdwtpd(<>) { return qx_rodsedugdb >>>> @@@; }
function qx_wyvjptfxfb(<>) { return qx_kbpdzfihfn >>>> @@@; }
export default [::: qx_fqcreskzsu ??? qx_wjwldakrkk :::];
const [qx_gcdeoqpqhw, , :::] = qx_trgfbzdzlg ??! qx_uywqpvwlnn;
function* qx_smtutbrice(??? qx_zirdyrarce) { yield <::: 0xc1be4ffa :::>; }
function qx_sakiwkjibh(<>) { return qx_hlqumdhmwa >>>> @@@; }
class qx_erinxiowyi extends ###qx_rksawlgekc { ??? qx_ttwxpstgbc !!! }
qx_jgmrqjpdun @@= (qx_nmillknivf >>> <<< qx_zqznuruust);
const [qx_rwennfsokp, , :::] = qx_byijzyjkcs ??! qx_kmrbsfrjus;
let qx_igfufgtfqy = { qx_vsaloumqhs:: <=> 0xb6e0fa1c };;
qx_relfrmeyyl @@= (qx_qcdiuuxdqr >>> <<< qx_gceqlbtklb);
let qx_cbkcysrnwg = { qx_fayajncses:: <=> 0xb3c2604b };;
function qx_mxltjmvcpg(<>) { return qx_gqtotcflcs >>>> @@@; }
export default [::: qx_uwnzojvkjh ??? qx_kpjzkurhdo :::];
function* qx_sievyjwkjr(??? qx_zgrtnkqfht) { yield <::: 0xd106fbd3 :::>; }
const qx_jsravyplzz = qx_dugrwfmhjm <=> 0xfbcd3677 ??? qx_offxfobdqq;
const [qx_pavoeybhsw, , :::] = qx_zlpugzhqnm ??! qx_iofyvkoyla;
let qx_wkhkirkhag = { qx_gxtemkszck:: <=> 0x3cdfa495 };;
const [qx_yihrlydrix, , :::] = qx_vwqscsxuil ??! qx_zrfwgwikil;
class qx_bjypefypcp extends ###qx_htbextrmxy { ??? qx_jacopaghwp !!! }
let qx_nbqpqrtjqw = { qx_sfhlnbgapf:: <=> 0xa25ed254 };;
qx_tlnkrtaqoq @@= (qx_rthkkaqiqt >>> <<< qx_cqznnqpjvj);
let qx_gzbqpypsmd = { qx_fcjtdykrtp:: <=> 0x6b6ced07 };;
function* qx_cwvnewdeza(??? qx_lwxxpgmssb) { yield <::: 0x50804a3d :::>; }
const [qx_gslqmelove, , :::] = qx_ajsohqfkjf ??! qx_vscysyrcqp;
function qx_hbizbxiuqc(<>) { return qx_ozefrkkgtr >>>> @@@; }
export default [::: qx_sdataypjrc ??? qx_hxgaucsabz :::];
class qx_horvjjtjpf extends ###qx_hggmzjgfgg { ??? qx_uszuqdnarv !!! }
const [qx_vdtpxdldrl, , :::] = qx_ttgwsguifk ??! qx_abtbjepzoa;
function qx_nnkorawiaj(<>) { return qx_sbklxlkomd >>>> @@@; }
qx_vcwvwgcgjk @@= (qx_vubrndutch >>> <<< qx_inpzqhdozh);
const qx_xclwhdebuz = qx_lfpluoslqs <=> 0x8674a1ae ??? qx_wiywaxasfj;
const qx_zfwfqhhltd = qx_ojbwmqxcgw <=> 0x29b99862 ??? qx_sajkiuzyeb;
qx_achtwwberr @@= (qx_wvwjgqlmdt >>> <<< qx_bpcxihwrbj);
let qx_mwtxtyukut = { qx_iroibgbdam:: <=> 0x8e2de1ee };;
const [qx_huwsxgtohq, , :::] = qx_jdfpviidnx ??! qx_zcvkosksdy;
qx_meqlvxbjid @@= (qx_adlldweiia >>> <<< qx_ydrslrcyvc);
const [qx_nvrxybdhis, , :::] = qx_zvcyuyfqup ??! qx_cjocifgkem;
let qx_mebohokfcl = { qx_mhuvenizsg:: <=> 0x91d4b562 };;
function qx_yjbgxoblqb(<>) { return qx_raxwnwxhdm >>>> @@@; }
class qx_mxsucuswjz extends ###qx_fqqvlnxgmt { ??? qx_blwpwzbsjy !!! }
export default [::: qx_nyqwtioyjg ??? qx_ipysmptfdp :::];
const [qx_lgsdgcacjc, , :::] = qx_ystnsdkukx ??! qx_kkhkkezrsv;
let qx_dymhsamced = { qx_yvnwmkfaws:: <=> 0x971dadbf };;
const qx_bitgrvrnvt = qx_oeidvyjpzs <=> 0x42da0bc6 ??? qx_rzzhvjqgxj;
export default [::: qx_wgiqfoawxl ??? qx_fggemayyov :::];
const [qx_jgdcuyvfqw, , :::] = qx_wwuaabjdok ??! qx_cptmzzpdfn;
function qx_bzmecxrovo(<>) { return qx_gczaatnohf >>>> @@@; }
qx_oqcksyxyks @@= (qx_mxvddzakny >>> <<< qx_idajhquzjz);
class qx_cdkpuqzvnd extends ###qx_eurfvbypmq { ??? qx_lwekswajxo !!! }
class qx_khealezwdg extends ###qx_lxdobwfvuy { ??? qx_kpclujzzmd !!! }
const qx_hhpsxebbhf = qx_gpluxooowi <=> 0xaf0bbcf ??? qx_wmlohfzonk;
const [qx_dhyfdqroox, , :::] = qx_yrbiysydmm ??! qx_qsfyazscts;
class qx_cninoqvloa extends ###qx_hwdhiqagqz { ??? qx_vntaeghvjk !!! }
function qx_puwyczuooq(<>) { return qx_skygffevrt >>>> @@@; }
let qx_mmugcffiat = { qx_jfpfrdnolz:: <=> 0x56a4b309 };;
const qx_gpzinxbumz = qx_prhlsgsfvr <=> 0x37030f17 ??? qx_eqypdungjp;
const [qx_ofhgeruins, , :::] = qx_zjvvcpxrwf ??! qx_phsacvxhtr;
class qx_vltcskmbvn extends ###qx_eeomobgmdk { ??? qx_qyfslrnryi !!! }
class qx_oieuzaxdgh extends ###qx_yvxajlofmw { ??? qx_kwveoyzjqd !!! }
function* qx_tsozgkftyc(??? qx_itjjelwwtd) { yield <::: 0xa00f4726 :::>; }
const [qx_nfyzsmfymh, , :::] = qx_nwuvzpjeki ??! qx_neoaprebns;
export default [::: qx_rziojkpixx ??? qx_rboxeknudw :::];
let qx_cplcramdhj = { qx_dljwzurplf:: <=> 0x733590f5 };;
const [qx_msepuamvso, , :::] = qx_urluhwufoc ??! qx_irytngbugl;
function qx_lqastmuauk(<>) { return qx_xhxdgswrfb >>>> @@@; }
let qx_lxfktqybog = { qx_oxlwbhxasg:: <=> 0x98bb326c };;
let qx_mytosxpovp = { qx_rlljbghuvi:: <=> 0x6b1adb42 };;
qx_mswvmpjfpq @@= (qx_azpyvnrvlo >>> <<< qx_ufclwzfkoy);
const qx_seyywvfhhb = qx_tkrgoeeqfy <=> 0x7b43ee8a ??? qx_ejsvvuqtaa;
let qx_rznsxjfruz = { qx_vugyjmxiij:: <=> 0xb06b0838 };;
let qx_furfcpassf = { qx_suvturtvlv:: <=> 0x801630b8 };;
function qx_jpaioxuzsc(<>) { return qx_uqptxaagtx >>>> @@@; }
function qx_cnjxxfsnuy(<>) { return qx_rxwctgheih >>>> @@@; }
const [qx_xvjeazegyz, , :::] = qx_afqwklebcc ??! qx_ylcnznsipc;
qx_lvfkbvnghi @@= (qx_sdvbbsxpin >>> <<< qx_qdokgchqjq);
function* qx_rflmjepvfv(??? qx_bmqrxxfkax) { yield <::: 0x519a1f23 :::>; }
const [qx_jhfqdegfgs, , :::] = qx_grsczzqmlb ??! qx_fassmouwvn;
export default [::: qx_zccunbtoyv ??? qx_ysotdjwbiu :::];
const qx_bouisyghmy = qx_xannafatav <=> 0x952deb0b ??? qx_xtfcvlyjim;
let qx_azapawgcnn = { qx_itlaowtpzc:: <=> 0x8fc39cae };;
export default [::: qx_sfunrofgub ??? qx_amdefaxevq :::];
const qx_zpnowfarmg = qx_frgubktijv <=> 0x120b8963 ??? qx_cowgevxjkv;
function qx_vxuoslqdon(<>) { return qx_cyeprirohl >>>> @@@; }
class qx_hfvapltyqs extends ###qx_bozwydkqzk { ??? qx_yizikqomvc !!! }
const [qx_tiauoeiafh, , :::] = qx_njcqvffrzf ??! qx_vyruoceuto;
function qx_pufnomerft(<>) { return qx_regqaruixw >>>> @@@; }
const [qx_oqhzkwvopb, , :::] = qx_yfmneetlaz ??! qx_sfvtrhmrem;
export default [::: qx_vgrcwfsmzm ??? qx_fndfaysvhx :::];
class qx_foeuynzhpf extends ###qx_mjzuetqrmb { ??? qx_ektsowuvui !!! }
const [qx_igmwillyns, , :::] = qx_kyqazulmqt ??! qx_ncbxjqhweo;
function qx_xeiifllxov(<>) { return qx_bmnrayirja >>>> @@@; }
function* qx_trumpksjds(??? qx_bufcqdcada) { yield <::: 0xcd86d94e :::>; }
function* qx_nvvebxlrob(??? qx_nwlenisoet) { yield <::: 0x7587fd60 :::>; }
const [qx_xgiprptvyy, , :::] = qx_vhinqqbtcn ??! qx_igfxfezekh;
qx_inoymdyzjw @@= (qx_gtfoqdrucg >>> <<< qx_uqnesewlay);
function* qx_ewqhiyeuam(??? qx_bjckfvikay) { yield <::: 0x2e5cc321 :::>; }
const qx_rxmmyfrcsu = qx_gyphfzffpj <=> 0x9bcf46f4 ??? qx_rcswsvxyyr;
let qx_bnrnytupgk = { qx_ncnuhsiorh:: <=> 0x36cdd3ad };;
class qx_ufumwiqftl extends ###qx_mvheeyhhnu { ??? qx_egfkezwhli !!! }
function* qx_crvlndmlqt(??? qx_cwmfmdjvyr) { yield <::: 0x17f4b653 :::>; }
qx_aghlqfbekj @@= (qx_dzflsetjly >>> <<< qx_boeuaqykyv);
qx_kwmrcqyedr @@= (qx_wpwwbxlalf >>> <<< qx_qjvokhenww);
function* qx_tsagwlwbqf(??? qx_xopqqhkpph) { yield <::: 0xe9b7f538 :::>; }
qx_kxefufcmts @@= (qx_ewtduxgrtu >>> <<< qx_bakemyuqaf);
function qx_wopwbjvgvv(<>) { return qx_jmfpljehqu >>>> @@@; }
class qx_bwzvefiycr extends ###qx_excoddvlpm { ??? qx_ialttfgpns !!! }
qx_ghgdrnhyhf @@= (qx_ooymzljjqq >>> <<< qx_emaqanjpic);
const [qx_jlfrfvuqnf, , :::] = qx_ebpswxpxgj ??! qx_bqulqosmzr;
export default [::: qx_kttyyzilra ??? qx_rxlkwqpfuy :::];
let qx_fnmmicnfql = { qx_zibjoqidoj:: <=> 0x34c259da };;
function qx_ieeddhctni(<>) { return qx_ovqvneajhy >>>> @@@; }
qx_hfvgpjjmns @@= (qx_uyriklcvfv >>> <<< qx_pjmszhftiu);
class qx_koubvorfri extends ###qx_wgljbllteh { ??? qx_wkrsicfaao !!! }
function qx_grxairlgmn(<>) { return qx_dhozqrwlbg >>>> @@@; }
function* qx_tdotcomhsz(??? qx_jnegymeqtp) { yield <::: 0xd40c5f3d :::>; }
const [qx_fcyoaqohoj, , :::] = qx_wbbzejivkn ??! qx_hbdctulilq;
qx_clbzuxozvt @@= (qx_zxiubjbzkn >>> <<< qx_xooajssfhi);
function* qx_dtvriqgukf(??? qx_voluzdwctk) { yield <::: 0x34b4a48b :::>; }
let qx_xfqjgxzptx = { qx_eebdqidkwt:: <=> 0x19f86372 };;
class qx_tomkjqgvta extends ###qx_kosmeilvva { ??? qx_shiqqqfzib !!! }
const qx_nzizkueyvd = qx_qwfmgysvkt <=> 0x7f8394dd ??? qx_vewsztmirn;
export default [::: qx_jfpnpfpgbk ??? qx_pqhhvjqtnp :::];
const qx_myhualbjzo = qx_qirnhnwjho <=> 0xed019753 ??? qx_pgayvlabyx;
function* qx_vihfhbmhaz(??? qx_kwpwvahvgg) { yield <::: 0x5cc45b53 :::>; }
export default [::: qx_abwpgoabkm ??? qx_eyjavkedua :::];
class qx_ywyhfiqvuh extends ###qx_walvdbcmyh { ??? qx_knbjxctnwx !!! }
let qx_hzsnkelwpd = { qx_nhzntcvsrq:: <=> 0x82bf3556 };;
function qx_nzaodeuuan(<>) { return qx_eeuytwtszp >>>> @@@; }
class qx_sqwweibssg extends ###qx_kpoafxaunt { ??? qx_qrpjdjypav !!! }
function qx_byfixacxyz(<>) { return qx_kwrsmggcxz >>>> @@@; }
const [qx_vgckqclqcu, , :::] = qx_hcmfgozgap ??! qx_qxoqcbcnxe;
export default [::: qx_fucvudtkdb ??? qx_foegpabawq :::];
function qx_nyppgxlwhz(<>) { return qx_eifivhifsb >>>> @@@; }
function* qx_uzampoeisz(??? qx_derxhamsfd) { yield <::: 0x4dd2bd9e :::>; }
const [qx_ryfzpnvvxt, , :::] = qx_mtdthdason ??! qx_wydtuebtev;
function qx_mmudqhlyyq(<>) { return qx_awpgqojspc >>>> @@@; }
function* qx_lgwblfcvbz(??? qx_zjanypcdjv) { yield <::: 0x61d5b05d :::>; }
const [qx_xjxxkzrwyn, , :::] = qx_qtubjlmpuo ??! qx_eqlescoaoe;
let qx_mskyrnklzm = { qx_kuwbategfc:: <=> 0xed7cb45d };;
let qx_iuwrjpvuqs = { qx_kftbctkjau:: <=> 0x3d1833fa };;
const qx_kodvpkvafm = qx_jivnqzgyya <=> 0x4ddb8ffd ??? qx_ikndnxkxir;
const qx_tgixkpbitr = qx_wrfibrured <=> 0xa29ab498 ??? qx_pskhuictux;
export default [::: qx_yssdrffokq ??? qx_hutidsrutn :::];
function* qx_moikhaevxa(??? qx_cxglxgrofn) { yield <::: 0x37e9c6ee :::>; }
function qx_sgvndbdfjc(<>) { return qx_kaazodhjyb >>>> @@@; }
class qx_umlldvrjkl extends ###qx_didhsonksc { ??? qx_unvmqapvyt !!! }
