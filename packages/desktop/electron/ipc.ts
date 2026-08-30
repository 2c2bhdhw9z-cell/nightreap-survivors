import { ipcMain, dialog, Notification, shell, type BrowserWindow } from "electron";
import fs from "node:fs/promises";

// IPC handlers backing window.electronAPI (see preload.ts and
// packages/web/src/web/lib/desktop.ts). Fully editable — change, remove, or add handlers to fit the
// app; keep the preload methods and web types in sync.
//
// `openExternal` and the deep-link channel used to come from @runablehq/managed-auth. They are
// native now, and live here with everything else.

/** Forward an OS deep link to the renderer. Called from main.ts. */
export function sendDeepLink(win: BrowserWindow, url: string): void {
  win.webContents.send("deep-link", url);
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null) {
  // Shell.
  //
  // The http(s) check is the whole security boundary here: without it a renderer could pass
  // `file://` and have the OS open a local executable. Electron's own guidance is to never hand
  // shell.openExternal an unvalidated string.
  ipcMain.handle("shell:open-external", async (_, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    await shell.openExternal(parsed.toString());
    return true;
  });

  // Dialog
  ipcMain.handle("dialog:open", async (_, opts) => {
    const result = await dialog.showOpenDialog(opts);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("dialog:save", async (_, opts) => {
    const result = await dialog.showSaveDialog(opts);
    return result.canceled ? null : result.filePath;
  });

  // File system
  ipcMain.handle("fs:read", async (_, filePath: string) => {
    return fs.readFile(filePath, "utf-8");
  });

  ipcMain.handle("fs:write", async (_, filePath: string, data: string) => {
    await fs.writeFile(filePath, data, "utf-8");
  });

  // Notifications
  ipcMain.handle("notification:show", (_, title: string, body: string) => {
    new Notification({ title, body }).show();
  });

  // Window controls
  ipcMain.handle("window:minimize", () => getWindow()?.minimize());
  ipcMain.handle("window:maximize", () => {
    const win = getWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  ipcMain.handle("window:close", () => getWindow()?.close());
}
