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
  { id: FLAG.COOP, fallback: false },
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
}

export function toDevFlags(state: RemoteConfigState, atMs: number): DevFlagsLike {
  const menu = state.reason(FLAG.DEV_MENU, atMs);
  return {
    devMenuEnabled: menu.on,
    chaosSandboxActive: state.isOn(FLAG.CHAOS_SANDBOX, atMs),
    accountBlocked: menu.why === WHY.DENIED,
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
