/**
 * The one place a live co-op session and the dev menu's COOP tab can find each other.
 *
 * WHY A HOLDER AND NOT A PROP
 * The dev menu is opened from anywhere — including from inside a run, which is the only time most of
 * these tools mean anything — so it cannot be handed the session as a prop by whoever rendered it. The
 * alternatives were a React context wrapped around the whole app (which would make a debugging tool a
 * dependency of the app's structure) or letting the panel reach into the run itself (which is how a dev
 * tool ends up able to corrupt a run it was only supposed to watch).
 *
 * WHAT IT HOLDS
 * A `CoopLab` — the settings and the pending faults — and a read-only view of the live session, supplied
 * by whoever owns that session as a function rather than as an object reference. The panel therefore
 * cannot touch the session at all: it can only ask it for numbers.
 *
 * The lab itself lives for the whole app run so the sliders survive leaving and re-entering the menu.
 * Its `reset()` is called by the code that starts a run, not from here.
 */

import { CoopLab, type LinkSource } from "@/game/dev/coop-lab";
import { HashCompare } from "@/game/dev/coop-lab";

/** Read the live session's numbers. Returns null when there is no session to read. */
export type LinkProbe = () => LinkSource | null;

const lab = new CoopLab();
const hashes = new HashCompare(0);
let probe: LinkProbe = () => null;
const listeners = new Set<() => void>();

export function coopLab(): CoopLab {
  return lab;
}

export function coopHashes(): HashCompare {
  return hashes;
}

/**
 * Called by whoever owns a live co-op session. Passing null on teardown matters: a stale probe would
 * keep reporting a session that has gone, and a readout that lies is worse than one that says nothing.
 */
export function attachCoopProbe(next: LinkProbe | null): void {
  probe = next ?? (() => null);
  for (const listener of listeners) listener();
}

export function readCoopSource(): LinkSource | null {
  return probe();
}

/** So the panel can redraw when a session appears or disappears. */
export function onCoopProbeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
