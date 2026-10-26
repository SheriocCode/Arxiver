import fs from "node:fs";
import path from "node:path";

import * as paths from "./paths";

// 旧版本把应用数据放在 %APPDATA%\<AppName>；新版应用数据在 <安装目录>/data。
// 首次启动时把已经存在的“用户数据”补到 data（不做覆盖），Chromium 缓存 / LocalStorage 不搬。
const FILES = ["config.json", "ui-settings.json", "skills.json"];
const DIRS = ["storage", "background", "models"];
const MARKER = ".legacy-data-migrated";

function copyMissingTree(src: string, dst: string): void {
  if (!fs.existsSync(src)) { return; }
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      copyMissingTree(from, to);
    } else if (!fs.existsSync(to)) {
      fs.copyFileSync(from, to);
    }
  }
}

export function migrateLegacyData(): void {
  try {
    const data = paths.userDataDir();
    const profile = paths.profileDir();
    if (path.resolve(data) === path.resolve(profile)) { return; }
    const marker = path.join(data, MARKER);
    if (fs.existsSync(marker)) { return; }
    fs.mkdirSync(data, { recursive: true });

    for (const name of FILES) {
      const src = path.join(profile, name);
      const dst = path.join(data, name);
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }
    for (const name of DIRS) {
      const src = path.join(profile, name);
      const dst = path.join(data, name);
      if (!fs.existsSync(src)) { continue; }
      if (name === "storage" && fs.existsSync(path.join(dst, "index.json"))) {
        // 新目录已经有文库时不做合并，避免覆盖当前数据
        continue;
      }
      copyMissingTree(src, dst);
    }
    fs.writeFileSync(marker, new Date().toISOString(), "utf8");
  } catch (err) {
    console.error("[arxiver] 旧数据迁移失败:", err);
  }
}
