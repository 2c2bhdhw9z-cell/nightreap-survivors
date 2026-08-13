/**
 * Tests for the door in front of the event log.
 *
 * The rules of the log are tested exhaustively next door in `../events/log.test.ts`. This file tests the one
 * thing this route file owns and cannot get wrong: nobody reaches the log without the admin token, and a
 * server with no token configured hands out nothing at all. FAIL CLOSED is the whole point — a
 * misconfigured server that quietly serves the log is worse than one that quietly serves nothing.
 *
 * The requests go through the real HTTP mount, so what is being checked is what a caller would actually
 * meet. No database is touched: every request here is refused before the log is ever built.
 *
 * Run directly: `bun packages/web/src/api/routes/events.test.ts`.
 */

import app from "../index";

let failures = 0;
let checks = 0;

function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n-- ${name}`);
}

const GOOD_TOKEN = "a-long-enough-admin-token";

async function call(path: string, body: unknown, token?: string): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await app.fetch(
    new Request(`http://localhost/api/rpc/events/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ json: body }),
    }),
  );
  return response.status;
}

const CALLS = ["append", "range", "verify", "planReversal", "reverseGroup", "accountView"];

/* ---- with no token configured ------------------------------------------------------------------ */

section("a server with no admin token configured");
{
  delete process.env.EVENT_LOG_ADMIN_TOKEN;
  for (const name of CALLS) {
    const status = await call(name, {}, GOOD_TOKEN);
    check(`${name} is refused`, status === 403, `answered ${status} instead of forbidden`);
  }

  process.env.EVENT_LOG_ADMIN_TOKEN = "short";
  const status = await call("verify", {}, "short");
  check("a token too short to be a secret counts as not configured", status === 403, `answered ${status}`);
}

/* ---- with a token configured ------------------------------------------------------------------- */

section("a server with an admin token configured");
{
  process.env.EVENT_LOG_ADMIN_TOKEN = GOOD_TOKEN;

  for (const name of CALLS) {
    check(`${name} with no token at all is refused`, (await call(name, {})) === 403);
    check(`${name} with the wrong token is refused`, (await call(name, {}, "not-the-admin-token!!")) === 403);
  }

  check("a token of the right length but wrong content is refused", (await call("verify", {}, "b".repeat(GOOD_TOKEN.length))) === 403);
  check("the token is not accepted without the Bearer prefix", (await call("verify", {}, "")) === 403);
}

/* ---- the door is only on these ----------------------------------------------------------------- */

section("the rest of the api is unaffected");
{
  const health = await app.fetch(new Request("http://localhost/api/health"));
  check("the health check still answers", health.status === 200);

  const config = await app.fetch(
    new Request("http://localhost/api/rpc/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: {} }) }),
  );
  check("config is still open to the app, as it must be", config.status === 200, `answered ${config.status}`);
}

/* ---- done -------------------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`FAIL — ${failures} problem(s) at the event-log door`);
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
} else {
  console.log("PASS — the event-log door");
}
