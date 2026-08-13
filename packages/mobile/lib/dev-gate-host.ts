/**
 * The app's one dev gate, and the wire that keeps it told what it is allowed to do.
 *
 * WHY ONE
 * Every dev panel opens through a `DevGate`, and the gate is what applies taint to the live run. Two
 * gates would mean two audit logs, two views of whether a run is clean, and a screen that could taint a
 * run the rest of the app did not know about. So there is one, it lives as long as the app does, and the
 * run's recorder is attached to it and detached from it as runs start and end.
 *
 * WHY THE FLAGS ARE PUSHED, NOT PULLED
 * The gate is in `game/`, which may not reach out to storage, a network, or a clock. So this file reads
 * remote config and pushes the answer in, on launch and again whenever a fetch lands. Every rule about
 * what those flags then mean lives in `game/dev/channel.ts` and is tested without a device.
 *
 * THE CHANNEL
 * Baked at build time by the release pipeline, which does not exist yet. Until it does, a development
 * client declares itself internal and a release build declares itself public — which is the honest
 * approximation, and changes nothing about the tier rules: SYSTEM panels are absent from a public build
 * either way, and the gate is still the only thing that decides.
 */

import { applyDevFlags, createDevContext, type Channel, type DevContext } from "@/game/dev/channel";
import { DevGate } from "@/game/dev/devgate";
import { toDevFlags } from "@/game/config/remote-config";
import { configNow, onConfigChange, remoteConfig } from "@/lib/remote-config-host";

function channel(): Channel {
  return __DEV__ ? "internal" : "public";
}

const context: DevContext = createDevContext(channel());
const gate = new DevGate(context);

const listeners = new Set<() => void>();

/** Read remote config once and push it into the gate's context. Returns true when something changed. */
export function refreshDevFlags(): boolean {
  const flags = toDevFlags(remoteConfig(), configNow());
  const changed = applyDevFlags(context, flags, flags.menuPublished);
  if (changed) for (const listener of listeners) listener();
  return changed;
}

let subscribed = false;

/**
 * The gate. Safe to call from anywhere; the first call subscribes to config changes so a kill published
 * mid-session reaches the menu without the app being restarted.
 */
export function devGate(): DevGate {
  if (!subscribed) {
    subscribed = true;
    onConfigChange(refreshDevFlags);
    refreshDevFlags();
  }
  return gate;
}

/** So a dev screen can redraw when the menu is switched off underneath it. */
export function onDevFlagsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
