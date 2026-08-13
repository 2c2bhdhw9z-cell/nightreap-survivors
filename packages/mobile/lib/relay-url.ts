/**
 * Where the relay is.
 *
 * The relay is its own small process, on its own port, because the app's own dev server cannot upgrade a
 * connection to a socket. So its address has to be worked out rather than assumed, and it is worked out
 * differently in each of the three places this code runs:
 *
 *   a shipped build      whatever `EXPO_PUBLIC_RELAY_URL` was baked in as, and nothing else
 *   a phone in dev       the machine serving the bundle, on the relay's port
 *   a browser in dev     the page's own host, on the relay's port — or the sibling preview address
 *
 * When none of those produce an address there is no co-op, and the screen says so plainly. A build that
 * quietly tries to reach somebody's laptop is worse than one that admits co-op is unavailable.
 */

import Constants from "expo-constants";
import { Platform } from "react-native";

/** The relay's port in development. Matches `RELAY_PORT` in the relay itself. */
export const RELAY_PORT = 4400;

/** The app's own dev port, which is what a preview address has in it. */
const APP_PORT = 4300;

/**
 * Preview environments hand out one hostname per port, like `something-preview-4300.example`, and do not
 * expose ports directly. Swapping the number in the hostname is the only way to reach a sibling service.
 */
function previewSibling(host: string): string {
  const suffix = `-${APP_PORT}`;
  const dot = host.indexOf(".");
  if (dot < 0) return "";
  const name = host.slice(0, dot);
  if (!name.endsWith(suffix)) return "";
  return `${name.slice(0, -suffix.length)}-${RELAY_PORT}${host.slice(dot)}`;
}

export function relayUrl(): string {
  const configured = process.env.EXPO_PUBLIC_RELAY_URL;
  if (configured !== undefined && configured !== "") return configured;

  if (Platform.OS === "web") {
    const loc = typeof globalThis.location === "undefined" ? undefined : globalThis.location;
    if (loc === undefined) return "";
    const secure = loc.protocol === "https:";
    const sibling = previewSibling(loc.hostname);
    if (sibling !== "") return `${secure ? "wss" : "ws"}://${sibling}`;
    return `${secure ? "wss" : "ws"}://${loc.hostname}:${RELAY_PORT}`;
  }

  // `hostUri` looks like "192.168.1.20:4300" while the dev server is running, and is absent otherwise.
  const hostUri = Constants.expoConfig?.hostUri ?? "";
  const host = hostUri.split(":")[0] ?? "";
  if (host === "") return "";
  const sibling = previewSibling(host);
  if (sibling !== "") return `wss://${sibling}`;
  return `ws://${host}:${RELAY_PORT}`;
}

/** Whether co-op can be attempted at all. Used to explain rather than to fail silently. */
export function relayConfigured(): boolean {
  return relayUrl() !== "";
}
