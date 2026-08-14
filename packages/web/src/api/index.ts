import type { RouterClient } from "@orpc/server";
import { createApp } from "./__core/app";
import { admin } from "./routes/admin";
import { cloud } from "./routes/cloud";
import { config } from "./routes/config";
import { events } from "./routes/events";
import { ping } from "./routes/ping";
import { runs } from "./routes/runs";

// API features are oRPC procedures, one file per feature in ./routes/,
// composed into this router — typed end-to-end via the clients
// (web: src/web/lib/api.ts, mobile: lib/api.ts).
// Keep each routes/ file under 500 lines (`bun run lint` enforces this);
// split into more feature files as they grow.
// Patterns and examples: skills/app/references/api.md
export const router = {
  ping,
  admin,
  cloud,
  config,
  events,
  runs,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);
// Rare plain-HTTP endpoints (webhooks, streaming, the Better Auth handler)
// register here with full paths, e.g. app.post("/api/webhooks/example", ...)

export default app;
