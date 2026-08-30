---
name: vendor-lockin-guard
description: Detect and prevent vendor lock-in before it is embedded. Use when evaluating a dependency, SDK, platform, template, or scaffolded starter; when reviewing code that adds a third-party service; when a user asks whether something will trap them or how hard it would be to leave; or when setting up guardrails and CI checks so coupling cannot be added silently. Also use before shipping, to audit what a project sends and to whom.
license: MIT
metadata:
  version: "1.0.0"
  companion: devendor-project
---

# Guard against vendor lock-in

Prevention. The companion skill `devendor-project` removes coupling that already exists; this one
stops it being embedded and makes it impossible to add silently.

## The principle

**Lock-in is not created by using a service. It is created by the cost of stopping.**

Every dependency has an exit cost. A library you can delete in an afternoon is not lock-in even if
you use it everywhere. A three-line SDK that owns your user identities is lock-in even though it is
three lines. Judge the exit, not the entry.

The most effective single question:

> *If this vendor shut down tomorrow with no notice, what would it take to keep shipping?*

Write the answer down before adopting. If nobody can answer it, that is the finding.

## Part 1 — Evaluating something before adopting it

Score each. Any **red** means the decision needs a written justification, not a shrug.

### 1. Data ownership
- 🟢 Data in your own store, vendor reads it
- 🟡 Vendor stores it, documented full export
- 🔴 Vendor stores it, export is partial, throttled, or absent

Ask: **can I get everything out, in a format I can use, without asking permission?** "There's an API"
is not the same as "there's an export."

### 2. Identity and auth
- 🟢 You own the user records; vendor is one provider among several
- 🟡 Vendor issues tokens you can verify independently
- 🔴 Vendor owns identity; leaving means every user re-registers

This is the single most expensive kind to unwind, because the cost lands on your users, not on you.

### 3. Interface shape
- 🟢 Vendor implements a standard you could swap (S3 API, SQL, OIDC, OCI)
- 🟡 Proprietary but thin, wrappable behind your own interface
- 🔴 Proprietary and pervasive; its idioms leak into your domain code

### 4. Build and deploy coupling
- 🟢 Standard toolchain; vendor is a deploy target
- 🟡 Vendor CLI wraps a standard build
- 🔴 Vendor's build is the only build; no local equivalent

**Test this directly: can you build and run the project with no network and no vendor account?** If
not, you cannot develop when they have an outage, and neither can a new contributor.

### 5. Runtime dependency for core function
- 🟢 Vendor is optional; core features work without it
- 🟡 Degrades gracefully
- 🔴 App is non-functional if the vendor is unreachable

### 6. Exit cost, in hours
Estimate honestly. Under a week is a dependency. Over a month is a merger.

### 7. The template question — for scaffolded starters specifically

Scaffolded projects are where lock-in hides best, because it arrives *pre-installed and endorsed*.
Before building on one, audit it:

```bash
# What does it ship that you didn't ask for?
grep -rniE 'analytics|telemetry|beacon|collector|badge|watermark|@vendor' \
  --include='*.ts' --include='*.tsx' --include='*.json' . | grep -v node_modules

# Does it enforce its own presence?
grep -rn -i 'vendor' *.json .*rc* 2>/dev/null | grep -v node_modules

# Does it hash-protect files so you cannot edit them?
find . -name '*protected*' -o -name '*manifest*.json' | grep -v node_modules
```

Then ask the decisive question: **does the template's own tooling fail if I remove its vendor code?**
If yes, you are not adopting a starter, you are adopting a landlord.

## Part 2 — Red flags in code review

These are the specific signals. All were present in a real project (see the companion skill's case
study) and every one is cheap to catch at review time and expensive later.

**🚩 A comment asserting necessity.**
```
// do not remove, required for analytics tracking
```
Treat as a claim to verify. In the reference case it was false. If something is genuinely required,
the comment should say *what breaks*, testably.

**🚩 A lint or convention rule that requires a vendor import.** Any rule shaped like
`must.importFrom: ["@vendor/..."]`. This is lock-in expressed as policy: it converts "you may not
remove this" into "your build fails if you try."

**🚩 Hash-protected files you are forbidden to edit.** Reasonable for genuine template plumbing;
unreasonable when it covers vendor coupling, because it means you cannot remove the coupling without
also defeating a safety mechanism — which feels illicit, so people don't.

**🚩 Telemetry on by default, or ignoring the product's own preference.** Check whether the app has a
user-facing telemetry setting and whether the vendor's SDK honours it. A provider that reports
regardless makes that setting cosmetic and any privacy statement built on it false.

**🚩 Vendor branding in permanent identity.** Bundle IDs, package names, URL schemes, database names.
Cheap to change before launch. After launch, a bundle ID change is a *new app* with no reviews and no
install base.

**🚩 Hardcoded vendor hosts, especially preview or sandbox URLs.**
```ts
apiUrl: "https://myapp-x7q2-preview-4200.vendor.site/"
```
These die silently. When they do, the error names the vendor's *proxy*, not the vendor — making it
effectively unsearchable for the person hitting it.

**🚩 Injected UI in your product.** Badges, feedback widgets, watermarks. Ask whether the licence
permits removal and remove it before shipping.

**🚩 A wrapper around a platform capability.** If an SDK wraps deep links, storage, notifications or
auth, ask what it adds beyond the platform primitive. Sometimes real value; often it is a hook to
route your users through their service.

**🚩 Declared-but-unused config.** Empty env placeholders for services you never adopted. Harmless
functionally, but they signal that nobody has audited what this project actually talks to.

## Part 3 — Guardrails that make it hard to re-add

Do not rely on vigilance. Encode it.

### A denylist check in CI

Cheap, effective, and it makes adding coupling a *conversation* rather than a commit. Adapt the
package globs to the project:

```bash
#!/usr/bin/env bash
# tools/check-vendor-coupling.sh — fail the build on undeclared vendor coupling.
set -uo pipefail

# Packages that may not be imported without an explicit, reviewed exception.
DENY='@vendor/|vendor-sdk|vendor-runtime'

# Behaviour that must never be added silently.
BEACON='r\.example\.com|collector\.|/track\?|analytics\.send'

fail=0
hits=$(grep -rnE "$DENY" --include='*.ts' --include='*.tsx' --include='*.json' . \
        2>/dev/null | grep -v node_modules | grep -v '\.lock' | grep -v '^\./docs/' || true)
if [ -n "$hits" ]; then echo "Vendor import(s) added:"; echo "$hits"; fail=1; fi

beacons=$(grep -rnE "$BEACON" --include='*.ts' --include='*.tsx' . \
        2>/dev/null | grep -v node_modules || true)
if [ -n "$beacons" ]; then echo "Telemetry endpoint(s) added:"; echo "$beacons"; fail=1; fi

[ "$fail" -eq 0 ] && echo "no new vendor coupling"
exit "$fail"
```

Wire it into the project's `lint` script so it runs where people already look.

### An architecture rule: vendors live behind your own interface

One module owns each vendor. Domain code imports your interface, never the SDK. Then a lint rule can
enforce that the SDK is imported in exactly one file — which turns "we're locked in" into "we rewrite
one adapter."

### A no-network build test

Add a CI job that builds and runs the test suite with **no network and no vendor credentials**. If it
passes, contributors can work during a vendor outage. If it fails, you have found runtime coupling
you did not know about.

### An `ADR` or decision log entry per vendor

One short file per adopted vendor recording: what it does, what data it holds, the documented export
path, the estimated exit cost in hours, and who decided. Reviewing this list annually is how you
notice that a "small" dependency now owns your identities.

## Part 4 — Pre-ship audit

Before a release, and especially before a store submission:

1. **What does this app send, and to whom?** Enumerate every outbound host. Compare against what your
   privacy policy declares. A mismatch is a legal problem, not a tidiness problem.
2. **Does anything phone home before consent?** Many jurisdictions require consent *before* the first
   non-essential request.
3. **Is any vendor branding shipping?** Badges, splash screens, and identity strings.
4. **Does the app still work if the vendor is unreachable?** Test with the vendor's hosts blocked.
5. **Are there dead vendor hosts left in config?** They will produce unexplainable errors for users
   long after everyone has forgotten the vendor existed.

## How to talk to the user about this

People discover lock-in while already frustrated, and often cannot name what has them. Be concrete
and non-fatalistic:

- **Name the specific mechanism**, with file and line. "You are locked in" is useless; "these three
  lint rules fail your build if you remove the badge" is actionable.
- **Separate rented from owned.** Users routinely believe their own good work is contaminated. Tell
  them which parts are genuinely theirs — usually most of it.
- **Give the exit cost as a number.** "About a day" changes how someone feels far more than
  reassurance does.
- **Do not moralise about the vendor.** They want to keep building.
- **Do not overstate the fix.** Removing a reference to a dead host is not the same as restoring the
  capability it provided. Say which you did.
