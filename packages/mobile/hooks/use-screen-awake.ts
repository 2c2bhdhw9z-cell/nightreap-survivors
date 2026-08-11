import { useEffect } from "react";
import { Platform } from "react-native";

/**
 * Keeps the screen from sleeping during a long benchmark run.
 *
 * We do NOT use `useKeepAwake` from expo-keep-awake directly. Its web
 * implementation reaches straight for `navigator.wakeLock.request`, and on
 * Android Chrome that object is missing unless the page is served over a
 * secure context the browser trusts. When it is missing the hook throws
 * during mount ("Cannot read property 'request' of undefined"), which takes
 * the whole screen down with it. The REVVL hit exactly that.
 *
 * So: every path is guarded, every failure is swallowed. A benchmark that
 * runs with the screen dimming is a minor annoyance. A benchmark that
 * refuses to open is a blocker.
 */

type WakeLockSentinel = { release: () => Promise<void> };
type WakeLockApi = { request: (kind: "screen") => Promise<WakeLockSentinel> };

function webWakeLock(): WakeLockApi | undefined {
  const nav = globalThis.navigator as unknown as
    | { wakeLock?: WakeLockApi }
    | undefined;
  return nav?.wakeLock;
}

export function useScreenAwake(): void {
  useEffect(() => {
    let released = false;
    let sentinel: WakeLockSentinel | undefined;

    if (Platform.OS === "web") {
      const api = webWakeLock();
      if (!api) return;
      api
        .request("screen")
        .then((granted) => {
          if (released) {
            void granted.release().catch(() => {});
            return;
          }
          sentinel = granted;
        })
        .catch(() => {});
      return () => {
        released = true;
        void sentinel?.release().catch(() => {});
      };
    }

    // Native: load lazily so a missing module can never break mount.
    let cancelled = false;
    const tag = "nightreap-bench";
    void import("expo-keep-awake")
      .then((mod) => {
        if (cancelled) return;
        return mod.activateKeepAwakeAsync(tag);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      void import("expo-keep-awake")
        .then((mod) => mod.deactivateKeepAwake(tag))
        .catch(() => {});
    };
  }, []);
}
