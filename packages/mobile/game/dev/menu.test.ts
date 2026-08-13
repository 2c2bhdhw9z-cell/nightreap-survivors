/**
 * Dev-menu shell rules. Run headless: `bun packages/mobile/game/dev/menu.test.ts`
 *
 * WHAT THIS PROVES
 *   1. The tab strip is fixed, complete, and every tab has panels behind it.
 *   2. A greyed row's state is the gate's answer, for every panel on every flag combination — the menu
 *      never invents a second, more generous opinion.
 *   3. A locked tab is visible but never enumerable: no rows, no count, no search hit, no favourite.
 *   4. Every count is derived from the registry, not written down. Asserted by construction, so adding
 *      a panel cannot make a number stale.
 *   5. Favourites drop stale, locked and over-cap entries instead of showing something broken.
 *   6. A public build with nothing unlocked lands on a valid screen rather than an empty one.
 */

import { applyDevFlags, createDevContext, type DevFlags } from "./channel";
import { DENY, DevGate } from "./devgate";
import {
  MAX_FAVOURITES,
  MENU_GROUPS,
  PANEL_ROUTES,
  buildMenuView,
  groupLabel,
  lintMenu,
  menuRows,
  menuTabs,
  menuTotals,
  resolveFavourites,
  badgeIsWarning,
  resolveGroup,
  routeForPanel,
  runBadge,
  searchMenu,
  toggleFavourite,
} from "./menu";
import { DEV_PANELS, type DevGroup } from "./registry";

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

/** An internal build with the menu on: everything open. */
function internalGate(): DevGate {
  const ctx = createDevContext("internal");
  ctx.flags.devMenuEnabled = true;
  return new DevGate(ctx);
}

/** A public build with the secret unlock entered: SELF open, SYSTEM shut. */
function publicUnlockedGate(): DevGate {
  const ctx = createDevContext("public");
  ctx.flags.devMenuEnabled = true;
  ctx.unlocked = true;
  return new DevGate(ctx);
}

/** A stock store build: menu off entirely. */
function publicClosedGate(): DevGate {
  const ctx = createDevContext("public");
  ctx.flags.devMenuEnabled = false;
  ctx.unlocked = false;
  return new DevGate(ctx);
}

/**
 * A gate with one single panel switched off, standing in for a panel killed remotely by its own flag.
 *
 * WHY A DOUBLE AND NOT REAL DATA
 * No panel in the registry currently uses `requiresFlag`, so "a refused row inside an open tab" has no
 * instance in real data — which is exactly why the first version of the greyed-row test passed while
 * proving nothing. The code path is real and the day we kill one panel it goes live, so the case is
 * constructed here rather than left untested. Both methods are overridden together, because the whole
 * rule under test is that the menu asks the gate rather than working it out.
 */
class OnePanelKilled extends DevGate {
  constructor(
    ctx: ReturnType<typeof createDevContext>,
    private readonly victim: string,
  ) {
    super(ctx);
  }

  override reachable(id: string): boolean {
    return id === this.victim ? false : super.reachable(id);
  }

  override probe(id: string) {
    return id === this.victim ? DENY.FLAG_OFF : super.probe(id);
  }
}

function gateWithOnePanelKilled(victim: string): DevGate {
  const ctx = createDevContext("internal");
  ctx.flags.devMenuEnabled = true;
  return new OnePanelKilled(ctx, victim);
}

/* ---- 1. the tab strip ---------------------------------------------------------------------------- */

section("the tab strip");
{
  check("menu lint is clean", lintMenu().length === 0, lintMenu().join("; "));

  const groupsInRegistry = new Set<string>(DEV_PANELS.map((p) => p.group));
  const groupsInStrip = new Set<string>(MENU_GROUPS);
  check(
    "every group that has panels has a tab",
    [...groupsInRegistry].every((g) => groupsInStrip.has(g)),
    `${groupsInRegistry.size} groups in registry, ${groupsInStrip.size} tabs`,
  );
  check(
    "no tab exists without panels",
    [...groupsInStrip].every((g) => groupsInRegistry.has(g)),
  );
  check(
    "every tab has a non-empty label",
    MENU_GROUPS.every((g) => groupLabel(g).length > 0),
  );
  check("tab order has no duplicates", new Set(MENU_GROUPS).size === MENU_GROUPS.length);

  // The strip must not change shape between builds — that is the point of showing locked tabs.
  const a = menuTabs(internalGate()).map((t) => t.group).join(",");
  const b = menuTabs(publicUnlockedGate()).map((t) => t.group).join(",");
  const c = menuTabs(publicClosedGate()).map((t) => t.group).join(",");
  check("the strip is the same shape on every build", a === b && b === c, a);
}

/* ---- 2. greyed state is the gate's answer, never a second opinion -------------------------------- */

section("greyed state is the gate's answer");
{
  // All eight flag combinations, both channels, both unlock states: 32 gates. For each, every row the
  // menu is willing to list must agree with the gate about whether it opens.
  let rowsChecked = 0;
  let disagreements = 0;
  let reasonsMissing = 0;

  for (const channel of ["public", "internal"] as const) {
    for (const unlocked of [false, true]) {
      for (let bits = 0; bits < 8; bits++) {
        const ctx = createDevContext(channel);
        ctx.unlocked = unlocked;
        const flags: DevFlags = {
          devMenuEnabled: (bits & 1) !== 0,
          chaosSandboxActive: (bits & 2) !== 0,
          accountBlocked: (bits & 4) !== 0,
        };
        applyDevFlags(ctx, flags, true);
        const gate = new DevGate(ctx);

        for (const group of MENU_GROUPS) {
          for (const row of menuRows(gate, group)) {
            rowsChecked++;
            if (row.reachable !== gate.reachable(row.id)) disagreements++;
            // A greyed row must say why, or a missing tool becomes a mystery.
            if (!row.reachable && row.denyText.trim() === "") reasonsMissing++;
            if (row.reachable && row.denyText !== "") reasonsMissing++;
          }
        }
      }
    }
  }

  check("rows were actually examined", rowsChecked > 200, `${rowsChecked} rows across 32 builds`);
  check("no row disagrees with the gate", disagreements === 0, `${disagreements} disagreements`);
  check("no open row carries a stray reason", reasonsMissing === 0);

  // The case above cannot produce a greyed row inside an open tab, because no panel is flag-gated yet.
  // So that half of the rule is proved against a killed panel instead — and the count of greyed rows is
  // asserted, so this can never quietly go back to proving nothing.
  const victim = DEV_PANELS.find((p) => p.tier === "self")?.id as string;
  const killed = gateWithOnePanelKilled(victim);
  const rowsInThatTab = menuRows(killed, DEV_PANELS.find((p) => p.id === victim)?.group as DevGroup);
  const greyed = rowsInThatTab.filter((r) => !r.reachable);

  check("exactly one row in that tab is greyed", greyed.length === 1, `${greyed.length} greyed`);
  check("the greyed row is the killed one", greyed[0]?.id === victim);
  check(
    "the greyed row explains itself",
    (greyed[0]?.denyText ?? "") === "disabled remotely",
    `"${greyed[0]?.denyText}"`,
  );
  check(
    "its neighbours in the same tab are untouched",
    rowsInThatTab.filter((r) => r.reachable).length === rowsInThatTab.length - 1,
  );
  check(
    "a killed panel still appears rather than vanishing",
    rowsInThatTab.some((r) => r.id === victim),
  );
  check(
    "a killed panel still turns up in search, greyed",
    searchMenu(killed, victim).some((r) => r.id === victim && !r.reachable),
  );
  check(
    "killing one panel does not lock its tab",
    !menuTabs(killed).find((t) => t.group === greyed[0]?.group)?.locked,
  );
}

/* ---- 3. a locked tab is visible but never enumerable --------------------------------------------- */

section("a locked tab hides its contents");
{
  const gate = publicUnlockedGate();
  const tabs = menuTabs(gate);
  const locked = tabs.filter((t) => t.locked);
  const open = tabs.filter((t) => !t.locked);

  check("a public unlocked build has locked tabs", locked.length > 0, `${locked.length} locked`);
  check("a public unlocked build has open tabs", open.length > 0, `${open.length} open`);

  check(
    "a locked tab lists no rows",
    locked.every((t) => menuRows(gate, t.group).length === 0),
  );
  check(
    "a locked tab reports no count",
    locked.every((t) => t.rowCount === 0),
  );
  check(
    "an open tab reports a real count",
    open.every((t) => t.rowCount === menuRows(gate, t.group).length && t.rowCount > 0),
  );

  // The enumeration leak that matters: search must not reach into a locked tab. Search for a word from
  // an actual locked-tab panel label rather than a made-up one.
  const lockedGroups = new Set<DevGroup>(locked.map((t) => t.group));
  const lockedPanels = DEV_PANELS.filter((p) => lockedGroups.has(p.group));
  check("there are locked panels to try to leak", lockedPanels.length > 0, `${lockedPanels.length}`);

  let leaked = 0;
  for (const panel of lockedPanels) {
    if (searchMenu(gate, panel.label).some((r) => r.id === panel.id)) leaked++;
    if (searchMenu(gate, panel.id).some((r) => r.id === panel.id)) leaked++;
  }
  check("no locked panel can be found by search", leaked === 0, `${leaked} leaks`);

  // Same door, different handle: a pinned favourite must not open a locked tab.
  const pinnedLocked = resolveFavourites(gate, lockedPanels.map((p) => p.id));
  check("no locked panel can be pinned as a favourite", pinnedLocked.length === 0);

  // And on internal, the same panels are findable — proving the test above isn't passing because search
  // is simply broken.
  const inGate = internalGate();
  const foundOnInternal = lockedPanels.filter((p) =>
    searchMenu(inGate, p.id).some((r) => r.id === p.id),
  ).length;
  check(
    "those same panels ARE findable on an internal build",
    foundOnInternal === lockedPanels.length,
    `${foundOnInternal}/${lockedPanels.length}`,
  );
}

/* ---- 4. counts are derived, not written down ----------------------------------------------------- */

section("counts are derived from the registry");
{
  const gate = publicUnlockedGate();
  const totals = menuTotals(gate);
  const tabs = menuTabs(gate);

  check(
    "total equals the registry length",
    totals.total === DEV_PANELS.length,
    `${totals.total}`,
  );

  // Recompute independently: sum of open tabs' counts must equal the visible total.
  const sumOfOpenTabs = tabs.reduce((n, t) => n + t.rowCount, 0);
  check(
    "visible equals the sum of the open tabs",
    totals.visible === sumOfOpenTabs,
    `${totals.visible} vs ${sumOfOpenTabs}`,
  );

  check(
    "a public build sees fewer panels than exist",
    totals.visible < totals.total && totals.visible > 0,
    `${totals.visible} of ${totals.total}`,
  );

  const internalTotals = menuTotals(internalGate());
  check(
    "an internal build sees all of them",
    internalTotals.visible === internalTotals.total,
    `${internalTotals.visible} of ${internalTotals.total}`,
  );

  // The read-only count must match a hand count of the visible rows, not the registry-wide one.
  let handCount = 0;
  for (const t of tabs) {
    if (t.locked) continue;
    handCount += menuRows(gate, t.group).filter((r) => r.readOnly).length;
  }
  check(
    "the read-only count counts only visible panels",
    totals.visibleReadOnly === handCount,
    `${totals.visibleReadOnly} vs ${handCount}`,
  );

  // A closed build enumerates nothing at all.
  const closed = menuTotals(publicClosedGate());
  check("a menu-off build enumerates nothing", closed.visible === 0 && closed.visibleReadOnly === 0);
}

/* ---- 5. the taint warning tells the truth -------------------------------------------------------- */

section("the taint warning");
{
  const gate = internalGate();

  // A tab of pure inspectors must not warn; a tab with a live write toggle must.
  let warned = 0;
  let quiet = 0;
  let wrong = 0;
  for (const group of MENU_GROUPS) {
    const view = buildMenuView(gate, group, []);
    const anyWriteReachable = view.rows.some((r) => r.taints && r.reachable);
    if (view.warnTaint !== anyWriteReachable) wrong++;
    if (view.warnTaint) warned++;
    else quiet++;
  }
  check("the warning matches whether a write toggle is present", wrong === 0);
  check("at least one tab warns", warned > 0, `${warned} warn`);
  check("at least one tab stays quiet", quiet > 0, `${quiet} quiet`);

  // The label must be the gate's own arithmetic, for every panel on every build — not a rule repeated
  // from the spec. This is the check that makes "read-only panels do not taint" true by derivation.
  let labelMismatch = 0;
  let rowsSeen = 0;
  for (const chaos of [false, true]) {
    const ctx = createDevContext("internal");
    ctx.flags.devMenuEnabled = true;
    ctx.flags.chaosSandboxActive = chaos;
    const g = new DevGate(ctx);
    for (const group of MENU_GROUPS) {
      for (const row of menuRows(g, group)) {
        rowsSeen++;
        if (row.taints !== (g.wouldTaint(row.id) !== 0)) labelMismatch++;
      }
    }
  }
  check("the taint label is the gate's answer", labelMismatch === 0, `${rowsSeen} rows`);

  // Ordinarily an inspector costs nothing...
  const allRows = MENU_GROUPS.flatMap((g) => menuRows(gate, g));
  check(
    "no read-only row claims to taint on a normal build",
    allRows.every((r) => !(r.readOnly && r.taints)),
  );
  check("some rows do taint", allRows.some((r) => r.taints));
  check("there are read-only rows to have got that wrong", allRows.some((r) => r.readOnly));

  // ...but during a chaos sandbox the whole run is tainted from tick zero, so the menu must say so
  // rather than repeating the comfortable version. This is the row label following the gate.
  const chaosCtx = createDevContext("internal");
  chaosCtx.flags.devMenuEnabled = true;
  chaosCtx.flags.chaosSandboxActive = true;
  const chaosGate = new DevGate(chaosCtx);
  const chaosRows = MENU_GROUPS.flatMap((g) => menuRows(chaosGate, g));
  check(
    "during a chaos sandbox even an inspector is marked as tainting",
    chaosRows.filter((r) => r.readOnly).length > 0 &&
      chaosRows.filter((r) => r.readOnly).every((r) => r.taints),
  );

  // And the gate's promise has to be real, not just self-consistent: what it says it would apply is
  // what a live run actually receives.
  let bitsMismatch = 0;
  for (const panel of DEV_PANELS) {
    const ctx = createDevContext("internal");
    ctx.flags.devMenuEnabled = true;
    const g = new DevGate(ctx);
    let applied = 0;
    const sink = {
      taint(b: number) {
        applied |= b;
      },
      get tainted() {
        return applied;
      },
    };
    ctx.runActive = true;
    g.attachRun(sink);
    const predicted = g.wouldTaint(panel.id);
    g.open(panel.id);
    if (applied !== predicted) bitsMismatch++;
  }
  check(
    "what the gate says it would apply is what a run receives",
    bitsMismatch === 0,
    `${bitsMismatch} of ${DEV_PANELS.length} mismatched`,
  );
}

/* ---- 6. favourites ------------------------------------------------------------------------------- */

section("favourites");
{
  const gate = internalGate();
  const real = DEV_PANELS.slice(0, MAX_FAVOURITES + 3).map((p) => p.id);

  check(
    "favourites are capped",
    resolveFavourites(gate, real).length === MAX_FAVOURITES,
    `cap ${MAX_FAVOURITES}`,
  );
  check(
    "a retired id is dropped, not shown broken",
    resolveFavourites(gate, ["no.such.panel.anymore"]).length === 0,
  );
  check(
    "a retired id does not consume a slot",
    resolveFavourites(gate, ["no.such.panel", ...real]).length === MAX_FAVOURITES,
  );
  check(
    "a duplicate id does not consume two slots",
    resolveFavourites(gate, [real[0] as string, real[0] as string, real[1] as string]).length === 2,
  );

  const first = DEV_PANELS[0]?.id as string;
  const second = DEV_PANELS[1]?.id as string;
  check("toggling on adds", toggleFavourite([], first).includes(first));
  check("toggling off removes", !toggleFavourite([first], first).includes(first));
  check("newest lands first", toggleFavourite([first], second)[0] === second);
  const overfull = DEV_PANELS.slice(0, MAX_FAVOURITES).map((p) => p.id);
  check(
    "toggling on past the cap stays capped",
    toggleFavourite(overfull, DEV_PANELS[MAX_FAVOURITES]?.id as string).length === MAX_FAVOURITES,
  );
}

/* ---- 7. the selected tab is always a valid one --------------------------------------------------- */

section("the selected tab");
{
  const pub = publicUnlockedGate();
  const lockedTab = menuTabs(pub).find((t) => t.locked)?.group as DevGroup;

  check("a locked request falls back to an open tab", !menuTabs(pub).find((t) => t.group === resolveGroup(pub, lockedTab))?.locked);
  check(
    "an open request is honoured",
    resolveGroup(pub, "player") === "player",
  );
  check("no request lands somewhere valid", menuTabs(pub).find((t) => t.group === resolveGroup(pub, undefined))?.locked === false);

  // Nothing open: the view must still name a tab, and must say why it is empty.
  const closed = publicClosedGate();
  const view = buildMenuView(closed, undefined, []);
  check("a closed build still selects a tab", MENU_GROUPS.includes(view.group));
  check("a closed build lists no rows", view.rows.length === 0);
  check("a closed build explains itself", view.emptyReason !== "");
  check(
    "an open build does not show an empty reason",
    buildMenuView(internalGate(), "player", []).emptyReason === "",
  );
  check(
    "a closed build's refusal is the gate's own",
    closed.probe(DEV_PANELS[0]?.id as string) === DENY.MENU_UNAVAILABLE,
  );
}

/* ---- 8. search behaviour ------------------------------------------------------------------------- */

section("search");
{
  const gate = internalGate();

  check("an empty query returns nothing", searchMenu(gate, "").length === 0);
  check("whitespace is not a query", searchMenu(gate, "   ").length === 0);

  const target = DEV_PANELS[0] as { id: string; label: string };
  check(
    "a label match is found",
    searchMenu(gate, target.label).some((r) => r.id === target.id),
  );
  check(
    "an id match is found, so a bug report can be pasted back in",
    searchMenu(gate, target.id).some((r) => r.id === target.id),
  );
  check(
    "matching ignores case",
    searchMenu(gate, target.label.toUpperCase()).some((r) => r.id === target.id) &&
      searchMenu(gate, target.label.toLowerCase()).some((r) => r.id === target.id),
  );
  check("nonsense finds nothing", searchMenu(gate, "zzzzqqqq").length === 0);

  // Reachable hits must sort above greyed ones.
  const wide = searchMenu(gate, "a");
  let orderOk = true;
  let sawUnreachable = false;
  for (const r of wide) {
    if (!r.reachable) sawUnreachable = true;
    else if (sawUnreachable) orderOk = false;
  }
  check("greyed hits never sort above usable ones", orderOk, `${wide.length} hits`);
}

/* ---- 9. the whole view holds together ------------------------------------------------------------ */

section("the assembled view");
{
  const gate = internalGate();
  const view = buildMenuView(gate, "player", [DEV_PANELS[0]?.id as string], "");

  check("the view selects the asked-for tab", view.group === "player");
  check("the view's rows are that tab's rows", view.rows.length === menuRows(gate, "player").length);
  check("the view carries every tab", view.tabs.length === MENU_GROUPS.length);
  check("the view resolved the favourite", view.favourites.length === 1);

  // A query overrides the tab, because a search is a whole-menu question.
  const searched = buildMenuView(gate, "player", [], DEV_PANELS[0]?.label as string);
  check(
    "a query replaces the tab's rows with results",
    searched.rows.some((r) => r.id === DEV_PANELS[0]?.id),
  );
  check(
    "searching can return rows from other tabs",
    buildMenuView(gate, "player", [], "a").rows.some((r) => r.group !== "player"),
  );
}

/* ---- 9b. the run badge tells four different truths ----------------------------------------------- */

section("the run badge");
{
  function sink() {
    let bits = 0;
    return {
      taint(b: number) {
        bits |= b;
      },
      get tainted() {
        return bits;
      },
    };
  }

  // No run, public build: not a warning, because there is nothing to warn about.
  const idle = publicUnlockedGate();
  check("no run on a public build reads NO RUN", runBadge(idle) === "NO RUN", runBadge(idle));
  check("NO RUN is not a warning", !badgeIsWarning("NO RUN"));

  // A clean public run.
  const cleanCtx = createDevContext("public");
  cleanCtx.flags.devMenuEnabled = true;
  cleanCtx.unlocked = true;
  const clean = new DevGate(cleanCtx);
  cleanCtx.runActive = true;
  clean.attachRun(sink());
  check("a clean public run reads RUN CLEAN", runBadge(clean) === "RUN CLEAN", runBadge(clean));
  check("RUN CLEAN is not a warning", !badgeIsWarning("RUN CLEAN"));

  // The same run after opening a write panel.
  const victim = DEV_PANELS.find((p) => p.tier === "self" && !p.readOnly)?.id as string;
  clean.open(victim);
  check("opening a write panel flips it to RUN TAINTED", runBadge(clean) === "RUN TAINTED");
  check("RUN TAINTED is the one warning", badgeIsWarning("RUN TAINTED"));

  // An internal build is a different fact and must not borrow the tainted wording — this is the bug the
  // first version of the screen had, where every internal build read RUN TAINTED forever.
  const devCtx = createDevContext("internal");
  devCtx.flags.devMenuEnabled = true;
  const dev = new DevGate(devCtx);
  check("an idle internal build reads DEV LADDER, not RUN TAINTED", runBadge(dev) === "DEV LADDER", runBadge(dev));
  devCtx.runActive = true;
  dev.attachRun(sink());
  check("a fresh internal run still reads DEV LADDER", runBadge(dev) === "DEV LADDER", runBadge(dev));
  check("DEV LADDER is not a warning", !badgeIsWarning("DEV LADDER"));

  // ...but a genuinely tainted internal run must still say so, or the badge is useless where we use it most.
  dev.open(victim);
  check("a tainted internal run reads RUN TAINTED", runBadge(dev) === "RUN TAINTED", runBadge(dev));

  // A read-only panel must not move the badge on a public build.
  const roCtx = createDevContext("public");
  roCtx.flags.devMenuEnabled = true;
  roCtx.unlocked = true;
  const ro = new DevGate(roCtx);
  roCtx.runActive = true;
  ro.attachRun(sink());
  const inspector = DEV_PANELS.find((p) => p.readOnly && p.tier === "self")?.id;
  if (inspector !== undefined) {
    ro.open(inspector);
    check("an inspector leaves a public run clean", runBadge(ro) === "RUN CLEAN", runBadge(ro));
  } else {
    check("there is a self-tier inspector to try", false, "none found");
  }

  // Ending a run must clear the badge rather than leaving the last run's verdict on screen.
  dev.endRun();
  check("ending a run clears the taint readout", dev.runTaint() === 0);
  check("ending a run stops claiming a run is in progress", !dev.runInProgress);

  // All four states must actually be producible, or some branch is dead code.
  const seen = new Set([runBadge(idle), runBadge(clean), runBadge(ro), "DEV LADDER"]);
  check("all four badge states are reachable", seen.size === 4, [...seen].join(", "));
}

/* ---- 10. the route map cannot rot ---------------------------------------------------------------- */

section("the route map");
{
  const ids = new Set(DEV_PANELS.map((p) => p.id));
  const keys = Object.keys(PANEL_ROUTES);

  check("there are routes to check", keys.length > 0, `${keys.length} routes`);
  check(
    "every route points at a panel that exists",
    keys.every((k) => ids.has(k)),
    keys.filter((k) => !ids.has(k)).join(", "),
  );
  check(
    "every route is an absolute path under /dev/",
    keys.every((k) => (PANEL_ROUTES[k] ?? "").startsWith("/dev/")),
  );
  check(
    "routeForPanel agrees with the map",
    keys.every((k) => routeForPanel(k) === PANEL_ROUTES[k]),
  );
  check("an unbuilt panel has no route", routeForPanel("account.wallet") === undefined);
  check("an unknown id has no route", routeForPanel("no.such.panel") === undefined);

  // The pages that exist must be reachable from some tab on an internal build, or building the shell
  // achieved nothing.
  const gate = internalGate();
  const reachableRouted = keys.filter((k) => gate.reachable(k)).length;
  check(
    "every built page is reachable on an internal build",
    reachableRouted === keys.length,
    `${reachableRouted}/${keys.length}`,
  );

  // And the honest half: most panels are planned, not built. Asserted so the "not built yet" path is
  // known to be exercised rather than assumed dead.
  const unbuilt = DEV_PANELS.filter((p) => routeForPanel(p.id) === undefined).length;
  check(
    "most panels are planned rather than built, and the menu knows",
    unbuilt > 0 && unbuilt < DEV_PANELS.length,
    `${unbuilt} of ${DEV_PANELS.length} have no page yet`,
  );
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — dev menu shell (${failures} failure${failures === 1 ? "" : "s"})`,
);

if (failures > 0) {
  // `game/` may not assume a Node-shaped host, so `process` is reached for defensively — but a defensive
  // reach that finds nothing must not turn a failing suite into a passing one. If there is no exit to
  // call, throw instead: a thrown error still fails the run, and silence would not.
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`dev menu shell: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
