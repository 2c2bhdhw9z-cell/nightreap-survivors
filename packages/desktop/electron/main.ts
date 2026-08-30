import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpcHandlers, sendDeepLink } from "./ipc";

// Fully editable Electron main process — window, lifecycle, menus, tray, and IPC
// (handlers in ./ipc.ts).
//
// Deep links used to be registered by a platform package (`createManagedDeepLinks` from
// @runablehq/managed-auth), which claimed a `runable-<APPLICATION_ID>` protocol and backed a managed
// sign-in flow. That package is gone: it tied the desktop build to one company's auth service, and
// the protocol name carried their branding into the OS. Electron does all of this natively in about
// twenty lines, which is what follows.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV !== "production";
const WEB_DEV_URL = process.env.WEBSITE_URL ?? "http://localhost:3000";
const WEB_DIST = path.join(__dirname, "../web-dist");

/** The app's own URL scheme. Must match `scheme` in packages/mobile/app.json. */
const PROTOCOL = "nightreap";

let win: BrowserWindow | null = null;
const getWindow = () => win;

/**
 * Register the scheme with the OS.
 *
 * In dev, Electron is launched via the `electron` binary, so the OS has to be told which executable
 * and arguments to re-invoke — otherwise the link opens a bare Electron instead of this app.
 */
function registerProtocol(): void {
  if (isDev && process.platform !== "darwin") {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] ?? "")]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/** Pull the first `nightreap://…` argument out of an argv array. Windows and Linux deliver links this way. */
function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`)) ?? null;
}

function forward(url: string | null): void {
  if (!url) return;
  const target = getWindow();
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.focus();
  sendDeepLink(target, url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL(WEB_DEV_URL);
  } else {
    win.loadFile(path.join(WEB_DIST, "index.html"));
  }
}

registerIpcHandlers(getWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// macOS delivers deep links as an event, never as argv.
app.on("open-url", (event, url) => {
  event.preventDefault();
  forward(url);
});

// Windows and Linux deliver them as argv — of a second instance while the app is running, or of this
// instance on a cold start. Keep one instance and handle both.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", (_event, argv) => forward(deepLinkFromArgv(argv)));
  app.whenReady().then(() => {
    registerProtocol();
    createWindow();
    forward(deepLinkFromArgv(process.argv));
  });
} else {
  app.quit();
}
