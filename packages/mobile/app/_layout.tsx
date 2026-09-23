// Root layout. Extend in place, never rewrite from scratch.
// Provider chain: ErrorBoundary → SafeArea → QueryClient.
// To switch navigation, replace only the <Slot /> line with <Stack /> or <Tabs />.
//
// NO THIRD-PARTY TELEMETRY LIVES HERE, DELIBERATELY.
// This file used to wrap the whole app in a vendor analytics provider that beaconed every launch
// to an external collector. It was removed because the game already owns this decision: the save
// schema carries `telemetryOptIn`, and it defaults to false. A provider that reports regardless of
// that flag contradicts the player's setting and the store privacy declaration built on it.
// If analytics are ever wanted, they go behind `telemetryOptIn` and ship with a privacy entry.
import { useEffect } from "react";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { startRemoteConfig } from "../lib/remote-config-host";

// NO PLATFORM CHROME IS INJECTED HERE, DELIBERATELY.
// This file used to call `startWebSafeArea()`, which painted a fake iPhone status bar and Dynamic
// Island into the web build and stamped the hosting platform's id attributes into the DOM. That
// existed so the game looked phone-shaped inside a vendor's web preview. The preview is gone, the
// game is not a vendor's demo, and a real device already reports its own safe area through
// SafeAreaProvider. Deleted rather than reimplemented: nothing the product needs was in it.

const queryClient = new QueryClient();

export default function RootLayout() {
  useEffect(() => {
    // The cached config, then the server's. Both are best-effort: with neither, every gate stays shut,
    // which is the state this build was submitted to the store in.
    void startRemoteConfig();
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="auto" />
          <Slot />
        </QueryClientProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
