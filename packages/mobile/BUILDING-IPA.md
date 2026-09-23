# Building an .ipa

This produces a signed `.ipa` for Nightreap Survivors via **EAS Build**, driven by GitHub Actions.
EAS runs the macOS compile in the cloud — no Mac of your own required. The runner just orchestrates,
provisions signing with `scripts/generate-ios-certs.py`, and hands you the `.ipa`.

Bundle id: `com.nightreap.survivors` · Expo owner: `fuckyouniggerbitch` · SDK 54.

## Three build profiles (`eas.json`)

| Profile | Produces | Installs on | Signing |
|---|---|---|---|
| `preview` | ad-hoc / internal `.ipa` | **your registered devices — this is the sideload build** | ad-hoc profile (`IOS_APP_ADHOC`) |
| `production` | App Store `.ipa` | TestFlight / App Store | store profile (`IOS_APP_STORE`) |
| `simulator` | unsigned `.app` | iOS Simulator only | none — no Apple account needed |

The workflow picks the provisioning-profile type automatically from the profile you choose
(`preview` → ad-hoc, `production` → store) via the `EXPO_PROFILE_TYPE` env it passes to the cert script.

## Run it from GitHub

**Actions → Build iOS IPA → Run workflow.** Pick a profile (defaults to `preview`). When it finishes,
download the `.ipa` from the run's **Artifacts** section, then sideload it your usual way.

## One-time secrets

Set these under **Settings → Secrets and variables → Actions**. Everything the cert script needs is
already documented in its header; the workflow just maps these in.

**Secrets:**

| Secret | What it is |
|---|---|
| `EXPO_TOKEN` | Expo access token from the **owner** account `fuckyouniggerbitch` (a token from the team account fails with `Entity not authorized`) |
| `EXPO_ASC_KEY_ID` | App Store Connect API key ID |
| `EXPO_ASC_ISSUER_ID` | App Store Connect issuer ID |
| `EXPO_ASC_API_KEY_BASE64` | the `AuthKey_XXXX.p8` file, base64-encoded (`base64 -i AuthKey.p8 \| pbcopy`) |
| `EXPO_APPLE_TEAM_ID` | your Apple Developer Team ID |

**Variables (optional — sensible defaults are baked in):**

| Variable | Default |
|---|---|
| `EXPO_ACCOUNT` | `fuckyouniggerbitch` |
| `EXPO_BUNDLE_ID` | `com.nightreap.survivors` |

The `simulator` profile needs none of the Apple secrets — only `EXPO_TOKEN`.

## What the signing script does

`scripts/generate-ios-certs.py` (unchanged in spirit, now profile-type aware): resolves a distribution
certificate (local → Expo → creates one on Apple, auto-revoking orphans if you hit the cert limit),
looks up the bundle id, and creates a provisioning profile. For **ad-hoc** it attaches every ENABLED
device on your account — so a device you sideload to must have its UDID registered at developer.apple.com
first, or the profile installs nowhere. It writes `credentials.json`, which `eas.json`'s
`credentialsSource: "local"` then consumes.

## Two invariants — don't break these (cross-referenced in `plan.md` / `RUNNING.md`)

- `runtimeVersion` in `app.json` stays `{ "policy": "sdkVersion" }` → `exposdk:54.0.0`. Changing it
  disconnects the phone from EAS Updates.
- Signing artifacts (`ios/`, `credentials.json`, `*.p12`, `*.mobileprovision`, ASC `.p8`) are
  **gitignored on purpose** and regenerated per build. Never commit them.

## Not a Mac replacement, just so you know

An `.ipa` won't make the engine faster — same Hermes JS + `expo-gl` renderer as Expo Go. It buys you a
standalone home-screen app, room for custom native modules (none used today), and the TestFlight path.
For fast iteration, `eas update --branch preview` (see `RUNNING.md`) is still the quicker loop.
