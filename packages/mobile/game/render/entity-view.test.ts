/**
 * Checks on EntityView — the display-only crowd interpolator.
 *
 * What is being defended: a live enemy that moved between two ticks is drawn part-way along that
 * segment by alpha (so the crowd glides on a guest instead of strobing), while a freshly spawned or
 * recycled slot SNAPS to the truth (so it never slides in from a corpse's old position). Nothing here
 * touches the simulation; these are all reads of drawn positions against known sampled ones.
 */

import { EntityView } from "./entity-view";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

// A tiny fake pool: `slots` lists the live indices, `count` how many are valid.
function pool(...indices: number[]): { slots: Int32Array; count: number } {
  const slots = new Int32Array(64);
  for (let i = 0; i < indices.length; i++) slots[i] = indices[i] as number;
  return { slots, count: indices.length };
}

console.log("-- a slot alive across two ticks interpolates between them");
{
  const view = new EntityView(64);
  const x = new Float32Array(64);
  const y = new Float32Array(64);
  const p = pool(3);

  x[3] = 0;
  y[3] = 0;
  view.sample(p.slots, p.count, x, y); // first sighting: snaps to (0,0)
  x[3] = 10;
  y[3] = 20;
  view.sample(p.slots, p.count, x, y); // second: a real segment (0,0) -> (10,20)

  check("alpha 0 draws the previous position", near(view.renderX(3, 0), 0) && near(view.renderY(3, 0), 0));
  check("alpha 1 draws the current position", near(view.renderX(3, 1), 10) && near(view.renderY(3, 1), 20));
  check("alpha 0.5 draws the midpoint", near(view.renderX(3, 0.5), 5) && near(view.renderY(3, 0.5), 10));
}

console.log("-- a slot's first sighting snaps, it does not glide from the origin");
{
  const view = new EntityView(64);
  const x = new Float32Array(64);
  const y = new Float32Array(64);
  const p = pool(7);

  x[7] = 500;
  y[7] = -300;
  view.sample(p.slots, p.count, x, y);

  // Without the first-sighting snap this would interpolate from (0,0) and read as a 580px slide.
  check("first-frame X sits on the truth at every alpha", near(view.renderX(7, 0), 500) && near(view.renderX(7, 1), 500));
  check("first-frame Y sits on the truth at every alpha", near(view.renderY(7, 0), -300) && near(view.renderY(7, 1), -300));
}

console.log("-- a recycled slot snaps rather than gliding from the dead enemy that held it");
{
  const view = new EntityView(64);
  const x = new Float32Array(64);
  const y = new Float32Array(64);

  // Slot 2 lives for two ticks over on the left, building real prev/cur history.
  x[2] = -100;
  y[2] = 0;
  view.sample(pool(2).slots, 1, x, y);
  x[2] = -110;
  view.sample(pool(2).slots, 1, x, y);

  // Slot 2 dies: it is absent from the live set for a tick (an empty crowd sample).
  view.sample(pool().slots, 0, x, y);

  // A new enemy is handed slot 2, spawned across the map on the right.
  x[2] = 400;
  y[2] = 400;
  view.sample(pool(2).slots, 1, x, y);

  check("recycled slot X snaps to the new spawn", near(view.renderX(2, 0), 400) && near(view.renderX(2, 1), 400));
  check("recycled slot Y snaps to the new spawn", near(view.renderY(2, 0), 400) && near(view.renderY(2, 1), 400));
}

console.log("-- a slot that stays away for a frame is treated as new when it returns");
{
  const view = new EntityView(64);
  const x = new Float32Array(64);
  const y = new Float32Array(64);

  x[5] = 0;
  view.sample(pool(5).slots, 1, x, y);
  x[5] = 10;
  view.sample(pool(5).slots, 1, x, y); // segment 0 -> 10
  // Skipped: slot 5 not in the live set this tick.
  view.sample(pool().slots, 0, x, y);
  x[5] = 90;
  view.sample(pool(5).slots, 1, x, y); // returns after a gap: must snap, not glide 10 -> 90

  check("a returning slot snaps to its position", near(view.renderX(5, 0), 90) && near(view.renderX(5, 1), 90));
}

console.log("-- reset forgets everything so a new run does not inherit the old crowd");
{
  const view = new EntityView(64);
  const x = new Float32Array(64);
  const y = new Float32Array(64);

  x[1] = 50;
  view.sample(pool(1).slots, 1, x, y);
  x[1] = 60;
  view.sample(pool(1).slots, 1, x, y);
  view.reset();

  // After reset the first sample of the new run is a first sighting again: it snaps.
  x[1] = 200;
  view.sample(pool(1).slots, 1, x, y);
  check("after reset the slot snaps to its fresh position", near(view.renderX(1, 0), 200) && near(view.renderX(1, 1), 200));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`FAIL — ${failures} problem(s) in entity view`);
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`entity view: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
