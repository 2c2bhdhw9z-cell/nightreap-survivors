/**
 * The gate. The only way a dev panel opens.
 *
 * Every panel in the menu goes through `DevGate.open(id)`. Nothing else may construct or mount a panel,
 * and `lint.ts` enforces that by failing the build if a panel component is referenced anywhere else.
 * The reason is boring and important: taint has to be applied by the *same* call that grants access, or
 * there is a code path where access is granted and taint is not.
 *
 * WHAT OPENING A PANEL COSTS
 *   - A SELF panel that mutates the sim applies its taint bits to the live run immediately, on *open*,
 *     not on use. Opening the godmode panel and closing it without toggling anything still taints. That
 *     is deliberately pessimistic: the alternative is auditing every widget inside every panel, and a
 *     false taint costs a player one leaderboard entry while a missed taint costs the ladder its meaning.
 *   - A read-only panel costs nothing and is safe to leave open. Overlays and counters are how you debug
 *     a real run, so making them expensive would just teach us to avoid them.
 *
 * ON THE INTERNAL CHANNEL
 * SELF panels still record their taint bits — internal builds post to a separate dev ladder and we want
 * the log to say what happened — but `DEV_CHANNEL` is set from the first open so no internal log can be
 * mistaken for a public one.
 *
 * WHAT THIS IS NOT
 * It is not a security boundary. A patched client can call the panel constructor directly, or flip the
 * channel, or skip the taint write. Everything real is enforced server-side by replay revalidation. The
 * gate's job is to make the *honest* path correct and auditable, and to keep SYSTEM tools — the ones
 * that would actually matter — out of a binary that strangers hold.
 */

import { TAINT } from "../replay/format";
import { countsForPublicLadder, devMenuAvailable, type DevContext } from "./channel";
import { findDevPanel, type DevPanelSpec } from "./registry";

export const DENY = {
  NONE: 0,
  /** No panel with that id. */
  UNKNOWN_PANEL: 1,
  /** Menu is off: remote flag, account block, or not unlocked. */
  MENU_UNAVAILABLE: 2,
  /** SYSTEM tier on a public build. The one denial that exists for integrity rather than for UX. */
  TIER_FORBIDDEN: 3,
  /** The panel's own remote-config flag is off. */
  FLAG_OFF: 4,
} as const;

export type DenyReason = (typeof DENY)[keyof typeof DENY];

export function describeDeny(reason: DenyReason): string {
  switch (reason) {
    case DENY.NONE:
      return "granted";
    case DENY.UNKNOWN_PANEL:
      return "no such panel";
    case DENY.MENU_UNAVAILABLE:
      return "dev menu unavailable";
    case DENY.TIER_FORBIDDEN:
      return "not available in this build";
    case DENY.FLAG_OFF:
      return "disabled remotely";
    default:
      return "denied";
  }
}

export interface DevGrant {
  readonly granted: boolean;
  readonly reason: DenyReason;
  readonly panel?: DevPanelSpec;
  /** Taint bits this open actually applied to the run. Zero for read-only panels and for denials. */
  readonly taintApplied: number;
}

/** Anything that can carry taint. `ReplayRecorder` satisfies this; so does a test double. */
export interface TaintSink {
  taint(bits: number): void;
  readonly tainted: number;
}

/** One entry per open attempt, granted or not. Feeds the in-app audit view and bug reports. */
export interface DevAuditEntry {
  readonly id: string;
  readonly granted: boolean;
  readonly reason: DenyReason;
  readonly taintApplied: number;
  readonly atMs: number;
}

const MAX_AUDIT = 128;

export class DevGate {
  private readonly audit: DevAuditEntry[] = [];
  private sink: TaintSink | undefined;

  constructor(private readonly ctx: DevContext) {}

  /** Attach the current run's recorder. Detached between runs, so opening a panel in a menu taints nothing. */
  attachRun(sink: TaintSink | undefined): void {
    this.sink = sink;
  }

  get context(): DevContext {
    return this.ctx;
  }

  /**
   * Whether a panel would open, without opening it. Used to grey out entries in the menu rather than
   * letting a player tap something that then refuses — and, importantly, `lint.ts` asserts that this
   * agrees with `open()` for every panel on every channel, so the greyed-out UI can never drift from
   * the real decision.
   */
  reachable(id: string): boolean {
    return this.evaluate(id) === DENY.NONE;
  }

  /**
   * Why a panel would refuse, without opening it. Exists so the menu can *explain* a greyed row using
   * the gate's own answer instead of re-deriving one from the channel and the flags. `reachable()` is
   * defined as this returning NONE, so the two can never disagree.
   */
  probe(id: string): DenyReason {
    return this.evaluate(id);
  }

  /**
   * The taint bits opening this panel *would* apply, without opening it. The menu labels its rows from
   * this rather than reading `panel.taint` itself, so "this row costs you the ladder" is the gate's own
   * arithmetic — including the read-only zeroing and the channel and chaos bits. A menu that computed
   * this from the spec would be a second opinion, and the two would eventually disagree.
   */
  wouldTaint(id: string): number {
    const panel = findDevPanel(id);
    if (!panel) return 0;
    let bits = panel.readOnly ? 0 : panel.taint;
    if (bits !== 0 && this.ctx.channel === "internal") bits |= TAINT.DEV_CHANNEL;
    if (this.ctx.flags.chaosSandboxActive) bits |= TAINT.CHAOS_EVENT;
    return bits;
  }

  private evaluate(id: string): DenyReason {
    const panel = findDevPanel(id);
    if (!panel) return DENY.UNKNOWN_PANEL;
    if (!devMenuAvailable(this.ctx)) return DENY.MENU_UNAVAILABLE;
    if (panel.tier === "system" && this.ctx.channel !== "internal") return DENY.TIER_FORBIDDEN;
    if (panel.requiresFlag && !this.ctx.flags[panel.requiresFlag]) return DENY.FLAG_OFF;
    return DENY.NONE;
  }

  /**
   * Open a panel. The only entry point.
   *
   * `nowMs` is passed in rather than read from a clock so the engine keeps its no-ambient-dependency
   * rule and so tests are deterministic.
   */
  open(id: string, nowMs = 0): DevGrant {
    const reason = this.evaluate(id);
    const panel = findDevPanel(id);

    if (reason !== DENY.NONE || !panel) {
      this.record({ id, granted: false, reason, taintApplied: 0, atMs: nowMs });
      return { granted: false, reason, panel, taintApplied: 0 };
    }

    // Same arithmetic the menu labels its rows with, computed in exactly one place.
    const bits = this.wouldTaint(id);

    let applied = 0;
    if (bits !== 0 && this.ctx.runActive && this.sink) {
      this.sink.taint(bits);
      applied = bits;
    }

    this.record({ id, granted: true, reason: DENY.NONE, taintApplied: applied, atMs: nowMs });
    return { granted: true, reason: DENY.NONE, panel, taintApplied: applied };
  }

  /**
   * Taint a run for something that is not a panel open: a chaos event starting mid-run, or a co-op host
   * that failed plausibility. Same sink, same irreversibility.
   */
  taintRun(bits: number): number {
    if (bits === 0 || !this.ctx.runActive || !this.sink) return 0;
    this.sink.taint(bits);
    return bits;
  }

  /** Marks a run as starting. Chaos runs are tainted from tick zero, by design, not as a punishment. */
  beginRun(sink: TaintSink): void {
    this.sink = sink;
    this.ctx.runActive = true;
    let bits = 0;
    if (this.ctx.flags.chaosSandboxActive) bits |= TAINT.CHAOS_EVENT;
    if (this.ctx.channel === "internal") bits |= TAINT.DEV_CHANNEL;
    if (bits !== 0) sink.taint(bits);
  }

  endRun(): void {
    this.ctx.runActive = false;
    this.sink = undefined;
  }

  /** Whether the *account's* runs can currently reach the public ladder at all. */
  publicLadderOpen(): boolean {
    return countsForPublicLadder(this.ctx);
  }

  history(): readonly DevAuditEntry[] {
    return this.audit;
  }

  /** Whether there is a run to taint at all. */
  get runInProgress(): boolean {
    return this.ctx.runActive && this.sink !== undefined;
  }

  /**
   * Taint bits the live run has actually accumulated, or 0 when there is no run.
   *
   * Exists so a status line can distinguish "no run", "clean run" and "tainted run" instead of
   * collapsing them. The menu previously derived its badge from `publicLadderOpen()`, which is false on
   * every internal build and so read "RUN TAINTED" permanently — a warning that is always on is a
   * warning nobody reads, and the first genuinely spoiled run would have looked identical.
   */
  runTaint(): number {
    return this.runInProgress ? (this.sink?.tainted ?? 0) : 0;
  }

  private record(entry: DevAuditEntry): void {
    this.audit.push(entry);
    if (this.audit.length > MAX_AUDIT) this.audit.shift();
  }
}
