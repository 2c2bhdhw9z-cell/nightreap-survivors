/**
 * Weapon content self-check. Run headless: `bun packages/mobile/game/sim/weapon-content.test.ts`
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM combat.test.ts
 * `combat.test.ts` proves the machinery: that a sweep sweeps, that pierce spends itself, that a tick
 * allocates nothing. This file proves the *content* — thirty rows of hand-typed numbers — and those fail
 * in a completely different way. Nothing here crashes. A weapon with the wrong archetype fields quietly
 * fires from the wrong place; an orbiter whose ring sits a few pixels too far out does full damage to
 * nothing at all; a level with no numbers on it is a card that costs the player a pick and gives them
 * nothing back; a renumbered wire id means an old replay decodes into a different weapon than the one
 * that was really fired. Every one of those looks completely fine in a screenshot.
 *
 * The orbiter check below exists because that exact bug happened. Two new orbiting weapons were written
 * with a ring wide enough to look impressive, and one of them could not touch a crowd pressed against the
 * player, because area does not only widen an orbiter's blade — it pushes the whole ring outward while the
 * blade stays the size it was. The rule is now measured rather than remembered.
 *
 * WHAT IT PROVES
 *   1. The table is fifteen offerable weapons and fifteen evolutions, one evolution each.
 *   2. Ids and names are unique, and every row has words on it.
 *   3. Wire ids are the append-only run 1..N, they fit in a byte, and the twelve that shipped first
 *      still hold the exact numbers they shipped with.
 *   4. Every one of the seven level-ups on every weapon moves at least one number, and says so.
 *   5. Archetype fields are consistent: what stands still has no speed, what travels has speed, and
 *      only the shapes anchored to the player carry an anchor distance and an arc.
 *   6. The behaviour switches and the numbers agree: a re-ticking shape has a re-tick interval and a
 *      non-re-ticking one does not, and a shape that says it never shoves carries no shove.
 *   7. Nothing folds itself into nonsense at max level: cooldowns and re-ticks stay above zero, and
 *      damage, count and pierce only ever go up.
 *   8. Every orbiter's ring, at ordinary starting area, still reaches a crowd standing at arm's length.
 *   9. Every evolution is strictly an upgrade: same archetype, more damage, no slower.
 *  10. The fifteen evolutions ask for fifteen different passive items, so chasing two is a real choice.
 */

import { MOVE, PROJ_FLAG } from "./projectiles";
import { PASSIVE_BY_ID } from "./passives";
import {
  createWeaponSnapshot,
  MAX_WEAPON_LEVEL,
  WEAPON_BY_ID,
  WEAPON_BY_WIRE_ID,
  WEAPON_TYPES,
  snapshotWeapon,
} from "./weapons";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

const OFFERABLE = WEAPON_TYPES.filter((w) => w.evolvedFrom === "");
const EVOLUTIONS = WEAPON_TYPES.filter((w) => w.evolvedFrom !== "");

/** Shapes that hang off the player rather than travelling away from it. */
const ANCHORED: number[] = [MOVE.sweep, MOVE.orbiting];
/** Shapes that do not move under their own speed at all. */
const STATIONARY: number[] = [MOVE.sweep, MOVE.orbiting, MOVE.aura];

function snapshotAtTop(w: (typeof WEAPON_TYPES)[number]) {
  const snap = createWeaponSnapshot();
  snapshotWeapon(WEAPON_BY_ID.get(w.id) ?? -1, MAX_WEAPON_LEVEL, snap);
  return snap;
}

// ---------------------------------------------------------------------------------------------
section("the shape of the table");
{
  check("fifteen weapons the player can be offered", OFFERABLE.length === 15, `${OFFERABLE.length}`);
  check("fifteen evolutions behind them", EVOLUTIONS.length === 15, `${EVOLUTIONS.length}`);
  check(
    "and nothing else in the table",
    OFFERABLE.length + EVOLUTIONS.length === WEAPON_TYPES.length,
    `${WEAPON_TYPES.length} rows`,
  );

  const ids = new Set(WEAPON_TYPES.map((w) => w.id));
  check("no two weapons share an id", ids.size === WEAPON_TYPES.length, `${ids.size} distinct`);

  const names = new Set(WEAPON_TYPES.map((w) => w.name));
  check(
    "no two weapons share a name — the level-up card would be unreadable",
    names.size === WEAPON_TYPES.length,
    `${names.size} distinct`,
  );

  check(
    "every weapon has a name and a description",
    WEAPON_TYPES.every((w) => w.name.trim().length > 2 && w.blurb.trim().length > 8),
  );

  check(
    "every archetype is held by at least two offerable weapons, so no single pick is the only way to see one",
    Object.values(MOVE).every((m) => OFFERABLE.filter((w) => w.move === m).length >= 2),
    Object.entries(MOVE)
      .map(([k, m]) => `${k}:${OFFERABLE.filter((w) => w.move === m).length}`)
      .join(" "),
  );
}

// ---------------------------------------------------------------------------------------------
section("wire ids, which live in saves, replays and co-op packets");
{
  check(
    "wire ids are the append-only run 1..N with no gaps",
    WEAPON_TYPES.every((w, i) => w.wireId === i + 1),
    `1..${WEAPON_TYPES.length}`,
  );
  check("and every one of them resolves back", WEAPON_BY_WIRE_ID.size === WEAPON_TYPES.length);
  check(
    "and they still fit in a single byte, which is what the packet format assumes",
    WEAPON_TYPES.every((w) => w.wireId >= 1 && w.wireId <= 255),
  );

  /*
   * The twelve weapons that shipped first, pinned by hand.
   *
   * This is the whole point of "append-only". A save file written last week holds these numbers and
   * nothing else; if a later edit reorders the table or renumbers a row, that save silently loads a
   * different weapon than the player had. A generated check cannot catch that — it would renumber right
   * along with the mistake — so the original twelve are written out longhand and compared.
   */
  const SHIPPED: readonly (readonly [string, number])[] = [
    ["reapersLash", 1],
    ["boneKnives", 2],
    ["gravebolt", 3],
    ["tombAxe", 4],
    ["shroudedTome", 5],
    ["rotAura", 6],
    ["reapersVerdict", 7],
    ["boneStorm", 8],
    ["gravehail", 9],
    ["tombfall", 10],
    ["codexOfHollows", 11],
    ["plagueBloom", 12],
  ];
  const moved = SHIPPED.filter(([id, wire]) => {
    const w = WEAPON_TYPES.find((x) => x.id === id);
    return w === undefined || w.wireId !== wire;
  }).map(([id]) => id);
  check(
    "the twelve weapons that shipped first still hold the numbers they shipped with",
    moved.length === 0,
    moved.length === 0 ? "" : `moved: ${moved.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("every level-up is a real level-up");
{
  const shortRows = WEAPON_TYPES.filter((w) => w.levels.length !== MAX_WEAPON_LEVEL - 1);
  check(
    "seven level-ups each, which is what levels 2 through 8 needs",
    shortRows.length === 0,
    shortRows.map((w) => w.id).join(", "),
  );

  const wordless: string[] = [];
  const empty: string[] = [];
  for (const w of WEAPON_TYPES) {
    for (let i = 0; i < w.levels.length; i++) {
      const lv = w.levels[i];
      if (lv.text.trim().length < 3) wordless.push(`${w.id}#${i + 2}`);
      const moves =
        (lv.damage ?? 0) !== 0 ||
        (lv.count ?? 0) !== 0 ||
        (lv.cooldown ?? 0) !== 0 ||
        (lv.pierce ?? 0) !== 0 ||
        (lv.radius ?? 0) !== 0 ||
        (lv.ttl ?? 0) !== 0 ||
        (lv.speed ?? 0) !== 0 ||
        (lv.retick ?? 0) !== 0;
      if (!moves) empty.push(`${w.id}#${i + 2}`);
    }
  }
  check("every level-up says what it does", wordless.length === 0, wordless.join(", "));
  check(
    "and every level-up actually does something — no level costs a pick and changes nothing",
    empty.length === 0,
    empty.join(", "),
  );

  // A level-up that reads "+5 damage" and adds nothing to damage is the one lie the player can catch
  // us in, because the number is printed on the card they just picked.
  const lying: string[] = [];
  for (const w of WEAPON_TYPES) {
    for (let i = 0; i < w.levels.length; i++) {
      const lv = w.levels[i];
      const claim = /\+(\d+) damage/.exec(lv.text);
      if (claim !== null && (lv.damage ?? 0) !== Number(claim[1])) lying.push(`${w.id}#${i + 2}`);
    }
  }
  check(
    "a level-up that promises a number on the card adds exactly that number",
    lying.length === 0,
    lying.join(", "),
  );
}

// ---------------------------------------------------------------------------------------------
section("archetype fields agree with the archetype");
{
  const speedWrong = WEAPON_TYPES.filter((w) =>
    STATIONARY.includes(w.move) ? w.speed !== 0 : w.speed <= 0,
  );
  check(
    "what stands still carries no travel speed, and what travels carries one",
    speedWrong.length === 0,
    speedWrong.map((w) => w.id).join(", "),
  );

  const anchorWrong = WEAPON_TYPES.filter((w) =>
    ANCHORED.includes(w.move) ? w.anchorDist <= 0 || w.arc <= 0 : w.anchorDist !== 0 || w.arc !== 0,
  );
  check(
    "only the shapes pinned to the player carry an anchor distance and an arc",
    anchorWrong.length === 0,
    anchorWrong.map((w) => w.id).join(", "),
  );

  const spreadWrong = WEAPON_TYPES.filter((w) => w.spread !== 0 && STATIONARY.includes(w.move));
  check(
    "a shape that does not fly anywhere has nothing to spread",
    spreadWrong.length === 0,
    spreadWrong.map((w) => w.id).join(", "),
  );

  const auraWrong = WEAPON_TYPES.filter((w) => w.move === MOVE.aura && w.radius < 20);
  check(
    "an aura is big enough to be worth standing in",
    auraWrong.length === 0,
    auraWrong.map((w) => `${w.id} r=${w.radius}`).join(", "),
  );
}

// ---------------------------------------------------------------------------------------------
section("behaviour switches and numbers do not contradict each other");
{
  const retickWrong = WEAPON_TYPES.filter((w) => {
    const reticks = (w.flags & PROJ_FLAG.reticks) !== 0;
    return reticks ? w.retick <= 0 : w.retick !== 0;
  });
  check(
    "a re-ticking shape has an interval, and one that hits once does not",
    retickWrong.length === 0,
    retickWrong.map((w) => `${w.id} retick=${w.retick}`).join(", "),
  );

  const shoveWrong = WEAPON_TYPES.filter(
    (w) => (w.flags & PROJ_FLAG.noKnockback) !== 0 && w.knockback !== 0,
  );
  check(
    "a shape that says it never shoves carries no shove, so the number cannot lie",
    shoveWrong.length === 0,
    shoveWrong.map((w) => `${w.id} kb=${w.knockback}`).join(", "),
  );

  const fragileWrong = WEAPON_TYPES.filter(
    (w) => (w.flags & PROJ_FLAG.fragile) !== 0 && w.pierce > 3,
  );
  check(
    "nothing claims to die on its first hit and also punch through a crowd",
    fragileWrong.length === 0,
    fragileWrong.map((w) => `${w.id} pierce=${w.pierce}`).join(", "),
  );

  check(
    "nothing in the player's hands is flagged as belonging to an enemy",
    WEAPON_TYPES.every((w) => (w.flags & PROJ_FLAG.hostile) === 0),
  );
}

// ---------------------------------------------------------------------------------------------
section("nothing folds into nonsense at the top level");
{
  const bad: string[] = [];
  for (const w of WEAPON_TYPES) {
    const top = snapshotAtTop(w);
    if (top.cooldown <= 0) bad.push(`${w.id} cooldown=${top.cooldown}`);
    if ((w.flags & PROJ_FLAG.reticks) !== 0 && top.retick <= 0) {
      bad.push(`${w.id} retick=${top.retick}`);
    }
    if (top.count < w.count) bad.push(`${w.id} count fell`);
    if (top.pierce < w.pierce) bad.push(`${w.id} pierce fell`);
    if (top.damage <= w.damage) bad.push(`${w.id} damage did not grow`);
    if (top.ttl <= 0) bad.push(`${w.id} ttl=${top.ttl}`);
    if (top.radius <= 0) bad.push(`${w.id} radius=${top.radius}`);
  }
  check("a fully levelled weapon still has sane numbers", bad.length === 0, bad.join(", "));

  // A cooldown that folds down to a couple of ticks fires sixty volleys a second, which is a frame-rate
  // problem disguised as a balance choice.
  const tooFast = WEAPON_TYPES.filter((w) => {
    const top = snapshotAtTop(w);
    return w.move !== MOVE.aura && top.cooldown < 20;
  });
  check(
    "and no weapon folds down to firing every few ticks",
    tooFast.length === 0,
    tooFast.map((w) => `${w.id} ${snapshotAtTop(w).cooldown}t`).join(", "),
  );
}

// ---------------------------------------------------------------------------------------------
section("an orbiter's ring still reaches the crowd it exists to grind");
{
  /*
   * The crowd this is measured against is the one in `combat.test.ts`: bodies pressed against the player
   * out to roughly two and a half body-widths, the furthest ring at 42 world units, each body 11 units
   * across. If an orbiter cannot reach that, it cannot reach anything that is actually threatening the
   * player, and it does its full damage to empty floor.
   *
   * The ring a weapon really orbits on is its anchor distance PLUS its own blade radius, and area
   * scales the blade — so a wide ring is pushed wider still by the very stat that is supposed to
   * improve it. That is why this is measured at ordinary starting area rather than assumed.
   */
  const CROWD_EDGE = 42;
  const BODY_RADIUS = 11;

  const drifted: string[] = [];
  for (const w of WEAPON_TYPES) {
    if (w.move !== MOVE.orbiting) continue;
    const ring = w.anchorDist + w.radius;
    const reach = w.radius + BODY_RADIUS;
    if (ring - CROWD_EDGE > reach) {
      drifted.push(`${w.id} ring=${ring} reach=${reach}`);
    }
  }
  check(
    "every orbiter can still touch a body standing at arm's length",
    drifted.length === 0,
    drifted.join(", "),
  );

  // Both directions matter. A ring drawn tight against the player is a garlic aura wearing an orbiter's
  // costume, and it loses the thing that makes an orbiter feel different to hold.
  const collapsed = WEAPON_TYPES.filter((w) => w.move === MOVE.orbiting && w.anchorDist < 24);
  check(
    "and no orbiter has collapsed into the player and become an aura",
    collapsed.length === 0,
    collapsed.map((w) => `${w.id} ad=${w.anchorDist}`).join(", "),
  );
}

// ---------------------------------------------------------------------------------------------
section("every evolution is strictly an upgrade");
{
  const notBetter: string[] = [];
  for (const e of EVOLUTIONS) {
    const base = WEAPON_TYPES.find((w) => w.id === e.evolvedFrom);
    if (base === undefined) {
      notBetter.push(`${e.id} has no base`);
      continue;
    }
    if (base.move !== e.move) notBetter.push(`${e.id} changed archetype`);
    if (e.damage <= base.damage) notBetter.push(`${e.id} hits no harder`);
    if (e.cooldown > base.cooldown) notBetter.push(`${e.id} fires slower`);
    if (e.count < base.count) notBetter.push(`${e.id} fires less`);
    if (e.evolvesTo !== "" || e.evolveRequires !== "") notBetter.push(`${e.id} evolves again`);
  }
  check(
    "same archetype, more damage, no slower, and the ladder ends there",
    notBetter.length === 0,
    notBetter.join(", "),
  );

  const missing = OFFERABLE.filter((w) => w.evolvesTo === "" || w.evolveRequires === "");
  check(
    "and every offerable weapon has one waiting",
    missing.length === 0,
    missing.map((w) => w.id).join(", "),
  );

  const asks = OFFERABLE.map((w) => w.evolveRequires);
  check(
    "the fifteen evolutions ask for fifteen different items, so chasing two is a real choice",
    new Set(asks).size === asks.length,
    `${new Set(asks).size} distinct items`,
  );
  check(
    "and every item they ask for is one the game actually has",
    asks.every((id) => PASSIVE_BY_ID.has(id)),
  );
}

console.log("");
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`weapon content: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
console.log(
  `PASS — ${OFFERABLE.length} weapons, ${EVOLUTIONS.length} evolutions, ` +
    `${WEAPON_TYPES.length * (MAX_WEAPON_LEVEL - 1)} level-ups`,
);
