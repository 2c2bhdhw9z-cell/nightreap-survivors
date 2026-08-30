/**
 * Typed API client.
 *
 * THE GAME DOES NOT NEED THIS TO RUN.
 * Every part of a run — the simulation, the save, unlocks, settings — is local. This client is only
 * for the optional online extras: cloud backup, leaderboards, and anti-cheat reporting.
 *
 * WHY THE URL IS ALLOWED TO BE ABSENT
 * It used to be hardcoded to a hosting-preview host belonging to the platform this project was
 * scaffolded on. That host is gone, so every call resolved to a dead name, and a missing value
 * silently produced the string "undefined/api/rpc". Now the base URL comes only from the
 * environment, and when it is unset `configured` is false so callers can skip the request instead
 * of firing one at a URL that cannot answer.
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import Constants from "expo-constants";
import type { AppRouterClient } from "@template/web";

/** Trailing slashes are trimmed so `${baseUrl}/api/rpc` cannot produce a double slash. */
function readBaseUrl(): string {
  const fromExtra = Constants.expoConfig?.extra?.apiUrl;
  const raw = (typeof fromExtra === "string" ? fromExtra : "") || process.env.EXPO_PUBLIC_API_URL || "";
  return raw.replace(/\/+$/, "");
}

const baseUrl = readBaseUrl();

/**
 * Whether an API is reachable at all. Check this before using `client` or `orpc`; with no base URL
 * configured, requests are pointed at a relative path and will fail fast rather than hang.
 */
export const configured: boolean = baseUrl !== "";

const link = new RPCLink({
  url: `${baseUrl}/api/rpc`,
});

/** Direct typed client: await client.ping() */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers: useQuery(orpc.ping.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);
