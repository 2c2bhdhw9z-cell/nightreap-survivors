/**
 * The save file and the settings, loaded once and shared by every screen.
 *
 * Two things come out of here and they are not the same thing:
 *
 *   `stored`   what the player chose. What a settings screen edits.
 *   `resolved` what will actually happen, after the rules are applied — the in-game keyboard forced back
 *              to the phone one for a language it cannot type, stranger chat switched off because chat
 *              itself is off, effect strengths halved by battery saver, HUD positions clamped on screen.
 *
 * Screens read `resolved` and make no decisions of their own. That split is the reason a setting appears
 * to stick: there is exactly one place that decides what a choice means, and it is not a screen.
 *
 * Loading is asynchronous and can fail, so `ready` exists and nothing may be drawn from a save that has
 * not arrived. Until then `stored` is the defaults, which is also what a brand new install gets — so the
 * first-run path and the loading path are the same path, and neither is special-cased.
 */

import { useEffect, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getLocales } from "expo-localization";
import { asyncStorageBackend } from "@/lib/save-backend";
import { createSaveData, type SaveData } from "@/game/save/schema";
import { SaveStore } from "@/game/save/store";
import { resolve, type DeviceFacts, type ResolvedSettings } from "@/game/settings/settings";

/** One store for the whole app. Two screens each with their own would fight over the two slots. */
let sharedStore: SaveStore | null = null;

export function saveStore(): SaveStore {
  sharedStore ??= new SaveStore(asyncStorageBackend());
  return sharedStore;
}

export interface SettingsHandle {
  /** False until the save has been read. Nothing should be drawn from settings before this. */
  ready: boolean;
  /** The whole save. Screens that only want settings should use `stored` and `resolved`. */
  save: SaveData;
  /** What the player chose. */
  stored: SaveData["settings"];
  /** What actually happens. */
  resolved: ResolvedSettings;
  /** True when the save could not be read at all and defaults are standing in. */
  loadFailed: boolean;
}

/**
 * The device facts the settings layer needs — and only those.
 *
 * It asks for the safe area rather than the screen, because a HUD laid out against the screen puts the
 * pause button under a notch. It asks for the language for one decision only: whether the in-game
 * keyboard can type it.
 */
function useDeviceFacts(playerCount: number): DeviceFacts {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const locale = getLocales()[0]?.languageTag ?? "en-US";
  return useMemo(
    () => ({
      safeWidth: Math.round(window.width - insets.left - insets.right),
      safeHeight: Math.round(window.height - insets.top - insets.bottom),
      locale,
      playerCount,
    }),
    [window.width, window.height, insets.left, insets.right, insets.top, insets.bottom, locale, playerCount],
  );
}

/**
 * Load the save and resolve the settings.
 *
 * `playerCount` matters because it decides whether party badges exist at all — solo hides them — and it
 * is a parameter rather than something read from a session, so a settings screen can preview a four
 * player layout without being in a party.
 */
export function useSettings(playerCount = 1): SettingsHandle {
  const [save, setSave] = useState<SaveData>(() => createSaveData());
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const device = useDeviceFacts(playerCount);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await saveStore().load();
      if (cancelled) return;
      if (result.save !== undefined) {
        setSave(result.save);
      } else {
        // Both slots unusable. Defaults stand in, and the player is told by whoever asked for this —
        // silently starting a fresh save over the top of an unreadable one is how progress disappears.
        setLoadFailed(true);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolved = useMemo(() => resolve(save.settings, device), [save.settings, device]);

  return { ready, save, stored: save.settings, resolved, loadFailed };
}
