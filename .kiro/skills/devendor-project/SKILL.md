---
name: devendor-project
description: Find and remove vendor, platform, or scaffolding lock-in from a codebase — telemetry beacons, injected badges, auth wrappers, hardcoded vendor hosts, and especially lint or convention rules that fail the build when vendor code is removed. Use when a user wants to own their code, escape a platform, remove a template's coupling, stop an app phoning home, or says they feel locked in, locked out, or trapped by a service.
license: MIT
metadata:
  version: "1.0.0"
  origin: Derived from a real de-vendoring of a scaffolded monorepo; see references/case-study.md
---

# De-vendor a project

Remove a vendor's grip on a codebase without breaking it, and leave the project genuinely portable.

## The central insight

**Lock-in is rarely just dependencies. The dependencies are the easy part.**

Real lock-in has an *enforcement layer* — machinery that makes removal fail. In the case this skill
was built from, three lint rules existed whose only purpose was to fail the build if vendor code was
deleted. A developer who tried to remove the tracking beacon would see their build break and conclude
it was load-bearing. It was not. It was guarded.

So the order of work is: **find the enforcement first, then the code.** If you remove code before
neutralising what enforces it, you will fight your own tooling and conclude the coupling is
structural when it is merely defended.

## Phase 0 — Before you touch anything

1. **Work on a branch. Never `main`.** State this to the user explicitly and confirm `main` is untouched at the end.
2. **Capture a baseline.** Run the project's full verification set and record the results:
   ```
   lint / typecheck / test / build
   ```
   Write down what *already* fails. You need this, or you will be blamed for pre-existing failures —
   and you will not be able to tell your own regressions from the project's existing state.
3. **Identify what is currently running.** If a deployed preview, published build, or cached client
   exists, establish whether your changes can reach it. Usually they cannot — a published artifact is
   a snapshot. Say so plainly, because a user mid-project is often frightened of losing the one
   working thing they have.

## Phase 1 — Discovery

Cast a wide net. Vendor names appear in places grep-for-source misses.

```bash
# 1. The vendor's own name, everywhere, including config and docs
grep -rniE 'vendorname|vendor-cli|@vendor/' \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' \
  --include='*.mjs' --include='*.cjs' --include='*.md' --include='*.yml' \
  --include='*.yaml' --include='*.toml' --include='*.template' . \
  | grep -v node_modules | grep -v '\.lock'

# 2. Dependencies (all manifests in a monorepo, not just the root)
grep -rn '"@vendor\|vendor-sdk\|vendor-runtime' */package.json package.json

# 3. Telemetry and phone-home, by behaviour rather than by name
grep -rniE 'analytics|telemetry|beacon|collector|track\(|sentry|posthog|amplitude|mixpanel|segment' \
  --include='*.ts' --include='*.tsx' . | grep -v node_modules

# 4. Hardcoded vendor hosts and endpoints
grep -rnE 'https?://[a-z0-9.-]*(vendor|preview|sandbox|gateway)[a-z0-9.-]*' \
  --include='*.ts' --include='*.tsx' --include='*.json' . | grep -v node_modules

# 5. Env cruft: declared, never read
#    For each var in the template, check whether any source file reads it.
grep -oE '^[A-Z_]+' .env.template 2>/dev/null | while read -r v; do
  n=$(grep -rl "$v" --include='*.ts' --include='*.tsx' . 2>/dev/null | grep -vc node_modules)
  [ "$n" -eq 0 ] && echo "UNUSED: $v"
done
```

**Do not stop at the first vendor name you find.** In the reference case the user asked about AI
providers; a search for those returned nothing, and the real coupling was under a *platform* name
nobody had mentioned. Ask: "what scaffolded this project?" and search for that too. Check
`README`, `package.json` `name` fields, lockfile registry URLs, `.gitignore` comments, and any
directory whose name you do not recognise.

### Classify every hit

Do not treat all coupling the same. Sort into:

| Class | Example | Removal risk |
|---|---|---|
| **Telemetry** | Provider wrapping the app root, beaconing on launch | Low. Usually a wrapper you can unwrap. |
| **Injected UI** | "Made with X" badge, feedback widget | Low. Delete the component. |
| **Dead config** | Unused env vars, empty placeholders | None. |
| **Dead hosts** | Hardcoded preview URL that 502s | Low, but check what reads it. |
| **Identity** | Vendor name in bundle IDs, URL schemes, package names | Medium. Affects store listings and installed clients. |
| **Wrappers** | Vendor SDK wrapping a platform capability (deep links, auth, storage) | **High.** Needs a native replacement written. |
| **Enforcement** | Lint/convention rules requiring vendor imports; hash-protected files | Medium, and must be handled *first*. |

## Phase 2 — Neutralise the enforcement layer

Look for these specifically. They are the reason people believe they cannot leave.

**A. Convention or lint rules requiring vendor imports.** Search the project's own lint/convention
config for the vendor name:

```bash
grep -rn -i 'vendor' *.json .*rc* eslint* 2>/dev/null | grep -v node_modules
```

Signals: a rule named like `keeps-*-runtime`, `*-must-import-*`, `template-managed-files-exist`, or
any rule whose `must.importFrom` or `must.haveFiles` names vendor paths. These are removable. Note
how many rules exist before and after so you can report the change honestly.

**B. Hash-protected "template-managed" files.** A manifest of checksums plus a lint rule that fails
when a file's hash drifts. Convention is often a `__` filename prefix.

```bash
find . -name '*protected*' -o -name '*manifest*.json' | grep -v node_modules
```

If you must edit one, **recompute its hash and update the manifest** — and tell the user you did,
framing it as a deliberate act of ownership. Do not silently defeat a safety mechanism.

```bash
node -e 'const fs=require("fs"),c=require("crypto");
const f="path/to/__file.ts";
console.log(c.createHash("sha256").update(fs.readFileSync(f)).digest("hex"));'
```

**C. Comments that assert necessity.** Grep for imperative comments:

```bash
grep -rn -i 'do not remove\|required for\|must stay\|do not edit\|template-managed' \
  --include='*.ts' --include='*.tsx' . | grep -v node_modules
```

Treat these as claims to verify, not facts. In the reference case a comment read *"required for
analytics tracking"* above a provider that was not required for anything the product did.

## Phase 3 — Removal, in dependency order

Work inside-out: usage, then dependency, then enforcement, then manifest.

1. **Remove the usage.** Unwrap providers, delete injected components, drop the import.
2. **Write native replacements for wrappers *before* deleting them.** See "Replacement patterns" below.
3. **Remove the dependency** from every manifest that declares it.
4. **Relax the enforcement rules** you catalogued in Phase 2.
5. **Update protection manifests** for any hash-guarded file you touched.
6. **Delete dead config** — unused env vars, dead hosts.
7. **Re-sync the lockfile** (`bun install` / `npm install` / etc.).
8. **Verify after each step, not at the end.** If something breaks you want to know which step did it.

### One rule that will save you

**Dead code is not automatically removable code.** Verify what it *would* do before deleting it.

In the reference project, a fully written, documented, tested fixed-point-math module was unused by
the simulation — textbook dead code. It was also the **correct implementation of a property the
project claimed to have and did not.** Deleting it would have destroyed the fix for the codebase's
most serious bug. The right action was to *wire it in*.

Ask of every dead thing: is this abandoned, or is this the solution nobody connected?

## Replacement patterns for wrappers

Vendor wrappers usually wrap something the platform already does. Common cases:

**Deep links / custom URL schemes.** Vendors wrap this to route auth through their service. Native
form (Electron shown; the shape is the same elsewhere):

- Register the scheme yourself (`app.setAsDefaultProtocolClient("yourscheme")`).
- Handle the platform's delivery mechanisms — macOS sends an event (`open-url`); Windows and Linux
  pass it in `argv`, both for a cold start and for a second instance.
- Enforce single-instance and forward the URL to the window.
- Rename the scheme off the vendor's branding while you are there.

**Open-in-browser.** Wrappers hide a security check. When you reimplement it, **keep the check**:
parse the URL and reject anything that is not `http:`/`https:`. Without it, a renderer can pass
`file://` and have the OS open a local executable. This is the whole security boundary.

**Analytics.** Do not replace it. Delete it, and if the product has a user-facing telemetry
preference, note whether the vendor provider honoured it. In the reference case the save format had
`telemetryOptIn` defaulting to **false** while the provider reported on every launch regardless —
making the user's setting cosmetic and any privacy declaration built on it false.

**Managed auth / storage / config.** These are the genuinely hard ones. Establish what the product
actually needs before rebuilding. Often the answer is "nothing" — the wrapper served the platform's
needs, not the product's.

## Phase 4 — Verification gates

Everything must be at least as green as your Phase 0 baseline.

```
lint          — must be clean, or exactly as dirty as the baseline
typecheck     — every package
tests         — full suite; compare failures to the baseline list
build         — the real production build, per target
runtime smoke — start it; confirm the app boots and a core action works
```

**Then verify the removal actually happened:**

```bash
# Only comments should remain
grep -rniE 'vendorname|@vendor/' --include='*.ts' --include='*.tsx' --include='*.json' . \
  | grep -v node_modules | grep -v '\.lock'
```

Explanatory comments that say "this used to come from X, here is why it does not now" are correct to
leave. They stop someone re-adding it.

## Phase 5 — Report honestly

State, in this order:

1. **What was found**, by class, with file:line evidence.
2. **What each thing was actually doing** — especially anything that phoned home, and how often.
3. **What changed**, including how many enforcement rules were removed.
4. **Verification results** versus the baseline, naming any pre-existing failure so it is not
   mistaken for yours.
5. **What was deliberately left**, and why.
6. **Anything with product consequences** — changed bundle IDs affect store listings; changed URL
   schemes break existing deep links; removed analytics changes what a privacy policy should say.

If you also **fixed something that was already broken**, say so separately. Do not let it hide
inside the de-vendoring work.

## What not to do

- **Do not remove a vendor's identity strings from a shipped app without flagging it.** Bundle IDs
  and package names are identity to app stores. Changing them pre-launch is free; post-launch it is a
  new app.
- **Do not touch unrelated code.** A de-vendoring diff should be reviewable. Resist tidying.
- **Do not delete a protection manifest** to make a lint rule pass. Update the specific entry.
- **Do not assume the vendor's hosting is coming back.** If a preview host is dead, the project needs
  a path that does not depend on it. Removing the reference is not the same as restoring the
  capability — say which you did.
- **Do not claim a property you have not measured.** If you remove a beacon, do not say "the app no
  longer makes network calls" unless you checked every call site.

## Deeper material

`references/case-study.md` — a complete worked example: what was found, what enforced it, the exact
replacements, and the two mistakes made along the way. Read it when a project's coupling looks
structural and you want to see how one that looked structural turned out not to be.
