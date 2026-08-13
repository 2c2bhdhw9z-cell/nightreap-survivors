/** Smoke test against a live relay: two real sockets, real room, real routing, real host migration. */
import { MSG, HDR_TYPE, HDR_PLAYER, HDR_DEST, RELAY_BROADCAST } from "../../mobile/game/net/protocol";

const BASE = "ws://127.0.0.1:4400/ws";
let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
}

interface Client {
  ws: WebSocket;
  control: Record<string, unknown>[];
  binary: Uint8Array[];
}

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const c: Client = { ws, control: [], binary: [] };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") c.control.push(JSON.parse(e.data));
      else c.binary.push(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error("socket error " + url));
    setTimeout(() => reject(new Error("timeout " + url)), 3000);
  });
}

function msg(type: number, sender: number, dest: number, n = 16): Uint8Array {
  const b = new Uint8Array(n);
  b[HDR_TYPE] = type;
  b[HDR_PLAYER] = sender;
  b[HDR_DEST] = dest;
  return b;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Host creates a private room.
const host = await connect(`${BASE}?mode=create&size=3&vis=private`);
await wait(150);
const seated = host.control[0] as { t: string; slot: number; token: number; room: { code: string } };
check("host is seated", seated?.t === "seated" && seated.slot === 0);
check("host got a seat token", typeof seated?.token === "number" && seated.token > 0);
const code = seated.room.code;
check("host got a room code", /^[A-Z0-9]{6}$/.test(code), code);

// 2. Two guests join by code.
const g1 = await connect(`${BASE}?mode=join&code=${code}`);
const g2 = await connect(`${BASE}?mode=join&code=${code.toLowerCase()}`);
await wait(200);
const s1 = g1.control[0] as { slot: number; token: number };
const s2 = g2.control[0] as { slot: number; token: number };
check("guests get slots 1 and 2", s1?.slot === 1 && s2?.slot === 2, `${s1?.slot} and ${s2?.slot}`);
check("a lowercase code finds the same room", s2?.slot === 2);
check("host was told about both arrivals", host.control.filter((c) => c.t === "peer_joined").length === 2);

// 3. A bad code is refused before the socket opens.
let refused = "";
try {
  await connect(`${BASE}?mode=join&code=ZZZZZZ`);
} catch {
  refused = "rejected";
}
check("a code for no room is refused at connect", refused === "rejected");

// 4. Guest traffic reaches the host and nobody else.
g1.ws.send(msg(MSG.INPUT_BATCH, 3, 2));
await wait(150);
check("the host got the guest's input", host.binary.length === 1);
check("the relay rewrote the forged sender to the real seat", host.binary[0]?.[HDR_PLAYER] === 1, `${host.binary[0]?.[HDR_PLAYER]}`);
check("the other guest got nothing", g2.binary.length === 0);

// 5. A guest forging host-authoritative traffic is dropped.
g1.ws.send(msg(MSG.TICK_CONFIRM, 0, RELAY_BROADCAST));
g1.ws.send(msg(MSG.HOST_MIGRATE, 0, RELAY_BROADCAST));
await wait(150);
check("a forged confirm never lands", host.binary.length === 1 && g2.binary.length === 0);

// 6. The host broadcasts.
host.ws.send(msg(MSG.TICK_CONFIRM, 0, RELAY_BROADCAST));
await wait(150);
check("both guests got the broadcast", g1.binary.length === 1 && g2.binary.length === 1);
check("and it is a tick confirm", g1.binary[0]?.[HDR_TYPE] === MSG.TICK_CONFIRM);

// 7. The host addresses one guest.
host.ws.send(msg(MSG.RESYNC_CHUNK, 0, 2));
await wait(150);
check("a snapshot goes only to the guest that asked", g2.binary.length === 2 && g1.binary.length === 1);

// 8. Host drops without saying goodbye: the party survives and someone is promoted.
host.ws.close();
await wait(250);
const migrate = g1.binary.find((b) => b[HDR_TYPE] === MSG.HOST_MIGRATE);
check("the party was told there is a new host", migrate !== undefined);
check("and it is the lowest live seat", migrate?.[4] === 1, `${migrate?.[4]}`);
const left = g1.control.find((c) => c.t === "peer_left") as { held: boolean } | undefined;
check("the dropped host's seat is being held", left?.held === true);

// 9. The new host can now broadcast, and the old one's seat is reclaimable.
g1.ws.send(msg(MSG.TICK_CONFIRM, 0, RELAY_BROADCAST));
await wait(150);
const promoted = g2.binary.filter((b) => b[HDR_TYPE] === MSG.TICK_CONFIRM && b[HDR_PLAYER] === 1);
check("the promoted player is now allowed to broadcast", promoted.length === 1, `${promoted.length}`);

const back = await connect(`${BASE}?mode=rejoin&code=${code}&token=${seated.token}`);
await wait(200);
const reseated = back.control[0] as { t: string; slot: number };
check("the dropped player walks back into the same seat", reseated?.slot === 0, `${reseated?.slot}`);

let stranger = "";
try {
  const other = await connect(`${BASE}?mode=join&code=${code}`);
  await wait(150);
  const st = other.control[0] as { slot: number };
  stranger = String(st?.slot);
  other.ws.close();
} catch {
  stranger = "refused";
}
check("a full room refuses a fourth", stranger === "refused" || stranger === "undefined", stranger);

// 10. Health endpoint.
const health = (await (await fetch("http://127.0.0.1:4400/health")).json()) as {
  ok: boolean;
  traffic: { dropped: number; droppedRole: number; droppedServerAuthored: number };
};
check("the relay reports healthy", health.ok === true);
check("it counted the forged messages it dropped", health.traffic.droppedRole >= 1, `${health.traffic.droppedRole}`);
check("including the one only the server may author", health.traffic.droppedServerAuthored >= 1);

g1.ws.close();
g2.ws.close();
back.ws.close();
console.log(fails === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${fails})`);
const h = globalThis as unknown as { process?: { exit?: (c: number) => void } };
h.process?.exit?.(fails === 0 ? 0 : 1);
