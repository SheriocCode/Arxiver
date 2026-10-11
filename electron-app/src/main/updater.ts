import { app } from "electron";
import { EventEmitter } from "node:events";
import updaterPkg from "electron-updater";
import type { UpdateStatus } from "../shared/types";

const { autoUpdater } = updaterPkg as unknown as { autoUpdater: any };

export class Updater extends EventEmitter {
  private status: UpdateStatus = { state: "idle" };

  init(autoCheck = true): void {
    if (!app.isPackaged) {
      this.set({ state: "unsupported" });
      return;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => this.set({ state: "checking" }));
    autoUpdater.on("update-available", (info: any) => this.set({ state: "available", version: info?.version }));
    autoUpdater.on("update-not-available", () => this.set({ state: "none" }));
    autoUpdater.on("download-progress", (p: any) => this.set({ state: "downloading", percent: Math.round(p?.percent || 0) }));
    autoUpdater.on("update-downloaded", (info: any) => this.set({ state: "ready", version: info?.version }));
    autoUpdater.on("error", (err: any) => this.set({ state: "error", error: String(err?.message || err) }));
    if (autoCheck) { this.check(); }
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  check(): void {
    if (!app.isPackaged) { this.set({ state: "unsupported" }); return; }
    this.set({ state: "checking" });
    void autoUpdater.checkForUpdates().catch((err: any) => this.set({ state: "error", error: String(err?.message || err) }));
  }

  download(): void {
    if (!app.isPackaged) { return; }
    void autoUpdater.downloadUpdate().catch((err: any) => this.set({ state: "error", error: String(err?.message || err) }));
  }

  install(): void {
    if (!app.isPackaged) { return; }
    autoUpdater.quitAndInstall();
  }

  private set(patch: UpdateStatus): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }
}
