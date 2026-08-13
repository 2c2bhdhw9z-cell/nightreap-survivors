import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "../../api";

const link = new RPCLink({
  url: `${window.location.origin}/api/rpc`,
});

/** Direct typed client: await client.ping() */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers: useQuery(orpc.ping.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);

/* ---------------------------------------------------------------------------------------------- */
/* The operator's client                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The break-glass endpoints need a secret in the request, and the ordinary client must never send one.
 *
 * Two things matter here. The token lives in this tab's own storage and nowhere else — not in a cookie the
 * browser would attach to every request by itself, and not in a file. And it is kept apart from the client
 * the game uses, so a stray call from a normal page cannot accidentally arrive holding operator rights.
 */
const TOKEN_KEY = "nightreap.operator.token";

let memoryToken = "";

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Private modes and locked-down browsers can refuse storage entirely. Holding the token in memory for
    // the life of the tab is a worse experience, not a broken one.
    return null;
  }
}

/** Whatever token this tab is currently holding, or an empty string. */
export function getAdminToken(): string {
  if (memoryToken !== "") return memoryToken;
  const stored = sessionStore()?.getItem(TOKEN_KEY) ?? "";
  memoryToken = stored;
  return stored;
}

/** Remember a token for this tab, or forget it when given an empty string. */
export function setAdminToken(token: string): void {
  memoryToken = token;
  const store = sessionStore();
  if (store === null) return;
  if (token === "") store.removeItem(TOKEN_KEY);
  else store.setItem(TOKEN_KEY, token);
}

const adminLink = new RPCLink({
  url: `${window.location.origin}/api/rpc`,
  headers: () => {
    const token = getAdminToken();
    return token === "" ? {} : { authorization: `Bearer ${token}` };
  },
});

/** Typed client for the break-glass endpoints. Every call carries the operator token, or is refused. */
export const adminClient: AppRouterClient = createORPCClient(adminLink);

/** TanStack Query helpers for the break-glass endpoints. */
export const orpcAdmin = createTanstackQueryUtils(adminClient, { path: ["admin-scope"] });
