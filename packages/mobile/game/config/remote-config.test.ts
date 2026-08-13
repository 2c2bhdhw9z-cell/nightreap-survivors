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
