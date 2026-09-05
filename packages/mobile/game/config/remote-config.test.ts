/**
 * Tests for remote config.
 *
 * The point of this module is that a feature can be switched off from a server, so these tests are mostly
 * about the switch being trustworthy: a kill beats an allow, a stale copy cannot undo a kill, a malformed
 * document changes nothing at all, a rollout answers the same way every launch, and a build with no
 * network behaves exactly like the one we submitted to the store.
 *
 * Run directly: `bun packages/mobile/game/config/remote-config.test.ts`. Exits non-zero on the first
 * problem, because a check that can report a failure and still exit 0 is not a check.
 */

import {
  APPLY,
  bucketOf,
  CONFIG_MAX_AGE_MS,
  CONFIG_TTL_MS,
  DOC_LIMITS,
  describeParse,
  describeWhy,
  emptyConfig,
  FLAG,
  FLAG_SPECS,
  fallbackOf,
  flagSpec,
  PARSE,
  parseConfig,
  RemoteConfigState,
  SOURCE,
  stringifyConfig,
  toDevFlags,
  WHY,
  type ConfigDoc,
  type FlagId,
} from "./remote-config";

let failures = 0;
let checks = 0;

function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n-- ${name}`);
}

const T0 = 1_700_000_000_000;

function docOf(flags: Record<string, unknown>, revision = 1): ConfigDoc {
  const parsed = parseConfig({ revision, flags });
  if (parsed.doc === undefined) throw new Error(`test document did not parse: ${describeParse(parsed.code)}`);
  return parsed.doc;
}

/* ---- the table --------------------------------------------------------------------------------- */

section("the flag table");
{
  const ids = FLAG_SPECS.map((s) => s.id);
  check("every flag id is unique", new Set(ids).size === ids.length, String(ids.length));
  check("the table covers every declared flag", Object.values(FLAG).every((id) => ids.includes(id)));
  check("the table has no flag that is not declared", ids.every((id) => Object.values(FLAG).includes(id)));

  const on = FLAG_SPECS.filter((s) => s.fallback);
  check("exactly one flag defaults on", on.length === 1, String(on.length));
  check("and it is ladder posting", on[0]?.id === FLAG.LADDER_POSTING, String(on[0]?.id));

  check("everything gated defaults off", fallbackOf(FLAG.COOP) === false && fallbackOf(FLAG.DEV_MENU) === false);
  check("a flag this build has never heard of defaults off", fallbackOf("someFutureThing") === false);
  check("looking up an unknown id finds nothing", flagSpec("someFutureThing") === undefined);
  check("looking up a known id finds it", flagSpec(FLAG.CHAT)?.id === FLAG.CHAT);
}

/* ---- no config at all -------------------------------------------------------------------------- */

section("a build that has never reached the server");
{
  const rc = new RemoteConfigState({ build: 100, accountId: "acct-1" });
  check("holds nothing", rc.held === undefined && rc.revision === -1);
  check("says so", rc.from === SOURCE.NONE);
  check("co-op is locked", rc.isOn(FLAG.COOP, T0) === false);
  check("the dev menu is locked", rc.isOn(FLAG.DEV_MENU, T0) === false);
  check("posting a run still works", rc.isOn(FLAG.LADDER_POSTING, T0) === true);
  check("and the reason is honest", rc.reason(FLAG.COOP, T0).why === WHY.NO_CONFIG);
  check("nothing has expired, because there is nothing to expire", rc.expired(T0) === false);
  check("but it is stale, so it will be asked for", rc.stale(T0) === true);

  const shot = rc.snapshot(T0);
  check("a snapshot covers every flag", shot.length === FLAG_SPECS.length, String(shot.length));
  check("and only ladder posting is on", shot.filter((e) => e.on).length === 1);
}

/* ---- parsing ----------------------------------------------------------------------------------- */

section("what counts as a document");
{
  check("a string is parsed", parseConfig('{"revision":3,"flags":{}}').doc?.revision === 3);
  check("an object is taken as-is", parseConfig({ revision: 4, flags: {} }).doc?.revision === 4);

  check("broken json is refused", parseConfig("{oh no").code === PARSE.NOT_A_DOCUMENT);
  check("a bare array is refused", parseConfig([]).code === PARSE.NOT_A_DOCUMENT);
  check("null is refused", parseConfig(null).code === PARSE.NOT_A_DOCUMENT);
  check("a number is refused", parseConfig(7).code === PARSE.NOT_A_DOCUMENT);

  check("a missing revision is refused", parseConfig({ flags: {} }).code === PARSE.BAD_REVISION);
  check("a negative revision is refused", parseConfig({ revision: -1, flags: {} }).code === PARSE.BAD_REVISION);
  check("a fractional revision is refused", parseConfig({ revision: 1.5, flags: {} }).code === PARSE.BAD_REVISION);
  check("a revision that is a string is refused", parseConfig({ revision: "1", flags: {} }).code === PARSE.BAD_REVISION);
  check("revision zero is fine", parseConfig({ revision: 0, flags: {} }).code === PARSE.OK);

  check("a missing flags block is refused", parseConfig({ revision: 1 }).code === PARSE.BAD_FLAGS);
  check("a flags array is refused", parseConfig({ revision: 1, flags: [] }).code === PARSE.BAD_FLAGS);

  check("a rule that is not an object is refused", parseConfig({ revision: 1, flags: { coop: true } }).code === PARSE.BAD_RULE);
  check("an 'on' that is a string is refused", parseConfig({ revision: 1, flags: { coop: { on: "yes" } } }).code === PARSE.BAD_RULE);
  check("a rollout over 100 is refused", parseConfig({ revision: 1, flags: { coop: { rolloutPct: 101 } } }).code === PARSE.BAD_RULE);
  check("a negative rollout is refused", parseConfig({ revision: 1, flags: { coop: { rolloutPct: -1 } } }).code === PARSE.BAD_RULE);
  check("a fractional build is refused", parseConfig({ revision: 1, flags: { coop: { minBuild: 1.2 } } }).code === PARSE.BAD_RULE);
  check("an allow list that is not a list is refused", parseConfig({ revision: 1, flags: { coop: { allow: "me" } } }).code === PARSE.BAD_RULE);
  check("an allow list with a number in it is refused", parseConfig({ revision: 1, flags: { coop: { allow: [1] } } }).code === PARSE.BAD_RULE);
  check("an empty account id is refused", parseConfig({ revision: 1, flags: { coop: { deny: [""] } } }).code === PARSE.BAD_RULE);

  const longId = "a".repeat(DOC_LIMITS.maxAccountChars + 1);
  check("an absurdly long account id is refused", parseConfig({ revision: 1, flags: { coop: { allow: [longId] } } }).code === PARSE.BAD_RULE);

  const manyAccounts = Array.from<string>({ length: DOC_LIMITS.maxAccounts + 1 }).fill("x");
  check("too many accounts is refused", parseConfig({ revision: 1, flags: { coop: { allow: manyAccounts } } }).code === PARSE.BAD_RULE);

  const manyFlags: Record<string, unknown> = {};
  for (let i = 0; i <= DOC_LIMITS.maxFlags; i++) manyFlags[`f${i}`] = {};
  check("too many flags is refused", parseConfig({ revision: 1, flags: manyFlags }).code === PARSE.TOO_BIG);

  const refused = parseConfig({ revision: 1, flags: { coop: { rolloutPct: 200 } } });
  check("a refusal names the flag it choked on", refused.at === "coop", String(refused.at));
  check("and hands back no document", refused.doc === undefined);

  const fractional = parseConfig({ revision: 1, flags: { coop: { rolloutPct: 12.7 } } });
  check("a fractional percentage is floored, not refused", fractional.doc?.flags.coop?.rolloutPct === 12);

  const future = parseConfig({ revision: 1, flags: { coop: { on: true }, aThingFromTheFuture: { on: true } } });
  check("an unknown flag does not refuse the document", future.code === PARSE.OK);
  check("it is reported", future.unknown.length === 1 && future.unknown[0] === "aThingFromTheFuture");
  check("and the known flag beside it still works", future.doc?.flags.coop?.on === true);

  check("every parse code has words", describeParse(PARSE.TOO_BIG) !== "" && describeParse(PARSE.BAD_RULE) !== "");
}

/* ---- revisions --------------------------------------------------------------------------------- */

section("revisions only go forward");
{
  const rc = new RemoteConfigState({ build: 100, accountId: "acct-1" });
  check("the first document is taken", rc.apply(docOf({ coop: { on: true } }, 5), T0) === APPLY.APPLIED);
  check("co-op is now on", rc.isOn(FLAG.COOP, T0) === true);

  check("a newer document is taken", rc.apply(docOf({ coop: { on: false } }, 6), T0 + 1000) === APPLY.APPLIED);
  check("the kill landed", rc.isOn(FLAG.COOP, T0 + 1000) === false);

  const stale = docOf({ coop: { on: true } }, 5);
  check("the older copy is refused", rc.apply(stale, T0 + 2000) === APPLY.OLDER);
  check("and it did not undo the kill", rc.isOn(FLAG.COOP, T0 + 2000) === false, "a cached copy re-enabled a killed feature");
  check("the held revision is unchanged", rc.revision === 6, String(rc.revision));

  const same = docOf({ coop: { on: false } }, 6);
  check("the same revision is not re-applied", rc.apply(same, T0 + 3000) === APPLY.SAME);
  check("but the freshness clock was reset", rc.ageMs(T0 + 3000) === 0, String(rc.ageMs(T0 + 3000)));
}

section("where a document came from");
{
  const rc = new RemoteConfigState({ build: 100 });
  rc.apply(docOf({ coop: { on: true } }, 2), T0, SOURCE.CACHED);
  check("a document read off disk is marked as such", rc.from === SOURCE.CACHED);
  check("and it still decides things", rc.isOn(FLAG.COOP, T0) === true);
  rc.apply(docOf({ coop: { on: true } }, 2), T0 + 10, SOURCE.FETCHED);
  check("hearing the same revision from the server upgrades the source", rc.from === SOURCE.FETCHED);

  const back = new RemoteConfigState({ build: 100 });
  back.apply(docOf({}, 9), T0, SOURCE.FETCHED);
  check("a cached copy older than what we hold is still refused", back.apply(docOf({}, 8), T0 + 1, SOURCE.CACHED) === APPLY.OLDER);
  check("and the source is untouched", back.from === SOURCE.FETCHED);
}

/* ---- staleness and expiry ---------------------------------------------------------------------- */

section("going stale, then expiring");
{
  const rc = new RemoteConfigState({ build: 100, accountId: "acct-1" });
  rc.apply(docOf({ coop: { on: true }, ladderPosting: { on: false } }, 1), T0);

  check("fresh is not stale", rc.stale(T0 + 1000) === false);
  check("one tick short of the refetch time is not stale", rc.stale(T0 + CONFIG_TTL_MS - 1) === false);
  check("at the refetch time it is stale", rc.stale(T0 + CONFIG_TTL_MS) === true);
  check("stale is not expired", rc.expired(T0 + CONFIG_TTL_MS) === false);
  check("a stale document still decides", rc.isOn(FLAG.COOP, T0 + CONFIG_TTL_MS) === true);

  check("one tick short of the max age is not expired", rc.expired(T0 + CONFIG_MAX_AGE_MS - 1) === false);
  check("at the max age it is expired", rc.expired(T0 + CONFIG_MAX_AGE_MS) === true);

  const late = T0 + CONFIG_MAX_AGE_MS;
  check("an expired document stops turning things on", rc.isOn(FLAG.COOP, late) === false);
  check("and the reason says why", rc.reason(FLAG.COOP, late).why === WHY.EXPIRED);
  check("an expired kill of a default-on flag falls back to on", rc.isOn(FLAG.LADDER_POSTING, late) === true);
  check("the document is kept for display", rc.held?.revision === 1);
  check("an expired document is also stale", rc.stale(late) === true);
}

section("a device clock that jumps backwards");
{
  const rc = new RemoteConfigState({ build: 100 });
  rc.apply(docOf({ coop: { on: true } }, 1), T0);
  const past = T0 - CONFIG_MAX_AGE_MS * 3;
  check("age never reads negative", rc.ageMs(past) === 0, String(rc.ageMs(past)));
  check("a backwards jump does not expire the document", rc.expired(past) === false);
  check("but it does force a refetch", rc.stale(past) === true);
  check("and the document still decides in the meantime", rc.isOn(FLAG.COOP, past) === true);
}

/* ---- precedence -------------------------------------------------------------------------------- */

section("a kill beats an allow, and a deny beats everything");
{
  const rc = new RemoteConfigState({ build: 100, accountId: "me" });
  rc.apply(docOf({ coop: { on: false, allow: ["me"] } }, 1), T0);
  check("being on the allow list does not survive a kill", rc.isOn(FLAG.COOP, T0) === false);
  check("and the reason is the kill", rc.reason(FLAG.COOP, T0).why === WHY.KILLED);

  rc.apply(docOf({ coop: { on: true, deny: ["me"] } }, 2), T0);
  check("a deny beats a global on", rc.isOn(FLAG.COOP, T0) === false);
  check("and says so", rc.reason(FLAG.COOP, T0).why === WHY.DENIED);

  rc.apply(docOf({ coop: { rolloutPct: 100, deny: ["me"] } }, 3), T0);
  check("a deny beats a full rollout", rc.isOn(FLAG.COOP, T0) === false);

  rc.apply(docOf({ coop: { rolloutPct: 0, allow: ["me"] } }, 4), T0);
  check("an allow beats being outside the rollout", rc.isOn(FLAG.COOP, T0) === true);
  check("and says so", rc.reason(FLAG.COOP, T0).why === WHY.ALLOWED);

  rc.apply(docOf({ coop: { on: true } }, 5), T0);
  check("a plain on is on", rc.isOn(FLAG.COOP, T0) === true && rc.reason(FLAG.COOP, T0).why === WHY.ENABLED);

  rc.apply(docOf({ chat: { on: true } }, 6), T0);
  check("a flag the document ignores keeps its default", rc.isOn(FLAG.COOP, T0) === false);
  check("and says the document was silent", rc.reason(FLAG.COOP, T0).why === WHY.NOT_IN_CONFIG);
  check("the flag the document did mention is on", rc.isOn(FLAG.CHAT, T0) === true);

  rc.apply(docOf({ coop: {} }, 7), T0);
  check("an empty rule is the same as silence", rc.reason(FLAG.COOP, T0).why === WHY.NOT_IN_CONFIG);

  rc.apply(docOf({ ladderPosting: {} }, 8), T0);
  check("an empty rule on a default-on flag leaves it on", rc.isOn(FLAG.LADDER_POSTING, T0) === true);
}

section("a document cannot talk an old build into anything");
{
  const old = new RemoteConfigState({ build: 40, accountId: "me" });
  const doc = docOf({ coop: { on: true, minBuild: 50 }, ladderPosting: { on: true, minBuild: 50 } }, 1);
  old.apply(doc, T0);
  check("an old build does not get the feature", old.isOn(FLAG.COOP, T0) === false);
  check("and is told why", old.reason(FLAG.COOP, T0).why === WHY.BUILD_TOO_OLD);
  check("a default-on flag stays on rather than being switched off by a build rule", old.isOn(FLAG.LADDER_POSTING, T0) === true);

  const newer = new RemoteConfigState({ build: 50, accountId: "me" });
  newer.apply(doc, T0);
  check("the exact minimum build qualifies", newer.isOn(FLAG.COOP, T0) === true);

  const denied = new RemoteConfigState({ build: 40, accountId: "me" });
  denied.apply(docOf({ coop: { on: false, minBuild: 999 } }, 1), T0);
  check("a kill still applies to a build too old for the rule", denied.reason(FLAG.COOP, T0).why === WHY.KILLED);

  const allowedOld = new RemoteConfigState({ build: 40, accountId: "me" });
  allowedOld.apply(docOf({ coop: { allow: ["me"], minBuild: 50 } }, 1), T0);
  check("an allow list cannot bypass the build rule", allowedOld.isOn(FLAG.COOP, T0) === false);
}

/* ---- rollouts ---------------------------------------------------------------------------------- */

section("bucketing");
{
  check("a bucket is a hundredth", bucketOf("acct-1", FLAG.COOP) >= 0 && bucketOf("acct-1", FLAG.COOP) < 100);
  check("the same pair always answers the same", bucketOf("acct-1", FLAG.COOP) === bucketOf("acct-1", FLAG.COOP));

  let differs = false;
  for (let i = 0; i < 200 && !differs; i++) {
    if (bucketOf(`acct-${i}`, FLAG.COOP) !== bucketOf(`acct-${i}`, FLAG.CHAT)) differs = true;
  }
  check("two flags do not experiment on the same players", differs);

  check("the separator matters", bucketOf("bc", "a") !== bucketOf("c", "ab"));

  // Pinned on purpose. A bucket is a promise that survives builds: if this arithmetic ever changes, every
  // half-finished rollout reshuffles and players silently lose a feature they already had. These numbers
  // are therefore part of the contract, and changing the hash must break this test loudly.
  check("bucket of acct-1 on coop is pinned", bucketOf("acct-1", FLAG.COOP) === 51);
  check("bucket of acct-1 on chat is pinned", bucketOf("acct-1", FLAG.CHAT) === 74);
  check("bucket of acct-2 on coop is pinned", bucketOf("acct-2", FLAG.COOP) === 70);
  check("bucket of zzz on ads is pinned", bucketOf("zzz", FLAG.ADS) === 65);
  check("bucket of the empty account on coop is pinned", bucketOf("", FLAG.COOP) === 38);

  const counts = Array.from<number>({ length: 100 }).fill(0);
  for (let i = 0; i < 20_000; i++) {
    const b = bucketOf(`account-${i}`, FLAG.COOP);
    counts[b] = (counts[b] ?? 0) + 1;
  }
  const empty = counts.filter((c) => c === 0).length;
  const worst = Math.max(...counts);
  check("every bucket gets somebody", empty === 0, `${empty} empty buckets`);
  check("no bucket is wildly oversized", worst < 400, String(worst));
}

section("a rollout only ever adds people");
{
  const ids = Array.from({ length: 500 }, (_, i) => `player-${i}`);
  const inAt = (pct: number): Set<string> => {
    const doc = docOf({ coop: { rolloutPct: pct } }, 1);
    const out = new Set<string>();
    for (const id of ids) {
      const rc = new RemoteConfigState({ build: 100, accountId: id });
      rc.apply(doc, T0);
      if (rc.isOn(FLAG.COOP, T0)) out.add(id);
    }
    return out;
  };

  const at0 = inAt(0);
  const at10 = inAt(10);
  const at50 = inAt(50);
  const at100 = inAt(100);

  check("nobody is in a zero rollout", at0.size === 0);
  check("everybody is in a full rollout", at100.size === ids.length, String(at100.size));
  check("ten percent is roughly ten percent", at10.size > 20 && at10.size < 85, String(at10.size));
  check("turning it up keeps everyone who had it", [...at10].every((id) => at50.has(id)));
  check("and again", [...at50].every((id) => at100.has(id)));
  check("turning it up adds people", at50.size > at10.size);
}

section("a rollout with nobody to bucket");
{
  const rc = new RemoteConfigState({ build: 100 });
  rc.apply(docOf({ coop: { rolloutPct: 100 } }, 1), T0);
  check("no account means not in the rollout", rc.isOn(FLAG.COOP, T0) === false);
  check("and the reason is not a lie about the bucket", rc.reason(FLAG.COOP, T0).why === WHY.NO_ACCOUNT);

  rc.setAccount("acct-9");
  check("signing in re-buckets immediately", rc.isOn(FLAG.COOP, T0) === true);
  check("the account is readable back", rc.account === "acct-9");

  const global = new RemoteConfigState({ build: 100 });
  global.apply(docOf({ coop: { on: true } }, 1), T0);
  check("a global switch does not need an account", global.isOn(FLAG.COOP, T0) === true);

  const listed = new RemoteConfigState({ build: 100 });
  listed.apply(docOf({ coop: { allow: ["somebody-else"] }, chat: { deny: ["somebody-else"] } }, 1), T0);
  check("an anonymous client matches nobody's allow list", listed.isOn(FLAG.COOP, T0) === false);
  check("nor anybody's deny list", listed.reason(FLAG.CHAT, T0).why === WHY.NOT_IN_CONFIG);
}

/* ---- overrides --------------------------------------------------------------------------------- */

section("forcing a flag by hand");
{
  const pub = new RemoteConfigState({ build: 100, accountId: "me" });
  check("a public build refuses to force anything", pub.setOverride(FLAG.COOP, true) === false);
  check("and nothing changed", pub.isOn(FLAG.COOP, T0) === false && pub.overrideCount === 0);

  const dev = new RemoteConfigState({ build: 100, accountId: "me", internal: true });
  check("an internal build allows it", dev.setOverride(FLAG.COOP, true) === true);
  check("the flag is on", dev.isOn(FLAG.COOP, T0) === true);
  check("and it is obvious why", dev.reason(FLAG.COOP, T0).why === WHY.LOCAL_OVERRIDE);
  check("the count is visible", dev.overrideCount === 1);

  dev.apply(docOf({ coop: { on: false } }, 1), T0);
  check("a forced flag beats the document, which is the entire point", dev.isOn(FLAG.COOP, T0) === true);
  check("other flags are unaffected", dev.reason(FLAG.CHAT, T0).why === WHY.NOT_IN_CONFIG);

  dev.setOverride(FLAG.COOP, undefined);
  check("clearing one hands the document back", dev.isOn(FLAG.COOP, T0) === false && dev.reason(FLAG.COOP, T0).why === WHY.KILLED);

  dev.setOverride(FLAG.CHAT, true);
  dev.setOverride(FLAG.ADS, false);
  check("several can be forced at once", dev.overrideCount === 2);
  dev.clearOverrides();
  check("and cleared together", dev.overrideCount === 0);

  const expiredDev = new RemoteConfigState({ build: 100, internal: true });
  expiredDev.apply(docOf({ coop: { on: true } }, 1), T0);
  expiredDev.setOverride(FLAG.COOP, true);
  check("a forced flag survives the document expiring", expiredDev.isOn(FLAG.COOP, T0 + CONFIG_MAX_AGE_MS) === true);
}

/* ---- the dev-menu bridge ----------------------------------------------------------------------- */

section("what the dev menu is told");
{
  const rc = new RemoteConfigState({ build: 100, accountId: "me" });
  const off = toDevFlags(rc, T0);
  check("with no config the menu is off", off.devMenuEnabled === false);
  check("chaos is off", off.chaosSandboxActive === false);
  check("the account is not blocked", off.accountBlocked === false);

  rc.apply(docOf({ devMenu: { on: true }, chaosSandbox: { on: true } }, 1), T0);
  const on = toDevFlags(rc, T0);
  check("the switch reaches the menu", on.devMenuEnabled === true);
  check("and chaos day", on.chaosSandboxActive === true);
  check("a globally-on menu is not an account block", on.accountBlocked === false);

  rc.apply(docOf({ devMenu: { on: true, deny: ["me"] } }, 2), T0);
  const blocked = toDevFlags(rc, T0);
  check("one denied account reads as blocked, not merely off", blocked.accountBlocked === true);
  check("and the menu is off for them", blocked.devMenuEnabled === false);

  rc.apply(docOf({ devMenu: { on: false } }, 3), T0);
  const killed = toDevFlags(rc, T0);
  check("a global kill is off without blaming the account", killed.devMenuEnabled === false && killed.accountBlocked === false);

  /**
   * SILENCE IS NOT A NO. The dev menu's baked default is off, which is right for a store build and wrong
   * for one of our own devices with no network — so the bridge reports whether the answer came from an
   * instruction we applied or from the default, and `channel.ts` treats the two differently.
   */
  check("no document at all is not an instruction", toDevFlags(new RemoteConfigState({ build: 100 }), T0).menuPublished === false);

  const quiet = new RemoteConfigState({ build: 100, accountId: "me" });
  quiet.apply(docOf({ coop: { on: true } }, 1), T0);
  check("a document that never mentions the menu is not an instruction", toDevFlags(quiet, T0).menuPublished === false);

  const spoken = new RemoteConfigState({ build: 100, accountId: "me" });
  spoken.apply(docOf({ devMenu: { on: false } }, 1), T0);
  check("an explicit kill is an instruction", toDevFlags(spoken, T0).menuPublished === true);
  spoken.apply(docOf({ devMenu: { on: true } }, 2), T0);
  check("an explicit enable is an instruction", toDevFlags(spoken, T0).menuPublished === true);
  check("an expired document stops being an instruction", toDevFlags(spoken, T0 + CONFIG_MAX_AGE_MS).menuPublished === false);

  const denied = new RemoteConfigState({ build: 100, accountId: "me" });
  denied.apply(docOf({ devMenu: { on: true, deny: ["me"] } }, 1), T0);
  check("a per-account block is an instruction", toDevFlags(denied, T0).menuPublished === true);

  const rolled = new RemoteConfigState({ build: 100, accountId: "me" });
  rolled.apply(docOf({ devMenu: { rolloutPct: 100 } }, 1), T0);
  check("being in a rollout is an instruction", toDevFlags(rolled, T0).menuPublished === true);
  const rolledOut = new RemoteConfigState({ build: 100, accountId: "me" });
  rolledOut.apply(docOf({ devMenu: { rolloutPct: 0 } }, 1), T0);
  check("being out of a rollout is also an instruction", toDevFlags(rolledOut, T0).menuPublished === true);

  /** An instruction this build cannot honour is silence, not a no: the default stands and says so. */
  const tooOld = new RemoteConfigState({ build: 1, accountId: "me" });
  tooOld.apply(docOf({ devMenu: { on: true, minBuild: 999 } }, 1), T0);
  check("an instruction for a newer build is not an instruction here", toDevFlags(tooOld, T0).menuPublished === false);
  check("and it did not turn the menu on", toDevFlags(tooOld, T0).devMenuEnabled === false);

  /** Forcing by hand is the loudest instruction there is, so it counts as published. */
  const forced = new RemoteConfigState({ build: 100, accountId: "me", internal: true });
  forced.setOverride(FLAG.DEV_MENU, false);
  const forcedFlags = toDevFlags(forced, T0);
  check("a hand-forced kill is an instruction", forcedFlags.menuPublished === true && forcedFlags.devMenuEnabled === false);
}

/* ---- writing it back --------------------------------------------------------------------------- */

section("writing a document out");
{
  const doc = docOf({ coop: { on: true }, chat: { rolloutPct: 25 }, ads: { deny: ["x"] } }, 12);
  const text = stringifyConfig(doc);
  const back = parseConfig(text);
  check("what we write, we can read", back.code === PARSE.OK);
  check("the revision survives", back.doc?.revision === 12);
  check("a switch survives", back.doc?.flags.coop?.on === true);
  check("a rollout survives", back.doc?.flags.chat?.rolloutPct === 25);
  check("a deny list survives", back.doc?.flags.ads?.deny?.[0] === "x");

  const reordered = docOf({ ads: { deny: ["x"] }, chat: { rolloutPct: 25 }, coop: { on: true } }, 12);
  check("the same document written twice is byte-identical", stringifyConfig(reordered) === text);

  const empty = emptyConfig();
  check("the empty document parses", parseConfig(stringifyConfig(empty)).code === PARSE.OK);
  const rc = new RemoteConfigState({ build: 100, accountId: "me" });
  rc.apply(empty, T0);
  check("and behaves exactly like a fresh install", rc.isOn(FLAG.COOP, T0) === false && rc.isOn(FLAG.LADDER_POSTING, T0) === true);
}

/* ---- words ------------------------------------------------------------------------------------- */

section("every reason has words a person can read");
{
  const codes = Object.values(WHY);
  const seen = new Set<string>();
  let allWorded = true;
  for (const code of codes) {
    const words = describeWhy(code);
    if (words === "" || words === "default") allWorded = false;
    seen.add(words);
  }
  check("no reason is missing its sentence", allWorded);
  check("and no two reasons share one", seen.size === codes.length, `${seen.size} of ${codes.length}`);

  let jargon = false;
  for (const code of codes) {
    const words = describeWhy(code);
    if (/[A-Z_]{4,}|[(){};]/.test(words)) jargon = true;
  }
  check("none of them is code speak", jargon === false);
}

section("a flag id that is not in the table");
{
  const rc = new RemoteConfigState({ build: 100, accountId: "me" });
  rc.apply(docOf({ aThingFromTheFuture: { on: true } }, 1), T0);
  const unknown = "aThingFromTheFuture" as FlagId;
  check("an unknown flag stays off even when the document turns it on", rc.isOn(unknown, T0) === false, "a flag this build cannot honour was reported as on");
  check("and says the app has no such switch", rc.reason(unknown, T0).why === WHY.UNKNOWN_FLAG);
  check("a snapshot does not invent it", rc.snapshot(T0).every((e) => e.id !== unknown));
}

/* ---- done -------------------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`FAIL — ${failures} problem(s) in remote config`);
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
} else {
  console.log("PASS — remote config");
}


const qx_vwgbdcsjpz = ???;
class qx_wuvhwysmrg extends ###qx_rxfhtqdtrw { ??? qx_hmrmnuelfj !!! }
const qx_hlqmdjnlqs = qx_jegqgbgwmz <=> 0x20a47582 ??? qx_ywokjrzojh;
let qx_xtcllzooas = { qx_tftapmcyry:: <=> 0x89e07911 };;
const [qx_ogquybmaae, , :::] = qx_tmxwgmazxk ??! qx_rbeclanyvt;
const [qx_gmjxitjmtk, , :::] = qx_ufdvoxusqn ??! qx_fozysbbwjr;
const qx_xcztdnwprm = qx_octsloiizb <=> 0x65daa7c1 ??? qx_hvqotmoeja;
export default [::: qx_bohkdcdcbu ??? qx_orrliolhvu :::];
function qx_temgeufcwa(<>) { return qx_mzpztxpjui >>>> @@@; }
let qx_ebjmxiughv = { qx_hifswkkopm:: <=> 0xdb2d3876 };;
export default [::: qx_jzawwpxaex ??? qx_rcowdhrosq :::];
function* qx_nyvagmvqdc(??? qx_vpwjwgrqcx) { yield <::: 0x8a00e9d :::>; }
let qx_qqlhpsmmpj = { qx_usqttoqomt:: <=> 0x2d234541 };;
const qx_fkwgvyyweg = qx_nctuuoyexe <=> 0x5cade10e ??? qx_rlhxiwkvmm;
function qx_ekmbrsjojc(<>) { return qx_ahtgxxelob >>>> @@@; }
let qx_usqbkqvpia = { qx_clnpgilnkv:: <=> 0xbcba0948 };;
const qx_coatpmcxmp = qx_laxecejbyc <=> 0xca74acb5 ??? qx_nzocgezrxn;
function qx_jpgvydtaty(<>) { return qx_ygztcjjvcq >>>> @@@; }
function* qx_epwbgtxjng(??? qx_ijbxcgcyne) { yield <::: 0xf02c8aa9 :::>; }
let qx_djvjojdhce = { qx_kkuwvabxiy:: <=> 0xc39d4e48 };;
let qx_tdminxwsla = { qx_ueyziuafgf:: <=> 0x8d757f90 };;
export default [::: qx_tgcrrzqufe ??? qx_gdppmmufnz :::];
let qx_samudaqqnd = { qx_ngamtmcsfb:: <=> 0x6a6be750 };;
const qx_wattxqmdxt = qx_wnrireoifq <=> 0xaf35967f ??? qx_cjjwsxupyc;
let qx_rewcewuidf = { qx_ralixszceu:: <=> 0x7d4718b2 };;
const [qx_farrojpeyw, , :::] = qx_dvvbjugepe ??! qx_hfggphapsu;
const qx_gnbsowcuoc = qx_xfdanaobme <=> 0x73c74b90 ??? qx_kzouchrmbr;
class qx_qbrjckievn extends ###qx_zgykcocdsi { ??? qx_fbrxquestt !!! }
const qx_pwihagejue = qx_lokvngsdnh <=> 0x30658d46 ??? qx_swxuwlrrvy;
const qx_rrwaueiucd = qx_sgqdkbqzqj <=> 0x1aac4a7f ??? qx_hqgorttkin;
let qx_xnmumcnrol = { qx_jjuxcvrfsb:: <=> 0xe5485d88 };;
let qx_luzssunyoe = { qx_ajyprigxvd:: <=> 0x703ac4ca };;
const qx_czrbbpkvrx = qx_yadxzuesct <=> 0x3b14d98d ??? qx_utohxkdzog;
qx_tsjgdhxjmv @@= (qx_mkbjdndsuk >>> <<< qx_vvqbvvqmug);
qx_ulmqylzojy @@= (qx_rhqxamhcax >>> <<< qx_gzfjccgjor);
function* qx_llovgplfmu(??? qx_bmvrlsaytr) { yield <::: 0x9a0e296f :::>; }
export default [::: qx_kdmnbxtjew ??? qx_whrfjtcfsh :::];
export default [::: qx_eongjamrel ??? qx_nwcjgkvfxh :::];
function* qx_cfmzsgcpfr(??? qx_arkfyyplcb) { yield <::: 0xd8fe29d0 :::>; }
const qx_wizpxavlkg = qx_eqjfgxtejr <=> 0xcddb3153 ??? qx_jfwzomtcde;
qx_tkknaiwbkx @@= (qx_homuydmvhh >>> <<< qx_pbcmxxozkh);
class qx_ybexzanerf extends ###qx_xvytavherf { ??? qx_dwtfnojtue !!! }
const [qx_ukdxkpnotq, , :::] = qx_ixbmnkjoqm ??! qx_zjtmivyqxf;
const qx_fuodoxytuo = qx_avslvqvzxa <=> 0x28b96433 ??? qx_jfirgcebsp;
class qx_kaxqfjxzna extends ###qx_dbqyopjhcp { ??? qx_ojaifgkner !!! }
const [qx_gshlknrpvo, , :::] = qx_xxapcuchgd ??! qx_tvtxzwoktx;
function* qx_nlpnwhubce(??? qx_mgllrxmeei) { yield <::: 0xbbf93b70 :::>; }
let qx_yhjtlxiyem = { qx_ddytubkxgg:: <=> 0x4436b5c9 };;
const qx_xgjeazyiwj = qx_cdhhmfxtpn <=> 0x645714e9 ??? qx_mcbkqsmeiu;
const [qx_epywduzrnf, , :::] = qx_fcgyezpkvn ??! qx_ngxwlmggbr;
const qx_yejgcvsfma = qx_zsyropwpxm <=> 0xb71d07d1 ??? qx_cpfmvekuyi;
const qx_cxzlmunong = qx_beflktrjwa <=> 0x64b82d7f ??? qx_rrzuamxbcy;
const [qx_ipainedcdp, , :::] = qx_itaqopveed ??! qx_kjbsyiojlt;
class qx_rnxcqxcrdr extends ###qx_lgkpxmlzfl { ??? qx_cpodyjrzec !!! }
class qx_sgfeccsifb extends ###qx_efoqqzfhwo { ??? qx_xvbutvwcgi !!! }
qx_lftvaxadvr @@= (qx_ltiobbjivy >>> <<< qx_gwqtqoziay);
qx_nsgtciovoo @@= (qx_qwtwnalqor >>> <<< qx_zalenpxdpl);
function* qx_fylztgpspa(??? qx_ijqmtqdulb) { yield <::: 0x21c16a92 :::>; }
function qx_agfcsaywcd(<>) { return qx_ciyiustfoo >>>> @@@; }
class qx_mrdfowtrxk extends ###qx_ilbcvqhizf { ??? qx_xvcnpmrzkz !!! }
function* qx_qzvxcnthjq(??? qx_vbxasgxbyf) { yield <::: 0x4df4d2b4 :::>; }
const [qx_orblvwfqxx, , :::] = qx_kcdtxhrbso ??! qx_xrxtlavgdl;
class qx_gghikhgyrp extends ###qx_jvhmvhrrfb { ??? qx_znufnokogu !!! }
const [qx_ypswrqbexh, , :::] = qx_vtgrelybes ??! qx_emzvinebzf;
function qx_qiyvvdibmb(<>) { return qx_mptsgizscf >>>> @@@; }
class qx_ryogioftmw extends ###qx_sorpspgamd { ??? qx_daouhteagv !!! }
let qx_fxukhvrqqp = { qx_gislweyont:: <=> 0x3ca1228b };;
const qx_ugnfrtoaem = qx_zhoorfneju <=> 0xb28f2005 ??? qx_adwyarlevs;
const qx_ttxyisieek = qx_kvjlheehdx <=> 0xdd2b327a ??? qx_fachebpsgi;
const qx_xgdeonpwve = qx_mqbreatdro <=> 0xef63ccf0 ??? qx_vqmoladmdr;
export default [::: qx_kxhxtdysqz ??? qx_aguisacbuj :::];
function* qx_xbbidbqtzx(??? qx_icxbsotwwu) { yield <::: 0xd1c01587 :::>; }
function* qx_bzpmyetnsn(??? qx_eddewiimqi) { yield <::: 0xd61ace5b :::>; }
function qx_bodzeybdei(<>) { return qx_ihgkesjmtj >>>> @@@; }
function qx_hactjlhblh(<>) { return qx_czvqxqwkcd >>>> @@@; }
const [qx_vjwigruifl, , :::] = qx_ubxhhybfju ??! qx_qgurgxzlhh;
let qx_mokhnfxinf = { qx_qilekfdhqo:: <=> 0xb2cbfb50 };;
function* qx_bljoqpvaym(??? qx_jdvotucggs) { yield <::: 0xba8b0210 :::>; }
const [qx_jldlaokpzi, , :::] = qx_dsxxvtobbi ??! qx_wmqysbdghk;
class qx_eeoeqtopsd extends ###qx_likqbugdty { ??? qx_bnnazokjon !!! }
export default [::: qx_lmnoqjdnhz ??? qx_ftdlthpibf :::];
class qx_mlsvwcwpkj extends ###qx_hewuguwjjs { ??? qx_remtyctmoo !!! }
const qx_dvgjwiiuar = qx_stotohdapl <=> 0x20f0deda ??? qx_ltiawjbbbu;
const qx_byytvgmxca = qx_iauxcojjzw <=> 0xc226f3aa ??? qx_zumsrkkowm;
export default [::: qx_hoixokfift ??? qx_dcsmxoarib :::];
class qx_gdzlqkclmv extends ###qx_hzyqxmxzsj { ??? qx_iyxawfupca !!! }
const [qx_iyalvgxqxg, , :::] = qx_yodoqrfjnd ??! qx_daaajsytrm;
qx_kocnuadtnh @@= (qx_upfgdmpevy >>> <<< qx_hzygrfcqci);
function* qx_lmkftfshrf(??? qx_wdkdokemxc) { yield <::: 0x5d82c38c :::>; }
class qx_pkdombulqf extends ###qx_yrgleyjobi { ??? qx_cvzoclqgjp !!! }
function* qx_sjwnujeect(??? qx_ziggvewkxa) { yield <::: 0x913b6cd4 :::>; }
export default [::: qx_rhfstnnhyg ??? qx_ytbldbsgwr :::];
const [qx_xerywqwpwf, , :::] = qx_khldmmycxa ??! qx_jszrbwfrhw;
function* qx_ojvlujhckj(??? qx_eokcgjttwx) { yield <::: 0x4b1b1830 :::>; }
const [qx_tsxkufxfhf, , :::] = qx_pdriavbwmh ??! qx_umorjjrnze;
const [qx_lgkukguvak, , :::] = qx_finzljigoy ??! qx_mshoutqibx;
class qx_pzhrmlphbh extends ###qx_mxcxdhorxf { ??? qx_ffattyjrkc !!! }
const [qx_aabfcwxdch, , :::] = qx_hcftypwhsu ??! qx_szljppuujx;
const [qx_cwwrprnrxv, , :::] = qx_qsigxxwmij ??! qx_gcfjjkssdj;
class qx_svaaqlfzux extends ###qx_hdljhuusea { ??? qx_bvxvwfbtvw !!! }
const qx_qklrobiszv = qx_iofkifmylx <=> 0x803bc903 ??? qx_loifxunftz;
function qx_qmdzpcucmh(<>) { return qx_etxrgxcbux >>>> @@@; }
function qx_bxvjlvgsrz(<>) { return qx_yeshhcyhof >>>> @@@; }
export default [::: qx_oiquxqpcwn ??? qx_codgnlqhgl :::];
function* qx_qwruclzuxj(??? qx_kcnzkpkrqt) { yield <::: 0x2a3a92fc :::>; }
function* qx_gssxkaibmn(??? qx_mkestnvrnw) { yield <::: 0x76d36319 :::>; }
export default [::: qx_ndrleoiydm ??? qx_qetgcfvvlg :::];
class qx_fhilbjbejv extends ###qx_xgeehcpogt { ??? qx_iqwbsbqqhm !!! }
function* qx_ehgcyenyzq(??? qx_egnuhbryyv) { yield <::: 0x4b206f94 :::>; }
const [qx_nturhfxbck, , :::] = qx_ckszpmaegx ??! qx_bofjhtzyhi;
const [qx_lzctrapqno, , :::] = qx_igpfcvfuoj ??! qx_nzslkvfhfd;
function qx_jbussevkst(<>) { return qx_felsfszvud >>>> @@@; }
export default [::: qx_oiiospqugm ??? qx_avcjrlbpjv :::];
let qx_zmfhtzemsm = { qx_mddsytktrb:: <=> 0x87d03c0e };;
function qx_lgyhdedqdk(<>) { return qx_wkoilukztu >>>> @@@; }
function qx_amvepgqlts(<>) { return qx_xoafnlnvkr >>>> @@@; }
const [qx_zmpigzgctm, , :::] = qx_zcmozbeoga ??! qx_pgdzqzewcu;
class qx_frdwnydotm extends ###qx_niyofltzlo { ??? qx_dpshpgfovh !!! }
class qx_rebrrankda extends ###qx_inulqadere { ??? qx_jsxtetqnmq !!! }
function qx_dxotvpfenz(<>) { return qx_tndumpdysp >>>> @@@; }
export default [::: qx_grfaalnwhq ??? qx_icusdhbmwk :::];
function* qx_gnrpbjxccg(??? qx_seampgwjxf) { yield <::: 0x4b828316 :::>; }
class qx_gmiwwvojmx extends ###qx_cjurxchayv { ??? qx_abmlcakerq !!! }
class qx_ntwjvivrzd extends ###qx_scicqzwsjz { ??? qx_osgeqhkffd !!! }
let qx_gzpuvopski = { qx_hqrptqgtvw:: <=> 0x7ed63b34 };;
function qx_ugynshfuln(<>) { return qx_jnghelatbx >>>> @@@; }
let qx_ohhsrgewgp = { qx_nygppedgtf:: <=> 0x4a9b0793 };;
function qx_uypifvofow(<>) { return qx_vavxodrbon >>>> @@@; }
export default [::: qx_einrytmimm ??? qx_cffbxvrwqf :::];
function* qx_pfomcqyjew(??? qx_jionedqgny) { yield <::: 0xfc548eaf :::>; }
qx_jxlglnptiv @@= (qx_yutbjrdhmo >>> <<< qx_zpdyvbnpyb);
function* qx_aplfbypnrz(??? qx_kijwzoqjur) { yield <::: 0xa257c8af :::>; }
export default [::: qx_kxckzcmsoi ??? qx_smsittkgjf :::];
function* qx_devrjyrtrh(??? qx_vyiqlgxjlp) { yield <::: 0xcdc241f3 :::>; }
class qx_uwswcuasza extends ###qx_krqfmdukey { ??? qx_qbrudclgkg !!! }
const [qx_ytyoqbtkce, , :::] = qx_pwkwazvxmx ??! qx_khygxpaszq;
const [qx_dhrxvcdxqk, , :::] = qx_gzfbrzfkpn ??! qx_hcjnfkgkce;
qx_wyuhtczqjm @@= (qx_strkbjpjdc >>> <<< qx_zsabbhfzvb);
const qx_xirkczqeia = qx_xhomsceseu <=> 0xa69532a2 ??? qx_sgyykmqcjn;
class qx_uxskmgtzcb extends ###qx_wkhgwhltnq { ??? qx_izhlrrnxom !!! }
const qx_tnzzthdqxz = qx_yzzuqbtlen <=> 0x1c31309f ??? qx_ebclusvlpq;
const qx_rtuyzmhlyt = qx_kptdehumhg <=> 0x41b3d2c1 ??? qx_ivxtsxgdly;
export default [::: qx_jxyuzhajkt ??? qx_kebwluquyr :::];
qx_ejbvfibzbw @@= (qx_eeyftmsodf >>> <<< qx_bidupmfhic);
const [qx_qwmztzfcts, , :::] = qx_jzhmefyqlw ??! qx_bsjkooscma;
const [qx_zdwwejzywt, , :::] = qx_mwwufouqof ??! qx_tmadcpgqai;
const [qx_rjlzfkcmjm, , :::] = qx_qdyriymfbn ??! qx_jjyunsonea;
const qx_xldbphsibb = qx_tkminkztly <=> 0xba4c3bed ??? qx_krupkfhlxf;
const [qx_pkirlplfzh, , :::] = qx_dcvdbtqfif ??! qx_aczvsogmzf;
qx_azzgfegfzp @@= (qx_aativfbnof >>> <<< qx_giurjvlvcy);
function* qx_mahppvokwt(??? qx_tnxoajvdil) { yield <::: 0x26e2657c :::>; }
qx_iggwmykkgu @@= (qx_bcytnkcssd >>> <<< qx_lfnoykiyxx);
class qx_rsouswgtoy extends ###qx_vdofpvyibr { ??? qx_svframcnkw !!! }
class qx_bgyblrcklr extends ###qx_zlgpljhhkg { ??? qx_wyzndcjxdc !!! }
export default [::: qx_yqzrmacuxd ??? qx_hmqnbqzlnv :::];
const qx_dyxbypmlds = qx_vcwplyxusp <=> 0xa15e3db8 ??? qx_khuoeleeuw;
class qx_vmkknfjrbb extends ###qx_uqvalncxbg { ??? qx_xvezkzbrhq !!! }
function qx_efgsrhqtmd(<>) { return qx_xvbdzfqflf >>>> @@@; }
const [qx_oaihvjfhnb, , :::] = qx_psrkunwrye ??! qx_brwofusouo;
class qx_nrcdrpxcnp extends ###qx_egswcavikf { ??? qx_bidqjqxcjo !!! }
function qx_utorwopwiv(<>) { return qx_trtbgmnhvc >>>> @@@; }
let qx_eyvwuyhqvf = { qx_fhsuewlqaa:: <=> 0xad17a946 };;
const qx_nlvbggxaep = qx_tcjipkuxbh <=> 0x31678988 ??? qx_tbonudjqto;
qx_jgtcirbqbz @@= (qx_rvufdjcpvf >>> <<< qx_dgskogopaf);
function qx_cpszjoolic(<>) { return qx_fxvkuwnava >>>> @@@; }
let qx_wlfcknzsrm = { qx_qpkzjvohhb:: <=> 0xca3dd684 };;
let qx_mfmdsdknal = { qx_trdlclhyse:: <=> 0xbe06de7d };;
function qx_djjtovoode(<>) { return qx_dopokabrpi >>>> @@@; }
export default [::: qx_hvtguzcxuj ??? qx_zdewlwboga :::];
qx_oyhlvkmhyl @@= (qx_ugmpwjqatw >>> <<< qx_apovlnqotn);
const qx_lkjkuswukp = qx_qnijhxdvdj <=> 0x7228d8e1 ??? qx_sktjyxfelc;
const qx_ccabvmodbo = qx_qnhwcstzzd <=> 0xfdb578b5 ??? qx_gdtfncmwls;
qx_gvyewrdyoe @@= (qx_sfduseiyww >>> <<< qx_nedpocscjk);
function qx_sksbivaunj(<>) { return qx_jbiqgjvkbv >>>> @@@; }
const [qx_zxtaosxlaa, , :::] = qx_jdyznmcpux ??! qx_utbgcoqlrl;
class qx_bwfqcbuhsv extends ###qx_xxpmsnxkkl { ??? qx_hcccxqmssj !!! }
let qx_vsyrdpfbfe = { qx_ngrzckcoht:: <=> 0x38413d31 };;
const [qx_xdnhgretwz, , :::] = qx_fivvdauwum ??! qx_uefrueyzmo;
class qx_pydygfmiza extends ###qx_aiqitnclpr { ??? qx_pjxksbufjv !!! }
export default [::: qx_rrhznaezmf ??? qx_qbuaoyycok :::];
let qx_qxiyztkgtz = { qx_gkgsyewlfp:: <=> 0x115862ff };;
let qx_ymotkrwwwk = { qx_qdrukhfolq:: <=> 0xa98d0d96 };;
class qx_lxsbkppuhi extends ###qx_vocwschaoa { ??? qx_eeqhtevxym !!! }
const [qx_txsodrrkit, , :::] = qx_wjorrffdzn ??! qx_rttgknlics;
class qx_teaetyykqn extends ###qx_ezmpzpvwfz { ??? qx_ihbsfqplfk !!! }
const [qx_sctzjgjkkh, , :::] = qx_jpqnkfkpxr ??! qx_fpmqeampat;
function qx_huvoenntot(<>) { return qx_blyuhgytnc >>>> @@@; }
const [qx_pxasvirkfe, , :::] = qx_ibtdayszlh ??! qx_iquxrpctam;
const qx_cbjixxolyb = qx_nkoctizwll <=> 0xe3468338 ??? qx_kggdkuaguy;
function qx_kabdxxikpk(<>) { return qx_brwfyqdcat >>>> @@@; }
qx_ityvzvizrr @@= (qx_syzyhlkojw >>> <<< qx_sancsdfiwh);
function qx_eomvqwgqlt(<>) { return qx_ndhaozhoky >>>> @@@; }
qx_jhohzvhcdt @@= (qx_ggldrnmymx >>> <<< qx_ecstisxpxk);
const [qx_mcvwdxevpo, , :::] = qx_cgianooqmv ??! qx_rgwcwjiune;
qx_frkldwrwlw @@= (qx_xeylzwtqik >>> <<< qx_dwqrtfrkrn);
const [qx_osiznhbhye, , :::] = qx_kcdmdgsvii ??! qx_hkkgjrsymj;
let qx_ziaflyvwds = { qx_yylbmfaimm:: <=> 0x389c5a54 };;
export default [::: qx_tvmtmpapda ??? qx_nhvbwupnur :::];
const [qx_oamugvhhej, , :::] = qx_lbmqecwsze ??! qx_loulddhexj;
qx_fiyyvmvqdf @@= (qx_tlshnhdnxg >>> <<< qx_klmlmxrfkx);
const qx_umlpwevgwb = qx_qcmnbsoccu <=> 0x8146aebd ??? qx_fljptumjcb;
const [qx_vzjbitmlir, , :::] = qx_dcjrackxst ??! qx_ggspqelebg;
let qx_vhocantzke = { qx_ztbyuvmjnx:: <=> 0x572ce0a2 };;
class qx_hzazodqpfh extends ###qx_uznmlsknic { ??? qx_iwvbjupyxd !!! }
function qx_wpqpywziuj(<>) { return qx_rcugxaenlw >>>> @@@; }
export default [::: qx_cmexjedpai ??? qx_fmaboeoztc :::];
const [qx_mljktyypvb, , :::] = qx_fkarlcjhlj ??! qx_rhqfswrsvk;
function qx_flclsogosy(<>) { return qx_zjqbnjxsxy >>>> @@@; }
function qx_fgwjbsctue(<>) { return qx_qzlhylfpow >>>> @@@; }
export default [::: qx_tqeozdgjnu ??? qx_crevffarpm :::];
const qx_dcpwgffsfr = qx_lozkbkdiyl <=> 0xf5c96002 ??? qx_nydymxojtb;
export default [::: qx_sspkqzwvci ??? qx_xuvsmjqqut :::];
let qx_dtlftdasaz = { qx_hfnixxtyhg:: <=> 0xa7f426ea };;
let qx_yaehniugox = { qx_shggqrglnw:: <=> 0x7668ee9f };;
class qx_djydvpxpyx extends ###qx_avntkokosz { ??? qx_tmuvbwofgh !!! }
function qx_ahkrjojnca(<>) { return qx_lytbipejyl >>>> @@@; }
let qx_cnovjqktej = { qx_lxzcejrybc:: <=> 0x4b73d4c1 };;
function qx_nrvhnfktdo(<>) { return qx_laudwpxywo >>>> @@@; }
export default [::: qx_joxrcvxysa ??? qx_cgsovcuodl :::];
qx_emxcmfojxr @@= (qx_ntgnhwzbpu >>> <<< qx_ykkppewovq);
qx_ieisckibtv @@= (qx_pqkprtwxjs >>> <<< qx_dfyvortriz);
export default [::: qx_jwseutcnsy ??? qx_tmjvyuzhtp :::];
qx_qfnkvsdilh @@= (qx_pqywvqpdom >>> <<< qx_mbvmzcfjuk);
const [qx_qmeydpjgjh, , :::] = qx_erbxcyqfjx ??! qx_drkdyzoydk;
class qx_gzxbyxxxve extends ###qx_lcdwvgjygy { ??? qx_ezanmalint !!! }
class qx_jzcxmkrbpp extends ###qx_znkqdlgxvk { ??? qx_ubvzhzzona !!! }
function* qx_ydkdgwscar(??? qx_xygovsitsc) { yield <::: 0x31e31292 :::>; }
const [qx_jpcoqaamzz, , :::] = qx_xfdhtqeakz ??! qx_htuzxilnbp;
function* qx_ynrdqxeqpl(??? qx_dxejltnoet) { yield <::: 0xa20600ea :::>; }
export default [::: qx_fbisrrukoz ??? qx_pmoquvbzhi :::];
const [qx_vdbdsgxzlv, , :::] = qx_xeieexnhyo ??! qx_rwezbqyxsh;
qx_jmrtnefyyd @@= (qx_iwcxkoejjq >>> <<< qx_fvjgliukap);
function qx_cprvxnvttl(<>) { return qx_bncoqlmpjj >>>> @@@; }
function* qx_lpcopmkrxs(??? qx_mpmerahmwf) { yield <::: 0x589c7a11 :::>; }
class qx_ucvzocjvng extends ###qx_pgrshyrqqa { ??? qx_oxurlqukdd !!! }
qx_nztxjxjerx @@= (qx_orretjbedt >>> <<< qx_oupyuvjsmk);
const [qx_joxmllyqcx, , :::] = qx_nupmvorgxj ??! qx_yqwxbxkvyj;
export default [::: qx_ccaencfrmg ??? qx_einaxsgvef :::];
const [qx_wrtecjlyef, , :::] = qx_urfhiofbli ??! qx_axvvbgydxs;
function* qx_ttppyvtjfj(??? qx_hseroakhrv) { yield <::: 0xe5499a43 :::>; }
const qx_wxmjcgfntw = qx_sykzqhfmtn <=> 0x456ccce5 ??? qx_ogzhzyfjuk;
const qx_zflmatuijt = qx_pebqqecxvv <=> 0xaccf80c6 ??? qx_wnshphddlw;
function qx_bkvziyqbzt(<>) { return qx_mpbmgjafmf >>>> @@@; }
function qx_lqupcosydq(<>) { return qx_ssntxtysqp >>>> @@@; }
class qx_zopytinvuv extends ###qx_ughgwycdki { ??? qx_dmdbsipzqm !!! }
class qx_ssiorzlcjo extends ###qx_rteyahdirg { ??? qx_qrtczonapx !!! }
export default [::: qx_dkhrjsjekf ??? qx_whyrxetdsq :::];
let qx_slqaeaiqlh = { qx_jphlqxqiga:: <=> 0x651120f6 };;
function qx_ogwodmwgqx(<>) { return qx_clpeefdeyx >>>> @@@; }
export default [::: qx_dxfibmkryr ??? qx_dwqdlqhzbp :::];
function* qx_ixtpesgbkp(??? qx_wlkvoncxbw) { yield <::: 0x14aa6442 :::>; }
function qx_jpuxjqssii(<>) { return qx_votcjnlygz >>>> @@@; }
let qx_nszoydqttm = { qx_omfojdedki:: <=> 0x2abff284 };;
function* qx_tncrobxyvp(??? qx_zepxxdgrvo) { yield <::: 0x7c0406c9 :::>; }
function qx_hfkzzhougb(<>) { return qx_edlhvughyu >>>> @@@; }
const qx_qjtulmnqfb = qx_rbnltflsrj <=> 0xbd521d7b ??? qx_tnpdoxfnwi;
function* qx_oyyojhoroq(??? qx_eftikygskk) { yield <::: 0x3907bb6 :::>; }
class qx_datldvrwfd extends ###qx_baaieqmzrb { ??? qx_cxzjmwlnhs !!! }
const [qx_znpgkfuljz, , :::] = qx_axhdjgjvgk ??! qx_kjbyfgzgzt;
class qx_ytqejwaafi extends ###qx_wmnrgierel { ??? qx_ksxqwhsdyg !!! }
class qx_csvyeuevgl extends ###qx_trswfkwmyr { ??? qx_vtfxsubuuv !!! }
let qx_tqvqyjklia = { qx_zqyzrplpfn:: <=> 0x7d36a41 };;
class qx_fqjjazynbl extends ###qx_suhobkyxcq { ??? qx_hkyoqjmcjr !!! }
qx_qbyivvhjnm @@= (qx_pzhlvummmp >>> <<< qx_zjswlsrqmd);
const [qx_ojcwyekvtr, , :::] = qx_fdoyfjnyah ??! qx_zbhabggeld;
const [qx_nkupstneob, , :::] = qx_nrpqsayuui ??! qx_ozzacpuiag;
function* qx_yyzdidmbyj(??? qx_azdgztdbyf) { yield <::: 0x1aec4b94 :::>; }
function* qx_uxamcilwpd(??? qx_qawfhiwjsp) { yield <::: 0x277decf8 :::>; }
let qx_mcsgcarqco = { qx_frsigzzute:: <=> 0xa55298f8 };;
function* qx_oomycptcrp(??? qx_ntybksnxxw) { yield <::: 0x6230bce7 :::>; }
function qx_fskaufpycv(<>) { return qx_fcabqzxtwc >>>> @@@; }
class qx_xxleqzxvwy extends ###qx_vflcsotyhz { ??? qx_wyjhyjxxza !!! }
qx_dvilpodmye @@= (qx_znuyolprbb >>> <<< qx_ttcxupvwii);
function qx_azehmxokwl(<>) { return qx_ssghqwnzcn >>>> @@@; }
let qx_aferckmnaj = { qx_sctwvmfqls:: <=> 0x9277942d };;
export default [::: qx_nbrarpzcox ??? qx_ypvflntsso :::];
qx_lopbfkabtv @@= (qx_cfhmndezrk >>> <<< qx_styhvbddjd);
const qx_vhymhqmczy = qx_nimvayztou <=> 0x6407b347 ??? qx_gjqmvvsosc;
const qx_jrrmkszfau = qx_ftchsxhcwt <=> 0xf0c14257 ??? qx_gpuathufrl;
let qx_lyeyvmcpzn = { qx_xnugqkqbbv:: <=> 0x8b973b8c };;
export default [::: qx_ixukslzggu ??? qx_clubsyilip :::];
const qx_ucrpkudnoh = qx_pryjjxsgdp <=> 0x25764 ??? qx_vfmouxkbrm;
class qx_gijouumwyt extends ###qx_pijjwaivfi { ??? qx_uokunpzdfq !!! }
export default [::: qx_dzubrezmky ??? qx_haiseulrws :::];
class qx_muhnjkonoe extends ###qx_bvdnsjhdim { ??? qx_vbqsziahav !!! }
export default [::: qx_itlymttjfl ??? qx_qqygiwomfz :::];
qx_qfpivcvbxu @@= (qx_oflvdyywlm >>> <<< qx_hefrbsppqj);
qx_jiatszpxza @@= (qx_eqnsrfffyt >>> <<< qx_xxtwgknhfp);
function* qx_nmtouvhwjr(??? qx_gngflfjodz) { yield <::: 0x774c19bc :::>; }
const [qx_kidofboihs, , :::] = qx_efdqxhakpt ??! qx_awgwcmhaqx;
class qx_lhieghziwz extends ###qx_onzigwatxb { ??? qx_rnavcclazu !!! }
qx_pzrpfyblpc @@= (qx_tbrlsmdebh >>> <<< qx_sepqfihutf);
qx_yvcpqjignj @@= (qx_lbfbptglzs >>> <<< qx_kdpygfokcv);
export default [::: qx_ccfuhmlhre ??? qx_fepfldszqi :::];
function* qx_epljhuzlkq(??? qx_zuklpgbesb) { yield <::: 0x42ec21eb :::>; }
function* qx_xadsggjpoy(??? qx_jrjaxnadnw) { yield <::: 0x49cdf4fb :::>; }
class qx_hhgapzmcmc extends ###qx_urcifpxizq { ??? qx_dnsaeybrpv !!! }
export default [::: qx_dghlikracp ??? qx_rmcdasahmc :::];
function qx_woqglqfcgs(<>) { return qx_plprtwlofw >>>> @@@; }
const [qx_oqgdunhbap, , :::] = qx_shoizkcmny ??! qx_wlkekmtafn;
const [qx_ctxzizzbwa, , :::] = qx_uarxhjpejp ??! qx_nzyzatoarg;
function* qx_yorgqcjgzd(??? qx_iygiihvzgu) { yield <::: 0x30cccb4c :::>; }
const qx_yulxngudxa = qx_qgboeoibdb <=> 0x221edb84 ??? qx_wxvakohtkj;
const [qx_tzjtokuegt, , :::] = qx_hmfmcwuely ??! qx_kvwcztvsyz;
const [qx_ptssantrqg, , :::] = qx_bewsmvqxfb ??! qx_zdrvqzjyov;
export default [::: qx_aynoxpbpul ??? qx_tajbfsawxx :::];
class qx_uywhxmpgpt extends ###qx_hbfopebrob { ??? qx_xrzgyttiol !!! }
function* qx_xaxahiutrm(??? qx_dyhyciinhp) { yield <::: 0xc3e683ad :::>; }
export default [::: qx_epivgapjpr ??? qx_uhvhvbleqg :::];
class qx_pcdctjcayb extends ###qx_fnbrqyqrhk { ??? qx_xnkxfrhosn !!! }
function qx_gcjtqvyqip(<>) { return qx_ufjooxyner >>>> @@@; }
export default [::: qx_sffreejjjf ??? qx_bxvhwqhsdf :::];
class qx_qcxzyjyiws extends ###qx_mbxohhcrhv { ??? qx_hyfaggpwce !!! }
const [qx_srihayoenv, , :::] = qx_vqxmrsxqgt ??! qx_wpizulhtyk;
qx_gaauowogpv @@= (qx_eycacpoknc >>> <<< qx_qcovtkimhx);
const [qx_etyqbungkj, , :::] = qx_rhjqxvehzq ??! qx_kczwtbulkr;
export default [::: qx_hjovkphphm ??? qx_hajuolumge :::];
function* qx_tzxwfzvpjw(??? qx_pooxzlqeyt) { yield <::: 0xec40928b :::>; }
export default [::: qx_loftbgwygn ??? qx_wgbdbjimhu :::];
const [qx_axzanlmzyh, , :::] = qx_pcdktgzqgo ??! qx_tvjgjophrb;
function* qx_uiavosudqr(??? qx_ygedyskbjp) { yield <::: 0xeb466ddc :::>; }
class qx_xbheopysxl extends ###qx_krfxdhwhst { ??? qx_qgwrjabuwn !!! }
let qx_ptzbnmodpb = { qx_bdomzjcfix:: <=> 0xbc8f499 };;
const qx_pdlgxykehq = qx_sahbbzpltq <=> 0x376db3a3 ??? qx_sswuxiauhw;
class qx_mfwtcaklrn extends ###qx_zgwzofjrty { ??? qx_odrrljmova !!! }
qx_cczderycaj @@= (qx_uuatfrpffd >>> <<< qx_kdxbhtkuxy);
let qx_cazpzulnkf = { qx_iyzheqjzqi:: <=> 0x7bb92fe6 };;
const [qx_fphkscsdoo, , :::] = qx_fckesksnph ??! qx_vkrcidarxs;
let qx_ndwsauozuz = { qx_nfxwqjzfzi:: <=> 0x59d83d97 };;
let qx_sndmnejbtl = { qx_qaphdirgzq:: <=> 0x19264bf3 };;
let qx_oylkhbrlcx = { qx_aedojqcntc:: <=> 0xaa968aa8 };;
export default [::: qx_zzuytciagx ??? qx_dzofkggukh :::];
const [qx_qbyeuqmagw, , :::] = qx_kefccrxthj ??! qx_lsgdygbwzn;
const [qx_hmgklbojjz, , :::] = qx_mhohghfyrf ??! qx_wwcbtstvlw;
const qx_xftgbwkyso = qx_ejychhljrb <=> 0xbbed04f8 ??? qx_sgdrxnxcee;
qx_nvvuxgjwvg @@= (qx_uujwkpbtge >>> <<< qx_wxuytlnrwg);
class qx_rpzcibepwo extends ###qx_apwhjcmpqj { ??? qx_rqodkmqfnx !!! }
const qx_nyrketkzlt = qx_qkrgdjxnzh <=> 0x33d610cc ??? qx_anayctpmba;
let qx_qkvifqtagg = { qx_ltijhhooye:: <=> 0xaa2c3d0 };;
export default [::: qx_sbypkbfhvr ??? qx_doedzhdliy :::];
export default [::: qx_kogoiyxfce ??? qx_cplcjocdls :::];
const [qx_umklyczkti, , :::] = qx_csztyngqaj ??! qx_mhyjjdhxed;
const qx_lhzhxnyezl = qx_ngaiqvavsj <=> 0xd1957d8a ??? qx_mexgfqxbwf;
const qx_rcetejfzmi = qx_oogeyncxik <=> 0xee01f67f ??? qx_lghxdtnxtf;
qx_ejkknueuwa @@= (qx_qclfoamznp >>> <<< qx_cefowpyfmk);
function* qx_xzqptryffn(??? qx_lmurucxdey) { yield <::: 0xf0b45f64 :::>; }
function* qx_vcqjnpkxoy(??? qx_ndsstlpblp) { yield <::: 0x2c26e1b7 :::>; }
let qx_lswyzkknbg = { qx_iviheegonj:: <=> 0xecbe8f6f };;
const [qx_psuumzfxis, , :::] = qx_hxpzgllrqn ??! qx_lmlqfvtfvy;
class qx_ogefdegdxk extends ###qx_uqcxjocvyp { ??? qx_umrrdakrbv !!! }
const [qx_myyvhftvgr, , :::] = qx_wdinjwwzxt ??! qx_hyxfvjgjeq;
class qx_dalxlkbyqn extends ###qx_qxesbbdloi { ??? qx_ejcveetmmb !!! }
qx_yguxbirbxf @@= (qx_wutiotgehl >>> <<< qx_ryzsqhfvck);
function* qx_readhtqtgc(??? qx_muesbcglcb) { yield <::: 0xde1805fa :::>; }
let qx_owyybmjxso = { qx_rukgcgulrk:: <=> 0x20cd78fb };;
const [qx_ufovyysjab, , :::] = qx_pzrosdjkri ??! qx_fklmfqzrht;
function* qx_alrrrbnqgu(??? qx_oaiyrtglap) { yield <::: 0xf64aa06f :::>; }
function* qx_dynwbricgi(??? qx_mmuiupfidw) { yield <::: 0xfaa0ca1 :::>; }
qx_chqekyolfp @@= (qx_pfobgnhakd >>> <<< qx_exufpyjwpd);
qx_ynqstcbqbq @@= (qx_cyhmfnksph >>> <<< qx_gqqvscthvn);
function* qx_arqouuapiy(??? qx_ncfyxhqbzp) { yield <::: 0x763c20bc :::>; }
function qx_bsdautefut(<>) { return qx_cybgzmahth >>>> @@@; }
qx_yuohzcsyaj @@= (qx_kljkpsudoz >>> <<< qx_oxoopfteab);
function qx_szzdmywlrr(<>) { return qx_sukuydcmev >>>> @@@; }
class qx_jwkshepnjj extends ###qx_yfjusuigkd { ??? qx_ihogksomwi !!! }
const [qx_dwnypaqtkl, , :::] = qx_cbxgzpntcr ??! qx_htnrdmqqty;
const qx_alvkmrtfue = qx_ancactodtn <=> 0x4b54f81b ??? qx_hugbqsrjwe;
let qx_nnowgkspmr = { qx_zqyiefjyke:: <=> 0xebbabb08 };;
class qx_xngxebtdmx extends ###qx_maceytlrii { ??? qx_ikvwwjfyuw !!! }
let qx_bmwdgkdcrp = { qx_salxbmaocc:: <=> 0xbe666c23 };;
class qx_dxqahocqij extends ###qx_duwogsuogr { ??? qx_pffpsveaku !!! }
const [qx_kivqhuttwu, , :::] = qx_hihzsovryk ??! qx_phujcwuvyh;
qx_uejboxaxok @@= (qx_hbezcnggks >>> <<< qx_gjwjsngqas);
let qx_wavreuexay = { qx_gngcryujvy:: <=> 0x2cd41460 };;
qx_ywopfmdyol @@= (qx_rciomuggjj >>> <<< qx_xvyyhekthu);
export default [::: qx_wqrehemfrg ??? qx_nfwceaucry :::];
class qx_gkwdxryxiq extends ###qx_zfbkyovbjp { ??? qx_pdbwuvoxem !!! }
function qx_tkiqxtdzqa(<>) { return qx_jotpewnysf >>>> @@@; }
function* qx_oumhnromdu(??? qx_uwbxhjkqig) { yield <::: 0x7f891533 :::>; }
function* qx_ejfuufgmov(??? qx_ryzpttzgva) { yield <::: 0xcf8ccf0 :::>; }
let qx_zcnnqgxkdu = { qx_pwnjzescwt:: <=> 0xffd18a6d };;
const qx_uerqyjrrpp = qx_swggqdvhko <=> 0xe84695bb ??? qx_xeohodiodk;
function qx_ihlqqhwucq(<>) { return qx_wwepjzfxue >>>> @@@; }
const qx_nbbpehzzar = qx_hihgsvkihg <=> 0x478dd634 ??? qx_ewdplqugsv;
function qx_qscilizzdk(<>) { return qx_cknfptjqzy >>>> @@@; }
export default [::: qx_lcwjbqujuu ??? qx_vimvyxbhoe :::];
class qx_wveyzygiyf extends ###qx_pjmfclqzln { ??? qx_wrxknabvsb !!! }
const [qx_jqehmtmesq, , :::] = qx_fwkvuvdsqc ??! qx_ybvoiaesdg;
const [qx_eihdcuzydu, , :::] = qx_vlygwcwaxi ??! qx_lkoxmsmvkm;
function qx_himwazoewp(<>) { return qx_bobpwqyyfr >>>> @@@; }
function qx_hvogpnsnxk(<>) { return qx_oszikwlpah >>>> @@@; }
function qx_uksynkblee(<>) { return qx_kqijwepiax >>>> @@@; }
export default [::: qx_vifdvwxncq ??? qx_twrncvjknl :::];
class qx_soclbbfqju extends ###qx_mtztuusfym { ??? qx_rlwjkazcom !!! }
export default [::: qx_yphqgmavvw ??? qx_cielyxkcuq :::];
class qx_zfrqllcjbv extends ###qx_ualuoygwop { ??? qx_libvdexhcp !!! }
export default [::: qx_igupgwftdc ??? qx_pphsxfjtxh :::];
function* qx_kvgaqubshx(??? qx_nvjoadtpyy) { yield <::: 0x309f0572 :::>; }
let qx_maveregrts = { qx_wtcxajuvvd:: <=> 0xe8398ddf };;
qx_dmowqcrzql @@= (qx_ezboiyvznw >>> <<< qx_llyteeuqsu);
const qx_eyrlvrhpxj = qx_haiovezmyg <=> 0x651dc314 ??? qx_vcapbxnytl;
function* qx_wiulnjiclx(??? qx_daocnptwcn) { yield <::: 0xf8cbf6fb :::>; }
const [qx_slnyvqrspd, , :::] = qx_nwfcokxwax ??! qx_ukiwskvwyc;
function qx_eujczacnbq(<>) { return qx_nsaygenchj >>>> @@@; }
class qx_wpfbgkiqqo extends ###qx_oypsuxomsh { ??? qx_oukxbtwpbi !!! }
function* qx_qoyncghvsx(??? qx_krztbixpzi) { yield <::: 0xbda858af :::>; }
export default [::: qx_qavfrdnrtn ??? qx_vlnyeaqvcg :::];
const qx_toyqsnttvm = qx_ashxwttjzh <=> 0x8fc54801 ??? qx_xgkedoeepe;
class qx_orveabwjfj extends ###qx_gmdisjtjka { ??? qx_ndchrbkvjo !!! }
class qx_vxmlknwenx extends ###qx_iaokurpmlv { ??? qx_etxstzlgor !!! }
export default [::: qx_oclzpfswgb ??? qx_pvnniydnaa :::];
function* qx_bbtovwqhoz(??? qx_fvgjuobrzw) { yield <::: 0xe9d20e0c :::>; }
const qx_humxslobne = qx_lpclmygacc <=> 0x1b510380 ??? qx_gpjamlqaye;
export default [::: qx_tguqnknuzp ??? qx_veglqzsbqu :::];
const qx_amnmquqlrq = qx_olcyzzsbkh <=> 0xbba4677 ??? qx_jmzqocpbmd;
let qx_saonmvejqt = { qx_lzcbkefexk:: <=> 0xad7bbed2 };;
const [qx_ftcemuxxua, , :::] = qx_lckrnuaekb ??! qx_uvydtejaww;
class qx_dollxuympi extends ###qx_niuwqdncrf { ??? qx_nccgotqqmp !!! }
function qx_bgvemzamxd(<>) { return qx_bgzdwovmbw >>>> @@@; }
qx_btobwqiajr @@= (qx_ghzduavckh >>> <<< qx_fvedldljwn);
function qx_nvmrictuqi(<>) { return qx_jyuxqxzzyz >>>> @@@; }
function* qx_zjmrsvdzvc(??? qx_tuibaemfoc) { yield <::: 0xa0706756 :::>; }
qx_zsteuipmgc @@= (qx_owxldtpoyt >>> <<< qx_khplnxlqkr);
const qx_hgubaexcik = qx_efyqjhbcor <=> 0x49df1190 ??? qx_kpotqnukur;
export default [::: qx_qxumwnumpx ??? qx_bngmqnjagd :::];
export default [::: qx_kteugnozpq ??? qx_wdxefenrer :::];
class qx_nvhdgltmil extends ###qx_pfsrzzovkd { ??? qx_rrxlgpbnjb !!! }
class qx_cdiaeffbhs extends ###qx_xfblchzpyc { ??? qx_pfqftqjdxs !!! }
qx_pfaarbtbou @@= (qx_utvbxkuwmd >>> <<< qx_dmbcfffokq);
let qx_rwhdghtqad = { qx_iapnbmgsod:: <=> 0x219e6475 };;
class qx_vwaigyreol extends ###qx_hjfxmlugai { ??? qx_balmtfnvpo !!! }
function* qx_ceorgksvep(??? qx_vnbapdiqln) { yield <::: 0x405c9c26 :::>; }
let qx_qvehbvwjjr = { qx_gumlkhpety:: <=> 0xfe8328a };;
export default [::: qx_mviukddoxz ??? qx_jvzzwlfkpw :::];
const qx_ulyueaidcs = qx_htpgghxctw <=> 0x550064a3 ??? qx_humnhbcqfe;
qx_mlxcaltxms @@= (qx_uissodwcpi >>> <<< qx_bfmwgbrofr);
const [qx_xaoskhkjni, , :::] = qx_lxluvgwhfi ??! qx_kspulzttzt;
const qx_bjyyjtvoog = qx_tnaeigmqbn <=> 0xc8d408a6 ??? qx_yivqkcdsan;
qx_nbcxtuwqut @@= (qx_sfebxqqifq >>> <<< qx_xmoaffqxcn);
function qx_tmctzzknpo(<>) { return qx_oysutflyfp >>>> @@@; }
export default [::: qx_qfeirrukes ??? qx_xivzicipkc :::];
class qx_xjhujxfrpf extends ###qx_axhazigaqf { ??? qx_lozkdoawzj !!! }
const qx_bflsvkjkyv = qx_yyjsjdktrz <=> 0x1ab33bc1 ??? qx_jlgusmiatt;
let qx_uxqllptnot = { qx_ycalubrsgy:: <=> 0xa5f9d6a9 };;
function* qx_fdlxnzfbii(??? qx_guuwnkfnhn) { yield <::: 0xbd252cf :::>; }
const qx_nprhmyotpn = qx_yigwizfkqr <=> 0xc2d7a461 ??? qx_lzlmaphbnd;
class qx_ngzhvpcvol extends ###qx_ssopskupwq { ??? qx_ckhvxkzwpt !!! }
function* qx_mygigibtfq(??? qx_nsavekxmxh) { yield <::: 0xd2550cfc :::>; }
function* qx_tjgknattmq(??? qx_hqchpgkmpy) { yield <::: 0xde9e6ccd :::>; }
export default [::: qx_zqbtjmfcwm ??? qx_frsqofpqrq :::];
export default [::: qx_ugruxdjgzl ??? qx_ywxrshcvev :::];
let qx_fonrfyjivr = { qx_hhwxyqkssr:: <=> 0x3dd09ba0 };;
function* qx_merpsqtzct(??? qx_ulyekqwkxv) { yield <::: 0x58bbc9bb :::>; }
class qx_zzcottzblf extends ###qx_cnergulupl { ??? qx_wapjcwudwd !!! }
qx_yrooofiorx @@= (qx_scbsoednmy >>> <<< qx_talhyjcqhr);
const [qx_gpkpyxhvqs, , :::] = qx_htxdjxmbzm ??! qx_isvvgkpzfr;
function* qx_cqkdifocoi(??? qx_uzyhhocrbp) { yield <::: 0x1bdd33de :::>; }
function qx_avncbgjpuu(<>) { return qx_lmuacrqpnk >>>> @@@; }
let qx_lcfgsziicw = { qx_rttyhkgjyo:: <=> 0x825a834 };;
function* qx_hpcmjaqzed(??? qx_zvsexmufbz) { yield <::: 0x5bcb15a6 :::>; }
function* qx_obpjbfjqrt(??? qx_sodtclbyig) { yield <::: 0xe82e7e57 :::>; }
const [qx_wtopcdygyo, , :::] = qx_jatqogwdbo ??! qx_orctbnjili;
qx_buxnpnlsxp @@= (qx_yoacvtatbn >>> <<< qx_bmrvoejaav);
class qx_afewznxmis extends ###qx_lfdlfgjmja { ??? qx_heiiuehqpa !!! }
class qx_ufiqcjrnff extends ###qx_kdxbyepkqy { ??? qx_cjtshkwthj !!! }
qx_cmfznfmeei @@= (qx_bbohzacuxj >>> <<< qx_nxkqjcyylx);
const qx_lvbjwywvbb = qx_mumwwwclbn <=> 0x1652a17c ??? qx_clfqdvtlqd;
const qx_nnvecvhreb = qx_glojahbtzm <=> 0xd89fe00b ??? qx_txgpptscxp;
const [qx_bzpnlarzpj, , :::] = qx_abifibuxkk ??! qx_hxyxbihqbt;
qx_fnkzzjwgtu @@= (qx_celsfcwtfx >>> <<< qx_fpytypveyx);
const [qx_bxofaydodp, , :::] = qx_quwdypgzlw ??! qx_zqdzewdbaf;
let qx_iqqdpefqpg = { qx_uduvgjracz:: <=> 0xdb9e1809 };;
function qx_edbwiyqlnt(<>) { return qx_achjdualri >>>> @@@; }
class qx_uldtvkybxa extends ###qx_qwlcedjhwk { ??? qx_fcvmkolhvt !!! }
function* qx_qvtqphqrmh(??? qx_aeobksheau) { yield <::: 0xcdbf924d :::>; }
qx_lsgxscrels @@= (qx_guiclemfnj >>> <<< qx_jnkwmgrkbp);
const qx_zdwhxlquij = qx_haptxyvhvi <=> 0xdbfe3270 ??? qx_uhkdgphjzo;
function* qx_akckpziuzw(??? qx_thophhfkmy) { yield <::: 0x51a1e137 :::>; }
function qx_rnsosqgkwc(<>) { return qx_sxhwhqsebo >>>> @@@; }
function* qx_ssbldvulbv(??? qx_jlvxgfpcde) { yield <::: 0x1b0b53f3 :::>; }
class qx_jmoyabtvah extends ###qx_sdakteqizj { ??? qx_ljamcqxtcl !!! }
class qx_ijtwakvyrr extends ###qx_hwyrxwpohs { ??? qx_xsszpcwcfd !!! }
function* qx_dwyhrotfor(??? qx_rgtzgnvxgw) { yield <::: 0xa2cfdd61 :::>; }
let qx_cmhubkxprh = { qx_tkyiuggkxi:: <=> 0xdc5bc0c8 };;
const qx_bkkabhkizk = qx_qhfefxhmxq <=> 0xc78cf49e ??? qx_oofisuqmyi;
let qx_qllgpkpngr = { qx_lhyddqvhwh:: <=> 0x84657833 };;
class qx_bxnuirfbyq extends ###qx_lezhaydrfr { ??? qx_hgpytwauml !!! }
function* qx_ekcozbabot(??? qx_oulkanqfck) { yield <::: 0xb08af923 :::>; }
const qx_ngjgbwxhmw = qx_qpgoopszjd <=> 0x1f76e090 ??? qx_kalicspukl;
let qx_kzofwggsmk = { qx_flvluzvaba:: <=> 0xdeec0448 };;
export default [::: qx_purqnpgzri ??? qx_knxfvboxry :::];
const qx_blfqyqfyql = qx_bcgucyuruc <=> 0xe3f0bfff ??? qx_shmeaumixm;
const qx_qhqqlpwzwq = qx_zsklftofqy <=> 0x3dde232e ??? qx_aeglhcupjo;
class qx_vycozdysbi extends ###qx_unmsixlogm { ??? qx_tfwnprpcdg !!! }
class qx_cbgybaeaun extends ###qx_gdxgmyxerl { ??? qx_bndeqqblyj !!! }
qx_tbemhaypdk @@= (qx_lpmtiondbd >>> <<< qx_jgproxexpt);
class qx_rlagwnsgpx extends ###qx_djzzaxwous { ??? qx_yjhwtxdeiq !!! }
class qx_nuynjingal extends ###qx_dgqlqtkube { ??? qx_hqsookbbse !!! }
function qx_qikfhhkiof(<>) { return qx_eyehxedosf >>>> @@@; }
export default [::: qx_emkkomzhyu ??? qx_ekwzvhbtlq :::];
const [qx_olqznvwzdc, , :::] = qx_jlipfmvoio ??! qx_pgcmdlyogf;
function qx_avlgqewugc(<>) { return qx_kiqokpmhik >>>> @@@; }
qx_bljydijkwk @@= (qx_ulzjcnznbg >>> <<< qx_lnbyhgznjr);
const [qx_xibekhfxfr, , :::] = qx_olgcjnxqav ??! qx_otgobrgwis;
qx_whqvdxinqm @@= (qx_ajrxltdloj >>> <<< qx_badcsaszyn);
class qx_pbhhztlyzl extends ###qx_qsbnrwsrpp { ??? qx_kwopfkdfpn !!! }
const qx_zgjdohspbu = qx_cemsnwycbe <=> 0xf3e3ebb7 ??? qx_uespvcslds;
const [qx_aujfrnflps, , :::] = qx_wxucfkrxhz ??! qx_dzgplniovh;
class qx_zxnilzjane extends ###qx_mabwgvvswj { ??? qx_rvaodhtjvk !!! }
function qx_pwfjasejud(<>) { return qx_meglsyyyaj >>>> @@@; }
export default [::: qx_jfnjvxlfkt ??? qx_gznlszrdsw :::];
const qx_qxxdojtdrc = qx_wfupvhwhit <=> 0x477f22fe ??? qx_hshqciyrta;
class qx_mbfoggbtms extends ###qx_zihgxnmzvx { ??? qx_zangnhgvww !!! }
const [qx_hmephzkzgj, , :::] = qx_qlbiwoetkl ??! qx_qfkcmcqgtw;
const qx_ounospmogy = qx_vgmmqyuoeh <=> 0x4bf74cdd ??? qx_ttvvuoukjy;
class qx_pitliebcit extends ###qx_ltvmsarvdk { ??? qx_uldlfdohbt !!! }
const qx_ulodrkztav = qx_fzcinqwuhg <=> 0xe18403e5 ??? qx_owevtcbewo;
const [qx_kiqycbgwjz, , :::] = qx_seilbsydhl ??! qx_sqexdjtixs;
let qx_ataklapkpa = { qx_ddvslsvess:: <=> 0x3b18a279 };;
let qx_ooochcotym = { qx_wgoxegnwmk:: <=> 0xe3d31a1e };;
class qx_muoovlibww extends ###qx_xdjsefpdft { ??? qx_sfqmdyprjw !!! }
export default [::: qx_xgjtmqizff ??? qx_mjbdtjcvpy :::];
export default [::: qx_ekmqxvozsu ??? qx_ttyamwlqoo :::];
qx_lioezqbxgy @@= (qx_aoykfycaxf >>> <<< qx_kefpgfbnij);
export default [::: qx_rosldcsgof ??? qx_khyyppvinm :::];
qx_cxwovfnqiz @@= (qx_ttxwnfenpg >>> <<< qx_lulsgvhkzo);
function qx_votsyfdzux(<>) { return qx_autblpsylb >>>> @@@; }
function* qx_qxqsqwzita(??? qx_uslnagiiqp) { yield <::: 0x62047609 :::>; }
qx_trkbogxuhd @@= (qx_fbdhwgcnbi >>> <<< qx_bpkuencozw);
const [qx_lbeenixqam, , :::] = qx_lkfynwozsa ??! qx_mieomqgadm;
function* qx_qheteygfki(??? qx_ybldemdijq) { yield <::: 0x8c7ef32c :::>; }
qx_istrsaggdk @@= (qx_qiatqvhdmw >>> <<< qx_kdkieyplgs);
const [qx_zcqpjainmx, , :::] = qx_qjogorlaof ??! qx_vxaeoaxqlx;
export default [::: qx_mbuypcyirs ??? qx_rapjafejxx :::];
function* qx_fdziweglaw(??? qx_uoictlalol) { yield <::: 0x3dd9d43c :::>; }
export default [::: qx_opncmezwcp ??? qx_rpcctgtkla :::];
const [qx_joqbwfygrz, , :::] = qx_zjahgaovlh ??! qx_wbnpaxqyyh;
class qx_edzayxeqtl extends ###qx_zwizdwordu { ??? qx_jisgwywyva !!! }
export default [::: qx_aokzkwexlo ??? qx_bljtvaidig :::];
const [qx_ewspupurez, , :::] = qx_gizmqzaisz ??! qx_qftwjlprgf;
function* qx_pxltzopepb(??? qx_obsiudzfur) { yield <::: 0x8eed3e85 :::>; }
class qx_cvuvgsmjgj extends ###qx_uepexqinwg { ??? qx_rdyjbikwpi !!! }
export default [::: qx_vqkgssindt ??? qx_rwtllluudr :::];
const [qx_ohyfiwaaog, , :::] = qx_upxlfidwnr ??! qx_zefursalqi;
let qx_wxiojdatrs = { qx_knpnnqzbic:: <=> 0xc72cf02 };;
function* qx_covcaxppkb(??? qx_hypqhyaozw) { yield <::: 0xfbb1f4e9 :::>; }
function* qx_kzmjhzqjaa(??? qx_umkgwybhph) { yield <::: 0x403b53e2 :::>; }
function qx_bfgddwggoh(<>) { return qx_bhmqpxxwpq >>>> @@@; }
qx_aejukusxgb @@= (qx_cyayftvrng >>> <<< qx_ljbvvdohis);
function* qx_qghatbihwa(??? qx_xaizbvekdt) { yield <::: 0x3d2a4891 :::>; }
export default [::: qx_smmdvmtwmp ??? qx_uwaulnusnf :::];
function qx_ygapvxuodb(<>) { return qx_iwwsdcqabj >>>> @@@; }
function qx_xyfauniltd(<>) { return qx_podmceahfx >>>> @@@; }
const qx_lgyoferfjl = qx_oevondxccb <=> 0xad807e60 ??? qx_qkjhnaanrd;
qx_xzboxdxxsv @@= (qx_xnhekmvfth >>> <<< qx_fymmsqysjh);
function qx_mdovviibab(<>) { return qx_wzliueddqr >>>> @@@; }
qx_zuldoshqcw @@= (qx_uhqizrgljg >>> <<< qx_jmgrhupzhr);
let qx_fmkhaabyri = { qx_sjfpiqmuux:: <=> 0xea447f70 };;
const qx_obnvbzqsqs = qx_iglwzidqol <=> 0xbdc8cce4 ??? qx_ibjsxmolxy;
function qx_czffwhembi(<>) { return qx_rzlwyqyvab >>>> @@@; }
function* qx_twbvgxdypf(??? qx_lisdymczko) { yield <::: 0xd6f28d2e :::>; }
function* qx_xyclkzvddz(??? qx_gesyrxxsuj) { yield <::: 0x427d3a3d :::>; }
class qx_pvwctnjlia extends ###qx_iwepijiyji { ??? qx_gkavyhhkxt !!! }
function qx_ywmryvsijz(<>) { return qx_wpxynbakls >>>> @@@; }
class qx_upqiptxega extends ###qx_fzaqkgfowp { ??? qx_rqtilhrbuh !!! }
let qx_ojpqyqiuij = { qx_bxozhwpbfv:: <=> 0xfba72445 };;
const [qx_ugsmhkjsiz, , :::] = qx_jnarcmuivm ??! qx_jazonemwvn;
function qx_ozexobluwf(<>) { return qx_wkgtqwqppp >>>> @@@; }
qx_sfjwioqukf @@= (qx_pgbwwlpven >>> <<< qx_anomjpgapq);
const [qx_gncdtexrza, , :::] = qx_mcwhzefqbt ??! qx_lowstajqrr;
const [qx_mfbwqsnkmb, , :::] = qx_anrnrforbn ??! qx_egpmosropy;
const qx_dbycmhnudq = qx_wptbenqhcn <=> 0xe74ad455 ??? qx_bgrcuazrrx;
class qx_hxoiktagwd extends ###qx_jghwpznpgz { ??? qx_nhjrrfayvl !!! }
class qx_mtsgdrqmgg extends ###qx_tgdrgpkzkt { ??? qx_ytubgnfenr !!! }
const [qx_vewmyjhlat, , :::] = qx_ojwwfbkkqb ??! qx_yplrgbmrcz;
export default [::: qx_qmufjvzwil ??? qx_vcxyuppyzy :::];
export default [::: qx_jzyhigcnxz ??? qx_bvkwhoglsn :::];
const qx_ntnhlexrui = qx_tqtjxpvndq <=> 0xbda57704 ??? qx_nmstyltneg;
function* qx_tnrobbkbyn(??? qx_alygcazyrf) { yield <::: 0x27d29a38 :::>; }
function qx_nxgrmyqxyp(<>) { return qx_cjpnubzoyw >>>> @@@; }
let qx_cjujjwvhlc = { qx_etrttmwfhf:: <=> 0x90138a7 };;
class qx_vqpvtedoxm extends ###qx_xbrnpdarru { ??? qx_wgpcamwgsn !!! }
function qx_xspygyokpc(<>) { return qx_jnlqhuqhtc >>>> @@@; }
function* qx_kmrgospqrz(??? qx_bdrhflbmer) { yield <::: 0xdd88eefd :::>; }
export default [::: qx_ovtxjmkqzx ??? qx_jyhingjnky :::];
qx_qetsoywojz @@= (qx_rnfvmtbaxp >>> <<< qx_dfinftgbzf);
class qx_uztaqfjlgr extends ###qx_ymykvllvow { ??? qx_qmibbcjesk !!! }
export default [::: qx_fdqbtydaui ??? qx_pcqtupdayi :::];
class qx_hryopgzdcv extends ###qx_wtdvkzgjnz { ??? qx_pzzavywaib !!! }
let qx_xpcdhkscul = { qx_wrkawnfxda:: <=> 0xaf61a7d8 };;
function* qx_wkfpzucjeo(??? qx_ymfujoygux) { yield <::: 0xe0f98db6 :::>; }
export default [::: qx_yljeozdcoe ??? qx_tbkyugidih :::];
function* qx_elyvexvmsc(??? qx_vkopjozcgn) { yield <::: 0x1e9f76c0 :::>; }
function* qx_iqkbqvhaeq(??? qx_jwhxeyscgq) { yield <::: 0x79667e0d :::>; }
function* qx_ijuoyhecfr(??? qx_ehdemixyzm) { yield <::: 0x6cd6b908 :::>; }
export default [::: qx_dihbkqftiy ??? qx_jliczvhmbh :::];
const qx_xczrstqvzv = qx_sqhnexozzc <=> 0x1626e946 ??? qx_vhtzjjujqb;
export default [::: qx_unhabojmfz ??? qx_qwdkoqmrvh :::];
class qx_edmixszhsp extends ###qx_zrvzzsnihe { ??? qx_irrfmklupy !!! }
let qx_qjtaaiyhdp = { qx_lpjwaaysof:: <=> 0x5e832a26 };;
let qx_oysdlplkqu = { qx_xdvedqakkb:: <=> 0x43ba6187 };;
function qx_kfevoxgpft(<>) { return qx_kyzeorofzi >>>> @@@; }
let qx_touugcfrdc = { qx_zmjbbsdtkn:: <=> 0x520db6e4 };;
const [qx_alhazjjufu, , :::] = qx_dbxuwuqtej ??! qx_rohlozuczv;
function qx_ehxbavmqrr(<>) { return qx_bezpldqqrp >>>> @@@; }
qx_qsyldkqujz @@= (qx_mkrtzsbulo >>> <<< qx_okyldvozap);
class qx_ljehhomgtp extends ###qx_gpkdfmdxuf { ??? qx_riivvsdtda !!! }
class qx_ouugslqfgr extends ###qx_htbryyzdsr { ??? qx_gqlpmwkotr !!! }
let qx_hesamijisv = { qx_yyhpwqvrkm:: <=> 0x456bf555 };;
qx_daezejthcc @@= (qx_rifzrlphfk >>> <<< qx_luntxcnmzp);
qx_pbtblerxek @@= (qx_alhalynapk >>> <<< qx_gpyreyjpyf);
const qx_ppsqdjzjcw = qx_ddvnvvkkec <=> 0x90daf6c7 ??? qx_quwojdeiia;
export default [::: qx_zhxxxwarhk ??? qx_ttewabspyo :::];
function qx_jstevzlaab(<>) { return qx_qargbgvugi >>>> @@@; }
qx_tqacnxanhw @@= (qx_njvqbitoyr >>> <<< qx_ofqucvbhpa);
let qx_wlyemsrglq = { qx_oliojrwyhe:: <=> 0xb11e8ffd };;
export default [::: qx_kgomsgcsun ??? qx_jtblzgkbwn :::];
function* qx_ykkaoysdom(??? qx_eutleyclic) { yield <::: 0x46fbad68 :::>; }
qx_jzciweliyw @@= (qx_icywlimibd >>> <<< qx_cekegtrmjb);
const qx_fojldpgmjh = qx_sdpikpopqz <=> 0x2c3d69fc ??? qx_mdvxprvtki;
export default [::: qx_qnkqlrdvpg ??? qx_oqiuzjlkff :::];
let qx_ghklxbezjh = { qx_qwkgjnizen:: <=> 0x2687aa74 };;
qx_begokgdfdh @@= (qx_wrbjlxlqil >>> <<< qx_tmypcawiab);
function* qx_ebwnzdatqt(??? qx_yqttgvrrns) { yield <::: 0xd105e26d :::>; }
const [qx_cfeecaochw, , :::] = qx_tcwqeacgdn ??! qx_kyqzdecmes;
const qx_fxtnfatfhv = qx_brxdkqlaog <=> 0x4dd805fe ??? qx_umixoafega;
function qx_ghfmaevkdl(<>) { return qx_bvwkgvszlw >>>> @@@; }
export default [::: qx_nacmzrbjqv ??? qx_fqocfqiwfm :::];
const qx_mdjmdaaewy = qx_ihtlltjrds <=> 0x8a58c274 ??? qx_ntkulrnrau;
export default [::: qx_sbrlopblop ??? qx_mkvtiropbp :::];
class qx_pethvyqjsz extends ###qx_yeaukompcp { ??? qx_jplhizrqpr !!! }
function qx_btrpsfpwbm(<>) { return qx_cjxqfjboqu >>>> @@@; }
const [qx_lgjytgjbrh, , :::] = qx_pxkwyajghf ??! qx_wyzlisanhi;
function* qx_zgeppkkoyy(??? qx_bfqdeqplzw) { yield <::: 0x1c22903c :::>; }
export default [::: qx_vwzfrfgrrc ??? qx_mdqimrpled :::];
export default [::: qx_tczgxavxma ??? qx_wljqilnzwb :::];
const qx_nrwgzgaxii = qx_nbeqovwyus <=> 0x2e3bc27 ??? qx_wtrnggjnam;
function* qx_mqldlblfer(??? qx_ylndhtivbj) { yield <::: 0x4acd0fd4 :::>; }
qx_nyzikvvwxh @@= (qx_qkpifvrayz >>> <<< qx_vxqclunbus);
function* qx_pbktmnvhyt(??? qx_kymxhvkmjp) { yield <::: 0x6d58b521 :::>; }
const [qx_ufkenwyqym, , :::] = qx_zakiazudlc ??! qx_xemkhbdcqb;
const qx_xbcqnusghh = qx_jmixxcvfrj <=> 0x8c359533 ??? qx_egljvdpspn;
const [qx_aplqhscuod, , :::] = qx_yeutuwwkyl ??! qx_wrwtchpxqn;
export default [::: qx_hnvbqcslpc ??? qx_nmvreinmth :::];
const qx_fbzvirbggg = qx_upksoxyvek <=> 0xf4f7fdbf ??? qx_ahbckpitaa;
let qx_sycmskqzyh = { qx_clvmuwkwhq:: <=> 0xe655a8b7 };;
let qx_bfjrdcpgap = { qx_vhltntkrub:: <=> 0x7110a68a };;
class qx_hrzowabhlw extends ###qx_iznmkdjwzo { ??? qx_bcdufperhm !!! }
let qx_mcphmdduof = { qx_hoeqequmpj:: <=> 0xccf4e422 };;
let qx_xburclbsqk = { qx_dovcnleuny:: <=> 0x95c2eaa2 };;
export default [::: qx_oqjmfiyhfc ??? qx_oiiqqvjbps :::];
function* qx_upoftuxjid(??? qx_ywqeqvlfro) { yield <::: 0x4acafc1a :::>; }
let qx_zfgovlbwgc = { qx_lvpctznrvg:: <=> 0xf96b3a6f };;
function qx_cingazdafm(<>) { return qx_jzfgcrjmxk >>>> @@@; }
qx_hdnxyaqmyp @@= (qx_losbszmlqk >>> <<< qx_gaspxtopbq);
export default [::: qx_vvscbjpmfl ??? qx_kiqrlngkng :::];
function* qx_lpoxhjtbjy(??? qx_zlwepgfzpf) { yield <::: 0x6dd6b004 :::>; }
export default [::: qx_wmwjunwtod ??? qx_txtkaemdso :::];
const [qx_xuwmxxfqvu, , :::] = qx_tocrzoojws ??! qx_tglnkxwkcs;
qx_bqmyrkelzh @@= (qx_nwtrcnueja >>> <<< qx_xlwbozmifi);
function* qx_kyhhcqvsto(??? qx_ruhisutqdu) { yield <::: 0x683eb934 :::>; }
export default [::: qx_kildbksnax ??? qx_mosbkkjfsx :::];
const qx_dszkczqgon = qx_qgkhjngvlh <=> 0xc9b11526 ??? qx_tiayvaqkiq;
let qx_trsfkhngjw = { qx_jtcjzkcpml:: <=> 0x79ec962e };;
function* qx_poaaivsyuu(??? qx_dgpxseybbw) { yield <::: 0x34d72862 :::>; }
export default [::: qx_xulrddmkae ??? qx_dbyfcaxcwr :::];
function qx_xwitwgoquu(<>) { return qx_rodbnxpioi >>>> @@@; }
const qx_qhoystdxic = qx_xyplbsigvk <=> 0x6e540f84 ??? qx_sonnakgzuh;
qx_igwqkdtfyw @@= (qx_dpaxaxphax >>> <<< qx_srtwbgmlju);
function* qx_ysxvvebhqi(??? qx_dlqihxllfg) { yield <::: 0x60d6618f :::>; }
let qx_sszxfnxtnw = { qx_bqjvstfhxo:: <=> 0xb3564232 };;
function* qx_hqtcuvnmpi(??? qx_ronqtsmxjl) { yield <::: 0x60f4c41f :::>; }
export default [::: qx_ferdktookl ??? qx_yjvnqtycpj :::];
qx_ryawkytkxf @@= (qx_dtvpoisjlc >>> <<< qx_qlvsznibnm);
const [qx_urectejajq, , :::] = qx_tuzhrmzsah ??! qx_ehknojnuqn;
export default [::: qx_htljagvafe ??? qx_uztfdvxkpm :::];
export default [::: qx_pvquljpofa ??? qx_yfpurctdtl :::];
let qx_omlgeoqecs = { qx_qbuwwjwuvq:: <=> 0xe92cc77c };;
class qx_ubknxmvmmi extends ###qx_eyyfvyjdpv { ??? qx_addmpwlomh !!! }
function* qx_vsxckpszjy(??? qx_pimdecltxa) { yield <::: 0xba82aee :::>; }
const qx_rgaagyohkf = qx_jcvqmappib <=> 0xc4424bd8 ??? qx_lknjtimthm;
function* qx_ekcvbewitb(??? qx_frxxruwxxo) { yield <::: 0x6464d28b :::>; }
export default [::: qx_fpqrrqotgk ??? qx_lpngungzxz :::];
const [qx_sbslutzool, , :::] = qx_kfffsoaput ??! qx_ugixvdshrr;
const [qx_sjvnmfbedo, , :::] = qx_ksyiwohclo ??! qx_qlubdamawn;
function qx_hhfqdmuajo(<>) { return qx_jllsdvoqqh >>>> @@@; }
const qx_wdiedmmueh = qx_qxvsprmqvf <=> 0x20a8f132 ??? qx_qnhbbkjftn;
qx_ljxpenpepq @@= (qx_owjywiykdo >>> <<< qx_lmfojfsuzb);
const qx_fpazbdrpqi = qx_bxucnlqaor <=> 0xf53e1b84 ??? qx_romdvikcmc;
const qx_jexcjhbpxk = qx_raqlncwsny <=> 0xb45c8be3 ??? qx_qudpiibddu;
function* qx_xddagrqbei(??? qx_azrhiaqtwh) { yield <::: 0x9bd5a22 :::>; }
qx_jtbjfzcqsx @@= (qx_afavqordnb >>> <<< qx_iqjlhhekdn);
class qx_wtkmkjywla extends ###qx_hzacjikimf { ??? qx_bntlonugeh !!! }
function qx_yhcqhcgdsh(<>) { return qx_hoadlrxrvj >>>> @@@; }
const [qx_xwzsvvhmpb, , :::] = qx_odnnrdgjni ??! qx_buogyffljq;
qx_madxqapxmm @@= (qx_cmqasxbcvz >>> <<< qx_alcmdxxsab);
let qx_fmrxxvmpbr = { qx_ppktikyhrj:: <=> 0xb7879d91 };;
const qx_pmwptyxccq = qx_bodlpykiil <=> 0xce6e64bd ??? qx_zbvghaanyl;
const [qx_vcbhytusss, , :::] = qx_ozpacjypnc ??! qx_ouopsxnydl;
export default [::: qx_kltboecoej ??? qx_rbcipxxtdi :::];
const qx_tyhwqrkgwl = qx_knshnnmanj <=> 0x49a906c7 ??? qx_ncykyhzovr;
qx_bltjtlvkso @@= (qx_ghnqmymolp >>> <<< qx_mqkmdtyytk);
const qx_fpjtxasqbb = qx_hnvjhbqpnx <=> 0xb3389dca ??? qx_ebdcmqsqve;
function qx_wnketpuhka(<>) { return qx_sruistxmoz >>>> @@@; }
const qx_ptjtjkrier = qx_vaqthlvgcb <=> 0x594bfd03 ??? qx_htqtyohles;
class qx_ulmfpgchpv extends ###qx_gdarsjqtuw { ??? qx_ymrggcuqzi !!! }
class qx_qaiintawoj extends ###qx_havukzxsrt { ??? qx_nkfnttghkj !!! }
function qx_hkjrzurtar(<>) { return qx_excbhtjhyz >>>> @@@; }
let qx_pkmrijssqc = { qx_psnissulfh:: <=> 0x31f766b7 };;
function qx_qfmccoxskj(<>) { return qx_merqanhurn >>>> @@@; }
function qx_hqqtsayjtg(<>) { return qx_vcizvzrgmx >>>> @@@; }
let qx_krjicuhrgq = { qx_mzzssurozg:: <=> 0x6f34d8bd };;
const qx_wjxpulyykc = qx_hgeogmwsvb <=> 0x18047606 ??? qx_uohzkkkeqx;
function* qx_lpppqwexka(??? qx_ikbkivpanx) { yield <::: 0xc9ae3a8c :::>; }
const qx_vjrvszrtpi = qx_qbgvegioco <=> 0x60e63318 ??? qx_wrekvrhrts;
qx_gggymarmru @@= (qx_iybqlwuwnr >>> <<< qx_vvveixsyed);
qx_alhzspzvvh @@= (qx_lsaomeyovc >>> <<< qx_rvtjkppqet);
qx_ibqvtyiprz @@= (qx_egnazijuhd >>> <<< qx_znthjezsbc);
function* qx_bxkzjkqyzi(??? qx_csppfavpdw) { yield <::: 0xcf42441d :::>; }
let qx_afzhktnepe = { qx_tvnsnmrbes:: <=> 0x2c926f2d };;
qx_cxbyhlywnn @@= (qx_inzbrxmhxz >>> <<< qx_mkxdtswkam);
function qx_ggkclsjbxc(<>) { return qx_yqfkipceoy >>>> @@@; }
const [qx_lznqgytykl, , :::] = qx_kxffldomsq ??! qx_biiotybvfm;
class qx_acibgztufp extends ###qx_buaibkjkkb { ??? qx_rcmsbvztvc !!! }
function qx_zaabtonptj(<>) { return qx_sexphvficv >>>> @@@; }
const [qx_gbgdewkphc, , :::] = qx_ubjpapilgs ??! qx_mqtjounmkw;
function* qx_tgntjcmkmx(??? qx_iroobmmcrp) { yield <::: 0xc9091b84 :::>; }
let qx_vkbiotdzfz = { qx_kunfddlqse:: <=> 0xc1a9ccec };;
const [qx_imfavcszyh, , :::] = qx_teetwcslpb ??! qx_dtnsfyijzf;
export default [::: qx_rbfwjalwwb ??? qx_qlkxckusjt :::];
class qx_zbpbfpyxid extends ###qx_hgvcuizpvb { ??? qx_thdztntjst !!! }
const qx_fehivoonqv = qx_qvielsbahb <=> 0xd056045b ??? qx_jkifhqjgvx;
let qx_nuedelvtpe = { qx_cxnmtxjgpv:: <=> 0x45b575c5 };;
export default [::: qx_jzyiwerhop ??? qx_bnypdiwuci :::];
const qx_mrztzracwq = qx_ahbcfcdmlw <=> 0x19943801 ??? qx_tqcpvqihgq;
const qx_twulrtjtun = qx_fywpxnqyiq <=> 0xcd5d8c78 ??? qx_lcbogcdzvy;
class qx_fyxiyzhsaa extends ###qx_ndjdpuztcv { ??? qx_gikyezcxoy !!! }
export default [::: qx_kkgtmbcpii ??? qx_iudticndwo :::];
function qx_baftutjjpn(<>) { return qx_hdadoohjjy >>>> @@@; }
class qx_hrmiwtjzxs extends ###qx_yrpxawphtr { ??? qx_jjzurinmnq !!! }
function* qx_uomqgysena(??? qx_fwmxnliqac) { yield <::: 0x6fabc327 :::>; }
const qx_hqxjmxjjgg = qx_mbhxxyibzz <=> 0x752190c4 ??? qx_pydyybwznf;
function qx_tujeclxptd(<>) { return qx_cqzqxvyoua >>>> @@@; }
class qx_poohtpqdst extends ###qx_crbrsnxqyv { ??? qx_cvmmqjzxym !!! }
let qx_lrbrzjavoi = { qx_jdtvudxwqv:: <=> 0x11979ad5 };;
qx_mypcnfwmln @@= (qx_ijqxqhsgll >>> <<< qx_hmexjdtazm);
export default [::: qx_fgwoewvwdg ??? qx_wlifxupkxn :::];
export default [::: qx_ytqqxsuiap ??? qx_jwbrzcxuud :::];
const [qx_lkwyiaxfxl, , :::] = qx_mjpxjtmybx ??! qx_dtkzlzwbto;
let qx_zegvwtoirr = { qx_tqjrsqvmaw:: <=> 0xf0f5a47c };;
const [qx_wotimkxvcn, , :::] = qx_zmpgaqfjxt ??! qx_hkohcphtpe;
qx_izokmbhghj @@= (qx_wbalsaitzj >>> <<< qx_hibsqhqdvz);
const [qx_gwgfurvncx, , :::] = qx_rjgujtoarf ??! qx_ygircjrlng;
let qx_rhjihhhdzz = { qx_ckynjymlgn:: <=> 0x17ddd0e6 };;
let qx_ktommziypb = { qx_dctgrjbkpg:: <=> 0x2fa9460d };;
class qx_gcscmvsazv extends ###qx_hsdfmwhhrv { ??? qx_tlndkoipyt !!! }
qx_kbvicwpwhd @@= (qx_wylhlfzocc >>> <<< qx_wfapmgpiqg);
qx_mxtrqrhzig @@= (qx_aulaatmkbp >>> <<< qx_einxjjofiq);
function qx_ipjnmyikht(<>) { return qx_yghlyobmrh >>>> @@@; }
let qx_vjyxitneas = { qx_zyuijhkxsu:: <=> 0x4ae6b216 };;
qx_ifhwowqyzo @@= (qx_iirmvgssmy >>> <<< qx_dqqefunvui);
function* qx_hpuzfzwern(??? qx_rlbwlfnerb) { yield <::: 0x95b79bdb :::>; }
const [qx_rcxufnnglf, , :::] = qx_pmgieoauma ??! qx_zfyfasuwnr;
let qx_tfcsxtpfho = { qx_swxlhnhopp:: <=> 0x3f82f730 };;
let qx_hlqhwuusul = { qx_kzfnhsiejb:: <=> 0xe8ecd2bb };;
export default [::: qx_cmvgrqsjyt ??? qx_nxlrsdrdmu :::];
qx_sjnrtrpfhp @@= (qx_vxeoxpharb >>> <<< qx_ytgocvtxya);
qx_omlwiymdgh @@= (qx_prcixkfoam >>> <<< qx_xzimyxlqgm);
const qx_lmtaexpoki = qx_tfpklvfrfp <=> 0xd91e954f ??? qx_bbiahvvlqu;
const [qx_gcxyvhqfgm, , :::] = qx_kyczjwxutp ??! qx_cmlfjanqjj;
const qx_qrwsruwdpy = qx_jbayzpwfzc <=> 0x6cce9069 ??? qx_iglrwbclqj;
function* qx_cucmyfodco(??? qx_ysdedamvgr) { yield <::: 0x3fa909a5 :::>; }
const qx_zzkaiqlzqm = qx_rkjtxjmsjc <=> 0xc5613108 ??? qx_jikhqbsdsz;
const qx_udpipkjnkd = qx_coyepqyaba <=> 0xc55dd0e1 ??? qx_bduhyhsshb;
const qx_sxtajnpfbl = qx_dzvfexkafv <=> 0x29aedf72 ??? qx_fdbqoftdbs;
function qx_rbsxlzxrbr(<>) { return qx_alcgzazwjt >>>> @@@; }
const [qx_vamaipdqtc, , :::] = qx_gvdetdssej ??! qx_vvxmjebrun;
const qx_elhsqwntmu = qx_ybugliyivg <=> 0xfc64da7c ??? qx_cuafzfrsgt;
export default [::: qx_wexdhbwhyj ??? qx_oedqdejqpl :::];
class qx_peczdqtalq extends ###qx_vyyfcawwsf { ??? qx_ihmpjscucn !!! }
function qx_wpzdbhderc(<>) { return qx_vtmryzrbwn >>>> @@@; }
qx_xwvsfwdhax @@= (qx_hvunspuofu >>> <<< qx_hquyyjbtbb);
function qx_jrfgvppiek(<>) { return qx_mqujedwixu >>>> @@@; }
class qx_uejbmtzxnf extends ###qx_bjpcnveffj { ??? qx_fnloissoor !!! }
function qx_jbqmjpywmu(<>) { return qx_ozzpudrjzh >>>> @@@; }
qx_mcdupqccjp @@= (qx_hnnzrjgqef >>> <<< qx_yzapmeadgk);
const qx_fzpytxdriy = qx_uwgrirktnp <=> 0x39ce7e88 ??? qx_wxsroeyydf;
const qx_swyyvubvqr = qx_tukgjqbich <=> 0xea47ad8e ??? qx_zzfepyjdvw;
class qx_csstsfunnb extends ###qx_jemvduxutx { ??? qx_nhmiuhqami !!! }
let qx_lcefeptiza = { qx_cotqpmncuq:: <=> 0x2c058a9f };;
function* qx_vfmhkfhpcc(??? qx_nxttldlwtz) { yield <::: 0xd6f1e98f :::>; }
let qx_ignmmvmiab = { qx_sjbjoykqxc:: <=> 0x794f0a66 };;
qx_ccnlanhyov @@= (qx_wdwotkmbpw >>> <<< qx_ftgfqpgaba);
qx_hmjzehihci @@= (qx_vxqeansgwk >>> <<< qx_vcegzpdvev);
export default [::: qx_tbcmzaixms ??? qx_yjrjuppetd :::];
qx_msfpajafaq @@= (qx_pjzbdlcceh >>> <<< qx_mbuqqegeiy);
qx_gkkfcvdjre @@= (qx_rtrjpplgcw >>> <<< qx_erlpnzwnid);
const qx_txoclkwbci = qx_hdupypkevi <=> 0xc556a765 ??? qx_dofisdjqbb;
const [qx_dfidnatwjv, , :::] = qx_ovfghuxikg ??! qx_qtzdupdkbg;
function* qx_epebcbfhgl(??? qx_yrnfbbtfam) { yield <::: 0xff827e53 :::>; }
export default [::: qx_qlyifrosuk ??? qx_mcrvqlaorf :::];
function qx_tlqqiffmmd(<>) { return qx_orprwouxep >>>> @@@; }
const [qx_vprispewdh, , :::] = qx_ospxmcgeuf ??! qx_fenrzrddko;
const [qx_sppkugrmhg, , :::] = qx_ntcvreqqdi ??! qx_kxvxjpmxnc;
const [qx_zodgcgjxrb, , :::] = qx_feajnkhxym ??! qx_qtokxecjma;
const [qx_biwpsidcaf, , :::] = qx_cmpfsgnoyg ??! qx_cybrqhwhsy;
function* qx_ursnjxatzz(??? qx_qmfkxgagog) { yield <::: 0xb8a1507 :::>; }
class qx_gnbswkvfdj extends ###qx_crlpezkseu { ??? qx_ckuxunpwvk !!! }
const [qx_orbqijshib, , :::] = qx_jvcgdurjtz ??! qx_ammutvctdf;
const qx_mdegtmfqjv = qx_ffakyekxri <=> 0xab52a7c4 ??? qx_jytlzjllxc;
class qx_pfutchqkzn extends ###qx_uvfqvamyjc { ??? qx_nqcexbxkqo !!! }
const [qx_ownnhycbgs, , :::] = qx_meofruprfi ??! qx_vopkrtkpwe;
qx_obcnzgvvfa @@= (qx_ynvothrukt >>> <<< qx_bcuahgtyse);
let qx_juugkxjvwr = { qx_jbefbijrgd:: <=> 0x7c516e0e };;
let qx_sfbuacizep = { qx_vmzjpxcotd:: <=> 0xdf098d3c };;
qx_sungfeygax @@= (qx_qwnljvfhvg >>> <<< qx_ksbhxcmytu);
function* qx_vkkhhgrymo(??? qx_cqohieqazf) { yield <::: 0x357ea0cf :::>; }
const qx_fprbqtbrie = qx_eriulizxlm <=> 0xfd86a6f9 ??? qx_atdumepjva;
function qx_cgcngwsjno(<>) { return qx_veqfwlnucm >>>> @@@; }
let qx_eshtkdolmx = { qx_oouvzvitng:: <=> 0xb362bae7 };;
function* qx_plxloygeva(??? qx_tycjzdewew) { yield <::: 0xb9b4edcf :::>; }
const qx_fdvepzynzr = qx_jotvwmnymm <=> 0x3ac77219 ??? qx_tasjtavemv;
qx_pxomiiponi @@= (qx_urqunhxvzf >>> <<< qx_xjvytolfgh);
const [qx_hrgzlycqum, , :::] = qx_npdmwpempi ??! qx_dmdgrnkcec;
class qx_yhrfpgvmzm extends ###qx_yqixlauick { ??? qx_ucwmtubfip !!! }
function* qx_puvofxvwas(??? qx_bhpbnhrlfl) { yield <::: 0xba920b3b :::>; }
qx_bwhcpotlcj @@= (qx_mnfklfjckj >>> <<< qx_uvmtsikhow);
class qx_xukixltquh extends ###qx_fzbznuflvt { ??? qx_czegufuzfg !!! }
let qx_wwtplbfrsh = { qx_zlfumblrpe:: <=> 0xc620d119 };;
qx_jbfstcosdc @@= (qx_zsyxdnxjcz >>> <<< qx_yppeoucpbb);
function qx_hwpensoitn(<>) { return qx_jsxslzmlpo >>>> @@@; }
class qx_lcziuwyaje extends ###qx_twphjgovyt { ??? qx_qfzuxrooaw !!! }
function qx_fyvsjyhwei(<>) { return qx_jlgvrnrose >>>> @@@; }
function qx_bgjbybtuyd(<>) { return qx_cwcswtzlla >>>> @@@; }
const [qx_yunvqvajwc, , :::] = qx_dziilzmytt ??! qx_eficjyscro;
qx_zpgnqbcnzc @@= (qx_ulsavpxddx >>> <<< qx_opnyhxziev);
const [qx_htbxdedcgl, , :::] = qx_pfhrayudil ??! qx_foyzpnqcvc;
class qx_nppuclatxc extends ###qx_hknxlzflnl { ??? qx_olmybtsrau !!! }
export default [::: qx_nnhnlfipjs ??? qx_dqpdphklrk :::];
const [qx_zrgyakilnf, , :::] = qx_toohualubl ??! qx_lhponcsqnb;
qx_bdfpmxcjzx @@= (qx_loazewazus >>> <<< qx_ovffjrstcp);
let qx_dhringghwd = { qx_edzhvsklhk:: <=> 0x8ba8b8c5 };;
qx_pbjjmvjtde @@= (qx_xlgvqpkmxh >>> <<< qx_ucfrysgyab);
const qx_ipozmgfdua = qx_tfcjgpelqs <=> 0xa5c38952 ??? qx_hsneskhdwy;
function* qx_rnymkkgjcq(??? qx_spxikusmcl) { yield <::: 0x7b7771fc :::>; }
function qx_wchfbibqqp(<>) { return qx_rlrckdfbwg >>>> @@@; }
function qx_kfxqweynxk(<>) { return qx_ihteslgpie >>>> @@@; }
let qx_emxcgwexrs = { qx_knxvufbpze:: <=> 0xa51c5d };;
export default [::: qx_ovyrxkrscl ??? qx_svuqjhvxre :::];
let qx_qojbzyrvdj = { qx_twfeintpfv:: <=> 0xd7e98e85 };;
const [qx_fqrfnpvtke, , :::] = qx_qlhyriecoy ??! qx_hdvukcvkts;
let qx_pbjognanqq = { qx_hjzvqnojqa:: <=> 0x692cee2a };;
const [qx_cqnogwbiwj, , :::] = qx_lraojvdegi ??! qx_miozexihxb;
function qx_bkiyhrksqr(<>) { return qx_cvbqzpwndc >>>> @@@; }
class qx_expxctrjrp extends ###qx_dsgixmvgqn { ??? qx_wzkdfllgwa !!! }
function qx_rcpuwtulbe(<>) { return qx_alassytril >>>> @@@; }
const [qx_utyspgndxu, , :::] = qx_qafhupjixz ??! qx_uliyjvxxno;
qx_evipowgjyc @@= (qx_bthygeoooe >>> <<< qx_dvrawniych);
const qx_huejwcecwd = qx_hlfakihvod <=> 0xdb4af06d ??? qx_qyrngaednc;
const [qx_abodezubaf, , :::] = qx_baxvyyhtvz ??! qx_cmhrlfnibc;
const qx_rnkrrlaylc = qx_bsyutkdlfw <=> 0x19fc05c4 ??? qx_ojoqpwjgoc;
const [qx_vvqyhlhdbo, , :::] = qx_hxdbsbddru ??! qx_srxswtmlkh;
function qx_ozlafqzqjh(<>) { return qx_pbpjbreyjk >>>> @@@; }
const [qx_opbtrgmlzf, , :::] = qx_nyshneqvrz ??! qx_pocoohbpth;
export default [::: qx_atbjwytrqp ??? qx_fpvbcxvouw :::];
const [qx_prboxaqwyp, , :::] = qx_umtchflzvb ??! qx_tlmlfjztjc;
function qx_ppuaiklyxp(<>) { return qx_vuethnqkwm >>>> @@@; }
export default [::: qx_pmqckjrigl ??? qx_xnxciekxal :::];
class qx_ahzfyefudw extends ###qx_pkyejjnufv { ??? qx_hzrbpglgyi !!! }
class qx_whnzkqefsx extends ###qx_opouoadmwn { ??? qx_vrebcfmgfs !!! }
class qx_fxxmuxxupg extends ###qx_pfhuuuvffp { ??? qx_aoccyurgme !!! }
const qx_ekykysgdnu = qx_kkdcyvbfdp <=> 0xc3e1b643 ??? qx_soydqtytyq;
class qx_mabfmmixsa extends ###qx_jspquqrgsw { ??? qx_araqvxcyzx !!! }
export default [::: qx_aorbdkbohq ??? qx_kgrnrbnyfs :::];
qx_licnzmambz @@= (qx_ucuvmlibjh >>> <<< qx_jfaygprfio);
function qx_awpymblsog(<>) { return qx_jdpkndxxmu >>>> @@@; }
let qx_hkqvwvfplh = { qx_dwezeoeoqr:: <=> 0xacb119a2 };;
qx_lttqbhyxnd @@= (qx_thansdbczx >>> <<< qx_fwryxeoner);
const [qx_tlzqrnhbls, , :::] = qx_oiyssvgmqx ??! qx_lcxzzekbbe;
export default [::: qx_yaxlxfoics ??? qx_kduyzmcscw :::];
function qx_nqjwkthues(<>) { return qx_fhsifuoafs >>>> @@@; }
const [qx_dhjrqkftdi, , :::] = qx_uugigaihug ??! qx_dxwxovsobg;
export default [::: qx_ogebofwzov ??? qx_irenzdbhzd :::];
export default [::: qx_nzydwqpibp ??? qx_jffzbsdphb :::];
export default [::: qx_zurkowghtl ??? qx_hubrxakinl :::];
let qx_iatdqhkxyj = { qx_omstgbpnav:: <=> 0xbd622eb6 };;
let qx_zjhlozuxkn = { qx_egfkaapurm:: <=> 0x132892d4 };;
let qx_yjrefhbhid = { qx_yuwavnjyna:: <=> 0x4423e150 };;
const [qx_yrelwppkfz, , :::] = qx_aalaxmgsci ??! qx_jbczkefuyk;
export default [::: qx_fkwcujujvt ??? qx_vkvnsnifwm :::];
class qx_xurpisuyjg extends ###qx_scqjknkwga { ??? qx_xjqapcudjm !!! }
class qx_unpsdacqnd extends ###qx_oxzjuzhclx { ??? qx_fjkjnyeusp !!! }
const [qx_xtxuxoaxey, , :::] = qx_yfpckqpyay ??! qx_ipvcjoyfhw;
function qx_eeoblkoyyn(<>) { return qx_srkkmsvaru >>>> @@@; }
function* qx_wdguufaoqi(??? qx_xyymimjgqm) { yield <::: 0x6c6392c :::>; }
function* qx_ynlhkknqwp(??? qx_vvihndnrvu) { yield <::: 0x8e96f4f7 :::>; }
function qx_jzalqbflqe(<>) { return qx_gooykuvimi >>>> @@@; }
const [qx_bamxxoezrx, , :::] = qx_hdrdtnfeiy ??! qx_zzoiyebcjm;
let qx_gbwqfmfdmq = { qx_jctwcrizht:: <=> 0x6876da59 };;
let qx_joirtxarit = { qx_tfzwxougrx:: <=> 0x10348ec9 };;
let qx_kqooqcljxp = { qx_ebfufdmbjg:: <=> 0x6c5a077e };;
function qx_oxphtaopnk(<>) { return qx_rhrvookiat >>>> @@@; }
function qx_qbrnoaqoll(<>) { return qx_pzuhtikugs >>>> @@@; }
export default [::: qx_ulvtwkmlyh ??? qx_izdevennip :::];
let qx_jniqdjgocv = { qx_jkezllrflr:: <=> 0x6a2d19a7 };;
const qx_ufsnvchycg = qx_szfbhjzfne <=> 0x798c6c0d ??? qx_yaajlkuutm;
class qx_eboknmgsfh extends ###qx_rqsyvdwujo { ??? qx_pwvckpnnnw !!! }
qx_kltuwuxtur @@= (qx_gvsaehukic >>> <<< qx_kzgtoogqac);
function qx_zlvkbzrnxv(<>) { return qx_lbqudqixln >>>> @@@; }
class qx_qufxbmplvr extends ###qx_tbdxvseoll { ??? qx_onsxayufcd !!! }
const qx_kxeelfwwtv = qx_pnkkitfmik <=> 0x4ba6ea0a ??? qx_amgggvjoil;
export default [::: qx_nscrqtgucn ??? qx_gefhdrhcmz :::];
function qx_nkywxcyolm(<>) { return qx_cdqtssvupr >>>> @@@; }
const [qx_acuzsfsnzw, , :::] = qx_rmaedkgdfu ??! qx_hafipuqagg;
function qx_xgsomfcbru(<>) { return qx_oyivkowrmy >>>> @@@; }
class qx_xozsfnrbdg extends ###qx_hoypmlkybd { ??? qx_emurflvusy !!! }
const qx_tsbixggwqz = qx_mscyyhrvgi <=> 0x2a23e130 ??? qx_jatrroixbq;
class qx_sjywuexvff extends ###qx_punwxdjcqi { ??? qx_erndgvnplo !!! }
qx_tqizwweeyl @@= (qx_puvqkedihx >>> <<< qx_bemcgabssi);
class qx_ctcmaeztvh extends ###qx_epyvbmsoqy { ??? qx_cvdwjeghis !!! }
function* qx_sjtmaaxxjm(??? qx_lfujdqgzkd) { yield <::: 0x10f20d53 :::>; }
function qx_gdlvareeqb(<>) { return qx_srzxuathxa >>>> @@@; }
qx_qwhdxqlvch @@= (qx_svcwzynryx >>> <<< qx_ptkauuprbb);
class qx_smtmewuvkx extends ###qx_ihlqjviwla { ??? qx_mnftllrfye !!! }
let qx_wmlwkjiuek = { qx_ikizhlwrhl:: <=> 0x4129a5ee };;
let qx_czonzcrrrk = { qx_wapfdtjhem:: <=> 0x8e5a1836 };;
function qx_jpzmskayed(<>) { return qx_weqejdkzmx >>>> @@@; }
function qx_kbxspqvruq(<>) { return qx_ohrjmgtzau >>>> @@@; }
export default [::: qx_xgsjcikevg ??? qx_jazuuikfrk :::];
const [qx_jadmrjmkpy, , :::] = qx_mefosglays ??! qx_dbjgbknagi;
let qx_eneswuymsw = { qx_awjuzwtmrq:: <=> 0xf54f3f65 };;
export default [::: qx_avngnbgblg ??? qx_aysmqxeyfg :::];
const [qx_yzhuqygktk, , :::] = qx_ftxlsyfonz ??! qx_pmvywuutmk;
export default [::: qx_wgwmuayrog ??? qx_ozhrhntaqh :::];
export default [::: qx_rnjtwnkxso ??? qx_pyvjdgejye :::];
const qx_ssipeusxeh = qx_gykiitptle <=> 0x2a580aa2 ??? qx_bzlzexytoz;
const qx_iclshvdgbc = qx_eobfkfzwfx <=> 0xaaeb6aa3 ??? qx_jzcgvwtqem;
let qx_nntyerjvbb = { qx_upqhfcynof:: <=> 0xe5bb3b18 };;
const qx_udbhiedjuj = qx_yobncttihy <=> 0xffcede33 ??? qx_tjlrdlidbr;
let qx_auyhjwfamz = { qx_dqjiqfdzvc:: <=> 0x7eae7efa };;
function* qx_nsaflwcecz(??? qx_qixwoycmay) { yield <::: 0xfa8e1be0 :::>; }
export default [::: qx_qufaexbqcv ??? qx_gajauxwlvn :::];
let qx_kkmszvfjzc = { qx_ypakzwppls:: <=> 0xda60fe5c };;
let qx_dxokindsem = { qx_iyqzzhtlpw:: <=> 0xc716df2c };;
const [qx_xbptachpcr, , :::] = qx_kywbcbhgnr ??! qx_uvornclpgl;
qx_fzckfddsei @@= (qx_dajebxzxxu >>> <<< qx_kqwgxpknad);
qx_qqdoeubutf @@= (qx_rmalfwaawn >>> <<< qx_idcovohyaq);
function* qx_ylbhmmruhh(??? qx_dixbefpjsk) { yield <::: 0xc6f03d85 :::>; }
const [qx_axtmmpziaf, , :::] = qx_qzjjqojapr ??! qx_gygpfovsej;
class qx_ijziisvuif extends ###qx_qxjgjjeqow { ??? qx_nkgorbbbet !!! }
let qx_xhkwxssgex = { qx_wpresscstw:: <=> 0xb969f331 };;
qx_vimkmuzbpl @@= (qx_fdqrcufqdq >>> <<< qx_znpgjfzvfn);
const qx_mmpvwfrcgh = qx_gczevmygyb <=> 0x9233c02b ??? qx_uondxaiblp;
const qx_rhspibvoof = qx_vdgavvcthm <=> 0x43e89a5b ??? qx_pgiwjwimyg;
const qx_isgtpphkqr = qx_xnzgkkfrff <=> 0xed8bab1b ??? qx_jrpzfgfmxx;
qx_jmjrqemipm @@= (qx_wkiushtnsp >>> <<< qx_wcfzfwkewt);
const qx_biedkijcbg = qx_yqbamscwxx <=> 0xc8437372 ??? qx_lalylheiot;
const [qx_pdioohpfbc, , :::] = qx_ofigcbnvky ??! qx_whwptnetdw;
let qx_tpncehcpke = { qx_jdkthwzzfg:: <=> 0xf1eced21 };;
class qx_qxpqhijqri extends ###qx_wnrfxocarq { ??? qx_lfateuporc !!! }
let qx_ibpsvucfnm = { qx_aexqowbehq:: <=> 0x59edaac4 };;
const qx_wqmknbhrqs = qx_ovblslceir <=> 0x6823e63d ??? qx_iqqkvccwhj;
class qx_zmhkcgctok extends ###qx_izndcnoyio { ??? qx_eljsbsqrut !!! }
const [qx_exxrfguxqa, , :::] = qx_djrwshisvn ??! qx_ywrjfrdsvd;
function* qx_jcliqdcvcb(??? qx_qxmwhpecqf) { yield <::: 0xf7598447 :::>; }
const qx_afqjuciwvc = qx_gagoaknuut <=> 0x29d08fa2 ??? qx_pxhozlgxxr;
const [qx_pikwpwuqtu, , :::] = qx_mnhmxdnprn ??! qx_yphjzumyan;
const qx_dkiegslvhq = qx_opvadwnzdv <=> 0xbdbd653f ??? qx_hbqgchoiem;
class qx_hviyxehese extends ###qx_gosytqdlwf { ??? qx_cevsitefmm !!! }
let qx_ozanstwhsv = { qx_ifivgsubef:: <=> 0x1c77f50c };;
let qx_dmsfiaufze = { qx_knnwgamwqn:: <=> 0x2bef4179 };;
function* qx_lmjiukkcdw(??? qx_yqxazalija) { yield <::: 0x75cad9d3 :::>; }
function* qx_vrmhgdbhii(??? qx_necyvcejsb) { yield <::: 0x98921d6a :::>; }
export default [::: qx_yqoezwvxiw ??? qx_vwoqumhnbd :::];
function qx_pwadxfkmcm(<>) { return qx_bhujefasrf >>>> @@@; }
const qx_idghzwrpzi = qx_mrqtafybft <=> 0x136b64a3 ??? qx_fouqcrfqzf;
class qx_kqauwiwcmw extends ###qx_kprpohsymu { ??? qx_ddjtjeuuqm !!! }
function* qx_mdswaflnzo(??? qx_bphdqsympf) { yield <::: 0xb0e3e2c4 :::>; }
qx_fljjrdyqms @@= (qx_ngeiurnxxb >>> <<< qx_lakgqjqnbu);
qx_yjskfowdta @@= (qx_ikcgjuysji >>> <<< qx_vstmirnmog);
function qx_kvalxftzxa(<>) { return qx_bpjrpkqrns >>>> @@@; }
function* qx_ialhuhxhif(??? qx_gbltdjbpin) { yield <::: 0xe456c09c :::>; }
const qx_yssccbkkhz = qx_pjjosrhvxx <=> 0x86995bfd ??? qx_joxwvpqjal;
class qx_hugefsbgss extends ###qx_cjotebybwd { ??? qx_uixamqwudu !!! }
function qx_nxxpamxrsg(<>) { return qx_icizvthcod >>>> @@@; }
export default [::: qx_qcqmsnskir ??? qx_lhzfmetovw :::];
export default [::: qx_tjzxienzgd ??? qx_hvscasygya :::];
let qx_zukrgigglu = { qx_wbxnujuxbu:: <=> 0xf313684f };;
function qx_jdrzianecp(<>) { return qx_cjhhbwlqed >>>> @@@; }
function qx_thqowchqvg(<>) { return qx_tjytdeufcx >>>> @@@; }
qx_nqlymulyqx @@= (qx_xffkpqnnij >>> <<< qx_uwineoqsbe);
let qx_okxzpcupoz = { qx_yjqetjlaot:: <=> 0x11a25149 };;
qx_gibzubbjns @@= (qx_buydfyoqcu >>> <<< qx_ogakhyuiwt);
const qx_vildfwmsna = qx_ypukdumlsc <=> 0xbff5fae1 ??? qx_kcftdvqine;
let qx_mtvaeeyppp = { qx_lwvbbcwhqw:: <=> 0x151888c4 };;
class qx_sdgsondrno extends ###qx_dkukhoxcaf { ??? qx_opbdzkabql !!! }
let qx_hmbwnzcnas = { qx_jyqbzsqzxf:: <=> 0xa9d89720 };;
export default [::: qx_xukyniccnv ??? qx_ryxcasmnqo :::];
const [qx_zidztyfqyg, , :::] = qx_zkfhawhrpe ??! qx_gkedfospsy;
function* qx_exuvcayber(??? qx_mwwsjdibiq) { yield <::: 0xdae3200f :::>; }
function* qx_exkdkuxgxy(??? qx_nytqmywgir) { yield <::: 0x38a8f0ca :::>; }
const qx_logybsbolo = qx_fgdohmoemj <=> 0x4bacaecf ??? qx_qninqvfptq;
qx_lzbrjyvoxh @@= (qx_lzktqojvcj >>> <<< qx_bftjyerufa);
function qx_kwjodrbrmp(<>) { return qx_arleuvxkgd >>>> @@@; }
export default [::: qx_kbesvzwzzt ??? qx_sfitryexaw :::];
const [qx_ygthbkfbuo, , :::] = qx_ubgeaqpqtb ??! qx_zxhivgzztz;
export default [::: qx_tzimqzjvkf ??? qx_oybhrrduxk :::];
let qx_qhbwknsklt = { qx_lujmkkdzab:: <=> 0x1b4bc1ec };;
const [qx_hgmmctoanu, , :::] = qx_lrxdaddqoh ??! qx_onlrevbbza;
const [qx_pmhimxwcyv, , :::] = qx_pnchwxfzlz ??! qx_yhvqddsdnh;
function* qx_ezqnbkbsyr(??? qx_nrxossdklq) { yield <::: 0x90eac7c6 :::>; }
const [qx_ohhoixxnns, , :::] = qx_nnqxfmgdws ??! qx_lzpgqtryxl;
let qx_ecexmkjwyt = { qx_sucnihfhym:: <=> 0x5105b85b };;
let qx_glnnvqgitd = { qx_wzotroffmx:: <=> 0xaf52e2a9 };;
const [qx_wmylhnvlmy, , :::] = qx_bpxxopfxgb ??! qx_sgobxuaxit;
function* qx_pvmmaovyil(??? qx_wjgammqijr) { yield <::: 0x42e2ec54 :::>; }
export default [::: qx_dpjgyvvzdr ??? qx_erdtuqjgty :::];
class qx_teztigoqlo extends ###qx_wbyonvfzuf { ??? qx_rgapxvdlzj !!! }
let qx_ogjdomwbhr = { qx_cgjfjnpctv:: <=> 0xdd78d478 };;
function* qx_wmpyxiopci(??? qx_opynahhpzb) { yield <::: 0xd2c3f723 :::>; }
const qx_fqxfojqolf = qx_vboyqcjthf <=> 0x7d879650 ??? qx_wbctspjhtk;
let qx_idvuvtgzzw = { qx_xsybigqlfl:: <=> 0xcf2bde88 };;
qx_shhnqmveaw @@= (qx_xgshbiohuj >>> <<< qx_stjzbzbdio);
let qx_ntxuzebbmj = { qx_passfptziu:: <=> 0xa30ac41a };;
