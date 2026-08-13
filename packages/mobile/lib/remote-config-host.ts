/**
 * The app's one copy of the remote config, and the twenty lines that keep it fed.
 *
 * The rules live in `game/config/remote-config.ts` and are tested without a network or a device. This file
 * is the plumbing that module refuses to contain: where the document is cached, when it is asked for, and
 * which clock it is judged against. Nothing here decides anything.
 *
 * THE LAUNCH SEQUENCE
 *   1. Read the cached document off the device and apply it. Instant, offline, and correct — a kill we
 *      published yesterday is already in force before the network answers.
 *   2. Ask the server. If the answer is newer, it replaces the cache.
 *   3. Ask again whenever the held document goes stale, and after the app comes back from the background.
 *
 * A failed fetch is not an error worth showing anybody. The app already has an answer for every flag: the
 * cached document, or failing that the defaults baked into the binary, which are the same defaults the
 * store build was submitted with. Co-op being locked because the network is down is the correct outcome.
 *
 * WHY THE CACHE IS NOT IN THE SAVE FILE
 * The save is the player's progress and is written with a verified double-buffered write because losing it
 * matters. Config is disposable — worst case we re-fetch it — so it lives in plain key-value storage and a
 * torn write costs nothing.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { client } from "@/lib/api";
import {
  parseConfig,
  RemoteConfigState,
  SOURCE,
  APPLY,
  type ApplyCode,
} from "@/game/config/remote-config";

const CACHE_KEY = "nightreap.config.doc";
/** Wall-clock time the cached document was fetched, stored beside it so its age survives a restart. */
const CACHE_AT_KEY = "nightreap.config.at";

/**
 * This binary's build number, used by a document's `minBuild` rule. Missing in a dev client, which reads
 * as build 0 — the oldest possible build, so a rule that requires a newer one holds off. Being cautious in
 * development is free; being optimistic there would mean testing a path players cannot reach.
 */
function buildNumber(): number {
  const raw = Constants.expoConfig?.version ?? "";
  const parts = raw.split(".");
  let n = 0;
  for (const part of parts) {
    const digits = Number.parseInt(part, 10);
    n = n * 1000 + (Number.isFinite(digits) ? digits : 0);
  }
  return n;
}

/**
 * The whole app reads flags through this one object. A second copy could answer differently from the
 * first, and "it depends which screen asked" is not a thing anybody can debug.
 */
const state = new RemoteConfigState({ build: buildNumber(), internal: __DEV__ });

type Listener = () => void;
const listeners = new Set<Listener>();

function announce(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to changes — a flag can flip mid-session when a fetch lands. Returns the unsubscribe. */
export function onConfigChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function remoteConfig(): RemoteConfigState {
  return state;
}

/** Wall clock, for judging a document's age. Deliberately not `performance.now()`: this is a real date. */
export function configNow(): number {
  return Date.now();
}

/** The account id arrives after sign-in, later than launch. Re-buckets every rollout when it does. */
export function setConfigAccount(accountId: string): void {
  state.setAccount(accountId);
  announce();
}

async function cache(text: string, atMs: number): Promise<void> {
  try {
    await AsyncStorage.multiSet([
      [CACHE_KEY, text],
      [CACHE_AT_KEY, String(atMs)],
    ]);
  } catch {
    // An uncacheable document just means the next launch asks again.
  }
}

/**
 * Apply whatever is on disk. Its stored age is used rather than "now", so a document cached eight days ago
 * is already expired on this launch instead of getting a fresh week of trust every time the app opens.
 */
export async function loadCachedConfig(): Promise<ApplyCode | undefined> {
  try {
    const pairs = await AsyncStorage.multiGet([CACHE_KEY, CACHE_AT_KEY]);
    const text = pairs[0]?.[1] ?? "";
    if (text === "") return undefined;
    const parsed = parseConfig(text);
    if (parsed.doc === undefined) return undefined;
    const at = Number.parseInt(pairs[1]?.[1] ?? "", 10);
    const applied = state.apply(parsed.doc, Number.isFinite(at) ? at : 0, SOURCE.CACHED);
    if (applied === APPLY.APPLIED) announce();
    return applied;
  } catch {
    return undefined;
  }
}

/**
 * Ask the server once. Never throws: every caller is either app startup or a background-to-foreground
 * transition, and neither is a place to fail loudly.
 */
export async function fetchConfig(): Promise<ApplyCode | undefined> {
  try {
    const doc = await client.config();
    const parsed = parseConfig(doc);
    if (parsed.doc === undefined) {
      console.warn("[config] the server sent something unusable — keeping what we have");
      return undefined;
    }
    const at = configNow();
    const applied = state.apply(parsed.doc, at, SOURCE.FETCHED);
    if (applied === APPLY.APPLIED) {
      await cache(JSON.stringify(doc), at);
      announce();
    }
    return applied;
  } catch {
    return undefined;
  }
}

/** Cache first, then network. Safe to call more than once; the second call is just a refresh. */
export async function startRemoteConfig(): Promise<void> {
  await loadCachedConfig();
  await fetchConfig();
}

/** Refresh only if the held document has gone stale. What the foreground transition calls. */
export async function refreshConfigIfStale(): Promise<void> {
  if (state.stale(configNow())) await fetchConfig();
}
