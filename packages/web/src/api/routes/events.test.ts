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

async function ask(route: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(`http://localhost/api/rpc/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ json: body }),
    }),
  );
}

async function call(route: string, body: unknown, token?: string): Promise<number> {
  return (await ask(route, body, token)).status;
}

// Both doors, in one list. The operator's endpoints were added after the log's own, and a gate that is
// copied rather than shared is always stale on exactly the newer half — so the newer half is tested here
// beside the older one, through the same list, and cannot be forgotten.
const LOG_CALLS = ["append", "range", "verify", "planReversal", "reverseGroup", "restore", "story", "accountView"].map(
  (name) => `events/${name}`,
);
const ADMIN_CALLS = ["catalogue", "account", "act", "undo"].map((name) => `admin/${name}`);
const CALLS = [...LOG_CALLS, ...ADMIN_CALLS];

/* ---- with no token configured ------------------------------------------------------------------ */

section("a server with no admin token configured");
{
  delete process.env.EVENT_LOG_ADMIN_TOKEN;
  for (const name of CALLS) {
    const status = await call(name, {}, GOOD_TOKEN);
    check(`${name} is refused`, status === 403, `answered ${status} instead of forbidden`);
  }

  process.env.EVENT_LOG_ADMIN_TOKEN = "short";
  for (const name of CALLS) {
    const short = await call(name, {}, "short");
    check(`${name}: a token too short to be a secret counts as not configured`, short === 403, `answered ${short}`);
  }
}

/* ---- with a token configured ------------------------------------------------------------------- */

section("a server with an admin token configured");
{
  process.env.EVENT_LOG_ADMIN_TOKEN = GOOD_TOKEN;

  for (const name of CALLS) {
    check(`${name} with no token at all is refused`, (await call(name, {})) === 403);
    check(`${name} with the wrong token is refused`, (await call(name, {}, "not-the-admin-token!!")) === 403);
  }

  check("a token of the right length but wrong content is refused", (await call("events/verify", {}, "b".repeat(GOOD_TOKEN.length))) === 403);
  check("the token is not accepted without the Bearer prefix", (await call("events/verify", {}, "")) === 403);
}

/* ---- the catalogue the screen is built from ----------------------------------------------------- */

section("the button list the screen is built from");
{
  process.env.EVENT_LOG_ADMIN_TOKEN = GOOD_TOKEN;
  const response = await ask("admin/catalogue", {}, GOOD_TOKEN);
  check("an operator with the token gets the button list", response.status === 200, `answered ${response.status}`);

  const body = (await response.json()) as { json?: { actions?: unknown[]; faults?: string[] } };
  const actions = body.json?.actions ?? [];
  check("the list is not empty", actions.length > 0, `read ${actions.length}`);
  check(
    "the server reports no disagreement between the buttons and the log",
    (body.json?.faults ?? []).length === 0,
    (body.json?.faults ?? []).join("; "),
  );

  const shaped = actions as { id?: string; undoable?: boolean; note?: string; fields?: unknown[] }[];
  check("every button has an id", shaped.every((a) => typeof a.id === "string" && a.id.length > 0));
  check("every button says whether it can be undone", shaped.every((a) => typeof a.undoable === "boolean"));
  check(
    "every one-way button carries a warning",
    shaped.every((a) => a.undoable === true || (a.note ?? "").length > 0),
    "an operator must never meet a one-way action without being told",
  );
  check("at least one button is one-way, or this check proves nothing", shaped.some((a) => a.undoable === false));
  check("the kind number is not sent to the screen", shaped.every((a) => !("kind" in a)), "the screen must post an action id, never a kind number");
}

/* ---- what the operator's door refuses before it writes anything -------------------------------- */

section("an action the catalogue will not build never reaches the log");
{
  // Every request below is turned away by the action catalogue *before* the log is opened, so nothing here
  // touches a database. That is the point: a request that cannot be expressed as a row it understands is
  // refused at the door, never repaired into something nobody agreed to.
  process.env.EVENT_LOG_ADMIN_TOKEN = GOOD_TOKEN;

  async function act(body: Record<string, unknown>): Promise<number> {
    return call("admin/act", { actorId: "admin-1", reason: "a proper written reason", fields: {}, ...body }, GOOD_TOKEN);
  }

  check("a button that does not exist is refused", (await act({ actionId: "makeThemLoseOnPurpose", subjectId: "acct-a" })) >= 400);
  check("a reason too thin to be a reason is refused", (await act({ actionId: "grantGold", subjectId: "acct-a", reason: "oops", fields: { amount: 10 } })) >= 400);
  check("a reason of one letter held down is refused", (await act({ actionId: "grantGold", subjectId: "acct-a", reason: "aaaaaaaaaa", fields: { amount: 10 } })) >= 400);
  check("an action about an account with no account named is refused", (await act({ actionId: "grantGold", fields: { amount: 10 } })) >= 400);
  check("an action about the whole build pinned on one player is refused", (await act({ actionId: "quarantineBuild", subjectId: "acct-a", fields: { buildId: 1000 } })) >= 400, "it would read forever as that player being punished");
  check("a missing field is refused", (await act({ actionId: "grantGold", subjectId: "acct-a" })) >= 400);
  check("a field that is not a number is refused", (await act({ actionId: "grantGold", subjectId: "acct-a", fields: { amount: "lots" } })) >= 400);
  check("nothing, or less than nothing, is not an amount", (await act({ actionId: "grantGold", subjectId: "acct-a", fields: { amount: 0 } })) >= 400);
  check("a fat-fingered amount is refused", (await act({ actionId: "grantGold", subjectId: "acct-a", fields: { amount: 999_999_999 } })) >= 400);
  check("a field nobody asked for is refused, not dropped", (await act({ actionId: "grantGold", subjectId: "acct-a", fields: { amount: 10, alsoBanThem: true } })) >= 400);
  check("a mute length that is not on the ladder is refused", (await act({ actionId: "chatMute", subjectId: "acct-a", fields: { hours: 3 } })) >= 400);
  check("a permanent mute is not on the ladder either", (await act({ actionId: "chatMute", subjectId: "acct-a", fields: { hours: 0 } })) >= 400, "forever is a ban, and a ban is its own button");

  check("an undo has to name a row", (await call("admin/undo", { seq: 0, actorId: "admin-1", reason: "a proper written reason" }, GOOD_TOKEN)) >= 400);
  check("an undo has to say why", (await call("admin/undo", { seq: 1, actorId: "admin-1", reason: "" }, GOOD_TOKEN)) >= 400);
  check("an account cannot be looked up without an id", (await call("admin/account", { subjectId: "" }, GOOD_TOKEN)) >= 400);

  const refusal = await ask("admin/act", { actionId: "grantGold", actorId: "admin-1", subjectId: "acct-a", reason: "a proper written reason", fields: { amount: 10, alsoBanThem: true } }, GOOD_TOKEN);
  const text = await refusal.text();
  check("the refusal says which field was the problem", text.includes("alsoBanThem"), text.slice(0, 200));
}

section("the button list and the door agree with each other");
{
  // A list that advertises a field the door does not actually require is how an operator ends up filing a
  // punishment with a blank in it. So the list is read back from the server and every button on it is
  // pushed with nothing filled in: anything that claims to need something must say no.
  process.env.EVENT_LOG_ADMIN_TOKEN = GOOD_TOKEN;

  const listed = (await (await ask("admin/catalogue", {}, GOOD_TOKEN)).json()) as {
    json?: { actions?: { id: string; aboutAnAccount: boolean; fields: { name: string; type: string; values: number[] }[] }[] };
  };
  const actions = listed.json?.actions ?? [];
  check("there is a list to check against", actions.length > 0);

  const KNOWN_TYPES = new Set(["id", "amount", "oneOf"]);
  check(
    "every field is a sort of input the screen knows how to draw",
    actions.every((a) => a.fields.every((f) => KNOWN_TYPES.has(f.type))),
    actions.flatMap((a) => a.fields.map((f) => f.type)).join(","),
  );

  let demanded = 0;
  for (const action of actions) {
    if (action.fields.length === 0) continue;
    demanded++;
    const status = await call(
      "admin/act",
      { actionId: action.id, actorId: "admin-1", subjectId: action.aboutAnAccount ? "acct-a" : "", reason: "a proper written reason", fields: {} },
      GOOD_TOKEN,
    );
    check(`${action.id} refuses to be filed with its inputs left blank`, status >= 400, `answered ${status}`);
  }
  check("several buttons were checked this way, so the loop proves something", demanded >= 4, `checked ${demanded}`);

  const noSubject = actions.filter((a) => a.aboutAnAccount === false);
  check("some actions are about no one in particular", noSubject.length > 0, "otherwise the next check is empty");
  for (const action of noSubject) {
    const fields: Record<string, unknown> = {};
    for (const field of action.fields) {
      fields[field.name] = field.type === "amount" ? 1 : field.type === "oneOf" ? (field.values[0] ?? 0) : "an-id";
    }
    const status = await call("admin/act", { actionId: action.id, actorId: "admin-1", subjectId: "acct-a", reason: "a proper written reason", fields }, GOOD_TOKEN);
    check(`${action.id} refuses to be pinned on one player`, status >= 400, `answered ${status}`);
  }
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
  throw new Error(`the event-log door: ${failures} check${failures === 1 ? "" : "s"} failed`);
} else {
  console.log("PASS — the event-log door");
}
