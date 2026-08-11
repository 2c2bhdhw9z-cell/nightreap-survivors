/**
 * Build channel and dev-menu access context.
 *
 * ONE BUILD, TWO BEHAVIOURS (plan.md §5b)
 * The same binary ships to the public store and to our own devices. What differs is the *channel* it
 * was published on, and the channel decides two things and only two things:
 *
 *   1. Which tier of dev panel is reachable at all — SELF everywhere, SYSTEM never in public.
 *   2. Whether using a SELF panel taints the run against the public ladder, or against the separate
 *      dev-only ladder that internal builds post to.
 *
 * WHY NOT JUST STRIP THE MENU FROM THE PUBLIC BUILD
 * Because we cannot, honestly. Hermes bytecode decompiles (`hermes-dec`, `hbctool`, Bytecode Studio),
 * and any client-side check is Frida-hookable — the injected tweak-menu screenshot that drove the §5b
 * addendum is exactly that, applied to somebody else's game. So the menu ships, the blast radius is
 * engineered to zero instead, and nothing here pretends to be a security boundary. The real boundary
 * is server-side replay revalidation in `game/replay/player.ts`.
 *
 * WHAT THE CHANNEL VALUE IS WORTH
 * Nothing, against a patched binary. A cheat can flip `channel` to "internal" and unlock the SYSTEM
 * tier in its own process. That is *fine* and is the whole point of the tier split: SYSTEM panels are
 * only useful if a server accepts what they produce, and no server endpoint accepts a client-reported
 * stat, gold total, unlock, or score. Flipping the flag locally buys a patched client a menu that
 * talks to nobody.
 */

/** Publication channel this binary came from. Baked at build time, not user-settable in the UI. */
export type Channel = "public" | "internal";

/**
 * Remote-config flags the dev menu cares about. Server-driven, evaluated per launch, and killable in
 * seconds without an app update — the per-feature kill switch from the plan.
 */
export interface DevFlags {
  /** Master switch. Off at store submission; a compromised menu can be shut off remotely. */
  devMenuEnabled: boolean;
  /** Chaos Sandbox Day. Same switch, on purpose, for 24-48h a few times a year. */
  chaosSandboxActive: boolean;
  /** Per-account disable, for an account we have flagged. */
  accountBlocked: boolean;
}

export const DEFAULT_DEV_FLAGS: DevFlags = {
  devMenuEnabled: false,
  chaosSandboxActive: false,
  accountBlocked: false,
};

/** Everything the gate needs to decide, in one record so no call site can forget a condition. */
export interface DevContext {
  channel: Channel;
  flags: DevFlags;
  /** True once the player has entered the secret unlock. Irrelevant on the internal channel. */
  unlocked: boolean;
  /** True when a run is in progress, so the gate knows whether there is anything to taint. */
  runActive: boolean;
}

export function createDevContext(channel: Channel): DevContext {
  return {
    channel,
    flags: { ...DEFAULT_DEV_FLAGS, devMenuEnabled: channel === "internal" },
    unlocked: channel === "internal",
    runActive: false,
  };
}

/**
 * Whether the menu can be opened at all. Deliberately separate from per-panel checks so the UI can
 * show "dev menu unavailable" once rather than failing panel by panel.
 */
export function devMenuAvailable(ctx: DevContext): boolean {
  if (ctx.flags.accountBlocked) return false;
  if (ctx.channel === "internal") return ctx.flags.devMenuEnabled;
  return ctx.flags.devMenuEnabled && (ctx.unlocked || ctx.flags.chaosSandboxActive);
}

/**
 * Whether runs on this channel count for the *public* ladder at all.
 *
 * Internal builds post to a separate dev ladder, so a SELF toggle there does not need to poison the
 * run — but the run still carries `DEV_CHANNEL`, so a log that somehow reaches the public pipeline is
 * identifiable rather than merely suspicious.
 */
export function countsForPublicLadder(ctx: DevContext): boolean {
  return ctx.channel === "public" && !ctx.flags.chaosSandboxActive;
}
