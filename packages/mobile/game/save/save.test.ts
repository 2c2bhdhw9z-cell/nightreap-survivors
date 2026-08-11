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
  saveChecksum,
} from "./codec";
import {
  SAVE_LIMITS,
  SAVE_VERSION,
  bitCount,
  bitGet,
  bitSet,
  createSaveData,
  defaultSettings,
  noteTaint,
} from "./schema";
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
    damageNumbers: false,
    screenShake: false,
    hudScale: 140,
    joystickSize: 92,
    telemetryOptIn: true,
    customNameOptIn: true,
  };
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
      s.damageNumbers === false &&
      s.screenFlash === true &&
      s.screenShake === false &&
      s.telemetryOptIn === true &&
      s.crashReportOptIn === false &&
      s.customNameOptIn === true,
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

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
