/**
 * Dev-gate self-check and content lint. Run headless: `bun packages/mobile/game/dev/dev.test.ts`
 *
 * This is a CI gate, not a curiosity. It fails the build when the dev menu's tier data is wrong, when a
 * SYSTEM panel becomes reachable on a public build, when a SELF panel forgets to taint, or when a file
 * under `game/dev/` picks up an import it must not have.
 *
 * WHAT IT PROVES
 *   1. The registry data satisfies every §5b rule.
 *   2. No SYSTEM panel opens on the public channel under any of the eight flag combinations.
 *   3. `reachable()` never disagrees with `open()`, so the menu's greyed-out state is the real decision.
 *   4. Opening a SELF panel taints the live run, additively, irreversibly, with the right bits.
 *   5. A read-only panel taints nothing, so debugging a real run stays free.
 *   6. Taint survives into the replay header and blocks ladder eligibility.
 *   7. The real files on disk obey the import rules.
 */

import { TAINT, describeTaint, isLadderEligible } from "../replay/format";
import { ReplayRecorder, decodeReplay } from "../replay/recorder";
import { applyDevFlags, createDevContext, devMenuAvailable, type DevFlags } from "./channel";
import { DENY, DevGate, describeDeny } from "./devgate";
import { DEV_PANELS, defineDevPanel, findDevPanel, selfTaintMask } from "./registry";
import {
  formatViolations,
  lintRegistry,
  lintReachability,
  lintSources,
  panelCounts,
  type SourceFile,
} from "./lint";

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

/* ---- 1. registry data --------------------------------------------------------------------------- */

section("registry data");
{
  const counts = panelCounts();
  const violations = lintRegistry();
  check("registry lint is clean", violations.length === 0, formatViolations(violations));
  check(
    "catalog covers both tiers",
    counts.self > 10 && counts.system > 10,
    `${counts.self} SELF, ${counts.system} SYSTEM, ${counts.readOnly} read-only`,
  );
  check(
    "an unrecognised tier normalises to SYSTEM",
    // Cast through unknown on purpose: this is what a typo in a future panel looks like.
    (() => {
      const bogus = defineDevPanel({
        id: "test.bogus",
        label: "Bogus",
        group: "ops",
        tier: "Self" as unknown as "self",
        taint: 0,
        readOnly: true,
      });
      return bogus.tier === "system";
    })(),
    "a typo locks a panel down instead of shipping it",
  );
  check(
    "every SELF mutating panel declares taint",
    DEV_PANELS.every((p) => p.tier !== "self" || p.readOnly || p.taint !== 0),
  );
  check(
    "the SELF taint mask is a subset of the defined bits",
    (selfTaintMask() & ~0x3fff) === 0,
    `mask 0x${selfTaintMask().toString(16)}`,
  );
}

/* ---- 2/3. reachability -------------------------------------------------------------------------- */

section("reachability");
{
  const violations = lintReachability();
  check("reachability lint is clean", violations.length === 0, formatViolations(violations));

  const pub = createDevContext("public");
  pub.flags.devMenuEnabled = true;
  pub.unlocked = true;
  const publicGate = new DevGate(pub);

  const systemIds = DEV_PANELS.filter((p) => p.tier === "system").map((p) => p.id);
  const anySystemOpened = systemIds.some((id) => publicGate.open(id).granted);
  check("no SYSTEM panel opens on a public build", !anySystemOpened, `${systemIds.length} checked`);

  const forbidden = publicGate.open("ops.killswitch");
  check(
    "the denial says why, without leaking that the tier exists",
    forbidden.reason === DENY.TIER_FORBIDDEN && describeDeny(forbidden.reason) === "not available in this build",
    describeDeny(forbidden.reason),
  );

  const selfIds = DEV_PANELS.filter((p) => p.tier === "self").map((p) => p.id);
  const allSelfOpened = selfIds.every((id) => publicGate.open(id).granted);
  check("every SELF panel opens on a public build once unlocked", allSelfOpened, `${selfIds.length} panels`);

  const locked = createDevContext("public");
  locked.flags.devMenuEnabled = true;
  locked.unlocked = false;
  check("locked public build shows no menu", !devMenuAvailable(locked));

  const blocked = createDevContext("internal");
  blocked.flags.accountBlocked = true;
  check("a blocked account loses the menu even internally", !devMenuAvailable(blocked));

  const internal = createDevContext("internal");
  const internalGate = new DevGate(internal);
  check(
    "internal build reaches SYSTEM panels",
    systemIds.every((id) => internalGate.reachable(id)),
    `${systemIds.length} panels`,
  );

  check("an unknown id is denied, not thrown", publicGate.open("nope.nope").reason === DENY.UNKNOWN_PANEL);
  check("audit records denials too", publicGate.history().some((e) => !e.granted));
}

/* ---- 4/5/6. taint plumbing --------------------------------------------------------------------- */

section("taint plumbing");
{
  const ctx = createDevContext("public");
  ctx.flags.devMenuEnabled = true;
  ctx.unlocked = true;
  const gate = new DevGate(ctx);

  const recorder = new ReplayRecorder();
  recorder.begin({ seed: 99, stageId: 1, buildId: 7, contentVersion: 1, characterIds: [1] });
  gate.beginRun(recorder);

  check("a clean public run starts clean", recorder.tainted === 0, describeTaint(recorder.tainted));

  const readOnly = gate.open("render.overlays");
  check(
    "a read-only panel costs nothing",
    readOnly.granted && readOnly.taintApplied === 0 && recorder.tainted === 0,
    "overlays, counters and the atlas viewer stay free during a real run",
  );

  const god = gate.open("run.godmode");
  check(
    "godmode taints on open, not on use",
    (recorder.tainted & TAINT.INVULNERABLE) !== 0 && (recorder.tainted & TAINT.DEV_TOGGLE) !== 0,
    describeTaint(recorder.tainted),
  );
  check("the grant reports what it applied", god.taintApplied === (TAINT.DEV_TOGGLE | TAINT.INVULNERABLE));

  const before = recorder.tainted;
  gate.open("run.timescale");
  check(
    "taint accumulates",
    (recorder.tainted & TAINT.TIME_SCALE) !== 0 && (recorder.tainted & before) === before,
    describeTaint(recorder.tainted),
  );

  const peak = recorder.tainted;
  gate.open("render.atlas");
  check("a read-only panel cannot un-taint", recorder.tainted === peak);
  check("there is no way to clear taint from the client", !("clearTaint" in recorder));

  recorder.recordTick(new Int8Array(2), new Uint8Array(1));
  recorder.end(0);
  const bytes = recorder.encode();
  const decoded = decodeReplay(bytes);
  check(
    "taint survives into the encoded log",
    decoded.header.tainted === peak,
    describeTaint(decoded.header.tainted),
  );
  check("a tainted log is not ladder eligible", !isLadderEligible(decoded.header.tainted));

  // The next run is a fresh recorder: taint is on the run, never on the save.
  gate.endRun();
  const clean = new ReplayRecorder();
  clean.begin({ seed: 100, stageId: 1, buildId: 7, contentVersion: 1, characterIds: [1] });
  gate.beginRun(clean);
  check(
    "the next run starts clean — taint is on the run, not the save",
    clean.tainted === 0 && isLadderEligible(clean.tainted),
  );

  // Opening a panel outside a run must not explode or invent a run to taint.
  gate.endRun();
  const outsideRun = gate.open("run.godmode");
  check("opening a panel with no run active is a no-op", outsideRun.granted && outsideRun.taintApplied === 0);
}

section("chaos and internal channel");
{
  const chaos = createDevContext("public");
  chaos.flags.devMenuEnabled = true;
  chaos.flags.chaosSandboxActive = true;
  const gate = new DevGate(chaos);
  const rec = new ReplayRecorder();
  rec.begin({ seed: 1, stageId: 1, buildId: 1, contentVersion: 1, characterIds: [1] });
  gate.beginRun(rec);
  check(
    "chaos runs are tainted from tick zero",
    (rec.tainted & TAINT.CHAOS_EVENT) !== 0,
    describeTaint(rec.tainted),
  );
  check("chaos closes the public ladder", !gate.publicLadderOpen());
  check("chaos day unlocks the menu without the secret", devMenuAvailable(chaos));
  check("chaos day still does not unlock SYSTEM", !gate.reachable("ladder.submit"));

  const internal = createDevContext("internal");
  const igate = new DevGate(internal);
  const irec = new ReplayRecorder();
  irec.begin({ seed: 1, stageId: 1, buildId: 1, contentVersion: 1, characterIds: [1] });
  igate.beginRun(irec);
  check(
    "internal builds mark every run",
    (irec.tainted & TAINT.DEV_CHANNEL) !== 0,
    describeTaint(irec.tainted),
  );
  check("internal runs never count for the public ladder", !igate.publicLadderOpen());

  const host = new ReplayRecorder();
  host.begin({ seed: 1, stageId: 1, buildId: 1, contentVersion: 1, characterIds: [1, 2] });
  const guestCtx = createDevContext("public");
  const guestGate = new DevGate(guestCtx);
  guestGate.beginRun(host);
  const applied = guestGate.taintRun(TAINT.IMPLAUSIBLE_HOST);
  check(
    "a guest can taint its own run when the host looks implausible",
    applied === TAINT.IMPLAUSIBLE_HOST && (host.tainted & TAINT.IMPLAUSIBLE_HOST) !== 0,
    describeTaint(host.tainted),
  );
}

/* ---- 7. source rules --------------------------------------------------------------------------- */

section("source rules");
{
  /**
   * Reached through `globalThis` for the same reason as the exit code below: the engine carries no Node
   * or Bun types, and this is the only place in it that wants a filesystem.
   */
  const host = globalThis as unknown as {
    Bun?: { file(path: string): { text(): Promise<string> } };
    process?: { cwd?: () => string; exit?: (code: number) => void };
  };

  /**
   * EVERY file under game/, not a hand-written list.
   *
   * This used to name nine files. That is how `core/fx.ts` could be built, documented and tested
   * while the simulation quietly called `Math.cos` on hashed state in six places for months: the
   * linter existed, bit correctly when tested, and was pointed at 9 of ~165 files. A guard with a
   * hardcoded subject list only ever guards the day it was written.
   */
  const files: SourceFile[] = [];
  if (host.Bun) {
    const cwd = host.process?.cwd?.() ?? "";
    const base = cwd.endsWith("/packages/mobile") ? cwd : `${cwd}/packages/mobile`;
    const glob = new Bun.Glob("game/**/*.ts");
    const found: string[] = [];
    for await (const path of glob.scan({ cwd: base })) found.push(path);
    found.sort();
    for (const path of found) {
      files.push({ path, text: await Bun.file(`${base}/${path}`).text() });
    }
  }

  // A floor rather than an exact count, so adding engine files never fails this check — but deleting
  // most of the engine, or a glob that silently matches nothing, still does.
  check("the whole engine was read, not a sample", files.length > 120, `${files.length} files`);
  const violations = lintSources(files);
  check("source lint is clean", violations.length === 0, formatViolations(violations));

  // Prove the linter actually bites, rather than passing because it never looks.
  const planted = lintSources([
    { path: "game/dev/evil.ts", text: `import { post } from "../net/ladder-client";` },
    { path: "game/dev/rn.ts", text: `import { View } from "react-native";` },
    { path: "game/menu/sneaky.ts", text: `const p = findDevPanel("ops.killswitch");` },
    { path: "game/sim/drift.ts", text: `const x = Math.cos(a) * r;` },
    { path: "game/sim/slow.ts", text: `const len = Math.hypot(dx, dy);` },
    { path: "game/sim/chance.ts", text: `const roll = Math.random();` },
  ]);
  const rules = new Set(planted.map((x) => x.rule));
  check(
    "a server-write import is caught",
    rules.has("dev-must-not-write-server"),
    formatViolations(planted.filter((x) => x.rule === "dev-must-not-write-server")),
  );
  check("an RN import inside game/dev is caught", rules.has("engine-has-no-rn"));
  check("bypassing the gate is caught", rules.has("gate-is-the-only-door"));
  check(
    "Math.cos on hashed state is caught",
    planted.some((x) => x.rule === "hashed-math-must-be-specified" && x.subject.endsWith("drift.ts")),
    formatViolations(planted.filter((x) => x.rule === "hashed-math-must-be-specified")),
  );
  check(
    "Math.hypot on hashed state is caught",
    planted.some((x) => x.rule === "hashed-math-must-be-specified" && x.subject.endsWith("slow.ts")),
  );
  check("Math.random anywhere in the engine is caught", rules.has("engine-has-no-unseeded-random"));

  // The rules must not fire on prose. Every one of these words appears in a real comment in the
  // engine explaining why the function is banned, and a linter that cannot tell code from a comment
  // about code is a linter people switch off.
  const prose = lintSources([
    {
      path: "game/sim/documented.ts",
      // eslint-disable-next-line no-useless-concat
      text: `// Math.cos and Math.hypot are banned here; see core/fx.\n/* Math.random too. */\nconst x = Math.sqrt(a);`,
    },
  ]);
  check("a comment naming a banned function is not a violation", prose.length === 0, formatViolations(prose));
  check("Math.sqrt stays allowed", prose.length === 0);
}

section("being told what the menu may do");
{
  /**
   * The asymmetry that matters: the dev menu's baked default is OFF, because that is the shape a store
   * build is submitted in. Feeding that default into an internal build would lock us out of our own
   * tools whenever the network is unreachable — so silence leaves an internal menu open, and only an
   * explicit instruction closes it. A kill, however, still reaches us.
   */
  const silentOff: DevFlags = { devMenuEnabled: false, chaosSandboxActive: false, accountBlocked: false };

  const internal = createDevContext("internal");
  check("internal starts with its menu open", devMenuAvailable(internal));
  applyDevFlags(internal, silentOff, false);
  check("silence does not lock an internal build out", devMenuAvailable(internal));
  check("silence twice reports no change", applyDevFlags(internal, silentOff, false) === false);

  applyDevFlags(internal, silentOff, true);
  check("an explicit kill reaches an internal build", !devMenuAvailable(internal));
  check("the kill is reported as a change", internal.flags.devMenuEnabled === false);

  applyDevFlags(internal, { ...silentOff, devMenuEnabled: true }, true);
  check("an explicit enable brings it back", devMenuAvailable(internal));

  const blocked = createDevContext("internal");
  applyDevFlags(blocked, { devMenuEnabled: false, chaosSandboxActive: false, accountBlocked: true }, true);
  check("a blocked account has no menu", !devMenuAvailable(blocked));

  /**
   * A public build is the opposite case: silence must leave it shut, because that is the default the
   * store copy ships with and the only thing standing between a stranger and the menu.
   */
  const publicCtx = createDevContext("public");
  applyDevFlags(publicCtx, silentOff, false);
  check("silence leaves a public build shut", !devMenuAvailable(publicCtx));
  publicCtx.unlocked = true;
  check("the secret unlock alone is not enough", !devMenuAvailable(publicCtx));
  applyDevFlags(publicCtx, { ...silentOff, devMenuEnabled: true }, true);
  check("published + unlocked opens a public build", devMenuAvailable(publicCtx));

  /** Applied in place, because the app holds exactly one gate and one context for its whole life. */
  const shared = createDevContext("internal");
  const gate = new DevGate(shared);
  applyDevFlags(shared, silentOff, true);
  check(
    "a live gate sees the kill without being rebuilt",
    gate.open("render.overlays").reason === DENY.MENU_UNAVAILABLE,
  );
  check("and it agrees with reachable()", gate.reachable("render.overlays") === false);

  /** Chaos Sandbox arrives the same way, and a chaos run is tainted from tick zero. */
  applyDevFlags(shared, { devMenuEnabled: true, chaosSandboxActive: true, accountBlocked: false }, true);
  check("chaos closes the public ladder", gate.publicLadderOpen() === false);
}

section("panel ids");
{
  check("findDevPanel resolves a known id", findDevPanel("run.godmode")?.tier === "self");
  check("findDevPanel returns undefined for junk", findDevPanel("") === undefined);
  const ids = DEV_PANELS.map((p) => p.id);
  check("ids are unique", new Set(ids).size === ids.length, `${ids.length} panels`);
  check(
    "ids are namespaced",
    ids.every((id) => id.includes(".") && id === id.toLowerCase()),
  );
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
