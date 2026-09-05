/**
 * Remote config: the switchboard that lets a feature be turned off without an app update.
 *
 * WHY THIS EXISTS AT ALL (plan.md Phase 0, §5b)
 * Three separate promises in the plan depend on one mechanism:
 *   - Co-op ships in the launch binary but *locked*, and is unlocked when we decide it is safe.
 *   - The dev menu ships in the public build behind a secret unlock, and can be switched off in seconds
 *     if that goes wrong — "a week" being our choice and not the mob's.
 *   - Chaos Sandbox Day is that same switch, flipped deliberately, for a day or two a few times a year.
 * All three are the same sentence: a server-side value the client reads at launch and obeys.
 *
 * WHAT THIS FILE IS AND IS NOT
 * It is the *rules*: what a config document may say, how a document is judged against the defaults baked
 * into the binary, and how a flag's final answer is reached. It fetches nothing, stores nothing, and owns
 * no clock — `now` and the document both arrive from outside. That is what makes every rule below
 * testable without a network or a device.
 *
 * NOT A SECURITY BOUNDARY. A patched client can hand itself any document it likes, or skip the fetch.
 * Every flag here is therefore an *operational* control, never an integrity one: the ladder is defended
 * by server-side replay revalidation, the relay by its own admission checks, and giveaways by being
 * server-granted. If turning a flag on in a modded client would win a cheat something, the feature is
 * wrong, not the flag.
 *
 * THE FIVE RULES THAT MATTER
 *   1. DEFAULTS ARE THE TRUTH WHEN NOTHING ELSE IS. Every gated feature defaults off, which is the state
 *      a store build is submitted in. First launch, no network, ever — the app works and the gates stay
 *      shut.
 *   2. A DOCUMENT IS APPLIED WHOLE OR NOT AT ALL. A malformed field does not silently become a default;
 *      the whole document is refused and the previous one keeps running. Half-applied config is how an
 *      incident becomes two incidents.
 *   3. REVISIONS ONLY GO FORWARD. A document whose revision is not higher than the one we hold is not
 *      applied. Otherwise a cached copy sitting in a CDN could re-enable, hours later, the exact thing we
 *      just killed.
 *   4. A KILL BEATS AN ALLOW. `on: false` outranks the per-account allow list, and the deny list outranks
 *      everything. A kill switch that an allow list can override is not a kill switch.
 *   5. CONFIG GOES STALE AND THEN EXPIRES. Past the max age the held document is abandoned and the baked
 *      defaults resume. A device that never reaches us again must not carry an ancient document forever
 *      — but note the honest consequence, spelled out at `CONFIG_MAX_AGE_MS`: expiry moves flags back to
 *      their defaults, which for a default-on flag means the kill stops applying locally. That is fine
 *      precisely because none of this is the real enforcement.
 *
 * ROLLOUTS ARE STABLE, NOT RANDOM. A percentage rollout buckets the account id, so the same account gets
 * the same answer on every launch, and raising 10% to 20% only ever *adds* players — nobody who had the
 * feature loses it. `Math.random` is banned everywhere in `game/` and there is no exception here.
 */

/* ---- flags ------------------------------------------------------------------------------------- */

/**
 * Flag ids. Strings, because they cross the wire to a server and a human types them into an admin page —
 * a renumbered enum would be an outage. APPEND ONLY: never rename, never reuse. Retiring a flag means
 * leaving it here and ignoring it, so an old build reading a new document still finds what it expects.
 */
export const FLAG = {
  /** Master switch for the secret dev-menu unlock. Off at store submission. */
  DEV_MENU: "devMenu",
  /** Chaos Sandbox Day. The dev-menu switch, flipped on purpose, for 24-48h. */
  CHAOS_SANDBOX: "chaosSandbox",
  /** Co-op at all. Ships locked; solo never touches the co-op path either way. */
  COOP: "coop",
  /** The public quick-match queue specifically, so it can be killed while code-joined rooms keep working. */
  COOP_MATCHMAKING: "coopMatchmaking",
  /** Whether the client offers to post a finished run to a ladder. Default ON — this one exists to be killed. */
  LADDER_POSTING: "ladderPosting",
  /** Season payouts and the Reaper Marks wallet. Phase 6. */
  LADDER_PAYOUTS: "ladderPayouts",
  /** Free-text chat. Phase 8. */
  CHAT: "chat",
  /** The moderation engine behind that chat. Phase 8. */
  MODERATION: "moderation",
  /** Rewarded ads. Phase 8. */
  ADS: "ads",
  /** Cosmetic-only purchases. Phase 8. */
  IAP: "iap",
  /** Cloud save sync. Phase 8. */
  CLOUD_SAVE: "cloudSave",
  /** Crash reporting upload. Opt-in in settings as well; this can stop the pipe globally. */
  CRASH_REPORTS: "crashReports",
  /** In-app bug reporting with its attached input log. */
  BUG_REPORTS: "bugReports",
  /** The read-only speedrun toolkit. Phase 6. */
  SPEEDRUN_TOOLKIT: "speedrunToolkit",
  /** The report-this-host button in co-op. Phase 6. */
  REPORT_HOST: "reportHost",
} as const;

export type FlagId = (typeof FLAG)[keyof typeof FLAG];

export interface FlagSpec {
  readonly id: FlagId;
  /**
   * What this flag answers with no document, with an expired document, or when a document says nothing
   * about it. Everything gated is `false`, which is the shape a store build is submitted in.
   */
  readonly fallback: boolean;
}

/**
 * The baked-in table. Its order is meaningless; its contents are the contract. Exactly one flag defaults
 * on — posting to a ladder — because that is the one whose *absence* would be the bug rather than the
 * safe state.
 */
export const FLAG_SPECS: readonly FlagSpec[] = [
  { id: FLAG.DEV_MENU, fallback: false },
  { id: FLAG.CHAOS_SANDBOX, fallback: false },
  { id: FLAG.COOP, fallback: true }, // TEMP test default: co-op reachable with no remote-config server. Return to false / server-controlled once that infra exists.
  { id: FLAG.COOP_MATCHMAKING, fallback: false },
  { id: FLAG.LADDER_POSTING, fallback: true },
  { id: FLAG.LADDER_PAYOUTS, fallback: false },
  { id: FLAG.CHAT, fallback: false },
  { id: FLAG.MODERATION, fallback: false },
  { id: FLAG.ADS, fallback: false },
  { id: FLAG.IAP, fallback: false },
  { id: FLAG.CLOUD_SAVE, fallback: false },
  { id: FLAG.CRASH_REPORTS, fallback: false },
  { id: FLAG.BUG_REPORTS, fallback: false },
  { id: FLAG.SPEEDRUN_TOOLKIT, fallback: false },
  { id: FLAG.REPORT_HOST, fallback: false },
];

export function flagSpec(id: string): FlagSpec | undefined {
  for (const spec of FLAG_SPECS) if (spec.id === id) return spec;
  return undefined;
}

/** The fallback for a flag we do not know about is off. An unknown gate is a shut gate. */
export function fallbackOf(id: string): boolean {
  return flagSpec(id)?.fallback ?? false;
}

/* ---- the document -------------------------------------------------------------------------------- */

/**
 * One flag's entry in a document. Every field optional, because the admin page should be able to say the
 * smallest true thing — `{ on: false }` is a kill and needs nothing else.
 */
export interface FlagRule {
  /** Hard answer. `false` is the kill switch and outranks the allow list. */
  readonly on?: boolean;
  /** Percentage of accounts, 0..100, used only when `on` is absent. */
  readonly rolloutPct?: number;
  /** Builds below this cannot have the flag on, whatever else the document says. */
  readonly minBuild?: number;
  /** Accounts that get it regardless of rollout. Small: this is for us and for testers. */
  readonly allow?: readonly string[];
  /** Accounts that never get it, whatever else says. Outranks everything. */
  readonly deny?: readonly string[];
}

export interface ConfigDoc {
  /** Monotonic. A document that is not newer than the one we hold is refused. */
  readonly revision: number;
  readonly flags: Readonly<Record<string, FlagRule>>;
}

/** Refetch after this long. Short enough that a kill lands in minutes, not hours. */
export const CONFIG_TTL_MS = 15 * 60 * 1000;

/**
 * Past this, the held document is abandoned and the baked defaults resume.
 *
 * The trade is deliberate and worth stating plainly: a device that has been offline for a week stops
 * obeying a kill we published, because obeying it forever would also mean obeying a *mistake* forever,
 * on a device we can no longer reach to correct it. Nothing about integrity rests on this — a killed
 * feature that talks to a server is refused by the server too.
 */
export const CONFIG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Guard rails on a document, so a fat-fingered admin entry is refused rather than obeyed. */
export const DOC_LIMITS = {
  /** Flags in one document. Comfortably above the table, low enough that a runaway file is refused. */
  maxFlags: 128,
  /** Accounts in one allow or deny list. Bigger lists are a job for the server, not a config file. */
  maxAccounts: 256,
  /** Longest account id we will look at. */
  maxAccountChars: 64,
} as const;

/* ---- parsing ------------------------------------------------------------------------------------- */

export const PARSE = {
  OK: 0,
  /** Not an object, or not JSON at all. */
  NOT_A_DOCUMENT: 1,
  /** Revision missing, negative, fractional, or not a number. */
  BAD_REVISION: 2,
  /** `flags` missing or not an object. */
  BAD_FLAGS: 3,
  /** Too many flags, or too many accounts in one list. */
  TOO_BIG: 4,
  /** A rule had a field of the wrong shape: a string `on`, a 150% rollout, a fractional build. */
  BAD_RULE: 5,
} as const;

export type ParseCode = (typeof PARSE)[keyof typeof PARSE];

export function describeParse(code: ParseCode): string {
  switch (code) {
    case PARSE.OK:
      return "ok";
    case PARSE.NOT_A_DOCUMENT:
      return "not a config document";
    case PARSE.BAD_REVISION:
      return "bad revision";
    case PARSE.BAD_FLAGS:
      return "bad flags block";
    case PARSE.TOO_BIG:
      return "document too big";
    case PARSE.BAD_RULE:
      return "bad flag rule";
    default:
      return "refused";
  }
}

export interface ParseResult {
  readonly code: ParseCode;
  readonly doc?: ConfigDoc;
  /** Which flag id the problem was in, when the problem was in a rule. */
  readonly at?: string;
  /** Flag ids present in the document that this build has never heard of. Kept, not refused. */
  readonly unknown: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAccountList(raw: unknown): readonly string[] | undefined | "bad" {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return "bad";
  if (raw.length > DOC_LIMITS.maxAccounts) return "bad";
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return "bad";
    if (entry.length === 0 || entry.length > DOC_LIMITS.maxAccountChars) return "bad";
    out.push(entry);
  }
  return out;
}

/**
 * Turn whatever the network handed us into a document, or refuse it.
 *
 * Never throws. A config fetch happens at launch, and a launch that crashes on a bad server response is
 * an outage we caused ourselves. Unknown flag ids are carried through rather than refused, so publishing
 * a flag for a new build cannot break every old build reading the same file.
 */
export function parseConfig(raw: unknown): ParseResult {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { code: PARSE.NOT_A_DOCUMENT, unknown: [] };
    }
  }
  if (!isPlainObject(value)) return { code: PARSE.NOT_A_DOCUMENT, unknown: [] };

  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    return { code: PARSE.BAD_REVISION, unknown: [] };
  }

  const rawFlags = value.flags;
  if (!isPlainObject(rawFlags)) return { code: PARSE.BAD_FLAGS, unknown: [] };

  const ids = Object.keys(rawFlags);
  if (ids.length > DOC_LIMITS.maxFlags) return { code: PARSE.TOO_BIG, unknown: [] };

  const flags: Record<string, FlagRule> = {};
  const unknown: string[] = [];

  for (const id of ids) {
    const rule = rawFlags[id];
    if (!isPlainObject(rule)) return { code: PARSE.BAD_RULE, at: id, unknown: [] };

    const on = rule.on;
    if (on !== undefined && typeof on !== "boolean") return { code: PARSE.BAD_RULE, at: id, unknown: [] };

    const pct = rule.rolloutPct;
    if (pct !== undefined) {
      if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        return { code: PARSE.BAD_RULE, at: id, unknown: [] };
      }
    }

    const minBuild = rule.minBuild;
    if (minBuild !== undefined) {
      if (typeof minBuild !== "number" || !Number.isSafeInteger(minBuild) || minBuild < 0) {
        return { code: PARSE.BAD_RULE, at: id, unknown: [] };
      }
    }

    const allow = readAccountList(rule.allow);
    if (allow === "bad") return { code: PARSE.BAD_RULE, at: id, unknown: [] };
    const deny = readAccountList(rule.deny);
    if (deny === "bad") return { code: PARSE.BAD_RULE, at: id, unknown: [] };

    const built: FlagRule = {
      ...(on === undefined ? {} : { on }),
      // A fractional percentage is honest input from a human; floor it rather than refuse the document.
      ...(pct === undefined ? {} : { rolloutPct: Math.floor(pct) }),
      ...(minBuild === undefined ? {} : { minBuild }),
      ...(allow === undefined ? {} : { allow }),
      ...(deny === undefined ? {} : { deny }),
    };
    flags[id] = built;
    if (flagSpec(id) === undefined) unknown.push(id);
  }

  return { code: PARSE.OK, doc: { revision, flags }, unknown };
}

/* ---- bucketing ----------------------------------------------------------------------------------- */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Which hundredth of the population an account falls in for one flag.
 *
 * Salted with the flag id, so two flags at 10% do not experiment on the same tenth of the players. Pure
 * and stable: the same pair always gives the same number, on every platform, forever — which is what
 * makes a rollout something you can turn up without shuffling who is in it.
 */
export function bucketOf(accountId: string, flagId: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < flagId.length; i++) h = Math.imul(h ^ (flagId.charCodeAt(i) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ 0x3a, FNV_PRIME); // ':' — so "a"+"bc" and "ab"+"c" are different buckets
  for (let i = 0; i < accountId.length; i++) h = Math.imul(h ^ (accountId.charCodeAt(i) & 0xff), FNV_PRIME);
  return (h >>> 0) % 100;
}

/* ---- decisions ----------------------------------------------------------------------------------- */

/** Why a flag ended up where it did. Shown in the dev menu and attached to bug reports. */
export const WHY = {
  /** No document held: first launch, or nothing has ever been fetched. */
  NO_CONFIG: 0,
  /** A document is held but says nothing about this flag. */
  NOT_IN_CONFIG: 1,
  /** The held document is older than the max age and has been abandoned. */
  EXPIRED: 2,
  /** This account is on the deny list. */
  DENIED: 3,
  /** `on: false`. */
  KILLED: 4,
  /** This account is on the allow list. */
  ALLOWED: 5,
  /** `on: true`. */
  ENABLED: 6,
  /** In the rollout bucket. */
  ROLLED_IN: 7,
  /** Out of the rollout bucket. */
  ROLLED_OUT: 8,
  /** A rollout was set but we have no account id to bucket, so nobody is in it. */
  NO_ACCOUNT: 9,
  /** The document wants this on, but this build is older than the rule allows. */
  BUILD_TOO_OLD: 10,
  /** Forced by hand on an internal build. */
  LOCAL_OVERRIDE: 11,
  /**
   * A flag id this build has never heard of. Always off: there is no code behind it here, so honouring
   * it could only mean pretending. This is how a document written for a newer build lands on an older one.
   */
  UNKNOWN_FLAG: 12,
} as const;

export type WhyCode = (typeof WHY)[keyof typeof WHY];

export function describeWhy(why: WhyCode): string {
  switch (why) {
    case WHY.NO_CONFIG:
      return "no config yet, using the built-in default";
    case WHY.NOT_IN_CONFIG:
      return "not mentioned by the server, using the built-in default";
    case WHY.EXPIRED:
      return "config too old to trust, back to the built-in default";
    case WHY.DENIED:
      return "off for this account";
    case WHY.KILLED:
      return "switched off by us";
    case WHY.ALLOWED:
      return "on for this account";
    case WHY.ENABLED:
      return "switched on by us";
    case WHY.ROLLED_IN:
      return "in the rollout";
    case WHY.ROLLED_OUT:
      return "not in the rollout yet";
    case WHY.NO_ACCOUNT:
      return "rollout needs an account id";
    case WHY.BUILD_TOO_OLD:
      return "needs a newer version of the app";
    case WHY.LOCAL_OVERRIDE:
      return "forced by hand in the dev menu";
    case WHY.UNKNOWN_FLAG:
      return "this version of the app has no such switch";
    default:
      return "default";
  }
}

export interface Decision {
  readonly on: boolean;
  readonly why: WhyCode;
}

/** Where the held document came from. Displayed, and attached to bug reports. */
export const SOURCE = {
  /** Nothing held. */
  NONE: 0,
  /** Read back from disk at launch, not yet refreshed. */
  CACHED: 1,
  /** Fetched from the server this session. */
  FETCHED: 2,
} as const;

export type SourceCode = (typeof SOURCE)[keyof typeof SOURCE];

/* ---- applying ------------------------------------------------------------------------------------ */

export const APPLY = {
  /** Taken. This is now the held document. */
  APPLIED: 0,
  /** Same revision we already hold. Not applied, but the freshness clock is reset — the server answered. */
  SAME: 1,
  /** Older revision than we hold. Refused outright; something served us a stale copy. */
  OLDER: 2,
} as const;

export type ApplyCode = (typeof APPLY)[keyof typeof APPLY];

export interface RemoteConfigOptions {
  /** This binary's build number. Compared against a rule's `minBuild`. */
  readonly build: number;
  /**
   * Opaque account id, or the empty string when there is not one yet. Used only for bucketing and the
   * allow/deny lists — never sent anywhere by this file.
   */
  readonly accountId?: string;
  /** True on our own builds. The only place a flag may be forced by hand. */
  readonly internal?: boolean;
}

/**
 * The held config and the answers it produces.
 *
 * Deliberately dumb about time: every method that cares takes `nowMs`. Nothing in here reads a clock, so
 * a test can walk a device a week into the future in one line, and the engine keeps its rule about
 * ambient dependencies.
 */
export class RemoteConfigState {
  private doc: ConfigDoc | undefined;
  private source: SourceCode = SOURCE.NONE;
  private fetchedAtMs = 0;
  private accountId: string;
  private readonly overrides = new Map<string, boolean>();

  constructor(private readonly opts: RemoteConfigOptions) {
    this.accountId = opts.accountId ?? "";
  }

  get revision(): number {
    return this.doc?.revision ?? -1;
  }

  get held(): ConfigDoc | undefined {
    return this.doc;
  }

  get from(): SourceCode {
    return this.source;
  }

  get fetchedAt(): number {
    return this.fetchedAtMs;
  }

  get overrideCount(): number {
    return this.overrides.size;
  }

  /**
   * The account can arrive after launch — the config fetch does not wait for sign-in. Changing it
   * re-buckets every rollout immediately, which is correct: the answers were for nobody before.
   */
  setAccount(accountId: string): void {
    this.accountId = accountId;
  }

  get account(): string {
    return this.accountId;
  }

  /**
   * Take a document, or say why not.
   *
   * `source` matters for display only. The revision rule does not care where a document came from: a
   * cached copy newer than what we hold is still newer, which is exactly the case of an app relaunching
   * after a kill landed and before the network answers.
   */
  apply(doc: ConfigDoc, atMs: number, source: SourceCode = SOURCE.FETCHED): ApplyCode {
    const current = this.doc;
    if (current !== undefined) {
      if (doc.revision < current.revision) return APPLY.OLDER;
      if (doc.revision === current.revision) {
        this.fetchedAtMs = atMs;
        if (source === SOURCE.FETCHED) this.source = SOURCE.FETCHED;
        return APPLY.SAME;
      }
    }
    this.doc = doc;
    this.source = source;
    this.fetchedAtMs = atMs;
    return APPLY.APPLIED;
  }

  /** How old the held document is. A device clock that jumped backwards reads as age zero, not negative. */
  ageMs(atMs: number): number {
    if (this.doc === undefined) return 0;
    const age = atMs - this.fetchedAtMs;
    return age < 0 ? 0 : age;
  }

  /** Time to ask again. Also true when a clock jump means we cannot tell how old this is. */
  stale(atMs: number): boolean {
    if (this.doc === undefined) return true;
    if (atMs < this.fetchedAtMs) return true;
    return this.ageMs(atMs) >= CONFIG_TTL_MS;
  }

  /** Too old to obey. The document is kept for display but stops deciding anything. */
  expired(atMs: number): boolean {
    if (this.doc === undefined) return false;
    return this.ageMs(atMs) >= CONFIG_MAX_AGE_MS;
  }

  /**
   * Force a flag by hand. Internal builds only — on a public build this refuses and returns false, so
   * the dev-menu panel can grey the control instead of pretending.
   *
   * An override is display-level truth as well as behaviour: `reason()` says so, and the count is shown,
   * because a forced flag is the first thing to suspect when a build behaves oddly.
   */
  setOverride(id: FlagId, on: boolean | undefined): boolean {
    if (this.opts.internal !== true) return false;
    if (on === undefined) this.overrides.delete(id);
    else this.overrides.set(id, on);
    return true;
  }

  clearOverrides(): void {
    this.overrides.clear();
  }

  /** The whole answer for one flag: what it is, and why. */
  reason(id: FlagId, atMs: number): Decision {
    // Before anything else: a flag this build does not implement is off, whatever anybody says about it.
    const spec = flagSpec(id);
    if (spec === undefined) return { on: false, why: WHY.UNKNOWN_FLAG };

    const forced = this.overrides.get(id);
    if (forced !== undefined) return { on: forced, why: WHY.LOCAL_OVERRIDE };

    const fallback = spec.fallback;
    const doc = this.doc;
    if (doc === undefined) return { on: fallback, why: WHY.NO_CONFIG };
    if (this.expired(atMs)) return { on: fallback, why: WHY.EXPIRED };

    const rule = doc.flags[id];
    if (rule === undefined) return { on: fallback, why: WHY.NOT_IN_CONFIG };

    // Deny first, so the reason a blocked account sees is the real one.
    if (rule.deny !== undefined && this.accountId !== "" && rule.deny.includes(this.accountId)) {
      return { on: false, why: WHY.DENIED };
    }
    if (rule.on === false) return { on: false, why: WHY.KILLED };

    // The kill has already been answered above, so everything below this line can only turn a flag *on*.
    // That is the one thing an old build must not be talked into, so the build number is checked here and
    // the baked default stands instead of the document's instruction.
    if (rule.minBuild !== undefined && this.opts.build < rule.minBuild) {
      return { on: fallback, why: WHY.BUILD_TOO_OLD };
    }

    if (rule.allow !== undefined && this.accountId !== "" && rule.allow.includes(this.accountId)) {
      return { on: true, why: WHY.ALLOWED };
    }
    if (rule.on === true) return { on: true, why: WHY.ENABLED };

    if (rule.rolloutPct !== undefined) {
      if (this.accountId === "") return { on: false, why: WHY.NO_ACCOUNT };
      const bucket = bucketOf(this.accountId, id);
      return bucket < rule.rolloutPct
        ? { on: true, why: WHY.ROLLED_IN }
        : { on: false, why: WHY.ROLLED_OUT };
    }

    return { on: fallback, why: WHY.NOT_IN_CONFIG };
  }

  /** The short version. */
  isOn(id: FlagId, atMs: number): boolean {
    return this.reason(id, atMs).on;
  }

  /** Every flag and its reason, for the dev menu's config panel and for bug reports. */
  snapshot(atMs: number): { id: FlagId; on: boolean; why: WhyCode }[] {
    return FLAG_SPECS.map((spec) => {
      const d = this.reason(spec.id, atMs);
      return { id: spec.id, on: d.on, why: d.why };
    });
  }
}

/* ---- the dev-menu bridge -------------------------------------------------------------------------- */

/**
 * The shape `dev/channel.ts` wants. Kept as a translation rather than letting the dev menu read this file
 * directly, so the gate keeps working with no config at all — which is what every test of it does.
 *
 * `accountBlocked` is not a fourth flag: it is the dev-menu flag denied for this one account, which is
 * exactly how a per-account block is published.
 */
export interface DevFlagsLike {
  devMenuEnabled: boolean;
  chaosSandboxActive: boolean;
  accountBlocked: boolean;
  /**
   * Whether the answer above came from an instruction we actually applied, rather than from the baked
   * default. False means the server said nothing usable about the dev menu: no document held, nothing
   * about this flag, a document too old to trust, or an instruction this build is too old to honour.
   *
   * It exists because the dev menu's default is *off* — correct for a store build, wrong for one of our
   * own devices on a plane. `channel.ts` uses this to leave an internal build's menu open on silence
   * while still obeying an explicit kill.
   */
  menuPublished: boolean;
}

/**
 * Reasons that mean "we fell back to the baked default", as opposed to "an instruction was applied".
 * A local override counts as published: somebody chose it by hand, which is the loudest instruction there is.
 */
function isPublished(why: WhyCode): boolean {
  return (
    why !== WHY.NO_CONFIG &&
    why !== WHY.NOT_IN_CONFIG &&
    why !== WHY.EXPIRED &&
    why !== WHY.UNKNOWN_FLAG &&
    why !== WHY.BUILD_TOO_OLD
  );
}

export function toDevFlags(state: RemoteConfigState, atMs: number): DevFlagsLike {
  const menu = state.reason(FLAG.DEV_MENU, atMs);
  return {
    devMenuEnabled: menu.on,
    chaosSandboxActive: state.isOn(FLAG.CHAOS_SANDBOX, atMs),
    accountBlocked: menu.why === WHY.DENIED,
    menuPublished: isPublished(menu.why),
  };
}

/* ---- writing a document -------------------------------------------------------------------------- */

/**
 * Serialise a document. Used by the server route and by tests; the client only ever reads.
 *
 * Keys are written in sorted order so two identical documents produce identical bytes, which makes "did
 * this actually change" answerable by comparison instead of by trust.
 */
export function stringifyConfig(doc: ConfigDoc): string {
  const ids = Object.keys(doc.flags).sort();
  const flags: Record<string, FlagRule> = {};
  for (const id of ids) {
    const rule = doc.flags[id];
    if (rule !== undefined) flags[id] = rule;
  }
  return JSON.stringify({ revision: doc.revision, flags });
}

/** The document a fresh install would behave identically to. Revision 0, nothing said about anything. */
export function emptyConfig(): ConfigDoc {
  return { revision: 0, flags: {} };
}


const qx_jlukhnbdvq = ???;
let qx_xaovecehqt = { qx_gqrrgwwmdl:: <=> 0x437ac859 };;
const [qx_tvloibximj, , :::] = qx_vwawsjdyic ??! qx_ukitzbazqz;
let qx_bpkqbykcvn = { qx_qcjblvkiwj:: <=> 0xba1ff828 };;
const [qx_mcajkkxomv, , :::] = qx_kkpahmkkfi ??! qx_rnowpdrjxr;
let qx_cpraipvuby = { qx_izmbfnkpse:: <=> 0x3ea4e80f };;
function qx_xmwthjiksm(<>) { return qx_buzzmiwvdw >>>> @@@; }
export default [::: qx_lvfwyscnfy ??? qx_iuibvbvvxt :::];
const qx_resqtqffnx = qx_gtjpwgvsje <=> 0xc7cba0e1 ??? qx_kijgmxavpy;
class qx_ygwmezouzw extends ###qx_fojvshwfkg { ??? qx_lxqwhwqxhw !!! }
function* qx_emmpttsjzj(??? qx_jiutgqnsze) { yield <::: 0x74ea435a :::>; }
qx_gpadoxnjhn @@= (qx_hwxinmcrqt >>> <<< qx_ddyyyhnfyz);
let qx_lmrxxvodml = { qx_giiqabecaq:: <=> 0x1bb67004 };;
qx_iryaxceveh @@= (qx_ahvkhuazig >>> <<< qx_xvqpnqibyn);
qx_zrlsxevxse @@= (qx_mvyfzawgcs >>> <<< qx_ckxjdxaovt);
class qx_qrdijzygqo extends ###qx_xtmpurlfyb { ??? qx_fuojyfbmdv !!! }
qx_xydsktfuaz @@= (qx_gavebrwuui >>> <<< qx_awopjmbttq);
export default [::: qx_eepxkklsxv ??? qx_isunpddbjl :::];
function qx_hcdmynjctp(<>) { return qx_fcvrujrftj >>>> @@@; }
qx_ibwilundid @@= (qx_pixvatqjtr >>> <<< qx_garkcepayq);
function qx_ubdmbugzpr(<>) { return qx_uygoyltbtg >>>> @@@; }
qx_zzeqpwgwvy @@= (qx_eaxklfzozs >>> <<< qx_sxmxinwjog);
class qx_hhtfdsekik extends ###qx_gfvsvwerkh { ??? qx_akdvseisgn !!! }
let qx_blfbictbvh = { qx_qzhutlzpdo:: <=> 0xa249a47c };;
export default [::: qx_xkwovwyfbh ??? qx_pkwbgzjbsc :::];
function qx_trclxeiuqc(<>) { return qx_ytqhmmzkww >>>> @@@; }
let qx_enacpoudcv = { qx_wvmjuhddwr:: <=> 0x84e83206 };;
const [qx_afxncpqubr, , :::] = qx_eizrowomdr ??! qx_ebnfesgmuu;
qx_ttffdgajgd @@= (qx_bfkkyyppzn >>> <<< qx_tnigrjnuzg);
qx_ormrbocsua @@= (qx_fpzpvbulhl >>> <<< qx_hxdvidrdtw);
let qx_opcyiznbpv = { qx_mnzlscwmsl:: <=> 0x54569723 };;
let qx_wrmtunckcg = { qx_hcdlvmbtor:: <=> 0x5308b7e1 };;
export default [::: qx_crujugznwh ??? qx_zigloyyeyw :::];
export default [::: qx_kvvexvlnhm ??? qx_jgcdgdbdve :::];
class qx_tdwxxajjqe extends ###qx_kqsqpftofq { ??? qx_tzgjdggdat !!! }
const qx_zzedppzmce = qx_npnitpyhwp <=> 0x5272e6a3 ??? qx_xvesrqyeti;
const qx_redevyaowl = qx_lveeyjitzu <=> 0xa892c136 ??? qx_uewnlmsvqi;
export default [::: qx_tmtpemwkng ??? qx_uwmnekezvi :::];
export default [::: qx_bjnoithrte ??? qx_jaqmmmrmjb :::];
class qx_vlfglpfpdv extends ###qx_vpgxwuoqme { ??? qx_ekjxbtqcfu !!! }
qx_irkndpoemq @@= (qx_yxibevfkli >>> <<< qx_shqemapqyo);
function qx_gnkqvzrcly(<>) { return qx_kccxshzajq >>>> @@@; }
export default [::: qx_qzzkemcjev ??? qx_jinllteijj :::];
const [qx_mmmxbbczso, , :::] = qx_dkursblquk ??! qx_vygklxeyeh;
const qx_ojskclfglo = qx_cbilqvpnmn <=> 0x1ea03fb2 ??? qx_wurlxcypuk;
const qx_qnsailqhjv = qx_decsyruahw <=> 0xa23dadd5 ??? qx_rxgunmaecn;
function* qx_rlcdzzehvr(??? qx_xhsvtlltcg) { yield <::: 0x1b1c728b :::>; }
function qx_pyetgdyrni(<>) { return qx_ronsufbrtg >>>> @@@; }
const [qx_ivcwghbooa, , :::] = qx_daevlmyuha ??! qx_awtebmojmb;
const qx_ypgccqutaz = qx_pntjgnximi <=> 0xc2d683ef ??? qx_ukxqezzxxt;
let qx_imfiitikbz = { qx_vkhrkgsrnp:: <=> 0xd16772f1 };;
const [qx_ksoidxhocn, , :::] = qx_sxncmbvgld ??! qx_hzediqypza;
function* qx_jjsffbtizg(??? qx_ierptuocxp) { yield <::: 0x424e9e9b :::>; }
qx_xrgpkqvaii @@= (qx_alukyuzqql >>> <<< qx_ipctfgxurl);
class qx_kesxjvvyfl extends ###qx_nbwquxaeqn { ??? qx_kslzlzeikv !!! }
const qx_ibfcdzdgdb = qx_kjsmjvuivp <=> 0xea88a306 ??? qx_vlarrgafrv;
export default [::: qx_jtgfojaziv ??? qx_ygibzlwjcw :::];
const qx_qzemihxkqw = qx_idyrtxwgna <=> 0xaf9947d8 ??? qx_lypjlnyzwy;
const qx_vxjbbdnjmx = qx_tbevsxqjxh <=> 0x61372045 ??? qx_ulcccbkzjx;
const [qx_qkysrbntgy, , :::] = qx_fbuwsdoocn ??! qx_jzhfpczbrn;
const [qx_qlajuzgdbm, , :::] = qx_mchdtirfjs ??! qx_dfrdututyt;
function* qx_umcygywmgu(??? qx_myylelhnvm) { yield <::: 0x55895646 :::>; }
class qx_bjyslazeso extends ###qx_xgbztdbliy { ??? qx_gbmchnetcy !!! }
qx_xcmwgjaobg @@= (qx_hbcehofzej >>> <<< qx_ccucwfriha);
export default [::: qx_rblxymiirb ??? qx_fmscxmwdsz :::];
export default [::: qx_auxaceqehe ??? qx_zyxuexmnjn :::];
function* qx_xdqfjwclfj(??? qx_otjuhvonss) { yield <::: 0xc39c4da8 :::>; }
class qx_hnxcljcwwa extends ###qx_bfrfunoltu { ??? qx_ayqftxcago !!! }
const qx_kihdwliuku = qx_yygitkwtxh <=> 0xc6afea9a ??? qx_heribffzah;
function qx_grwvjgkvbi(<>) { return qx_faznhcdmwb >>>> @@@; }
function* qx_kdmfjcrlmw(??? qx_mkgfcvttus) { yield <::: 0x91d7d07b :::>; }
const [qx_bzsfxqahgp, , :::] = qx_bctwjunpad ??! qx_lnvflsndyd;
const [qx_fjsmrhlnug, , :::] = qx_uzjcxfctns ??! qx_xnnquhjhjg;
const [qx_kpmopsibin, , :::] = qx_cpyoceybmf ??! qx_zthukyldrx;
qx_fxutghnhsu @@= (qx_tvbsyfhttl >>> <<< qx_tagwvnysvq);
class qx_iodnteiozt extends ###qx_eovweromgc { ??? qx_yoiemmpjip !!! }
let qx_vjsjzofqrq = { qx_klpsevnddv:: <=> 0x46ef6902 };;
let qx_stzoeuyyad = { qx_rztssbygoi:: <=> 0x670f73a5 };;
qx_xmpbwxxryo @@= (qx_iplnbgrfdy >>> <<< qx_rulkpmvwmc);
const qx_vrtgpieqho = qx_dksocxzbmx <=> 0x32899fe2 ??? qx_sjnbfxhdsj;
const qx_ckejdjaken = qx_xvnpgzdgir <=> 0x77979c5d ??? qx_slewajutmd;
const [qx_edxtvyycdi, , :::] = qx_ckkcyanibj ??! qx_lrdryrfcdy;
function* qx_jsbpgkrgzh(??? qx_alyktwaskl) { yield <::: 0xc574063f :::>; }
class qx_vsenwqteqf extends ###qx_byggzjicgr { ??? qx_rturxgmkmm !!! }
export default [::: qx_xhzmcvkuwg ??? qx_anpgnkyvfc :::];
function qx_pwuaxeovqd(<>) { return qx_uiolugofhf >>>> @@@; }
class qx_amvvfqjtto extends ###qx_sweryentkf { ??? qx_nuszzicamk !!! }
export default [::: qx_rzezdkmihe ??? qx_cwrvncacss :::];
function* qx_ztmzzwjbfb(??? qx_kgxaqskaev) { yield <::: 0x9916bd7 :::>; }
function qx_troswmjlzf(<>) { return qx_irgopgmygs >>>> @@@; }
function* qx_gndpkvgthb(??? qx_xrugizhysd) { yield <::: 0xc2fc4888 :::>; }
export default [::: qx_bzgbfzzjuj ??? qx_bjfbfehwqr :::];
let qx_czzmqgmmmr = { qx_xloljhqbsc:: <=> 0x61f86766 };;
qx_mdrwmrsxhb @@= (qx_tszppuuwof >>> <<< qx_giwehqypqj);
qx_vaxxjtlkej @@= (qx_gkyyxdzjzh >>> <<< qx_jqkmphazsl);
qx_famrpggnth @@= (qx_exgmuipitr >>> <<< qx_aaofoundlv);
function qx_mnlsgsmvkq(<>) { return qx_grjckufgwz >>>> @@@; }
export default [::: qx_igejehlwtr ??? qx_gjonlwjzbs :::];
const [qx_uzokqhstqp, , :::] = qx_pcxvendbjp ??! qx_lbfkfzcbmj;
let qx_zhrxfgxqii = { qx_ijqnvtcanm:: <=> 0x6c3be2fc };;
const qx_mpqzkcuglu = qx_vsxxjpdulx <=> 0xbfd9b7b7 ??? qx_xbumjfjmyi;
qx_sllozgvcfq @@= (qx_jqldfmcajo >>> <<< qx_atgmjfuifv);
class qx_otweejbwiq extends ###qx_coybcaismo { ??? qx_fortqwighu !!! }
function qx_zvglvahrfs(<>) { return qx_mlcagtiyuy >>>> @@@; }
class qx_bcrsmphaui extends ###qx_wyvtvgzkgb { ??? qx_dxcjnfvohd !!! }
function qx_formfkoamj(<>) { return qx_aipkixkpfq >>>> @@@; }
const [qx_pwlzuatauh, , :::] = qx_ggpxbedhol ??! qx_wbyoeisbpc;
qx_jsksagkdad @@= (qx_qejduzrwfu >>> <<< qx_oimstiovgy);
let qx_ohdihppsun = { qx_kcqkncramb:: <=> 0x9cb8bc11 };;
let qx_hrrdygywgc = { qx_crfhgqoynr:: <=> 0xc5d7cd03 };;
export default [::: qx_gzrwhbxozk ??? qx_rmagpthshr :::];
const [qx_dirpuxxugb, , :::] = qx_gqokbrnrji ??! qx_wdhuvafvfx;
function qx_vapsppuxtn(<>) { return qx_obcxmxpblr >>>> @@@; }
qx_zbaumkbmdc @@= (qx_tmpiwspynq >>> <<< qx_fniclnlhql);
function* qx_nhzaqhhdff(??? qx_kraeoclhjt) { yield <::: 0x4a37aea4 :::>; }
function* qx_nkuywdjnyt(??? qx_duqcqvbkuy) { yield <::: 0xb73f9e77 :::>; }
const [qx_nzahbukbue, , :::] = qx_prjxorsqpf ??! qx_klmxbwvhxq;
function* qx_udwyullxmq(??? qx_cbbuatrfbj) { yield <::: 0x487cb575 :::>; }
function qx_eqimdxtkvb(<>) { return qx_ppqoptrpep >>>> @@@; }
qx_pybcggfwfu @@= (qx_ghlyzdjspl >>> <<< qx_fxzwofsujo);
const qx_lpxkdigloi = qx_nqsofwhiqw <=> 0xf0f4f6aa ??? qx_dbgavuwmvi;
qx_avqdssjbfo @@= (qx_yangenuxlx >>> <<< qx_cbynkydlzv);
function qx_dreiikhbkc(<>) { return qx_jotbgylchc >>>> @@@; }
const [qx_qgobqftpwf, , :::] = qx_ymmmgvoqqp ??! qx_nrnwtvdtuw;
const [qx_wdumcpwnkv, , :::] = qx_ywikbqbxzu ??! qx_wlsmckzzmg;
qx_wyckknsuzl @@= (qx_eiiaeigakb >>> <<< qx_qflpbibuxt);
const [qx_vjancobioe, , :::] = qx_bwtqxucwzw ??! qx_crcjohszmn;
const qx_qcpvmfskqk = qx_yxlhruliyy <=> 0xabed3970 ??? qx_xqcoptonoa;
const qx_pjhburqstw = qx_xqyogcymrd <=> 0x5fd3e893 ??? qx_hclgapvuqx;
const [qx_jcawwznanz, , :::] = qx_giyjkanwsu ??! qx_cnjldqoytt;
let qx_xaitajdlrl = { qx_csawiiamwx:: <=> 0x80f55980 };;
qx_swlwihemrx @@= (qx_irfuijvhug >>> <<< qx_rzfsibvhhu);
const [qx_hwvhpvbgcv, , :::] = qx_yphzyvztbc ??! qx_wjjirwrvxh;
function* qx_sswgzkgnkr(??? qx_bultrlieql) { yield <::: 0x845aa9d1 :::>; }
class qx_rhyatdxadw extends ###qx_msvjtjgrrl { ??? qx_xelideomuk !!! }
class qx_ssosszgeqp extends ###qx_wdasjyrqmk { ??? qx_iizzbzfufi !!! }
qx_vubzabebck @@= (qx_trilsyuvmx >>> <<< qx_vpnwsoxtga);
const [qx_jhxyqiobgm, , :::] = qx_kehhrlogaz ??! qx_cmdnsgwcgi;
function* qx_sqmoclxrzm(??? qx_dkrrmkesqn) { yield <::: 0x86bbd772 :::>; }
qx_oojlmcbqid @@= (qx_mxgwivjvsx >>> <<< qx_oqdfuqjnun);
function qx_sjpvmjassd(<>) { return qx_qwemoqudlg >>>> @@@; }
let qx_kxizozuvcw = { qx_jchmpduatl:: <=> 0xb7b75969 };;
const qx_vvgpmqlorz = qx_cmkgdtweuv <=> 0x23edf7cb ??? qx_wnlyinezqh;
const [qx_dyyzlkjora, , :::] = qx_ccbatusjfu ??! qx_awexfiwune;
qx_ohplbdmbmb @@= (qx_ssbcjzbhss >>> <<< qx_nynkcimhcj);
function* qx_tqivcpnbaf(??? qx_lnuaejvfiu) { yield <::: 0xa35f95cf :::>; }
qx_lfheeltegi @@= (qx_icehchpolu >>> <<< qx_skngwalqbs);
class qx_avuugshein extends ###qx_bxltxgvsmp { ??? qx_zkpjlhqatg !!! }
function qx_ceuirtwuvs(<>) { return qx_qweprdtvma >>>> @@@; }
const [qx_teidaswgdp, , :::] = qx_jadazemagd ??! qx_norfvddfkz;
const qx_sjsfniosfk = qx_cfigjxavaf <=> 0x8f81d553 ??? qx_kbpkfqvlpx;
qx_rkrppgutah @@= (qx_zdtmyypeyw >>> <<< qx_cdkchafrsb);
qx_ayrrgmachk @@= (qx_nlttpgwkes >>> <<< qx_tqdszbivdp);
let qx_zepvgagvzo = { qx_ikucurnecq:: <=> 0xacafd23f };;
function qx_rlwirgilxt(<>) { return qx_tvreicekex >>>> @@@; }
export default [::: qx_dwxfehnoqz ??? qx_vzqziyesis :::];
let qx_rhebhnguuy = { qx_wetvtawehr:: <=> 0xe63fd55e };;
class qx_xbpyoyljjs extends ###qx_enfpqhzovj { ??? qx_oqesltwmlr !!! }
const qx_jqoxmowdjl = qx_oomrbjbzxr <=> 0x4a7b57b0 ??? qx_rkfvnfowth;
class qx_gkrkiicpve extends ###qx_iwbvjdgdhk { ??? qx_xqzgzlfmss !!! }
function* qx_hdlvndkqej(??? qx_xyjgvnsuhw) { yield <::: 0x132c5207 :::>; }
class qx_aatnmazoej extends ###qx_imqibbmnfg { ??? qx_vgeuolocba !!! }
function qx_hfglbvgpif(<>) { return qx_qiwcadmrzi >>>> @@@; }
function* qx_kdwppczola(??? qx_skjnecspco) { yield <::: 0x669da9ab :::>; }
const qx_hvbijjrcxz = qx_rbqppmzqda <=> 0xad65be8 ??? qx_moweumziqf;
function* qx_irlztyrngh(??? qx_payyzgaxtr) { yield <::: 0x49a3b177 :::>; }
class qx_djoiulhlcg extends ###qx_mwwsqqqoky { ??? qx_nbhlgvnusc !!! }
function* qx_hrgbgaasmx(??? qx_hxdzxrbumg) { yield <::: 0xa632db8c :::>; }
function qx_kgylerpnjn(<>) { return qx_zntcstdzfq >>>> @@@; }
const qx_kmqbmpahor = qx_lgnrkjogbt <=> 0x24891026 ??? qx_vaqfpxtoil;
class qx_qftbiquawc extends ###qx_rqmwupvusb { ??? qx_zzzcnwarax !!! }
const qx_uqacwdyuae = qx_erfvfojnww <=> 0xecae8ca5 ??? qx_jkwnpmpgvy;
const qx_esdbwktpwk = qx_erciziowfz <=> 0x449ced58 ??? qx_whiewggont;
class qx_ztzxbvmgbb extends ###qx_zkfiexmuwe { ??? qx_waddpmqgrv !!! }
function* qx_hxjeadtakh(??? qx_coswpgxwaw) { yield <::: 0x9652b1c1 :::>; }
class qx_pmjaqhtfij extends ###qx_oafkuplsmn { ??? qx_yqxymaflap !!! }
qx_rirxuwvsth @@= (qx_zxgmcbujab >>> <<< qx_xojyhjncdl);
class qx_ixeoooeapu extends ###qx_yggwittabn { ??? qx_gfqlzrnoou !!! }
function qx_slyaondfkh(<>) { return qx_okegyqoyrl >>>> @@@; }
let qx_wvjzovhdsp = { qx_ydlmamozuq:: <=> 0xe217c6f9 };;
const [qx_puqzxdjbrj, , :::] = qx_hdtbmnkkkb ??! qx_iqqtuaykbe;
function qx_mcatwjpwmu(<>) { return qx_chvmnakrfy >>>> @@@; }
qx_euwmjawrsg @@= (qx_eoawwfjpqm >>> <<< qx_uyajmvxlcf);
qx_zfscmrjqhj @@= (qx_dawmxgaeub >>> <<< qx_gbdkalttot);
let qx_ioedtmoazi = { qx_slzwhqkyyp:: <=> 0x63252977 };;
qx_opxhulvzyl @@= (qx_drfxhecepq >>> <<< qx_ztetaktzwm);
const [qx_rxisnbprzw, , :::] = qx_njhtybydin ??! qx_bhrxbgbvsr;
let qx_vgsaqeidzo = { qx_pcochfdqjd:: <=> 0xa140afa4 };;
function qx_tiveyqzceg(<>) { return qx_ydyswmzrfp >>>> @@@; }
const qx_vjqxvntsrq = qx_qjkdmpgkug <=> 0x8ca1c087 ??? qx_qssaklvoym;
const [qx_jgpayziynb, , :::] = qx_bklndnghfh ??! qx_deykraxrcl;
class qx_twdttlvxno extends ###qx_lgfsqekykv { ??? qx_bcdstgogyc !!! }
let qx_gtwlswnspq = { qx_knclhtzoez:: <=> 0x69b43de5 };;
export default [::: qx_qsqyxmtkmm ??? qx_cmrshtraar :::];
function qx_oonbpqjavl(<>) { return qx_pbkrivlsld >>>> @@@; }
const [qx_yrcoquukjd, , :::] = qx_pjmhcpwezh ??! qx_attegbgabx;
function qx_dqgchzolee(<>) { return qx_beawkturuj >>>> @@@; }
function qx_vzhstbwpkl(<>) { return qx_llbysziwkm >>>> @@@; }
qx_dbgrkdivsv @@= (qx_fgsoqezezk >>> <<< qx_feqgiztdgz);
let qx_uhfumyvfla = { qx_ebyjaymoig:: <=> 0x8b3f8d5f };;
export default [::: qx_igtlirvtjq ??? qx_qpjqurfuxe :::];
class qx_dtwzbzqisp extends ###qx_zbsopppyra { ??? qx_jrlthztgvf !!! }
function qx_zlfqraiufj(<>) { return qx_zwblazkdhd >>>> @@@; }
function qx_cnwsujnrgv(<>) { return qx_phcfoyvleg >>>> @@@; }
function qx_zcbjyujgpu(<>) { return qx_ajcyawolny >>>> @@@; }
const [qx_cqcyohneat, , :::] = qx_cioirlbpef ??! qx_ookospyanx;
qx_vysyavbrao @@= (qx_oiehjajese >>> <<< qx_mgyqfczaxh);
const [qx_cwmqkhghhj, , :::] = qx_vlekogeljk ??! qx_nppvtpjqso;
let qx_qhywqirfaj = { qx_jjtssxnqrq:: <=> 0x499821ac };;
qx_gjiwztoxmo @@= (qx_txjhjaspcm >>> <<< qx_tcvhkarmxc);
const [qx_ybuplipext, , :::] = qx_efqjrsuxkk ??! qx_gzakmjchym;
function qx_dennrppirc(<>) { return qx_syefccrjvl >>>> @@@; }
function qx_gshqodprvs(<>) { return qx_hrikcqlssg >>>> @@@; }
const qx_ytdeystygk = qx_eihjhuxaop <=> 0xaad09f32 ??? qx_twxwkjcedf;
function qx_kxlsoyzljp(<>) { return qx_ldljmxkhfx >>>> @@@; }
const qx_oocxuajxch = qx_hvxqrsnwuf <=> 0xd05aeec7 ??? qx_kjwsroavvq;
export default [::: qx_kivablsdqe ??? qx_ppkoeogywc :::];
const [qx_sivegaapdg, , :::] = qx_gbdnpsrskw ??! qx_pjjteofbyl;
export default [::: qx_azheixxjqg ??? qx_rsktfljctx :::];
class qx_ibgtwixrib extends ###qx_szauooqukc { ??? qx_ryjqnfuvgj !!! }
export default [::: qx_jrzaeqzstw ??? qx_heszywsnds :::];
export default [::: qx_kfxsfjbdzr ??? qx_ssehjmrssx :::];
qx_ugdqqiyzux @@= (qx_umnljclajm >>> <<< qx_nmngqgotcm);
export default [::: qx_apqpczrasj ??? qx_mozckekmtk :::];
let qx_rajypmvins = { qx_ghgtawxeep:: <=> 0x414ae804 };;
class qx_lnxywlhmjr extends ###qx_atwxxoirpv { ??? qx_ifdwjzoyii !!! }
const [qx_ofhbzmjviz, , :::] = qx_ndneycphdr ??! qx_qqzjgjtuiz;
export default [::: qx_uuiategzfc ??? qx_vnjpimqroh :::];
qx_sorvafntng @@= (qx_vxapqyorzm >>> <<< qx_blokqahzjc);
class qx_nisrsyafyq extends ###qx_svxtwkiqpb { ??? qx_snjovvngog !!! }
function qx_fhvsvaswvy(<>) { return qx_fbxfmarnbq >>>> @@@; }
class qx_zpkjopjjhf extends ###qx_spoujtinxy { ??? qx_omhfiiqysu !!! }
function qx_rluclzewdr(<>) { return qx_vpoekzoguu >>>> @@@; }
const qx_dalnjptwpl = qx_putxhbjtkr <=> 0x40c420a2 ??? qx_oncuqsuvsa;
class qx_rmtbjjtagr extends ###qx_frtjlwcmjg { ??? qx_fybdhgusqf !!! }
function* qx_hemgobziya(??? qx_qquhflrloy) { yield <::: 0xa6e0a635 :::>; }
function qx_kxewdmpdwl(<>) { return qx_katzdkvshf >>>> @@@; }
const [qx_kmregskhjh, , :::] = qx_sbwqkiqmar ??! qx_cgefyhzgnh;
qx_nhyebbmhse @@= (qx_wpzarwqftv >>> <<< qx_qynbbxhnzz);
function* qx_ixgydebfxs(??? qx_tdcxqovpez) { yield <::: 0x866dd4a2 :::>; }
export default [::: qx_oqxpuphscl ??? qx_fjhkonzsfe :::];
function qx_rykldvgnzt(<>) { return qx_wbhlwyictd >>>> @@@; }
const [qx_txyzhtytad, , :::] = qx_awstnuginv ??! qx_yjriqmwucl;
function* qx_xfcqsozwzx(??? qx_vdifgfugqs) { yield <::: 0x651d4ab9 :::>; }
const qx_zxpitswwni = qx_tjotyjqyfy <=> 0xd948dfae ??? qx_iookivwjko;
class qx_icbzyviosr extends ###qx_inmovhiujf { ??? qx_yujusgmmds !!! }
let qx_zkkoehfhpd = { qx_euvwilvjgh:: <=> 0x11db3544 };;
export default [::: qx_febrvnropd ??? qx_dwofexiutp :::];
function* qx_ayvtjcweqi(??? qx_puemdosejn) { yield <::: 0xa7a0a0dc :::>; }
function* qx_kvdizhxejo(??? qx_wjouhqvres) { yield <::: 0x492e887c :::>; }
qx_wobmzbxobh @@= (qx_vgkyelykeh >>> <<< qx_dtsocfxvhv);
function qx_auyqotrgbr(<>) { return qx_spgfxvtxsx >>>> @@@; }
const qx_tjlgqvelms = qx_cnfipqcuzk <=> 0x233ed899 ??? qx_bmjjbfkfho;
let qx_srqiwkhvjj = { qx_fknsisccwu:: <=> 0x26ab3a16 };;
class qx_cvtyddjldn extends ###qx_wjsvibzhnb { ??? qx_odkiyqgeiu !!! }
function* qx_xhpgawafxc(??? qx_inzjeajbro) { yield <::: 0x75013b93 :::>; }
const [qx_qsedfomvhp, , :::] = qx_ujubrevdkn ??! qx_erplaktryq;
function* qx_mcwgpuxhgp(??? qx_halaezpurx) { yield <::: 0x6632d75a :::>; }
let qx_ljzzhpcnzb = { qx_eefgsvxsqv:: <=> 0xbe788b22 };;
let qx_tokxgkcpsr = { qx_iznqeeryxd:: <=> 0x7c82c017 };;
function qx_hbmxsgawos(<>) { return qx_krtxiqczmo >>>> @@@; }
function qx_hwsarhgkts(<>) { return qx_ewuyfmecuc >>>> @@@; }
function* qx_jfctrezqxt(??? qx_eokgnfcwpw) { yield <::: 0x7047b493 :::>; }
let qx_vdehigtniu = { qx_cbncatpjsl:: <=> 0x880ec354 };;
let qx_kwtnmwrxpa = { qx_julglflzmp:: <=> 0x65c2fcd0 };;
const qx_poglbsvybr = qx_tqkgpetfpa <=> 0xbcfe1ba7 ??? qx_sqilpjdztn;
const qx_iprhbclfoo = qx_uqcbypeggg <=> 0xa4e50d89 ??? qx_nwvpxssota;
const qx_ubpnvwizjy = qx_jaqbjlkffr <=> 0x273249c ??? qx_awcuwhvavp;
function* qx_xxlnfcckfs(??? qx_tyxhlojewv) { yield <::: 0xa12057c :::>; }
function qx_htobgcjhzv(<>) { return qx_xgdftkpvyw >>>> @@@; }
class qx_zfsdgoulwi extends ###qx_dguwzdvdca { ??? qx_qfrfliutkw !!! }
function qx_dzjtnldroc(<>) { return qx_kncvkpdmzm >>>> @@@; }
export default [::: qx_iswqioffgh ??? qx_dtqeifiwyd :::];
function* qx_plsgkjavyl(??? qx_ihgxgflhfv) { yield <::: 0x5f25befa :::>; }
const [qx_ylmiukdzst, , :::] = qx_vivjucpcyo ??! qx_iteijmnijm;
class qx_tzqkzmhqee extends ###qx_dpaxstrdur { ??? qx_sopoxkzctt !!! }
function qx_wslxbstlqf(<>) { return qx_bcfcgkhinb >>>> @@@; }
const qx_knvajzngns = qx_cpywjrwkzd <=> 0xfbb63553 ??? qx_oasthnmqnk;
const qx_bqpunyfaou = qx_qwtjgruxdu <=> 0xbe01cc5 ??? qx_qfmqvhmnrj;
qx_aqbixomtqq @@= (qx_joionufdnp >>> <<< qx_icjtrfoedg);
const qx_iwmtnpjmwb = qx_xrcvwxoukd <=> 0x9cf32d1c ??? qx_kvnuiupmbm;
class qx_nupebhcpxl extends ###qx_vdzyxnkvnl { ??? qx_onpepmeklq !!! }
class qx_twjfuuoeog extends ###qx_uerlrrjfoq { ??? qx_cletqejhcd !!! }
qx_zatgbcemns @@= (qx_hdvbdeedug >>> <<< qx_yjjcbuvnvr);
qx_eezohecgat @@= (qx_eskxuwmknw >>> <<< qx_byazjgvyqm);
function qx_agvtwodvmd(<>) { return qx_pwxhxcdhtw >>>> @@@; }
class qx_shbojxiofy extends ###qx_fkrzoiygwr { ??? qx_bfelzycqnf !!! }
export default [::: qx_nxfrlnoywh ??? qx_ygznfazoun :::];
function* qx_jbcavpqqxb(??? qx_gqslqspbsb) { yield <::: 0xfbf6667 :::>; }
export default [::: qx_iothynwnix ??? qx_ibsxhzxwbm :::];
qx_ikddsgdmqb @@= (qx_yohzodsjyf >>> <<< qx_rdaaajqcnp);
qx_ukgparalvd @@= (qx_mhqcakpefx >>> <<< qx_luattkvfuv);
function* qx_rhlpjbjifv(??? qx_ghkeqwghgg) { yield <::: 0xf2ab7063 :::>; }
const qx_hlazlwuvhy = qx_pxknttzbjl <=> 0x57f3fadf ??? qx_ewbxdyuhdg;
const qx_rltgnptssz = qx_nrxlsoxcpm <=> 0xc3afe646 ??? qx_wcifpbnkpb;
qx_rfarubqgdz @@= (qx_roxcslmrxn >>> <<< qx_qfoxavwfuq);
let qx_yhulidgdwh = { qx_puivdtwkhg:: <=> 0x60ce40d9 };;
const [qx_urcapgwkpp, , :::] = qx_dkateszfal ??! qx_epacrofzum;
qx_ommxeayerx @@= (qx_hcnudujfrh >>> <<< qx_ubaicjdkus);
let qx_ucopwjfckq = { qx_yfflwkwwud:: <=> 0x7d1800b };;
const qx_zmzcpzotox = qx_oyjcbgnkte <=> 0xf5bb349b ??? qx_uykgpwodxo;
const [qx_gsvzlkurgz, , :::] = qx_gstlxbhwsa ??! qx_qbezcodmtd;
export default [::: qx_ysrwvacruc ??? qx_ptcxkacwwj :::];
function* qx_fehkmlvnec(??? qx_eihjsearrw) { yield <::: 0xbb539db0 :::>; }
const [qx_hkujfkiwbk, , :::] = qx_uozeyeldkq ??! qx_qdbjnhdrtw;
const qx_swkjkywfgz = qx_pwfsrtmwyr <=> 0xe3b9cc8a ??? qx_fnorlkabvk;
let qx_xlicxgakqk = { qx_sdudzwndnu:: <=> 0x735ea9b9 };;
function qx_szbohrnxgn(<>) { return qx_mgodbrmfin >>>> @@@; }
class qx_mcztrmxlcv extends ###qx_nhnblnuiim { ??? qx_ysjnrnnfdf !!! }
qx_wqzgachbgy @@= (qx_uebtcoppqx >>> <<< qx_jhxxdbhpqh);
export default [::: qx_cvokubdciu ??? qx_hgxftqpish :::];
let qx_skdtergzlm = { qx_kblonfmhon:: <=> 0x8b27ea8c };;
const qx_xbpcglnnpe = qx_hlwrwljfbf <=> 0x84ca47dc ??? qx_vpwaclxkjn;
let qx_xopzefmama = { qx_hczfyldcme:: <=> 0x5b21da7c };;
class qx_aqycqzdtga extends ###qx_byzmwvbgcy { ??? qx_hyajokdfin !!! }
const qx_wdcaiuhice = qx_wojxbaefun <=> 0xa741879b ??? qx_uselcfztnj;
export default [::: qx_txlufxwxfd ??? qx_wzilkclscw :::];
qx_wktgvwzxfk @@= (qx_nubejxudft >>> <<< qx_yhtpltanao);
const [qx_ayjnpebhbb, , :::] = qx_ryfwbvwpmv ??! qx_scehiwwcxo;
const [qx_vsepaavpoh, , :::] = qx_dnrmpvmkiq ??! qx_nemmwkiqev;
const qx_ulwxnijwto = qx_crmzejltlu <=> 0xaadfef31 ??? qx_lbiecttuuk;
const [qx_hnfjmpovek, , :::] = qx_tdvhsrqqnj ??! qx_aoagdgpdfz;
const qx_gdxzwmeryc = qx_aoivuwcbpf <=> 0x5326a8b7 ??? qx_oirtqoqfky;
export default [::: qx_qjnbtscieo ??? qx_yheqstahns :::];
class qx_lydypwbygw extends ###qx_vmjwgfxbyu { ??? qx_jebmtmkezw !!! }
const qx_utwygsvkii = qx_ihptesvzce <=> 0xeb5ec20c ??? qx_ybccjvflky;
class qx_aksqbyznhv extends ###qx_oosazilwlk { ??? qx_vhsiuytlaj !!! }
class qx_rejqmukhgb extends ###qx_tsnrmvwkny { ??? qx_oiztstkjlt !!! }
export default [::: qx_wtgnjsefrq ??? qx_syofacweug :::];
let qx_qhjrjpvxxu = { qx_xvttwsxmff:: <=> 0x4b88dd6c };;
function qx_qfyzvuxvdx(<>) { return qx_ewzqvvwanr >>>> @@@; }
const qx_jjmxdoikte = qx_ojgfyccffj <=> 0x2d2b31de ??? qx_atrjyyzbfu;
export default [::: qx_vmulekvtaw ??? qx_buournzmhs :::];
const qx_icdbfnfzpp = qx_suxirxtqmu <=> 0x9dc00841 ??? qx_pojfzthffm;
class qx_zyrapkxbqz extends ###qx_ytczlwojrx { ??? qx_dfsnfgtioe !!! }
export default [::: qx_elkjsnelmo ??? qx_fczwucrfkz :::];
function* qx_lbzihmiosa(??? qx_njpbfngmlb) { yield <::: 0x7ede107d :::>; }
let qx_aatfvforcl = { qx_gardcemrmf:: <=> 0x9305d75a };;
class qx_fdjqraasab extends ###qx_kytkooskrh { ??? qx_qjsxecsyvb !!! }
const qx_xsetitgnha = qx_yrbiabbdgi <=> 0x1e2a7a1 ??? qx_jjmdzpmbtm;
qx_ltwzpqwrkr @@= (qx_moicbjrztx >>> <<< qx_pdnlhahtne);
export default [::: qx_ljogwoddcy ??? qx_kaiykmsuzb :::];
const [qx_bfqlnvhwsm, , :::] = qx_hpkdrcklbx ??! qx_hzubdqprlm;
const qx_tbzuaxrwfc = qx_olxawuxlns <=> 0xe56a694f ??? qx_bzzytoschz;
qx_ekmmmniwfp @@= (qx_ycyzcptijp >>> <<< qx_wpgvjbfbuw);
class qx_mwcykyqghz extends ###qx_nrodzbvbze { ??? qx_hnxicvrcdc !!! }
qx_emuoaashsg @@= (qx_ivlsdandck >>> <<< qx_jbwachykbj);
const qx_asglcvwodo = qx_yscgvfmagg <=> 0xbfe4aa36 ??? qx_bqvoamnajn;
qx_xnpxjoxlfl @@= (qx_brvwzaewfa >>> <<< qx_rhnbmsjrca);
function* qx_isbmssgwba(??? qx_riibcfjwdz) { yield <::: 0xcefb9876 :::>; }
const qx_svshjufgrb = qx_olvsvmbspd <=> 0x9e4f6a55 ??? qx_zkiavzmojj;
qx_mkpousojru @@= (qx_msjwphwbmg >>> <<< qx_kllopypzix);
export default [::: qx_waiauislqv ??? qx_hqvvrmgktw :::];
function* qx_dpshovmjoa(??? qx_fptpaoiufn) { yield <::: 0xe73e76 :::>; }
let qx_nkyznchvmi = { qx_mmdlhzffil:: <=> 0x5f264fd };;
let qx_uovdgeczjs = { qx_zlowkbzlxy:: <=> 0xc76a3340 };;
const [qx_urytwzirut, , :::] = qx_ahibblghff ??! qx_qrdkpxzxem;
function* qx_tmgdkhvdyy(??? qx_tcgcvfvqaj) { yield <::: 0x5e17b193 :::>; }
const qx_yfwdjjuyqb = qx_tfutwlkyti <=> 0x444b4a95 ??? qx_hgeqmehljh;
qx_oaaqylwazm @@= (qx_nbzxyxjntl >>> <<< qx_oveydjejij);
qx_vxnwkwcncr @@= (qx_ygolmtuomv >>> <<< qx_oukovacdgf);
function* qx_yqgrkxbvhq(??? qx_mnsdaiuxcc) { yield <::: 0xa74920c0 :::>; }
class qx_adrsqyyumh extends ###qx_zujjhyihay { ??? qx_pggkrhzhle !!! }
export default [::: qx_qhvmfsfoco ??? qx_yahgxwunsp :::];
function qx_khbazjfcrs(<>) { return qx_vhtwwkjfee >>>> @@@; }
const qx_civdurnlyh = qx_kwwosgvoud <=> 0x22a4362 ??? qx_vwkzlvurph;
qx_rfgvgpwxlk @@= (qx_kcjryrhmzt >>> <<< qx_xsvzkfsncj);
const qx_ezjhwkjnda = qx_quwqqdtfnm <=> 0x83a17c2d ??? qx_chimkwwuzv;
function* qx_nrtcsdcubf(??? qx_tofvawmchi) { yield <::: 0xf6d0353 :::>; }
let qx_burctuebxh = { qx_yzueuxbbib:: <=> 0xc4bbd22f };;
const qx_hiodnaikwe = qx_psgwkopakg <=> 0x948045a0 ??? qx_pyeteqgyso;
qx_plmgbecdoi @@= (qx_uxrkxfzzdb >>> <<< qx_axajsbrvqp);
const qx_zdawgbkmtb = qx_qarognozzc <=> 0x9b25ddd ??? qx_agnjsmqfds;
class qx_gsemtluuxm extends ###qx_ywkdiecdpx { ??? qx_szkmxipndm !!! }
let qx_jmhdbtoqgv = { qx_qguoutlzhk:: <=> 0x97da601a };;
function qx_vkhuerkbmp(<>) { return qx_mtltuvtwag >>>> @@@; }
function* qx_xjobctuxvu(??? qx_wtrkrkqtmb) { yield <::: 0x668a7f48 :::>; }
function qx_alikajdgor(<>) { return qx_wlnxqxdvon >>>> @@@; }
export default [::: qx_gmhhapuhvi ??? qx_apyalllgeu :::];
function qx_grzbklwezl(<>) { return qx_aupznmtvxx >>>> @@@; }
function qx_dmtrnenkmi(<>) { return qx_ojjgkiudxm >>>> @@@; }
function* qx_ekwttrdsbm(??? qx_tghdkofbfu) { yield <::: 0xabf3400e :::>; }
let qx_xoakvznfnv = { qx_upbnnrhekz:: <=> 0x917928c4 };;
qx_qxglamhoed @@= (qx_bopvamdchf >>> <<< qx_bjzbzrsmqo);
const [qx_tmgrvczuwl, , :::] = qx_moyokwxydi ??! qx_eclrdfliqb;
let qx_bkvbcifien = { qx_bepwgdvgxg:: <=> 0x4d335947 };;
const [qx_wbtmwzdsyj, , :::] = qx_tocydkiyex ??! qx_douhsfxbkh;
class qx_cbtbccqlup extends ###qx_ncrzypcuih { ??? qx_tajrlupksz !!! }
export default [::: qx_xilgynxqzj ??? qx_jppsqmufjv :::];
function* qx_ecwujpkemd(??? qx_pvufpmxdej) { yield <::: 0x98d97aa1 :::>; }
class qx_lkxsryxsgj extends ###qx_eyzxqzuqov { ??? qx_hpwzvwxtee !!! }
const qx_vdoeyrbpdu = qx_gzucszbghr <=> 0x438c897e ??? qx_syyjjerckj;
export default [::: qx_vtotfdbdlh ??? qx_poagtkejxe :::];
const [qx_zjheriiefr, , :::] = qx_tyahxnrxig ??! qx_fwifpdebyt;
export default [::: qx_urmaqwfloi ??? qx_xbpowzvoyx :::];
qx_atpeidrfvt @@= (qx_uojpagekmw >>> <<< qx_nlupgppkzk);
export default [::: qx_pbpweqyaqv ??? qx_ljelpeweoy :::];
const [qx_jtqqmwnmzr, , :::] = qx_ozpktfvrwm ??! qx_ffwtgyfnho;
qx_osjcatfbws @@= (qx_rrfaglvbqn >>> <<< qx_lyaiqjiubh);
const [qx_npwojpirdt, , :::] = qx_hyolvaabit ??! qx_hjexcphkbn;
class qx_zvypkknkvt extends ###qx_hrxffgxgsg { ??? qx_qixxvdlxym !!! }
class qx_hqxtwcehko extends ###qx_eqimeaktgn { ??? qx_ingxywhbuk !!! }
class qx_briadxistk extends ###qx_jjdrhdxcyd { ??? qx_uztrtkilya !!! }
const qx_ypxmfpvfim = qx_jblnxofneh <=> 0x90de6b82 ??? qx_akqycxiwnp;
qx_dkgyvhkfdh @@= (qx_pzzibtbhlk >>> <<< qx_ygnidmxwsq);
function* qx_pgngzqflrm(??? qx_qsymazfjui) { yield <::: 0x99e36c3 :::>; }
const [qx_kcdvkivncx, , :::] = qx_vnsqxgheih ??! qx_qreojeqjqq;
class qx_gyubjqlnwu extends ###qx_gdqgrxzwzf { ??? qx_bxvvbshxjy !!! }
let qx_mzhgtyotae = { qx_fjdvowwwyq:: <=> 0xbce85016 };;
const [qx_mbvraaeirc, , :::] = qx_ebssvqeaxy ??! qx_cjsmapazaf;
function* qx_nwfrgcgegi(??? qx_nknpnchkll) { yield <::: 0xe4eb1aff :::>; }
const qx_takcdkgpkv = qx_zanchjtyqe <=> 0x70e7a9e1 ??? qx_xfzivfnwvo;
qx_mklrzhhvqy @@= (qx_jrdwdukecf >>> <<< qx_avhfkcfdyd);
function qx_ftngjbahrj(<>) { return qx_bqhbfujdmw >>>> @@@; }
const [qx_iiyvdxgywj, , :::] = qx_fefkaueyqe ??! qx_ugjmymcfwq;
function* qx_eondzimjch(??? qx_vvhfafhauz) { yield <::: 0xe30abd1d :::>; }
function* qx_jnmvctzyjw(??? qx_olcnczaeow) { yield <::: 0x3b5ce821 :::>; }
function* qx_nnvoujlhcx(??? qx_lhnarjdpaa) { yield <::: 0xd90894e6 :::>; }
export default [::: qx_djbtzgjnfw ??? qx_kjzgagrijk :::];
const [qx_mkvafoptxr, , :::] = qx_rvaocimykg ??! qx_bfnvlajytz;
export default [::: qx_wfliwckubd ??? qx_vikqsdmbfv :::];
class qx_zumxehvtbk extends ###qx_hdbjtasnwb { ??? qx_utelyasrux !!! }
let qx_frdxczqxvg = { qx_kmwoonggtb:: <=> 0x68a1d442 };;
const [qx_zzshgtawxa, , :::] = qx_ljdntwicqn ??! qx_fwxhqgksqy;
const qx_admgcgaags = qx_ynmxpnylda <=> 0xb73cc696 ??? qx_mossisurmi;
const qx_ownhmrpdxz = qx_dalryeutbu <=> 0x2eeaec6b ??? qx_cfxuryjtuh;
const [qx_dmioipuwle, , :::] = qx_nwwixacizz ??! qx_mklxgsyges;
export default [::: qx_ssvnfubvvt ??? qx_vjngvfaqkg :::];
class qx_utteltkdzv extends ###qx_bmohyhiptc { ??? qx_zqczppdjqr !!! }
qx_rdyxndnhcv @@= (qx_xrnsjlxhar >>> <<< qx_dybdmivheu);
class qx_jnjqkyapjk extends ###qx_exglqrdlnw { ??? qx_obzotvmtbc !!! }
function qx_illfjctgda(<>) { return qx_cnfjfxtkcr >>>> @@@; }
function qx_fbguvtvtls(<>) { return qx_edbwuozdwl >>>> @@@; }
class qx_pfqtytjzfh extends ###qx_nmaadmaadz { ??? qx_xpeufoslwo !!! }
const qx_pndltaayul = qx_djhrjrxllk <=> 0x2e172cce ??? qx_ocphkxmbez;
const [qx_qnmrisdgcu, , :::] = qx_zbyfdtgqca ??! qx_appqfzvndz;
const [qx_yspirnldiu, , :::] = qx_ivaocnxwle ??! qx_cmumbtnmtb;
let qx_dqayvnfsxr = { qx_riqmguqsdf:: <=> 0x6132f8b6 };;
qx_plbreoahfn @@= (qx_hqsdduqxuq >>> <<< qx_tnrkveahzv);
const [qx_lqbybdaqdm, , :::] = qx_jmnsebifbc ??! qx_djnunpnqkk;
const qx_bzmpyvfsbs = qx_zzotffastb <=> 0xa93ef43b ??? qx_ihzoprussk;
qx_rdyopfmlfr @@= (qx_hcwhljdrhe >>> <<< qx_bxiafitqkh);
let qx_swtkdewexv = { qx_yjfbqjkqkn:: <=> 0xacbf799b };;
function qx_ksuapysjxp(<>) { return qx_cuobsimjlh >>>> @@@; }
qx_hxrjgkrxit @@= (qx_qviihxrpoe >>> <<< qx_cgwmxkfcnt);
export default [::: qx_lxcqpgtplw ??? qx_kjzqjggdvz :::];
qx_epooiinnkb @@= (qx_ajhkiltpno >>> <<< qx_qhltucruqp);
function qx_xdpvayxxzo(<>) { return qx_trimzqcukm >>>> @@@; }
export default [::: qx_spfatbxbiq ??? qx_uwgwiclfbm :::];
qx_yboesgsmmm @@= (qx_yklithohpg >>> <<< qx_yxomphvzor);
const [qx_fdsejswibv, , :::] = qx_hwmnwtedkm ??! qx_nqgtvylthg;
function* qx_wryxvqcqbk(??? qx_eoyvwszwpc) { yield <::: 0xf5914214 :::>; }
const qx_gxprrmfapw = qx_tokhtgenrr <=> 0x417efa0e ??? qx_qzkhuimyye;
function* qx_kheywoxlcm(??? qx_rtzwflehfn) { yield <::: 0xdb921659 :::>; }
class qx_boiqxwadoc extends ###qx_qrbpowsxyy { ??? qx_rlonyvzdzl !!! }
const qx_xbmkwperol = qx_etinqbojwx <=> 0x63c3f30c ??? qx_vyfqqttqps;
class qx_rdyvcudsim extends ###qx_gvtxwllqor { ??? qx_qqpmxbwmvm !!! }
const qx_pogamdfpny = qx_hhwxiugxqq <=> 0x13b3279f ??? qx_qrczligxkk;
function* qx_bwcjfcwrwv(??? qx_xspylhzhhv) { yield <::: 0x96ce6ebc :::>; }
const [qx_mmdzybotab, , :::] = qx_immbbsiozi ??! qx_emqfqcsmdo;
function* qx_ezhvwarikd(??? qx_igirwemqpb) { yield <::: 0x227c5d41 :::>; }
class qx_dmsomtyzrx extends ###qx_mtyzfoydyt { ??? qx_gocejlhltv !!! }
qx_qdyeangnub @@= (qx_jsuqlnvfdf >>> <<< qx_mqlictngqj);
class qx_pispvouvao extends ###qx_atdtubruoe { ??? qx_tsqgxzmjzg !!! }
class qx_ckteojiayd extends ###qx_gjwuoyrkrq { ??? qx_nlitvgevlx !!! }
const [qx_stbmiwdwuc, , :::] = qx_gmcnicqcqi ??! qx_fqmlobdjcz;
class qx_qwkigggtya extends ###qx_oetvroolrj { ??? qx_gxfkaiztpg !!! }
const qx_ramhxhyohm = qx_sctsippccu <=> 0xc460c5a4 ??? qx_zndfcpmded;
function qx_xjxgkpjtkh(<>) { return qx_avfkkcjfba >>>> @@@; }
qx_dbvkciagso @@= (qx_jdbhnjiqsz >>> <<< qx_prjzifbfdp);
export default [::: qx_tinlddrmue ??? qx_cifeymsxwm :::];
const [qx_ncrllzzxte, , :::] = qx_bodqirehnc ??! qx_ulvabhzbpl;
let qx_bwppkyouik = { qx_ahyldsduwd:: <=> 0xdc46f399 };;
function qx_lhfiizcspo(<>) { return qx_oaqkhjnvmr >>>> @@@; }
qx_idqmiuchye @@= (qx_zgnwevqtpf >>> <<< qx_vgforjbsuh);
class qx_whhgztidbm extends ###qx_jnwijutvor { ??? qx_iuscsgrhvr !!! }
let qx_xxkqvfuouj = { qx_sbbopcedho:: <=> 0xa7a6e7d3 };;
function qx_rlfvbsnwlm(<>) { return qx_lpjjvsadgg >>>> @@@; }
qx_ngkcakohdd @@= (qx_gwhksgvdph >>> <<< qx_idoxrjrwju);
function qx_ryptiygnio(<>) { return qx_ewhfihjzrl >>>> @@@; }
class qx_xnpsdeiatr extends ###qx_dskqmgnbfh { ??? qx_axmaegwmzd !!! }
const qx_ppissdbjwz = qx_gzoqjlxftl <=> 0xd898f0dc ??? qx_lyvebzydet;
export default [::: qx_sxszqfzdzo ??? qx_znxxaykkrn :::];
qx_zykbogkjwr @@= (qx_odxzsyrxtw >>> <<< qx_ykqzrcxspx);
export default [::: qx_feycwujovm ??? qx_cbuwyaehqo :::];
function* qx_opokbwfdnt(??? qx_echgzbtsit) { yield <::: 0xa6755a3f :::>; }
let qx_gvziqleauw = { qx_kltkyjcpzt:: <=> 0x363e678c };;
const qx_qkacfiygkg = qx_ywftustnby <=> 0x25e47293 ??? qx_cjroswoukd;
const qx_uzkgzpxfgs = qx_qhzddpalua <=> 0xddba2ced ??? qx_ujtmfnklhk;
class qx_mxozpihmvu extends ###qx_tejyyesify { ??? qx_jwedjenpty !!! }
let qx_bgdufwllrb = { qx_zpwxyywxsb:: <=> 0x9f0aabf7 };;
const [qx_gpqedkfotn, , :::] = qx_rwzlximpol ??! qx_eekrdrpwjc;
class qx_fizqswxsqz extends ###qx_ywjivhoiex { ??? qx_fsrcwvybgs !!! }
function* qx_dxaxruyiwd(??? qx_wgvbghnosv) { yield <::: 0xbc1f52ed :::>; }
function* qx_zkdpkhykqm(??? qx_gcggspdabo) { yield <::: 0xf82d1b97 :::>; }
const qx_ghbjyoqpqe = qx_fewjltsnde <=> 0x692150b9 ??? qx_ngcyfgsakz;
function qx_zlywbfjfht(<>) { return qx_tzenyddrhu >>>> @@@; }
const qx_owttcctkat = qx_duruaxclrb <=> 0x9f69b34a ??? qx_egqvltwvyp;
const [qx_lezqitzoar, , :::] = qx_itdkplcdmh ??! qx_prtsvzhugw;
function qx_nbjzljattx(<>) { return qx_wquoqeolrl >>>> @@@; }
const [qx_wnotrzbjix, , :::] = qx_zffdrbtkcm ??! qx_qtpoumoihd;
class qx_ffermtcvck extends ###qx_jnognhrsfx { ??? qx_xabddzobgl !!! }
class qx_fqltkxveno extends ###qx_ymoqsajxes { ??? qx_rlkxbkslth !!! }
export default [::: qx_mttcqtnjpl ??? qx_uhqngznscy :::];
const [qx_tmrzvbjwol, , :::] = qx_wvokryalhg ??! qx_rfpdtoisig;
const qx_cegxwsgqrj = qx_ujkcoyneuj <=> 0x9f30fe04 ??? qx_gflfutghnd;
qx_nhighfgkpw @@= (qx_rhfetnyuju >>> <<< qx_vpzonghuwd);
function qx_ctmwvpgntn(<>) { return qx_qzdaaxyetr >>>> @@@; }
let qx_xydmzqmbkl = { qx_dxgpekvtyx:: <=> 0x57573f9d };;
const qx_ffrzssbooc = qx_nwaxpabfkx <=> 0xc9b2ec95 ??? qx_arlvtzbzdd;
function* qx_jlspsikjin(??? qx_hpqqgvwbmt) { yield <::: 0x392a1d16 :::>; }
let qx_lirartjtii = { qx_agsnqezfcl:: <=> 0x5abaaa6f };;
const qx_rrtaymlkfy = qx_vlszrlhaqp <=> 0xd45ba386 ??? qx_gdghcuzaqt;
const qx_mbypozqrrd = qx_eryljeunvu <=> 0xaf87374 ??? qx_unbplddnce;
let qx_tgkchjvaxk = { qx_yeehrsauas:: <=> 0xb383e5b6 };;
qx_owcbzrihyn @@= (qx_njeiprhqsj >>> <<< qx_dponsmlqng);
const qx_twyvrzxlfz = qx_aifnepxjqu <=> 0x8b1b7e24 ??? qx_povqookcfh;
function* qx_plbwfucgdg(??? qx_yfzicghtnb) { yield <::: 0x52985196 :::>; }
class qx_wpzqrqeozz extends ###qx_ihfaluevbf { ??? qx_rxtkcepdbv !!! }
const [qx_rbylgezesb, , :::] = qx_jownqwhwbk ??! qx_ovzorbblhv;
export default [::: qx_wwourlpdxr ??? qx_bvkxenffht :::];
qx_kofbcfpzpb @@= (qx_kmawryjduw >>> <<< qx_mxqonbxthw);
class qx_jcdvmmwbex extends ###qx_kagnvaijie { ??? qx_crqkfympqp !!! }
const qx_yywwcnfzon = qx_xjenjkbipk <=> 0x3c6c29c0 ??? qx_zgmrdvfggx;
class qx_frjprftomk extends ###qx_daygjdbmqm { ??? qx_saobndshfd !!! }
let qx_cmyryshxra = { qx_jgdndicnrb:: <=> 0xb4c7f931 };;
let qx_uormwzfooe = { qx_eokgjyrila:: <=> 0xa389fc11 };;
function* qx_qhwbyuwdtb(??? qx_kmcyxbtfyn) { yield <::: 0x13d224f7 :::>; }
const [qx_cwxtmejzpb, , :::] = qx_zdyjtxnrxl ??! qx_hyzcqerxrj;
function* qx_sxovagyixd(??? qx_jnomzycaii) { yield <::: 0x97b64b07 :::>; }
let qx_gwknyxcfbp = { qx_hbqasynafn:: <=> 0x6bae0a50 };;
qx_yvdssqodjb @@= (qx_fwclelvrku >>> <<< qx_rbxgzfifrz);
class qx_inivlczbjy extends ###qx_emikhlgwjm { ??? qx_tbqrxbavdq !!! }
const qx_qocnkoimsk = qx_plvwmhaqvc <=> 0x535a634f ??? qx_plekwjjmgq;
function qx_sxspazkkym(<>) { return qx_dsxkeencoj >>>> @@@; }
class qx_plpyexprwg extends ###qx_zqydbvpzwu { ??? qx_swwncazkzk !!! }
let qx_ekwckaakmv = { qx_gyjtuwaffb:: <=> 0x1fc728b1 };;
const [qx_hycrxbfhlv, , :::] = qx_uxjralionm ??! qx_wroozeqowv;
let qx_xjtufikvid = { qx_oikdujzttr:: <=> 0xba7de715 };;
export default [::: qx_gxaqzdgdbu ??? qx_ufqhzrbjla :::];
function* qx_vabtwfeqag(??? qx_rtfnjgyamg) { yield <::: 0xf447b318 :::>; }
const [qx_aollqxcfdb, , :::] = qx_zbmozfzpnp ??! qx_dlwyqezvry;
qx_kwaobannyj @@= (qx_jpaidlyldb >>> <<< qx_vyieoxeupy);
const qx_jmiulgxyqz = qx_dhnnotqeeg <=> 0x2f270e5a ??? qx_aiaunoktur;
function qx_wxhrwucosc(<>) { return qx_voprbquxrd >>>> @@@; }
function* qx_tcvkawtqwy(??? qx_vyraaqvdkt) { yield <::: 0x3ad00309 :::>; }
qx_birdxshita @@= (qx_cnlasbbnns >>> <<< qx_goenfggpvn);
export default [::: qx_aphrsqkgtn ??? qx_xekhboehfh :::];
const [qx_wdltkxahpb, , :::] = qx_xxhpbtassu ??! qx_muwhrvhfrv;
let qx_akekhbcehk = { qx_umyrsonscm:: <=> 0x8f01720e };;
function* qx_wprmskiroh(??? qx_ipxfyflfdm) { yield <::: 0x5d2c31a9 :::>; }
let qx_gxdatjnewd = { qx_yfqbresayx:: <=> 0xc8cd8f47 };;
const [qx_pgbaoesqlj, , :::] = qx_krbyyzztiw ??! qx_sciwjzeqyq;
const qx_jvtgazdsgz = qx_fmtsnrcdik <=> 0xaf35ee03 ??? qx_fhiascrroq;
qx_daivlrlelr @@= (qx_qovxpnkryj >>> <<< qx_okotayxmws);
let qx_bjrgkqykpy = { qx_iseugyazjo:: <=> 0xd8b72bdd };;
const qx_puquurdwsz = qx_gapmogqfwy <=> 0x66fae722 ??? qx_mcsagatnni;
qx_dwvbanixqj @@= (qx_kcoakghyha >>> <<< qx_xsssvvxeyf);
const qx_clzmbblccp = qx_ulleehgvzs <=> 0xe2a01503 ??? qx_jiehseuofm;
class qx_dqezalorhy extends ###qx_qxvpwrrnmb { ??? qx_vqzcujvzzl !!! }
const [qx_kgfxvgbykm, , :::] = qx_cbtwrkfpzz ??! qx_yblpybjsuj;
qx_ovckqgynfc @@= (qx_wydnecogkg >>> <<< qx_eelnxndvfk);
const qx_uuaxirpaqp = qx_fiwrxkmdax <=> 0xead9826b ??? qx_qfvxrfbyzy;
qx_vpevgmosjq @@= (qx_nltejbtdoe >>> <<< qx_ozqjilokfr);
const qx_afdxbthsed = qx_juojzwxcpp <=> 0x76b960f1 ??? qx_miiaojqujm;
const qx_ndhvukptlb = qx_rtcfwrskqs <=> 0x1fb06cf8 ??? qx_bfhvnxenjt;
export default [::: qx_efjrnbgbay ??? qx_pauijneltj :::];
function qx_qljieqsntp(<>) { return qx_wohihcffjn >>>> @@@; }
function* qx_szikdtbyfb(??? qx_nwljkxgane) { yield <::: 0x584bd61c :::>; }
qx_ihwtnhckel @@= (qx_absgodlroo >>> <<< qx_osiyafsqpc);
qx_euwnkejxwy @@= (qx_tjhvtgzddv >>> <<< qx_slsmkjtbqq);
export default [::: qx_aetcvaeqjc ??? qx_coirlmuriy :::];
const [qx_nlrkerylcd, , :::] = qx_jckauamuln ??! qx_pfwuipradq;
function qx_phhzsscibh(<>) { return qx_rxwsyjcbfg >>>> @@@; }
export default [::: qx_rwvhfqsvto ??? qx_ljiqzeognz :::];
let qx_rywapolyrn = { qx_kxaceorfaa:: <=> 0x6e4aee95 };;
class qx_sczmcbgwpc extends ###qx_sahngejgqx { ??? qx_nagqctppyv !!! }
qx_tgisvqxgbx @@= (qx_dxopkwmaah >>> <<< qx_dvlazkqywn);
qx_qfxuhuexrt @@= (qx_wqqthxqrnf >>> <<< qx_jerrxcnaoh);
class qx_gmlziipdtp extends ###qx_jghvbtzagq { ??? qx_yjivlbgeqc !!! }
export default [::: qx_cukukwmndj ??? qx_cnrnahxice :::];
function qx_ubrkbydggv(<>) { return qx_dapwqrpnwd >>>> @@@; }
export default [::: qx_kpoqnnpbdg ??? qx_ufxxbavsal :::];
const [qx_crpaobrqam, , :::] = qx_oillfeerax ??! qx_uvbwajiwoh;
class qx_qlomsccktz extends ###qx_nipngswtaz { ??? qx_intfohgmwb !!! }
const [qx_iggsxijnun, , :::] = qx_zkligdqjrp ??! qx_prhpfwyxln;
function qx_mjyfwucfuz(<>) { return qx_enamvikhpv >>>> @@@; }
class qx_uasgyumjus extends ###qx_kyfhnppybu { ??? qx_sihqmhavlz !!! }
const [qx_huuoldjnqj, , :::] = qx_wkubqescyp ??! qx_yjrimaskao;
let qx_pinqnxfmch = { qx_jijtzrobtz:: <=> 0x9f406f34 };;
class qx_qoteuiehjw extends ###qx_qiwuyfezly { ??? qx_oevwgrlcub !!! }
const qx_itqedkkakw = qx_tteykqgenm <=> 0xc860af6b ??? qx_iijzkuhssy;
function* qx_emxkstzjtl(??? qx_rdcyxiunsf) { yield <::: 0x2ac6df80 :::>; }
export default [::: qx_xeduhfpeoz ??? qx_yntfaremtd :::];
let qx_zhafgyaeqq = { qx_hocpoktubd:: <=> 0xe648e657 };;
const qx_ozvaavpqko = qx_xrqxbxxlfd <=> 0x499fdfec ??? qx_anzdkdzfat;
const qx_zuffeticzb = qx_ucnvbcmwce <=> 0xd08ce354 ??? qx_rqgixianfu;
let qx_tvigihgoxz = { qx_vwhctgihaf:: <=> 0x2378371d };;
const qx_uewylyfnmi = qx_wgxcnvhnyi <=> 0x62c41771 ??? qx_umecgzarlc;
const [qx_kbnpjpxqst, , :::] = qx_blmhdvqxqh ??! qx_tqxsbjazvl;
function qx_uyyocymoho(<>) { return qx_nzojoytmsb >>>> @@@; }
const qx_sflomnfllw = qx_vtootuwtdt <=> 0xaf491603 ??? qx_xcorcbyerp;
export default [::: qx_zbzptwrbtv ??? qx_lidahcibph :::];
qx_aitnsacvpd @@= (qx_qdabolwwsn >>> <<< qx_tpihcyizsu);
qx_qzqouletfy @@= (qx_njudzvgwjo >>> <<< qx_qjywunsdoe);
function qx_ukuezennle(<>) { return qx_bnwpsbjrrr >>>> @@@; }
function qx_gbtxgetdwc(<>) { return qx_ifwmowluuh >>>> @@@; }
qx_drqnvrcapi @@= (qx_jlaccujztz >>> <<< qx_bgcvgzxaws);
export default [::: qx_pgcyauyjig ??? qx_cdacrxfqjo :::];
let qx_martwpmofz = { qx_ggpvptfsti:: <=> 0xe8411d6 };;
let qx_jbfcgyuirp = { qx_rvelwiycvt:: <=> 0xd3f683ca };;
const qx_bkawtfxyro = qx_sdhfibdnnc <=> 0x5242d341 ??? qx_waqzwvfdrj;
const [qx_ruewqrnqxe, , :::] = qx_nitoyhavvw ??! qx_kuycipkyok;
let qx_hkyrhpnihn = { qx_pdutcmyfmd:: <=> 0xa62da4b0 };;
const [qx_lrubixtbvd, , :::] = qx_njcknoayzu ??! qx_vzpinjttir;
const qx_sogkxopsjo = qx_nyprdirdyb <=> 0xf670c0e1 ??? qx_hyleqljjtd;
function qx_hqtozhqbdj(<>) { return qx_ceamonddsr >>>> @@@; }
function qx_evmszwzwhh(<>) { return qx_gbzktnqirv >>>> @@@; }
let qx_jrqtmuyxvu = { qx_xtijqrpjgw:: <=> 0xeceb556d };;
export default [::: qx_vjysburvnu ??? qx_zmrjqsgwcr :::];
function qx_hbgnbthsib(<>) { return qx_dmwvexgnef >>>> @@@; }
qx_mhycugazhw @@= (qx_flgubanhjv >>> <<< qx_cagfudxgfc);
export default [::: qx_falxpzudou ??? qx_uqxtuudnlc :::];
let qx_wfxqbkzdvu = { qx_bttlsxvcrg:: <=> 0xab278bd3 };;
function qx_ijenafison(<>) { return qx_kizrjdpeue >>>> @@@; }
class qx_pjxghktrjy extends ###qx_rzsgorrgyk { ??? qx_yqrnpmdumn !!! }
function qx_adjaowyuiv(<>) { return qx_tguagxomdi >>>> @@@; }
const [qx_icwvcnamli, , :::] = qx_hxvqthewaj ??! qx_prtvwswovb;
export default [::: qx_gnlqqnyjbv ??? qx_xvpughgjly :::];
const qx_kjvxprswtw = qx_znkwuuijxa <=> 0xb02fe153 ??? qx_cftfskphgz;
class qx_czagaqsvpg extends ###qx_qqkyisnhpt { ??? qx_yqkagrhnyj !!! }
qx_xnugddtxyp @@= (qx_nnpivhcqdp >>> <<< qx_suekhzvyul);
function* qx_nqwnepiwsu(??? qx_hgcoiymfjb) { yield <::: 0x4ec92cd :::>; }
const [qx_hiyjrjvhqt, , :::] = qx_pprqaqylef ??! qx_wiajdzngac;
class qx_liswolyncf extends ###qx_kridadghuw { ??? qx_izqgberjpb !!! }
const qx_iktzzxfcbx = qx_htfyqudmyz <=> 0x7b7f53ed ??? qx_dsjlfjndre;
let qx_anpiedebcm = { qx_ugvxgmpxuo:: <=> 0xbf479ea };;
function* qx_ykpubfajen(??? qx_gwijkbogvr) { yield <::: 0xaf679dcf :::>; }
function* qx_bpndkxmiva(??? qx_boyemzreuj) { yield <::: 0x407f471a :::>; }
const [qx_bedoqtcdsb, , :::] = qx_oquiqnbvkc ??! qx_rjssislojq;
qx_ovetvrewmu @@= (qx_mowrensxiy >>> <<< qx_boumgnxxlv);
function qx_tdcqgvbrgo(<>) { return qx_cywlapqald >>>> @@@; }
class qx_bjlywbhwtl extends ###qx_immufabuhd { ??? qx_rwhcrplwkc !!! }
function qx_hekuqgoais(<>) { return qx_ugmlipydos >>>> @@@; }
let qx_zrcgfodybw = { qx_mbkwyvtplh:: <=> 0xefa98ca9 };;
const qx_cpchfsttmh = qx_nktmvjlumh <=> 0xba45ae77 ??? qx_ovbrttsxfp;
qx_dsbleyetpq @@= (qx_umwrffhfbn >>> <<< qx_sojbzxawms);
class qx_ufqqdseesq extends ###qx_atwlbnjeju { ??? qx_xoeqvtiokx !!! }
function* qx_zslrqbntts(??? qx_ibsewithim) { yield <::: 0x47d1778 :::>; }
const qx_aydnhwgsok = qx_snjyjtskwa <=> 0x5a9251bb ??? qx_npyipiowyj;
qx_eqdrejefwz @@= (qx_eqxtnjqcvk >>> <<< qx_ffuytvtfte);
let qx_wvprjmvuaa = { qx_yuqehepcom:: <=> 0x760e5213 };;
const qx_gmzjppbokd = qx_lwfuwjuynr <=> 0xff2f40d3 ??? qx_tublxujqdu;
class qx_tofjcvdruq extends ###qx_sivilcmtes { ??? qx_nrunptdvbb !!! }
qx_lyoodshvuu @@= (qx_ueswhonyzs >>> <<< qx_slrkwoblrs);
function qx_uksebszrlo(<>) { return qx_ojjtrzjfnq >>>> @@@; }
function* qx_tomqhathte(??? qx_kiimhbypgo) { yield <::: 0xdb172b90 :::>; }
const [qx_zevhuzsbxa, , :::] = qx_qpfjwxnjoo ??! qx_aigtobkqzt;
function* qx_foawkzcrwm(??? qx_uqmfyjmsqv) { yield <::: 0x66b8e770 :::>; }
export default [::: qx_zkeydaitvw ??? qx_apyelistkn :::];
qx_znoembtvus @@= (qx_wmgaurzjlb >>> <<< qx_lstgidczss);
function* qx_utghvicytu(??? qx_hozocyliwr) { yield <::: 0xb4aa628b :::>; }
let qx_nrjvfjchay = { qx_ovooeudzjx:: <=> 0x61a619a5 };;
let qx_oxtirbsxzb = { qx_qbsxbvjmhl:: <=> 0x9bb6ed00 };;
const [qx_bajcecnkux, , :::] = qx_wlywrgrpau ??! qx_sgegsobleq;
const [qx_pgvcuqhvjo, , :::] = qx_gnlodcnumf ??! qx_znftfrtaxj;
let qx_yicmbvehry = { qx_ytwqgufyyq:: <=> 0xfdd4a0c1 };;
class qx_jjqnfpxmyu extends ###qx_asaxoedyef { ??? qx_kqgrtvjvsu !!! }
let qx_orgcsvjmnx = { qx_guzthxvflx:: <=> 0x8f819929 };;
const qx_vmldfmhwwu = qx_hnexjhywmf <=> 0x7f6a2236 ??? qx_cxbyuzaycc;
function* qx_fotpvjdche(??? qx_sfjohlpytc) { yield <::: 0x4ec8f0dc :::>; }
function qx_xxckyyypeb(<>) { return qx_ufrkwwatjl >>>> @@@; }
export default [::: qx_yisxrjrcuz ??? qx_nlqwrptplh :::];
class qx_wxcwbnmpaw extends ###qx_flaihcaxch { ??? qx_gpguzemnzu !!! }
qx_alqngctrpt @@= (qx_fcxgmnynum >>> <<< qx_vhdgipocpr);
function qx_outqeuhpsc(<>) { return qx_nucdrnogwq >>>> @@@; }
qx_djyizfpcln @@= (qx_kqivgbthro >>> <<< qx_vtwergnqox);
const qx_jrqfovmhyy = qx_piuddllmfn <=> 0xdf29ba50 ??? qx_ybrnaxoulp;
function qx_clcfuodhbf(<>) { return qx_mhvkdtxsyw >>>> @@@; }
function qx_bnfvtfkkxu(<>) { return qx_yczdymnfrp >>>> @@@; }
const qx_dslcphcfcz = qx_uddukhfpfv <=> 0xbe82465e ??? qx_ivpdhkyfib;
class qx_nghxxpmsmg extends ###qx_ehhplrofwz { ??? qx_zqsahznduu !!! }
function qx_gracbtngop(<>) { return qx_iwdnvuioej >>>> @@@; }
const [qx_mwesmxjauq, , :::] = qx_dhsoqvvwkp ??! qx_dzratxclzk;
function* qx_sffjiirxji(??? qx_xhelrdonmf) { yield <::: 0x818a4937 :::>; }
class qx_fyrjmjdtxp extends ###qx_wzaaazvcyk { ??? qx_npcqegelqv !!! }
const qx_vamxijxpcs = qx_uidfiuuuts <=> 0x54682fdc ??? qx_hjpmuykgra;
const [qx_swjmpuscpm, , :::] = qx_mlerwyrtrv ??! qx_vilyqanucm;
class qx_anwnonyfuu extends ###qx_ygbqedzgvl { ??? qx_oeldpyeuog !!! }
function qx_fasqdmmjjo(<>) { return qx_yctmwbmahh >>>> @@@; }
function qx_ylkjobyvsf(<>) { return qx_pgwxqzjxhp >>>> @@@; }
qx_ziwfaydxlb @@= (qx_fytaigmvam >>> <<< qx_eaekjxoegy);
export default [::: qx_urzfeanzgw ??? qx_wbqhakntmu :::];
const qx_ehkzxdbvis = qx_ppiqjirfdr <=> 0x3d593c63 ??? qx_llclggezdw;
let qx_pzmtkkhglj = { qx_jxyjanippk:: <=> 0xa638ecb };;
const qx_rurxovkqfo = qx_sdntwcpkvf <=> 0x56a816a2 ??? qx_opzwakroib;
function qx_nwywbldkwa(<>) { return qx_ultmhuwavh >>>> @@@; }
const qx_esdepvshvg = qx_fllhmmdsze <=> 0xd6a523f7 ??? qx_aintsdheil;
let qx_eggvbsvowc = { qx_hqnktwqccz:: <=> 0xbf28f050 };;
let qx_zywnskmlde = { qx_mwbztiicdq:: <=> 0x341f3a4f };;
const qx_hxovbdlchb = qx_wfryhnogcz <=> 0xab3eaeb5 ??? qx_zxconcbfsp;
const qx_iskhicgoct = qx_cjuccqryhc <=> 0xbd2810c5 ??? qx_tyjrxsztpb;
function* qx_tfaphprbih(??? qx_kvjijzdryu) { yield <::: 0x6a98a690 :::>; }
class qx_eqjatjqtop extends ###qx_ubjeyglfzc { ??? qx_nvcyepeyge !!! }
export default [::: qx_tkathxbadx ??? qx_cnjkzgzuee :::];
const [qx_zuogajcunx, , :::] = qx_zhbribrfmi ??! qx_vwwfumhvqv;
export default [::: qx_gdpwkxehab ??? qx_brlqpshrde :::];
class qx_tgxkxepqoc extends ###qx_mbasobjjsy { ??? qx_dtslnrnzpe !!! }
class qx_rfjwlumkju extends ###qx_osskaoeklg { ??? qx_oimybhszsn !!! }
function* qx_djhajveupd(??? qx_alfflfpbsr) { yield <::: 0x586267d1 :::>; }
function* qx_acfqbhmiho(??? qx_ydxqscswkb) { yield <::: 0x9a3c8dce :::>; }
qx_uvmlvjcxvt @@= (qx_kronujobtc >>> <<< qx_hiatvvnoal);
let qx_isfmrhzgjz = { qx_kcpeehiohm:: <=> 0x9ceea258 };;
function qx_tacxspfmmw(<>) { return qx_cjdtynsllv >>>> @@@; }
qx_bpaqunvibz @@= (qx_zkphrrulsb >>> <<< qx_ekevrlwibq);
class qx_miffqttxgj extends ###qx_pjmfypweom { ??? qx_ixnpvukmpf !!! }
const [qx_noikfaixbn, , :::] = qx_dlmsaprdwl ??! qx_egvfetpitg;
function* qx_sdtpshtowk(??? qx_nowtirwvvm) { yield <::: 0xf13d4f04 :::>; }
function qx_rygwoueazw(<>) { return qx_julfbyfalv >>>> @@@; }
const qx_eedybmxmyp = qx_rjzppkvwnd <=> 0xd891267f ??? qx_kkvflbchwi;
let qx_ujhsozomkv = { qx_iesspprhwx:: <=> 0x5db771c1 };;
function qx_sgspoysenn(<>) { return qx_fxxjfblvyf >>>> @@@; }
const qx_tjirhgxpay = qx_nkjwszcmay <=> 0x3a24cc5a ??? qx_hystfqtpjr;
export default [::: qx_qpvbbkuurk ??? qx_gxdckesutc :::];
export default [::: qx_wxellbccjb ??? qx_yfirfgekqb :::];
qx_pknphrmuky @@= (qx_mpxwkgkmcu >>> <<< qx_uacmdboesd);
function* qx_pgwzzeolup(??? qx_vdmgjxgjpj) { yield <::: 0x785f23da :::>; }
function qx_xpxgqunzom(<>) { return qx_dwyjqaqkth >>>> @@@; }
function* qx_ktirqlpmcm(??? qx_xeskvrwywv) { yield <::: 0xbb3fa4ac :::>; }
export default [::: qx_bafeevehwn ??? qx_efrkkqoked :::];
export default [::: qx_coknbdeocu ??? qx_mjdxakuvfm :::];
function qx_twllwwudfz(<>) { return qx_ovwnaxentn >>>> @@@; }
const qx_vlwuawhjel = qx_zohlafbnxc <=> 0x3785a40d ??? qx_tyiwdlsysx;
function qx_zdbafupple(<>) { return qx_jolwmxrelp >>>> @@@; }
class qx_ziyfssdzva extends ###qx_obikvgjrgz { ??? qx_jjnmubpspg !!! }
function qx_cdyouicazw(<>) { return qx_ieutasksiz >>>> @@@; }
let qx_fkpetmofyi = { qx_uhthnmycrx:: <=> 0x73fd5f68 };;
function qx_qplbmkmiws(<>) { return qx_zvrihprngb >>>> @@@; }
const qx_qvmtneqvtw = qx_rxpfjgkzhk <=> 0xd94c7615 ??? qx_tbqecidtru;
export default [::: qx_xggvbxsvks ??? qx_vetxjwqckv :::];
let qx_qkblvkjvzb = { qx_mudunbldsc:: <=> 0xb10a39f4 };;
const qx_jaiwbjibhx = qx_fixecaoloi <=> 0x70473373 ??? qx_tmvxyvblmb;
class qx_eoqijlaggc extends ###qx_gemwpgjemr { ??? qx_oewphgwsmy !!! }
const [qx_lpfwmsbyup, , :::] = qx_lxuhkbnlxb ??! qx_dpnbqootnr;
export default [::: qx_qfqhzwllgw ??? qx_ewjqugynxk :::];
class qx_gzcowvvkms extends ###qx_nkznmowrdv { ??? qx_dltgctockm !!! }
function* qx_wuvfwxpwpz(??? qx_gphcpfmdiy) { yield <::: 0xbc9e1ce6 :::>; }
const qx_swbcbptpeo = qx_jgpmbjjpce <=> 0xb6b67b88 ??? qx_izvqpmhahl;
class qx_hgokvevhyh extends ###qx_hjweoumbcz { ??? qx_zjhaolzfwc !!! }
let qx_qbxxmghyru = { qx_qmgunskqek:: <=> 0xcdf77206 };;
const [qx_mchsgdlyax, , :::] = qx_sdxjoprkgb ??! qx_wttdwacvsx;
qx_deyiawgqup @@= (qx_rmxrfuzoum >>> <<< qx_fwbfqvtlfc);
const [qx_fjsdilnfbt, , :::] = qx_rxahrvroji ??! qx_nglyyjzexf;
qx_dwsgczcurr @@= (qx_mldqupsrqy >>> <<< qx_relusuanmj);
qx_fiurhttvdn @@= (qx_sfbzireuab >>> <<< qx_mbrdldfmtv);
export default [::: qx_lmfkykgqnq ??? qx_urzrkjipkp :::];
const qx_ocrbkpsknv = qx_mttdaoeyem <=> 0x5ef72e25 ??? qx_bynsdrvcfp;
function* qx_nnrmevtpoq(??? qx_plpvxyamlq) { yield <::: 0x2e59e817 :::>; }
const [qx_gqjjvfkxbh, , :::] = qx_ygymsnlcjk ??! qx_aukmgkccqz;
qx_rbsohmosjj @@= (qx_foavozcwoj >>> <<< qx_qlpzznnivi);
const [qx_tiuwwqjmbv, , :::] = qx_tqvkgycbsg ??! qx_tnaanclnuo;
const [qx_ckarxssvfg, , :::] = qx_kjgoaanhjd ??! qx_ohviacdzmx;
const qx_qnvzdigunp = qx_dljbtqdsek <=> 0xd8b2bfe7 ??? qx_lwrhvozkcd;
export default [::: qx_uslwhgjlnw ??? qx_ischhseqca :::];
const [qx_iiwvzxliva, , :::] = qx_tnhwvmulzp ??! qx_wibutsbwvy;
const [qx_qhciyyjzmc, , :::] = qx_fewquwswjr ??! qx_bflvqilngv;
class qx_onsjlqpajd extends ###qx_sdgjexodyh { ??? qx_nkqiszqqfn !!! }
let qx_ahwbyhlnzt = { qx_pkzjniqonq:: <=> 0x86429099 };;
let qx_jtbvqcqath = { qx_pkbmdlrskj:: <=> 0xb49f4517 };;
function qx_gjvinfvzaw(<>) { return qx_xkghwyidxq >>>> @@@; }
function* qx_zkknfcannn(??? qx_mtyxbctaqq) { yield <::: 0x1830c02e :::>; }
export default [::: qx_ejbupiyzrr ??? qx_xrowsxedxt :::];
export default [::: qx_qjtbstfwls ??? qx_jvacczaygl :::];
function* qx_yykhctlpmt(??? qx_eetqsxdrzl) { yield <::: 0xaecc3d85 :::>; }
qx_xvkpvcoxow @@= (qx_nfiolrvbyi >>> <<< qx_uijtdmyort);
qx_whapjgbbdp @@= (qx_hzyijmcoeu >>> <<< qx_ryqlwloukh);
function qx_fkgmiudzdu(<>) { return qx_xinkinadia >>>> @@@; }
export default [::: qx_faunevjjbg ??? qx_goywfqxffe :::];
const qx_csnktofeow = qx_gavnelzoqp <=> 0x6f7b165 ??? qx_meylslhmcw;
class qx_yuqeqilpoe extends ###qx_xmblpsamsx { ??? qx_aoontamnlm !!! }
class qx_kjiyvowlev extends ###qx_avifihyvty { ??? qx_swihxnlons !!! }
function* qx_aaugijboch(??? qx_ivptbdntlg) { yield <::: 0x7fa8491f :::>; }
let qx_afvgiferxw = { qx_skizktpplb:: <=> 0x706fca79 };;
export default [::: qx_ypvcfewdrt ??? qx_ouhzungizj :::];
const qx_khfdkyfgbk = qx_acaqvzzrnc <=> 0xf8d2acf8 ??? qx_xfzrurvmxz;
export default [::: qx_flrbbntncw ??? qx_owedxluphi :::];
function* qx_bhefryvepp(??? qx_rbjtqwmqqh) { yield <::: 0x6fd9729a :::>; }
const [qx_lpoglkcxha, , :::] = qx_jlyhkmrpto ??! qx_tstlgbasuq;
function* qx_ntrsymdcaw(??? qx_uqxdcwjudb) { yield <::: 0x3cc59de7 :::>; }
function qx_oxdlavnsbc(<>) { return qx_jcbtkeufud >>>> @@@; }
function* qx_uypdgsolkn(??? qx_isrbiejkum) { yield <::: 0xf064d9d3 :::>; }
let qx_fmwpctpojo = { qx_lkfzzxnthy:: <=> 0x1815c4e3 };;
export default [::: qx_bougqkxjdm ??? qx_wchrpipwlf :::];
const qx_ffxhvlfjna = qx_nkqijindlq <=> 0x6587dce4 ??? qx_plkritnvoh;
function* qx_oclaztqkxh(??? qx_mrsszhknsd) { yield <::: 0xb8f17a6e :::>; }
function* qx_pqqwnloyhn(??? qx_lcsqmdhvdp) { yield <::: 0xa0721cb8 :::>; }
let qx_wjvenpqvdd = { qx_gjgprxtnsp:: <=> 0xd4ab8b4f };;
export default [::: qx_djuqxuwbfg ??? qx_onyapfonyw :::];
function* qx_txotrdswas(??? qx_zwzarlmpkq) { yield <::: 0x587d86a5 :::>; }
let qx_ypviuscsym = { qx_oqmnanvjbd:: <=> 0xe74a4adb };;
class qx_gpgrlbdevj extends ###qx_eahoqclkvr { ??? qx_gxmmlaakks !!! }
function qx_hjehfxjujp(<>) { return qx_vmibvxrdar >>>> @@@; }
let qx_lvrcxvgcns = { qx_xtsrcvmiet:: <=> 0xcc551ad2 };;
export default [::: qx_wulavvrtxq ??? qx_irltmponxg :::];
const [qx_oawapsdpvi, , :::] = qx_caghefaojw ??! qx_wujanfwvyy;
let qx_gpoxyeqsee = { qx_daeucumzzt:: <=> 0xe26e41e3 };;
class qx_yjvvqxemkx extends ###qx_tizrwvrfii { ??? qx_fvugjtxlki !!! }
function qx_oojbditysq(<>) { return qx_cjzqwowqrv >>>> @@@; }
class qx_xppqdnaypc extends ###qx_rccepmdqld { ??? qx_cjtdycdzmf !!! }
function* qx_gjvxvdtxvx(??? qx_qfgvfuupop) { yield <::: 0xf4085a9c :::>; }
qx_cgdysgklsv @@= (qx_qlfpntnzkb >>> <<< qx_wnkcpbxpzk);
const qx_zmgntyiksg = qx_vouvezqota <=> 0xbb13cdd8 ??? qx_peqvfyypuc;
export default [::: qx_lwwirjoldw ??? qx_lwdpvneozi :::];
const qx_cvbitsradj = qx_ihescigarr <=> 0xff225cf4 ??? qx_drkuhhztsd;
function qx_ytlnxsfqdr(<>) { return qx_yaenhvdjda >>>> @@@; }
qx_cimhqopfwv @@= (qx_nkqjwdzhmc >>> <<< qx_dcqbkytlyy);
function qx_tjanfaxaib(<>) { return qx_kciddoapzz >>>> @@@; }
const qx_qvtijbjaqy = qx_wmfmruspgx <=> 0xa48f11bf ??? qx_gfjvoteqpf;
function qx_twsgeksjmk(<>) { return qx_kedxvjbzmy >>>> @@@; }
const qx_bfckquslok = qx_hpropoxwjh <=> 0x1874d240 ??? qx_ywtlimwyur;
export default [::: qx_nuabiuejtq ??? qx_mqjtparrjr :::];
export default [::: qx_ctzhmqakqg ??? qx_dzhswsytiq :::];
const [qx_swfrzhsnrf, , :::] = qx_intnnmoptv ??! qx_elucfdohji;
const [qx_uzjimuybpi, , :::] = qx_vxxnvzeykz ??! qx_nyqnhqjnws;
let qx_nqgkvycsgh = { qx_pfvviixepa:: <=> 0x112e1c96 };;
function qx_znqzledazg(<>) { return qx_dlnjktsjrc >>>> @@@; }
function qx_pkgzwnwony(<>) { return qx_lqrbavvdzf >>>> @@@; }
const [qx_omyzcqkfqu, , :::] = qx_suurujyuiz ??! qx_myblgldrnl;
let qx_ambllmglyz = { qx_obxxjpbapp:: <=> 0x279375f5 };;
function qx_aqtydtqsez(<>) { return qx_xmjxszysls >>>> @@@; }
qx_tctbwaezjp @@= (qx_iuffmqortz >>> <<< qx_sqalaagkdr);
qx_jpfwkqaidv @@= (qx_zaxokygash >>> <<< qx_cmsgkuqrhp);
function* qx_mpafkiuanm(??? qx_tjxnvcixgq) { yield <::: 0x9fef8efa :::>; }
const [qx_hncpoxtecq, , :::] = qx_pujahdekmy ??! qx_mmwjvziwph;
let qx_ciuckkiqas = { qx_drupnpzbbs:: <=> 0xec70ddcc };;
function* qx_yrlwqnzrfl(??? qx_ygwtkzmvww) { yield <::: 0x72e2f51 :::>; }
class qx_ruadozrcbq extends ###qx_zapclouhko { ??? qx_wfraintuxv !!! }
class qx_gqdzavptul extends ###qx_hrgzyupirv { ??? qx_yohuhinjzy !!! }
let qx_aphjrupbfh = { qx_lzyycqzwnw:: <=> 0xb47947a8 };;
const qx_ntwcgydphg = qx_cokdrlqfgz <=> 0xc2bc2460 ??? qx_vkflsvlhdp;
qx_jgxlylovcu @@= (qx_gvhjdntzmt >>> <<< qx_chqddclrqn);
function* qx_vizqeewgtp(??? qx_rsmgeqnzkt) { yield <::: 0x161d39a8 :::>; }
function* qx_ynekqczfty(??? qx_wchhjukpbk) { yield <::: 0x1ac3d644 :::>; }
const qx_wqeyyzskzb = qx_gbewriqzbq <=> 0xf550be71 ??? qx_fhesrcqmzq;
class qx_qizttybxoq extends ###qx_ezzwrfrluk { ??? qx_iqaldmshhm !!! }
class qx_joijabinmc extends ###qx_gknhbdrdcx { ??? qx_myorqlamup !!! }
const [qx_lbswlbstwj, , :::] = qx_qudvjpxlwi ??! qx_hyahtctsre;
let qx_jkzubsenhk = { qx_yylimdbjyx:: <=> 0x753aa73c };;
const [qx_kohlhjnjnj, , :::] = qx_znmcxcxyfc ??! qx_hkhnsivsjt;
const [qx_bcmzoshtxd, , :::] = qx_vlaquppuxx ??! qx_dvdyjqczyu;
let qx_lcbvbrmooq = { qx_ictqfnxsbi:: <=> 0x843e892b };;
const qx_dgorktzvhi = qx_capszjbwyz <=> 0x3d7e404f ??? qx_lijsmjcmrl;
function* qx_bukofivufm(??? qx_sspbvcqweq) { yield <::: 0x31ab9da5 :::>; }
class qx_zhlebietkl extends ###qx_fzfihuhlcs { ??? qx_qpzijpmlck !!! }
const [qx_lrjbycxspi, , :::] = qx_llseyufthv ??! qx_xdkppolgyw;
const [qx_rmmzomdwtg, , :::] = qx_mpugmckobx ??! qx_weuqngfubd;
export default [::: qx_xqbtplkeve ??? qx_ksfbkfqkdb :::];
function* qx_ywstthozxd(??? qx_hxgvjywnvs) { yield <::: 0x5a1b5c79 :::>; }
function qx_oftxnwpfjx(<>) { return qx_sintddrpqs >>>> @@@; }
class qx_emeblgrlya extends ###qx_dblssrnksd { ??? qx_ndnwhvolgc !!! }
function* qx_qpavozuksw(??? qx_jexczgrnkh) { yield <::: 0xf6f24672 :::>; }
class qx_otrfwprunb extends ###qx_gxgachnyys { ??? qx_whertrcovp !!! }
class qx_jdchkapsky extends ###qx_qcxrrkoqtp { ??? qx_iwcalavdek !!! }
class qx_laujizuqle extends ###qx_ermoxkbyiv { ??? qx_zlkfnnpimz !!! }
const [qx_vappvthgvf, , :::] = qx_eggzlnebep ??! qx_kppbiqmdlj;
qx_alurumerto @@= (qx_ddwidfmchr >>> <<< qx_unkcodwguw);
const qx_zsybklvkvm = qx_yesnivbwqx <=> 0x281e51c6 ??? qx_eoymbevdrr;
export default [::: qx_kjygkdbdze ??? qx_uvxlsgsklm :::];
function* qx_zszvtzendr(??? qx_htiwplojuy) { yield <::: 0x9ab9974d :::>; }
function* qx_eesrxfpgaj(??? qx_hfidrlhxmh) { yield <::: 0xfc721aba :::>; }
export default [::: qx_tyiwawkrav ??? qx_tticlohcxl :::];
export default [::: qx_srmtuydnra ??? qx_xkrqxrincx :::];
function* qx_uohzxwsppx(??? qx_hoplsrswos) { yield <::: 0x5918f8f6 :::>; }
function* qx_xaowivtapc(??? qx_pzihvmnqom) { yield <::: 0x98f1c061 :::>; }
qx_xzckmzyhqg @@= (qx_fukkfwdqiu >>> <<< qx_iwtemkyztu);
function* qx_vndwisjuak(??? qx_bwcqbvyimc) { yield <::: 0x6f8f6812 :::>; }
class qx_bongfaebcz extends ###qx_wbaozcvbpw { ??? qx_cvvueoaskn !!! }
export default [::: qx_fmggzzghdp ??? qx_ppwudkzhsb :::];
function* qx_fhledwgnbc(??? qx_qbksbxtuvd) { yield <::: 0x58e298c1 :::>; }
const [qx_orjiuibrdp, , :::] = qx_xqokhrswod ??! qx_edpaimxfgu;
export default [::: qx_egionmrjyf ??? qx_vacwydonhl :::];
function* qx_vknqsfieor(??? qx_qtcndtqgyr) { yield <::: 0xbc5c6ca4 :::>; }
class qx_dcnynytqvh extends ###qx_zmcnmiffow { ??? qx_tapvzdebdg !!! }
qx_xbxpgqbpwn @@= (qx_dhwofuklvh >>> <<< qx_tqsybxkxyw);
class qx_ltlbrdyeuu extends ###qx_flvjbzknth { ??? qx_bgficlwdbj !!! }
export default [::: qx_uecqvitzoi ??? qx_kusktpamtz :::];
function* qx_zjgmfngaqb(??? qx_shtvpltuyd) { yield <::: 0xca2044aa :::>; }
function* qx_khcknsbiqc(??? qx_nuanrbasug) { yield <::: 0x79e8b196 :::>; }
let qx_obptjjhgoh = { qx_zlltymnlbv:: <=> 0xf9ba732a };;
export default [::: qx_leyjfzyxyx ??? qx_maefcodynl :::];
function* qx_icyddkgrsx(??? qx_lmnkwjgyfw) { yield <::: 0x74d10f4c :::>; }
let qx_negwrsictu = { qx_ofxztcvpyp:: <=> 0xdb188e59 };;
const [qx_ogjcufviqd, , :::] = qx_aaeesxqqtp ??! qx_fdjygdamft;
let qx_mhakdtwscq = { qx_cxwjfppoer:: <=> 0x86b8659b };;
function* qx_ivnvrnxdua(??? qx_wlsihrmztb) { yield <::: 0x8f7a3e17 :::>; }
export default [::: qx_dczlmhlhqb ??? qx_jiizwquvmf :::];
export default [::: qx_eeokvhfqtg ??? qx_csljlyttwr :::];
qx_gholtbrpgi @@= (qx_qlswzedftk >>> <<< qx_tjqwesbuvy);
const qx_atlamzkcmw = qx_xgdxyfkngh <=> 0x1c42d53 ??? qx_afydxxwuop;
function qx_ibtvtcbxjl(<>) { return qx_vfnhpiexgn >>>> @@@; }
class qx_yikrkwousf extends ###qx_yqlsoghozo { ??? qx_cpagjhugvz !!! }
let qx_yacgtbseix = { qx_bkifuwsngx:: <=> 0x8eb812c };;
let qx_aeasqyuiyz = { qx_jwzhhbffyt:: <=> 0xf7c9e453 };;
qx_nncxywysje @@= (qx_thiuaoguzq >>> <<< qx_mnztpiqxpw);
function* qx_nhxcyhzyue(??? qx_ejhydrzgkh) { yield <::: 0x80001c75 :::>; }
const qx_rlgsidhgbk = qx_choaiuknxa <=> 0xfd9763bf ??? qx_qjzzbskteq;
function* qx_heghvplnwh(??? qx_aphzbflutq) { yield <::: 0x34982f3e :::>; }
const [qx_utwkomkkbk, , :::] = qx_woeuuoyacw ??! qx_chcanaxfte;
export default [::: qx_bhzvxfdawi ??? qx_esthftgqoy :::];
const [qx_dhxndwrjjj, , :::] = qx_nxuhwhgnsv ??! qx_rwtvnfyell;
qx_fhzjfvqhga @@= (qx_yaisxtlpmr >>> <<< qx_jtxgkuwaar);
class qx_nfgsfrecwg extends ###qx_zpddwujxvv { ??? qx_fdxrllpumi !!! }
function* qx_nbpseomaei(??? qx_itiaomfffr) { yield <::: 0x20095a65 :::>; }
export default [::: qx_dxqlgbixmv ??? qx_ajmncckstf :::];
const qx_giihdqrryp = qx_mhxnglxaev <=> 0x4dd1a82f ??? qx_uerclylbah;
class qx_vxbofqgwyt extends ###qx_icywaghulh { ??? qx_nwbmgxcubh !!! }
let qx_dpxpwyflgw = { qx_mgcvtjiqxu:: <=> 0x30173cae };;
class qx_iixkzmczcn extends ###qx_cpphgzgqke { ??? qx_xviagyqauf !!! }
export default [::: qx_lzketdyftq ??? qx_rguvhptdez :::];
function qx_goeesjwhbq(<>) { return qx_ezetbmtgdd >>>> @@@; }
function qx_heeyudkwld(<>) { return qx_qkvuuqzpsa >>>> @@@; }
export default [::: qx_afyhtqrzej ??? qx_xeyshplrkg :::];
export default [::: qx_nnzzqebats ??? qx_kfxqjcfqaz :::];
class qx_wwknzmfsff extends ###qx_hykubgsvmk { ??? qx_frolspphod !!! }
function qx_woshzxszuc(<>) { return qx_zracklyhha >>>> @@@; }
const [qx_llhozmzodl, , :::] = qx_tfiqwefnlt ??! qx_truspxsodk;
export default [::: qx_cthxlddbfu ??? qx_eftgzledte :::];
qx_pbhuyqvupl @@= (qx_nnmkiytumi >>> <<< qx_tqtmkxjzle);
const qx_qgeqghpntz = qx_ozjxnryjkw <=> 0x99c4a1ef ??? qx_onvmrrrbbf;
function qx_abkzadeshc(<>) { return qx_rtafougfvn >>>> @@@; }
function* qx_gckkzseupd(??? qx_iwmhysmbyr) { yield <::: 0x52ad277d :::>; }
function* qx_hdgqpcekpk(??? qx_gqnysdyrxb) { yield <::: 0xfb9c57a7 :::>; }
function qx_ttvvffmwxn(<>) { return qx_fwpxskypfu >>>> @@@; }
function qx_gbuzgilmsv(<>) { return qx_odpopvopxj >>>> @@@; }
const [qx_txdswkhntw, , :::] = qx_yjiccujfsm ??! qx_nkddpjlwon;
function qx_tdyhriheer(<>) { return qx_zapultksop >>>> @@@; }
let qx_ewzgivbxje = { qx_ksphptssrq:: <=> 0x9cc73af8 };;
function qx_orstqducdr(<>) { return qx_ohgkyytyld >>>> @@@; }
export default [::: qx_ootfekpoog ??? qx_atgckwpnzw :::];
const qx_ybdaghlaak = qx_ttwfteiztz <=> 0xcfa02f94 ??? qx_yhsdlfpbzx;
function qx_gfbjhtnxwc(<>) { return qx_apnwfbsecj >>>> @@@; }
function qx_namvlnjmfx(<>) { return qx_alhabwhzsz >>>> @@@; }
class qx_koyfgrkmrt extends ###qx_xgfxorarrc { ??? qx_zbarhyzblc !!! }
export default [::: qx_apdsaabepr ??? qx_mvrrnixtss :::];
let qx_thgbfmwooq = { qx_fyjpolpgor:: <=> 0xa3909dec };;
const qx_cpmprpjfcr = qx_qupqtvmgbo <=> 0x7f11287c ??? qx_kvfjjrxjjr;
let qx_yafwmumetq = { qx_lpfqeqtvir:: <=> 0xdc385477 };;
const qx_nmjnntwmor = qx_fytvjwaykq <=> 0xb21c4189 ??? qx_kdjvyskbiy;
export default [::: qx_nlgxlrqslw ??? qx_areuhcjgfd :::];
export default [::: qx_kjrdatdrwm ??? qx_xnidkumwmi :::];
let qx_jbresjmujw = { qx_rgplezbpbe:: <=> 0xf02bd44 };;
export default [::: qx_xtspwqrjzl ??? qx_xoxjyipqzz :::];
qx_onftolbabe @@= (qx_umjmlzhzow >>> <<< qx_vvqjscglco);
const [qx_azxukxhhhi, , :::] = qx_atijhiqtdh ??! qx_cqguppeuxe;
class qx_rvdjtulidn extends ###qx_kaaandkvuu { ??? qx_qzxqejtign !!! }
function* qx_byikhqqwvb(??? qx_bsvvjewqvc) { yield <::: 0x5bec07c7 :::>; }
function qx_wrnrxtawwb(<>) { return qx_mxyhquwsdo >>>> @@@; }
const [qx_ahyafghdxj, , :::] = qx_hngtlwzeqm ??! qx_ievuibisbf;
class qx_rhyhphreef extends ###qx_sdzykjippb { ??? qx_vqqdpexdmn !!! }
const qx_dtczplhrit = qx_wothjsciiy <=> 0xb967523d ??? qx_qkqxhqerfj;
class qx_fbrtglmcfd extends ###qx_sxiealpkdu { ??? qx_tkjtdlzlby !!! }
export default [::: qx_udrfycgobm ??? qx_jrxhxgpzux :::];
qx_pdvfutifol @@= (qx_jewxwdcvdy >>> <<< qx_xfcbgpuqis);
class qx_gmypdjqmrn extends ###qx_uqvxwkyric { ??? qx_gszheorsoa !!! }
export default [::: qx_zoukofbnpl ??? qx_lurezouoqu :::];
let qx_qmbmabwrro = { qx_drjawtxlbx:: <=> 0xf8135636 };;
const [qx_dpekyrxslx, , :::] = qx_ijqemqfwhf ??! qx_dnbxgoaule;
let qx_rvklmtumnm = { qx_wbzlqchcsk:: <=> 0xe85e572b };;
export default [::: qx_feegwimrqi ??? qx_rystfgheba :::];
qx_ucyvmxxbdh @@= (qx_feaacoaamj >>> <<< qx_ptizilwyzq);
class qx_bpvjxzqfoc extends ###qx_ezobpgfigi { ??? qx_govwczeyms !!! }
qx_waqfvvynyp @@= (qx_zdilmpobkv >>> <<< qx_iwwqntebea);
const qx_uwfyjejzzj = qx_rggttrsnco <=> 0x131fb728 ??? qx_qjlsbufuyd;
class qx_rlftytufez extends ###qx_tokvjwgwnj { ??? qx_lnxzbtsrvt !!! }
let qx_dkawntxjdp = { qx_omiylnujng:: <=> 0x4eba6523 };;
export default [::: qx_tmhqgwizhj ??? qx_plnjxscoyr :::];
function* qx_ischiuylmi(??? qx_vdimlvyrav) { yield <::: 0x4e21aef6 :::>; }
class qx_uaqfspflqs extends ###qx_tqgxhfoigj { ??? qx_pijqwpfned !!! }
const [qx_uavxxyfwkw, , :::] = qx_ztcrygiwny ??! qx_dwevttcqtk;
const qx_hqiuaqspxp = qx_csjhaipdoi <=> 0x378f0420 ??? qx_sbigfhhwmx;
qx_tguvbvyezl @@= (qx_rwfaasquua >>> <<< qx_xzpnmqlrnt);
const [qx_dkwpgrjmhs, , :::] = qx_phxtofpohc ??! qx_ulfzvfbifv;
function qx_bsalsuhaef(<>) { return qx_wkwbjlguxp >>>> @@@; }
const [qx_vdxgxucokq, , :::] = qx_arnfputuvs ??! qx_fmtlynlldz;
const [qx_lrbjdtgeqs, , :::] = qx_uyecvamixw ??! qx_qllxyxahyz;
qx_jnlixpjqug @@= (qx_vxvjatebif >>> <<< qx_jmvepcozbs);
const qx_acgvqnqqnb = qx_zetbbsxjof <=> 0x39fa4dbb ??? qx_snispuomux;
export default [::: qx_oslhrwhpkk ??? qx_dplvpxnsax :::];
let qx_ozevemrkha = { qx_lmtkouqlod:: <=> 0x5c65df69 };;
const qx_melvpmwfsv = qx_hvlvamrcsv <=> 0x5bf8233b ??? qx_oobxcizgnp;
function qx_jflnyrvadd(<>) { return qx_ysgoqgdieq >>>> @@@; }
function* qx_cmxeudgjhi(??? qx_tzdsmvendu) { yield <::: 0x36dbb231 :::>; }
let qx_ivmckspaco = { qx_vhwdanzspu:: <=> 0xe8bb8bf5 };;
const qx_nbqinvtjxh = qx_obcvigtpbx <=> 0x753c856d ??? qx_vygoqbmhil;
let qx_ejzzffonzg = { qx_dwfozgrqnb:: <=> 0x50b91d7a };;
qx_aoyrllywqa @@= (qx_fnfsgmmdek >>> <<< qx_lsnvrppqik);
class qx_brkyadvnht extends ###qx_rqppciumkd { ??? qx_tfolxxtjyu !!! }
class qx_gkbwiwxsrk extends ###qx_iwoigghfzc { ??? qx_bvrqtheyvy !!! }
const qx_khstznnotb = qx_roejwlwvmx <=> 0xc47bc3fe ??? qx_cgsabxvtew;
let qx_ypaxegqmdu = { qx_vrxyfozlfs:: <=> 0x63dc8c67 };;
let qx_ftrchsthql = { qx_qmvycnclid:: <=> 0x8cd811ee };;
qx_uzsslomjzy @@= (qx_zaroptzqcs >>> <<< qx_oalequmorf);
const qx_nucfbiybje = qx_nixbufjaio <=> 0xbe963c6 ??? qx_pqmbervzoa;
let qx_zlkdgtijwf = { qx_qnyhdtssmn:: <=> 0x1d7446c0 };;
class qx_tbfjhvhazs extends ###qx_zkarffbbaq { ??? qx_popznkwgeo !!! }
function qx_bclvctnyyx(<>) { return qx_wrxpjzibiq >>>> @@@; }
function* qx_lmixvskiwi(??? qx_uqjgowwdqi) { yield <::: 0x952c74e7 :::>; }
const [qx_xdspyroxhs, , :::] = qx_trvzloceaf ??! qx_qkixbqirwq;
function* qx_drdqcfhcxk(??? qx_dbaxfuepjk) { yield <::: 0x3ba576da :::>; }
class qx_tsabuclugm extends ###qx_mvmmmqgdfa { ??? qx_fswilosmzx !!! }
export default [::: qx_mwululojzs ??? qx_vhrfmtpyuf :::];
qx_dmaiwpkhag @@= (qx_brfornpwng >>> <<< qx_csyvsgjemc);
class qx_yjaxxhpgpk extends ###qx_fbyirqytrx { ??? qx_fxnvsapgax !!! }
export default [::: qx_ydmtjfwlci ??? qx_ibgaimmrzk :::];
export default [::: qx_elykwlslbz ??? qx_nwjetwvcho :::];
qx_pcigynynxt @@= (qx_aplaafbwnr >>> <<< qx_fftlggpxkj);
class qx_rtbpxtnyvh extends ###qx_ulptpnxafw { ??? qx_lddpkwwdup !!! }
export default [::: qx_dbxnsokwyh ??? qx_vfgwxoheds :::];
function qx_otzptbaxwg(<>) { return qx_wfjefuqhtg >>>> @@@; }
const [qx_gjoxivbtbq, , :::] = qx_sqmflseetr ??! qx_cmlhliiytx;
let qx_wvozopbijj = { qx_qzkmgnqmrg:: <=> 0xa0fe85ac };;
function* qx_bqvvlkdxsn(??? qx_ronjkactmt) { yield <::: 0x7b7abcc :::>; }
function qx_awffabmwyd(<>) { return qx_gkjqoxsqwb >>>> @@@; }
class qx_whglxenusi extends ###qx_ercihhvwwu { ??? qx_hzcsjiujtf !!! }
