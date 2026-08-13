/**
 * The dev-menu registry: every panel that exists, what tier it is, and what it costs the run.
 *
 * WHY A REGISTRY AND NOT JUST SCREENS
 * If panels were ordinary screens, the security question would be asked once per screen by whoever
 * wrote it, and the day somebody forgets is the day a SYSTEM tool ships to the store. A registry turns
 * that into a data question a linter can answer: every panel is a record with an explicit tier and an
 * explicit taint mask, `devgate.ts` is the only thing that can open one, and CI fails the build if the
 * data is wrong. See `lint.ts`.
 *
 * TIERS (plan.md §5b)
 *   SELF   — affects only this device's simulation and this run. Ships unlocked in public builds.
 *            Godmode, grants, spawns, time scale, seeking, VFX toggles, device emulation, input
 *            playback. Every one of these taints the run.
 *   SYSTEM — anything that writes to an account, a ladder, matchmaking, remote config, or another
 *            player. Never reachable on the public channel, private dev build and web admin only.
 *
 * THE DEFAULT IS SYSTEM
 * `defineDevPanel` requires `tier` explicitly, and `normaliseTier` treats anything unrecognised as
 * SYSTEM. A typo therefore locks a panel down rather than opening it up. The failure mode of a mistake
 * here is "the tool I wanted is missing from my own build", which is a bug report; the opposite failure
 * mode is a leaderboard we cannot trust.
 */

import { TAINT } from "../replay/format";
import type { DevFlags } from "./channel";

export type DevTier = "self" | "system";

export interface DevPanelSpec {
  /** Stable id. Written into the audit log, so never rename — add a new one and retire the old. */
  readonly id: string;
  readonly label: string;
  /** Tab the panel lives under in the menu. */
  readonly group: DevGroup;
  readonly tier: DevTier;
  /**
   * Taint bits opening this panel applies to the current run. Must be non-zero for a SELF panel unless
   * `readOnly` is true — a toggle that changes the sim but does not say so is the exact hole §5b closes.
   */
  readonly taint: number;
  /** True when the panel only observes: inspectors, atlas viewers, screenshot tools. */
  readonly readOnly: boolean;
  /** Optional extra remote-config flag, so a single panel can be killed without killing the menu. */
  readonly requiresFlag?: keyof DevFlags;
  readonly notes?: string;
}

export type DevGroup =
  | "run"
  | "player"
  | "spawns"
  | "content"
  | "render"
  | "perf"
  | "coop"
  | "account"
  | "ladder"
  | "ops";

function normaliseTier(tier: string): DevTier {
  return tier === "self" ? "self" : "system";
}

export function defineDevPanel(spec: DevPanelSpec): DevPanelSpec {
  return { ...spec, tier: normaliseTier(spec.tier) };
}

/**
 * The catalog. Written from plan.md §5b's two lists so the tier split is stated once, in code, rather
 * than living in a document nobody re-reads.
 */
export const DEV_PANELS: readonly DevPanelSpec[] = [
  /* ---- SELF: sim-only, ships unlocked, always taints ------------------------------------------- */
  defineDevPanel({
    id: "run.godmode",
    label: "Godmode",
    group: "player",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.INVULNERABLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "run.oneshot",
    label: "One-shot kills",
    group: "player",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.GRANTED,
    readOnly: false,
  }),
  defineDevPanel({
    id: "run.grant",
    label: "Grant gold / XP / items",
    group: "player",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.GRANTED,
    readOnly: false,
    notes: "Run-local only. Gold granted here never reaches the account wallet.",
  }),
  defineDevPanel({
    id: "run.setlevel",
    label: "Set level",
    group: "player",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.GRANTED,
    readOnly: false,
  }),
  defineDevPanel({
    id: "run.evolve",
    label: "Force evolutions",
    group: "player",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.GRANTED,
    readOnly: false,
  }),
  defineDevPanel({
    id: "run.timescale",
    label: "Slow-mo / fast-forward",
    group: "run",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.TIME_SCALE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "run.seek",
    label: "Jump to timestamp",
    group: "run",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.TIME_TRAVEL,
    readOnly: false,
  }),
  defineDevPanel({
    id: "run.restart-seed",
    label: "Restart same seed",
    group: "run",
    tier: "self",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
    notes: "Rerunning a seed is legitimate practice, but the restart itself is a dev action.",
  }),
  defineDevPanel({
    id: "run.modifiers",
    label: "Modifier stack editor",
    group: "run",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.MODIFIER_EDIT,
    readOnly: false,
  }),
  defineDevPanel({
    id: "run.rng",
    label: "Reroll RNG stream",
    group: "run",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.RNG_EDIT,
    readOnly: false,
  }),
  defineDevPanel({
    id: "spawn.entity",
    label: "Spawn enemy / boss / chest",
    group: "spawns",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.SPAWN_EDIT,
    readOnly: false,
  }),
  defineDevPanel({
    id: "spawn.freeze",
    label: "Freeze spawns",
    group: "spawns",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.SPAWN_EDIT,
    readOnly: false,
  }),
  defineDevPanel({
    id: "spawn.killall",
    label: "Kill all",
    group: "spawns",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.SPAWN_EDIT,
    readOnly: false,
  }),
  defineDevPanel({
    id: "input.playback",
    label: "Record / play back input",
    group: "perf",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.SYNTHETIC_INPUT,
    readOnly: false,
    notes: "Drives the soak test. Synthetic input must never look like a human run to the ladder.",
  }),
  defineDevPanel({
    id: "perf.device-profile",
    label: "Emulate device profile",
    group: "perf",
    tier: "self",
    taint: TAINT.DEV_TOGGLE | TAINT.EMULATED_DEVICE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "a11y.simulate",
    label: "Accessibility simulation",
    group: "render",
    tier: "self",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
    notes: "Colourblind and reduced-VFX previews change what is drawn, so it is not read-only.",
  }),
  defineDevPanel({
    id: "render.pseudoloc",
    label: "Pseudo-localisation",
    group: "render",
    tier: "self",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),

  /* ---- SELF and read-only: observe, never mutate, never taint ---------------------------------- */
  defineDevPanel({
    id: "render.overlays",
    label: "VFX / hitbox / overlay toggles",
    group: "render",
    tier: "self",
    taint: 0,
    readOnly: true,
    notes: "Debug draw only. Nothing here touches the sim, so a run with overlays on still counts.",
  }),
  defineDevPanel({
    id: "render.atlas",
    label: "Atlas inspector",
    group: "render",
    tier: "self",
    taint: 0,
    readOnly: true,
  }),
  defineDevPanel({
    id: "audio.inspect",
    label: "Audio inspector",
    group: "content",
    tier: "self",
    taint: 0,
    readOnly: true,
  }),
  defineDevPanel({
    id: "perf.counters",
    label: "Frame / entity / allocation counters",
    group: "perf",
    tier: "self",
    taint: 0,
    readOnly: true,
  }),
  defineDevPanel({
    id: "perf.flight-recorder",
    label: "Flight recorder",
    group: "perf",
    tier: "self",
    taint: 0,
    readOnly: true,
    notes: "Reads the previous run's tail from storage. Already built, see game/bench.",
  }),
  defineDevPanel({
    id: "render.screenshot",
    label: "Screenshot / capture",
    group: "render",
    tier: "self",
    taint: 0,
    readOnly: true,
  }),
  defineDevPanel({
    id: "replay.inspect",
    label: "Replay inspector",
    group: "run",
    tier: "self",
    taint: 0,
    readOnly: true,
    notes: "Loads a local tick log and steps it. Reading a log cannot change the live run.",
  }),

  /* ---- SYSTEM: never reachable on the public channel ------------------------------------------- */
  defineDevPanel({
    id: "account.wallet",
    label: "Write account gold",
    group: "account",
    tier: "system",
    taint: TAINT.DEV_TOGGLE | TAINT.GRANTED,
    readOnly: false,
  }),
  defineDevPanel({
    id: "account.unlocks",
    label: "Write unlocks / achievements",
    group: "account",
    tier: "system",
    taint: TAINT.DEV_TOGGLE | TAINT.GRANTED,
    readOnly: false,
  }),
  defineDevPanel({
    id: "account.entitlements",
    label: "Write entitlements",
    group: "account",
    tier: "system",
    taint: TAINT.DEV_TOGGLE | TAINT.GRANTED,
    readOnly: false,
  }),
  defineDevPanel({
    id: "account.cloudsave",
    label: "Cloud save write",
    group: "account",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "ladder.submit",
    label: "Submit / edit leaderboard entry",
    group: "ladder",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "ladder.cleartaint",
    label: "Clear taint on a run",
    group: "ladder",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
    notes: "The single highest-value cheat target. Server-side only, written to the event log.",
  }),
  defineDevPanel({
    id: "ladder.rebuild",
    label: "Purge and rebuild a ladder",
    group: "ladder",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "ladder.clock",
    label: "Force Daily / Weekly window",
    group: "ladder",
    tier: "system",
    taint: TAINT.DEV_TOGGLE | TAINT.TIME_TRAVEL,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.force-match",
    label: "Force matchmaking",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.spectate",
    label: "Join / spectate a stranger",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.inject",
    label: "Inject into another player's sim",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE | TAINT.SPAWN_EDIT,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.bots",
    label: "Bot players in a public lobby",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.link",
    label: "Link readout",
    group: "coop",
    tier: "system",
    taint: 0,
    readOnly: true,
    notes: "Watches only. Must stay read-only so a real run can be inspected without spoiling it.",
  }),
  defineDevPanel({
    id: "coop.hashes",
    label: "Hash comparison",
    group: "coop",
    tier: "system",
    taint: 0,
    readOnly: true,
    notes: "Shows which seats agree with this device. Deciding who is right is still the host's job.",
  }),
  defineDevPanel({
    id: "coop.latency",
    label: "Added latency",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.loss",
    label: "Packet loss",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.jitter",
    label: "Jitter and reordering",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.desync",
    label: "Force desync",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE | TAINT.RNG_EDIT,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.drop",
    label: "Drop a guest",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
    notes: "Ungraceful on purpose: this is the case that must hold the seat for its grace period.",
  }),
  defineDevPanel({
    id: "coop.migrate",
    label: "Migrate host",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.stall",
    label: "Stall the host",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE | TAINT.TIME_SCALE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "coop.diverge",
    label: "Replay diverge",
    group: "coop",
    tier: "system",
    taint: TAINT.DEV_TOGGLE | TAINT.SYNTHETIC_INPUT,
    readOnly: false,
    notes: "Poisons the recorded input log so server-side revalidation has something real to reject.",
  }),
  defineDevPanel({
    id: "ops.config-readout",
    label: "Remote config readout",
    group: "ops",
    tier: "system",
    taint: 0,
    readOnly: true,
    notes: "Every flag, its state and why. Reads only, so it costs the run nothing and is safe mid-run.",
  }),
  defineDevPanel({
    id: "ops.remote-config",
    label: "Remote config write",
    group: "ops",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "ops.killswitch",
    label: "Kill switch controls",
    group: "ops",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "ops.moderation",
    label: "Flag / ban / restore an account",
    group: "ops",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "ops.snapshots",
    label: "Snapshots / point-in-time restore",
    group: "ops",
    tier: "system",
    taint: TAINT.DEV_TOGGLE,
    readOnly: false,
  }),
  defineDevPanel({
    id: "ops.telemetry",
    label: "Other-account telemetry",
    group: "ops",
    tier: "system",
    taint: 0,
    readOnly: true,
  }),
];

const BY_ID = new Map<string, DevPanelSpec>();
for (const panel of DEV_PANELS) BY_ID.set(panel.id, panel);

/** Lookup. Returns undefined for an unknown id, which the gate treats as a denial, not an error. */
export function findDevPanel(id: string): DevPanelSpec | undefined {
  return BY_ID.get(id);
}

export function devPanelsInGroup(group: DevGroup): DevPanelSpec[] {
  return DEV_PANELS.filter((p) => p.group === group);
}

/** Every taint bit any SELF panel can apply. Used by the run recap to explain a tainted run. */
export function selfTaintMask(): number {
  let mask = 0;
  for (const panel of DEV_PANELS) if (panel.tier === "self") mask |= panel.taint;
  return mask;
}
