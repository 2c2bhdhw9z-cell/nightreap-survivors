/**
 * Content lint for the dev menu. This is the thing that actually holds §5b together.
 *
 * The tier split is only worth anything if it is impossible to get wrong quietly. Reviews miss a
 * one-line change; a linter does not. CI runs `dev.test.ts`, which runs everything here, and the build
 * fails on any violation.
 *
 * The rules, and why each one exists:
 *
 *   1. Every panel declares a tier, and an unrecognised tier normalises to SYSTEM. A typo locks a tool
 *      down instead of shipping it.
 *   2. A SELF panel that is not read-only declares non-zero taint. A sim-mutating toggle that does not
 *      record itself is precisely the hole the addendum closes.
 *   3. A read-only panel declares zero taint. Otherwise "read-only" starts meaning nothing and people
 *      stop trusting the flag.
 *   4. No SYSTEM panel is reachable on the public channel, on any combination of flags — checked by
 *      actually constructing gates and asking, not by reading the code.
 *   5. `reachable()` and `open()` agree for every panel on every channel. A greyed-out menu entry that
 *      would in fact open, or the reverse, is how a tier check gets bypassed by accident.
 *   6. Panel ids are unique, and the SYSTEM set covers every capability §5b lists as SYSTEM. Adding a
 *      new account/ladder/coop/ops capability without tiering it fails here.
 *   7. Source rule: nothing under `game/dev/` imports a server-write module, and no file outside
 *      `game/dev/` reaches for a panel component directly, bypassing the gate.
 *
 * Rule 7 needs file contents, which the engine cannot read (no Node types, by design), so it takes the
 * files as data and the test harness does the reading.
 */

import { createDevContext, type Channel, type DevFlags } from "./channel";
import { DENY, DevGate } from "./devgate";
import { DEV_PANELS, type DevPanelSpec } from "./registry";

export interface Violation {
  readonly rule: string;
  readonly subject: string;
  readonly detail: string;
}

/** Capabilities §5b names as SYSTEM. Each must be matched by at least one SYSTEM panel id prefix. */
const REQUIRED_SYSTEM_PREFIXES = ["account.", "ladder.", "coop.", "ops."] as const;

/** Every flag combination worth testing, so rule 4 is exhaustive rather than representative. */
function flagMatrix(): DevFlags[] {
  const out: DevFlags[] = [];
  for (const devMenuEnabled of [false, true]) {
    for (const chaosSandboxActive of [false, true]) {
      for (const accountBlocked of [false, true]) {
        out.push({ devMenuEnabled, chaosSandboxActive, accountBlocked });
      }
    }
  }
  return out;
}

export function lintRegistry(): Violation[] {
  const v: Violation[] = [];
  const seen = new Set<string>();

  for (const panel of DEV_PANELS) {
    if (seen.has(panel.id)) {
      v.push({ rule: "unique-id", subject: panel.id, detail: "duplicate panel id" });
    }
    seen.add(panel.id);

    if (panel.tier !== "self" && panel.tier !== "system") {
      v.push({ rule: "explicit-tier", subject: panel.id, detail: `tier is ${String(panel.tier)}` });
    }
    if (panel.tier === "self" && !panel.readOnly && panel.taint === 0) {
      v.push({
        rule: "self-must-taint",
        subject: panel.id,
        detail: "SELF panel mutates the sim but declares no taint bits",
      });
    }
    if (panel.readOnly && panel.taint !== 0) {
      v.push({
        rule: "readonly-is-clean",
        subject: panel.id,
        detail: `read-only but declares taint ${panel.taint}`,
      });
    }
    if (panel.label.trim() === "") {
      v.push({ rule: "has-label", subject: panel.id, detail: "empty label" });
    }
  }

  for (const prefix of REQUIRED_SYSTEM_PREFIXES) {
    const covered = DEV_PANELS.some((p) => p.id.startsWith(prefix) && p.tier === "system");
    const mistiered = DEV_PANELS.filter((p) => p.id.startsWith(prefix) && p.tier !== "system");
    if (!covered) {
      v.push({ rule: "system-coverage", subject: prefix, detail: "no SYSTEM panel in this group" });
    }
    for (const p of mistiered) {
      v.push({ rule: "system-coverage", subject: p.id, detail: `${prefix}* must be SYSTEM tier` });
    }
  }

  return v;
}

/** Rules 4 and 5: ask real gates, on every channel, under every flag combination. */
export function lintReachability(): Violation[] {
  const v: Violation[] = [];
  const channels: Channel[] = ["public", "internal"];

  for (const channel of channels) {
    for (const flags of flagMatrix()) {
      for (const panel of DEV_PANELS) {
        const ctx = createDevContext(channel);
        ctx.flags = flags;
        ctx.unlocked = true; // most permissive case: assume the player found the unlock
        const gate = new DevGate(ctx);

        const reachable = gate.reachable(panel.id);
        const grant = gate.open(panel.id);

        if (reachable !== grant.granted) {
          v.push({
            rule: "reachable-agrees-with-open",
            subject: panel.id,
            detail: `${channel} flags=${JSON.stringify(flags)} reachable=${reachable} granted=${grant.granted}`,
          });
        }
        if (channel === "public" && panel.tier === "system" && grant.granted) {
          v.push({
            rule: "no-system-in-public",
            subject: panel.id,
            detail: `granted on public build with flags=${JSON.stringify(flags)}`,
          });
        }
        if (
          channel === "public" &&
          panel.tier === "system" &&
          !grant.granted &&
          grant.reason !== DENY.TIER_FORBIDDEN &&
          grant.reason !== DENY.MENU_UNAVAILABLE
        ) {
          v.push({
            rule: "no-system-in-public",
            subject: panel.id,
            detail: `denied for the wrong reason (${grant.reason})`,
          });
        }
      }
    }
  }

  return v;
}

/* ---- rule 7: source-level rules ----------------------------------------------------------------- */

export interface SourceFile {
  /** Path relative to the mobile package, forward slashes. */
  readonly path: string;
  readonly text: string;
}

/**
 * Modules that write to a server. Dev-menu code may never import one, so that "SELF is sim-only" is a
 * property of the import graph and not of somebody's memory. The paths are declared before the modules
 * exist on purpose — the rule should be live the moment the first one lands.
 */
export const SERVER_WRITE_MODULES = [
  "net/ladder-client",
  "net/account-client",
  "net/cloud-save",
  "net/telemetry-upload",
  "net/remote-config-write",
  "server/",
] as const;

const IMPORT_RE = /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(text: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m = IMPORT_RE.exec(text);
  while (m !== null) {
    const spec = m[1] ?? m[2];
    if (spec) out.push(spec);
    m = IMPORT_RE.exec(text);
  }
  return out;
}

export function lintSources(files: readonly SourceFile[]): Violation[] {
  const v: Violation[] = [];

  for (const file of files) {
    const inDev = file.path.includes("game/dev/");
    const specs = importsOf(file.text);

    if (inDev) {
      for (const spec of specs) {
        for (const banned of SERVER_WRITE_MODULES) {
          if (spec.includes(banned)) {
            v.push({
              rule: "dev-must-not-write-server",
              subject: file.path,
              detail: `imports ${spec}`,
            });
          }
        }
      }
      // The engine rule, restated here so a dev panel cannot be the file that smuggles RN into game/.
      // `app/dev/*.tsx` host screens live outside game/ and are exempt by construction.
      for (const spec of specs) {
        if (spec === "react-native" || spec.startsWith("expo-") || spec === "react") {
          v.push({
            rule: "engine-has-no-rn",
            subject: file.path,
            detail: `imports ${spec}`,
          });
        }
      }
    }

    // Rule 7b: only the gate may decide access. Any file that imports the registry's `findDevPanel`
    // without also importing the gate is very likely about to open a panel on its own authority.
    const usesFinder = /\bfindDevPanel\b/.test(file.text);
    // The registry declares it, the gate consumes it, the linter checks it. Everyone else goes through
    // `DevGate.open`.
    const isGateOrLint =
      file.path.includes("game/dev/devgate") ||
      file.path.includes("game/dev/lint") ||
      file.path.includes("game/dev/registry");
    const isTest = file.path.endsWith(".test.ts");
    if (usesFinder && !isGateOrLint && !isTest) {
      v.push({
        rule: "gate-is-the-only-door",
        subject: file.path,
        detail: "uses findDevPanel directly; go through DevGate.open",
      });
    }
  }

  return v;
}

export function formatViolations(violations: readonly Violation[]): string {
  if (violations.length === 0) return "no violations";
  return violations.map((x) => `${x.rule}: ${x.subject} — ${x.detail}`).join("\n");
}

/** Convenience for CI: every data-level rule in one call. Source rules need file contents. */
export function lintAll(): Violation[] {
  return [...lintRegistry(), ...lintReachability()];
}

/** Exposed so the menu can show a count without the linter's internals leaking into UI code. */
export function panelCounts(): { self: number; system: number; readOnly: number } {
  let self = 0;
  let system = 0;
  let readOnly = 0;
  for (const p of DEV_PANELS as readonly DevPanelSpec[]) {
    if (p.tier === "self") self++;
    else system++;
    if (p.readOnly) readOnly++;
  }
  return { self, system, readOnly };
}
