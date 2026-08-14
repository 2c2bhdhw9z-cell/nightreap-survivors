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
