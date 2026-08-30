import { ipcRenderer, contextBridge } from "electron";

// window.electronAPI — the whole renderer-facing surface.
//
// `openExternal` and `onDeepLink` used to come from @runablehq/managed-auth, which also exposed a
// second `window.managedAuth` global for a hosted sign-in flow. Both are gone: the auth service is
// not ours and the extra global was only there to serve it. These are now plain IPC calls into
// ./ipc.ts, which is the same place every other desktop capability already lived.

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,

  // Dialog
  showOpenDialog: (opts: Electron.OpenDialogOptions) => ipcRenderer.invoke("dialog:open", opts),
  showSaveDialog: (opts: Electron.SaveDialogOptions) => ipcRenderer.invoke("dialog:save", opts),

  // File system
  readFile: (path: string) => ipcRenderer.invoke("fs:read", path),
  writeFile: (path: string, data: string) => ipcRenderer.invoke("fs:write", path, data),

  // Shell — opens in the user's default browser. http(s) only, enforced in the main process.
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),

  // Notifications
  showNotification: (title: string, body: string) =>
    ipcRenderer.invoke("notification:show", title, body),

  // Window controls
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),

  /**
   * OS deep links on the app's own `nightreap://` scheme.
   *
   * Returns an unsubscribe function, and deliberately does not hand the renderer the raw
   * IpcRenderer event — only the URL string.
   */
  onDeepLink: (handler: (url: string) => void) => {
    const listener = (_event: unknown, url: string) => handler(url);
    ipcRenderer.on("deep-link", listener);
    return () => ipcRenderer.removeListener("deep-link", listener);
  },
});
