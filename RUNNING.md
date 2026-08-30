# Running the game

Verified against Expo SDK 54 (`expo ~54.0.33`), managed workflow, no `android/` or `ios/` directory.
The web bundle was confirmed to build: 908 modules, clean exit.

## Once, on your machine

```sh
git clone https://github.com/2c2bhdhw9z-cell/nightreap-survivors.git
cd nightreap-survivors
bun install
```

You do **not** need a `.env`, a database, or the API server to play. The save lives on the device
(AsyncStorage). The server is only used for cloud backup, leaderboards and anti-cheat reporting.

## On a phone — Expo Go (the best path)

This is what the renderer was built for: `expo-gl` gets a real OpenGL ES context on device.

```sh
cd packages/mobile
bunx expo start
```

Then:

- **Android** — open Expo Go and scan the QR code in the terminal.
- **iPhone** — scan the QR code with the Camera app; it hands off to Expo Go.

Phone and computer must be on the **same Wi-Fi**. If they are not, or the QR code hangs at
"Downloading JavaScript bundle":

```sh
bunx expo start --tunnel
```

Tunnel routes through ngrok, so it works across networks — slower to boot, but reliable on locked-down
or corporate Wi-Fi.

Expo Go must be a build that supports **SDK 54**. An older Expo Go will refuse the project outright.

All four config plugins (`expo-router`, `expo-asset`, `expo-font`, `expo-localization`) and `expo-gl`
ship inside Expo Go, so no custom dev client is needed.

## In a browser

```sh
cd packages/mobile
bunx expo start --web
```

Requires WebGL. If the browser does not grant a context, `/dev/play` shows a "No WebGL on this
browser" panel instead of crashing (`play.tsx:webglAvailable`) — that guard is a fallback, not a
statement that web is unsupported. Menus are React Native Web and render fine either way.

To produce a static build instead of a dev server:

```sh
bunx expo export --platform web --output-dir dist
```

## From the repo root

```sh
bun run dev:mobile     # cd packages/mobile && expo start --port 4300
```

## How to reach actual gameplay

```
/  (title)  →  PLAY  →  /stages  →  pick a stage
            →  /characters?stage=X  →  pick a character
            →  /dev/play?character=Y&stage=X   ← the run
```

The run screen still lives at `/dev/play`; it is the real gameplay screen, not a stub.

**Shortcut to the dev tools:** tap the version line on the title screen **seven times** (resets after
two seconds of no tapping). That opens `/dev/launcher`, which reaches the dev menu, the benchmark
harness, and the leak harness. The dev menu can jump to any minute, stage, character or enemy count.

## Known, and not your fault

- `bun run typecheck` fails in `packages/web` — two major versions of Vite in one workspace. It does
  not affect the mobile app.
- `bun run test:game` fails exactly one assertion, a replay-revalidation performance budget. Gameplay
  is unaffected.
- `bun run test:web` cannot run without `DATABASE_URL`, because the database client is constructed at
  module load.

Both real issues are documented in `audit-handoff.md`.
