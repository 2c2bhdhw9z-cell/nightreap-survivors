/**
 * Where the save file actually lives on a phone.
 *
 * The save layer knows how to build, check and repair a save; it deliberately knows nothing about
 * storage, so it can be tested without one. This is the twenty lines that connect it to the device, and
 * it is the whole of the platform-specific part.
 *
 * Bytes go in and out as base64 because the key-value store holds strings. That conversion is ours (see
 * `game/save/base64.ts`) rather than the platform's, because the platform's does not exist on Android's
 * JavaScript engine.
 *
 * Nothing here throws. A read that fails returns nothing, which the save layer already treats as "this
 * slot is unusable, try the other one" — and there are always two slots. A write that fails is reported
 * to the caller, which reads every write back and compares it anyway.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { fromBase64, toBase64 } from "@/game/save/base64";
import type { SaveBackend } from "@/game/save/store";

export function asyncStorageBackend(): SaveBackend {
  return {
    async read(key: string): Promise<Uint8Array | undefined> {
      try {
        const text = await AsyncStorage.getItem(key);
        if (text === null || text === "") return undefined;
        return fromBase64(text);
      } catch {
        // A slot that cannot be read is a slot the save layer skips. There is another one.
        return undefined;
      }
    },

    async write(key: string, bytes: Uint8Array): Promise<void> {
      await AsyncStorage.setItem(key, toBase64(bytes));
    },

    async remove(key: string): Promise<void> {
      try {
        await AsyncStorage.removeItem(key);
      } catch {
        // Removing a slot that is already gone is not a failure worth propagating.
      }
    },
  };
}
