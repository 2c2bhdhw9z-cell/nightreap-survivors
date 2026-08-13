/**
 * How a screen asks whether a feature is switched on.
 *
 * One line at the call site (`const coop = useFlag(FLAG.COOP)`) and no screen ever holds its own copy of
 * the answer. A flag can flip mid-session — a fetch lands, or the app comes back from the background and
 * finds a kill waiting — so this subscribes rather than reading once, and the screen redraws itself.
 *
 * Flags are read at the point of use, never cached in a screen's own state, because a gate that closed
 * five minutes ago and a button that still works are the same bug.
 */

import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { configNow, onConfigChange, refreshConfigIfStale, remoteConfig } from "@/lib/remote-config-host";
import { describeWhy, type FlagId, type WhyCode } from "@/game/config/remote-config";

export function useFlag(id: FlagId): boolean {
  const [on, setOn] = useState(() => remoteConfig().isOn(id, configNow()));

  useEffect(() => {
    const read = (): void => setOn(remoteConfig().isOn(id, configNow()));
    read();
    const stop = onConfigChange(read);
    // Coming back from the background is the moment a day-old document is most likely to be wrong.
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void refreshConfigIfStale().then(read);
    });
    return () => {
      stop();
      sub.remove();
    };
  }, [id]);

  return on;
}

/**
 * The reason as well as the answer, in plain words. For the dev menu's config panel and for a screen that
 * has to explain to a player why something is unavailable rather than just greying it out.
 */
export function useFlagReason(id: FlagId): { on: boolean; why: string } {
  const [value, setValue] = useState<{ on: boolean; why: WhyCode }>(() => {
    const d = remoteConfig().reason(id, configNow());
    return { on: d.on, why: d.why };
  });

  useEffect(() => {
    const read = (): void => {
      const d = remoteConfig().reason(id, configNow());
      setValue({ on: d.on, why: d.why });
    };
    read();
    return onConfigChange(read);
  }, [id]);

  return { on: value.on, why: describeWhy(value.why) };
}
