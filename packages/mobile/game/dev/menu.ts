/**
 * The dev menu shell: what the menu shows, which tabs exist, what is greyed out and why.
 *
 * WHY THIS IS A MODULE AND NOT JUST A SCREEN
 * The shell makes access-shaped decisions — which tabs a build may see, which rows it may enumerate,
 * which entries are greyed — and an access-shaped decision inside a React component is a decision that
 * cannot be tested and will drift. So the screen owns no logic: it calls `buildMenuView` and paints the
 * answer. `lint.ts` already proves `reachable()` agrees with `open()`; this file's job is to make sure
 * the *menu* never invents a second opinion about either.
 *
 * THE ONE RULE THAT MATTERS MOST
 * A row's greyed state is `gate.reachable(id)` and nothing else. It is never recomputed from the tier,
 * the channel or a flag. Any second calculation is a chance to be more generous than the gate, and the
 * whole point of §5b is that there is exactly one decision-maker.
 *
 * WHAT A LOCKED GROUP HIDES
 * A locked tab is visible — the tab strip is fixed so the menu does not change shape between builds,
 * and "OPS is locked" tells a stranger nothing. Its *contents* are never enumerated: no row, no search
 * hit, no count of what is inside. Panel labels are the interesting part of the secret ("flag / ban /
 * restore an account" describes our moderation surface), so a public build can learn that ops tooling
 * exists but never what it contains.
 *
 * COUNTS ARE COMPUTED, ALWAYS
 * The approved mock says "SEARCH ALL 41 PANELS" and "8 OF 41". Those numbers were true of the picture
 * and are already false of the registry, which is exactly why no number here is a literal. Every count
 * is derived from `DEV_PANELS` at call time, and a test asserts the derivation rather than the value.
 */

import { describeDeny, type DevGate } from "./devgate";
import { DEV_PANELS, type DevGroup, type DevPanelSpec } from "./registry";

/**
 * Tab order. Fixed and complete: the strip looks the same on every build so muscle memory survives
 * moving between a public phone and an internal one. Adding a group here without adding panels gives an
 * empty tab, which `lintMenu` treats as a fault.
 */
export const MENU_GROUPS: readonly DevGroup[] = [
  "run",
  "player",
  "spawns",
  "content",
  "render",
  "perf",
  "coop",
  "account",
  "ladder",
  "ops",
] as const;

const GROUP_LABEL: Readonly<Record<DevGroup, string>> = {
  run: "RUN",
  player: "PLAYER",
  spawns: "SPAWNS",
  content: "CONTENT",
  render: "RENDER",
  perf: "PERF",
  coop: "COOP",
  account: "ACCOUNT",
  ladder: "LADDER",
  ops: "OPS",
};

export function groupLabel(group: DevGroup): string {
  return GROUP_LABEL[group];
}

/** Cap on pinned entries. Small on purpose: a favourites row that scrolls is just a second menu. */
export const MAX_FAVOURITES = 4;

/**
 * Panel id → the route that draws it.
 *
 * WHY THIS LIVES HERE AND NOT IN THE SCREEN
 * So `lintMenu` can prove every key is a real panel id. A map like this rots in one specific way: a
 * panel gets renamed or retired, the entry stays, and the menu grows a button that goes nowhere. In our
 * own tools that is an hour spent debugging the wrong thing. Route *strings* are the app's business but
 * they are only strings, so keeping them next to the ids costs nothing and buys a CI check.
 *
 * Only pages that actually exist are listed. Everything else is a panel the registry has planned and
 * nobody has written yet, and the menu says exactly that rather than pretending.
 */
export const PANEL_ROUTES: Readonly<Record<string, string>> = {
  "perf.counters": "/dev/bench",
  "perf.leak": "/dev/leak",
  "ops.config-readout": "/dev/config",
  "ops.remote-config": "/dev/config",
  "coop.link": "/dev/coop",
  "coop.hashes": "/dev/coop",
  "coop.latency": "/dev/coop",
  "coop.loss": "/dev/coop",
  "coop.jitter": "/dev/coop",
  "coop.desync": "/dev/coop",
  "coop.drop": "/dev/coop",
  "coop.migrate": "/dev/coop",
  "coop.stall": "/dev/coop",
  "coop.diverge": "/dev/coop",
};

/** The route that draws a panel, or undefined when the page does not exist yet. */
export function routeForPanel(id: string): string | undefined {
  return PANEL_ROUTES[id];
}

/** One row in the menu. Everything the screen needs to paint it, and nothing it has to work out. */
export interface MenuRow {
  readonly id: string;
  readonly label: string;
  readonly group: DevGroup;
  /** Straight from the gate. Never recomputed. */
  readonly reachable: boolean;
  /** Plain-language reason, shown on a greyed row so a missing tool is never a mystery. */
  readonly denyText: string;
  /** True when opening this row costs the run its ladder eligibility. */
  readonly taints: boolean;
  readonly readOnly: boolean;
}

/** One tab. */
export interface MenuTab {
  readonly group: DevGroup;
  readonly label: string;
  /**
   * Locked means "this build may not enumerate what is in here". A group is locked when the gate
   * refuses every panel in it — derived, so a group that becomes half-open stops being locked without
   * anyone editing a list.
   */
  readonly locked: boolean;
  /**
   * How many rows this tab would list. Zero for a locked tab, because a count is a leak: "OPS: 6"
   * tells a stranger how much moderation tooling to go looking for.
   */
  readonly rowCount: number;
}

export interface MenuTotals {
  /** Panels this build may enumerate. The number the search box should quote. */
  readonly visible: number;
  /** Of the visible ones, how many cost the run nothing. The footer's "read-only panels do not taint". */
  readonly visibleReadOnly: number;
  /** Panels that exist at all. Only ever shown on an internal build. */
  readonly total: number;
}

export interface MenuView {
  readonly tabs: readonly MenuTab[];
  /** The selected tab, corrected if the caller asked for a locked or unknown one. */
  readonly group: DevGroup;
  readonly rows: readonly MenuRow[];
  readonly favourites: readonly MenuRow[];
  readonly totals: MenuTotals;
  /**
   * True when the visible rows include at least one that would taint. Drives the crimson warning bar,
   * so a tab of pure inspectors does not cry wolf.
   */
  readonly warnTaint: boolean;
  /** Set when the menu is open but every single tab is locked — a public build with no unlock entered. */
  readonly emptyReason: string;
}

/** What the status badge says about the current run. */
export type RunBadge = "NO RUN" | "RUN CLEAN" | "RUN TAINTED" | "DEV LADDER";

/**
 * The run's status, told honestly.
 *
 * Four states, because collapsing them is how a warning stops working. "RUN TAINTED" must mean a real
 * run really lost its ladder eligibility. An internal build whose runs go to the dev ladder is a
 * different fact and gets different words, and no run at all is not a warning.
 */
export function runBadge(gate: DevGate): RunBadge {
  if (!gate.runInProgress) return gate.publicLadderOpen() ? "NO RUN" : "DEV LADDER";
  if (gate.runTaint() !== 0) return "RUN TAINTED";
  return gate.publicLadderOpen() ? "RUN CLEAN" : "DEV LADDER";
}

/** True when the badge is bad news, so the screen does not decide what counts as bad news. */
export function badgeIsWarning(badge: RunBadge): boolean {
  return badge === "RUN TAINTED";
}

function rowFor(gate: DevGate, panel: DevPanelSpec): MenuRow {
  const reachable = gate.reachable(panel.id);
  return {
    id: panel.id,
    label: panel.label,
    group: panel.group,
    reachable,
    denyText: reachable ? "" : describeDeny(gate.probe(panel.id)),
    // Asked, not calculated. The gate zeroes a read-only panel's bits and adds the channel and chaos
    // bits, so working this out from `panel.taint` here would be a second opinion that drifts. During a
    // chaos sandbox even an inspector taints, and this row tells the truth about that instead of
    // repeating a rule from the spec.
    taints: gate.wouldTaint(panel.id) !== 0,
    readOnly: panel.readOnly,
  };
}

function panelsOf(group: DevGroup): DevPanelSpec[] {
  return DEV_PANELS.filter((p) => p.group === group);
}

/** True when the build may list what is inside a group at all. */
function groupUnlocked(gate: DevGate, group: DevGroup): boolean {
  return panelsOf(group).some((p) => gate.reachable(p.id));
}

export function menuTabs(gate: DevGate): MenuTab[] {
  return MENU_GROUPS.map((group) => {
    const unlocked = groupUnlocked(gate, group);
    return {
      group,
      label: GROUP_LABEL[group],
      locked: !unlocked,
      rowCount: unlocked ? panelsOf(group).length : 0,
    };
  });
}

export function menuTotals(gate: DevGate): MenuTotals {
  let visible = 0;
  let visibleReadOnly = 0;
  for (const group of MENU_GROUPS) {
    if (!groupUnlocked(gate, group)) continue;
    for (const panel of panelsOf(group)) {
      visible++;
      if (panel.readOnly) visibleReadOnly++;
    }
  }
  return { visible, visibleReadOnly, total: DEV_PANELS.length };
}

/**
 * Rows for one group. Empty for a locked group — the caller cannot opt out of that, which is why the
 * check lives here and not in the screen.
 *
 * An unreachable row inside an *unlocked* group is still listed, greyed, with its reason. That case is
 * a tool switched off remotely or gated behind its own flag, and hiding it turns "we killed that panel
 * an hour ago" into a bug report about a missing feature.
 */
export function menuRows(gate: DevGate, group: DevGroup): MenuRow[] {
  if (!groupUnlocked(gate, group)) return [];
  return panelsOf(group).map((p) => rowFor(gate, p));
}

/**
 * Search across everything this build may enumerate.
 *
 * Matches id as well as label, because the id is what appears in the audit log and in a bug report, so
 * pasting one back in has to find the panel. Locked groups are skipped entirely — a search box is the
 * easiest possible enumeration tool and would undo the whole point of locking a tab.
 */
export function searchMenu(gate: DevGate, query: string): MenuRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const out: MenuRow[] = [];
  for (const group of MENU_GROUPS) {
    if (!groupUnlocked(gate, group)) continue;
    for (const panel of panelsOf(group)) {
      const haystack = `${panel.label} ${panel.id}`.toLowerCase();
      if (haystack.includes(needle)) out.push(rowFor(gate, panel));
    }
  }
  // Reachable first, then alphabetical, so a greyed hit never sits above a usable one.
  out.sort((a, b) => {
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

/**
 * Resolve pinned ids into rows.
 *
 * Three things get dropped silently rather than shown broken: an id that no longer exists (panel ids
 * retire and are never reused, so a stale favourite is expected, not an error), an id whose group this
 * build may not enumerate (a favourite must not be a back door into a locked tab), and anything past
 * the cap. Silently, because a favourites row is not the place to explain build channels.
 */
export function resolveFavourites(gate: DevGate, ids: readonly string[]): MenuRow[] {
  const out: MenuRow[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (out.length >= MAX_FAVOURITES) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const panel = DEV_PANELS.find((p) => p.id === id);
    if (!panel) continue;
    if (!groupUnlocked(gate, panel.group)) continue;
    out.push(rowFor(gate, panel));
  }
  return out;
}

/** Add or remove a pinned id, newest first, capped. Pure: returns a new list. */
export function toggleFavourite(ids: readonly string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  return [id, ...ids].slice(0, MAX_FAVOURITES);
}

/**
 * Pick the tab to show. Falls back to the first unlocked tab when the caller asks for one it may not
 * see, so a saved "last tab was OPS" on an internal build cannot strand a public build on an empty
 * screen.
 */
export function resolveGroup(gate: DevGate, wanted: DevGroup | undefined): DevGroup {
  if (wanted && groupUnlocked(gate, wanted)) return wanted;
  for (const group of MENU_GROUPS) {
    if (groupUnlocked(gate, group)) return group;
  }
  // Nothing is open. Return the first tab so the screen still has a valid selection to paint.
  return MENU_GROUPS[0] as DevGroup;
}

export function buildMenuView(
  gate: DevGate,
  wanted: DevGroup | undefined,
  favouriteIds: readonly string[],
  query = "",
): MenuView {
  const tabs = menuTabs(gate);
  const group = resolveGroup(gate, wanted);
  const searching = query.trim() !== "";
  const rows = searching ? searchMenu(gate, query) : menuRows(gate, group);
  const anyUnlocked = tabs.some((t) => !t.locked);
  return {
    tabs,
    group,
    rows,
    favourites: resolveFavourites(gate, favouriteIds),
    totals: menuTotals(gate),
    warnTaint: rows.some((r) => r.taints && r.reachable),
    emptyReason: anyUnlocked ? "" : "dev menu unavailable",
  };
}

/* ---- self-check ----------------------------------------------------------------------------------- */

/**
 * Shape rules a screen cannot be trusted to keep. Runs in CI next to the other dev lints.
 *
 * Kept here rather than in `lint.ts` because these are menu rules, and the linter should not have to
 * know what a tab is.
 */
export function lintMenu(): string[] {
  const problems: string[] = [];

  const groups = new Set<DevGroup>();
  for (const group of MENU_GROUPS) {
    if (groups.has(group)) problems.push(`menu-tabs: ${group} listed twice`);
    groups.add(group);
    if (!(group in GROUP_LABEL)) problems.push(`menu-tabs: ${group} has no label`);
    if (panelsOf(group).length === 0) problems.push(`menu-tabs: ${group} has no panels`);
  }

  // Every panel must be reachable through some tab, or it is a tool nobody can find.
  for (const panel of DEV_PANELS) {
    if (!groups.has(panel.group)) {
      problems.push(`menu-orphan: ${panel.id} is in group "${panel.group}" which has no tab`);
    }
  }

  // A route pointing at an id that no longer exists is a button that goes nowhere.
  const ids = new Set(DEV_PANELS.map((p) => p.id));
  for (const id of Object.keys(PANEL_ROUTES)) {
    if (!ids.has(id)) problems.push(`menu-route: "${id}" has a route but is not a panel`);
  }

  return problems;
}
