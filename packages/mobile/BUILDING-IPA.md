# Building an unsigned .ipa (for ESign / Feather)

This produces an **unsigned** `.ipa` you sideload with **ESign** or **Feather**. Those apps do the
signing on-device with *your* certificate + provisioning profile, so the build itself needs **no Apple
Developer account, no certificates, and no secrets**.

Bundle id: `com.nightreap.survivors` · Expo owner: `fuckyouniggerbitch` · SDK 54.

## Get the .ipa

**Actions → Build unsigned iOS IPA → Run workflow.** Leave the configuration on `Release`. When it
finishes, open the run and download **`nightreap-unsigned-ipa`** from the **Artifacts** section — that
zip contains `nightreap-unsigned.ipa`.

The build runs on a macOS runner (Xcode is required to produce a device `.ipa`). It:
`expo prebuild` → `pod install` → `xcodebuild archive` with signing switched **off** → repackages the
`.app` into an unsigned `.ipa`. Takes roughly 10–20 minutes.

> Cost note: on a **public** repo, macOS minutes are free. On a **private** repo they are metered at
> ~10× Linux rate, so trigger the build only when you actually want one.

## Sideload it

**ESign:**
1. Import your signing assets once: **Distribution.p12** (password `123456`) and
   **Distribution.mobileprovision** under ESign's Certificate/Signing section.
2. Import `nightreap-unsigned.ipa` (Files, AirDrop, or a URL).
3. Sign it with that certificate, then install.

**Feather:**
1. Add your certificate: the **.p12** (password `123456`) + the **.mobileprovision** pair.
2. Import `nightreap-unsigned.ipa`.
3. Sign with that certificate and install.

Either app re-signs the unsigned `.ipa` with your credentials — that is exactly what an unsigned build
is for. Nothing needs to be signed in CI.

## Invariant — don't break this

`runtimeVersion` in `app.json` stays `{ "policy": "sdkVersion" }` → `exposdk:54.0.0`. It is what the
Expo Go + EAS Update path (see `RUNNING.md`) matches on. Nothing in this build changes it, and neither
should you.

## Notes

- The generated `ios/` folder is gitignored and recreated by `expo prebuild` on every run — never
  commit it.
- An `.ipa` won't make the engine faster (same Hermes JS + `expo-gl` renderer as Expo Go). It gives you
  a standalone home-screen app and room for custom native modules. For quick iteration,
  `eas update --branch preview` (in `RUNNING.md`) is still the faster loop.
- `scripts/generate-ios-certs.py` is unrelated to this flow — it provisions Apple Developer signing for
  EAS store builds and is left untouched.
