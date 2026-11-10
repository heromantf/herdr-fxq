// Installs the 飞行棋 mod into a Herdr app home: node install.mjs [home] [--update]
// --update replaces an installed copy (the old one is kept in <home>/fxq-backup-<time>/).
// The mod's files are copied before its main.js, so a running Herdr reloads a complete build.
import { existsSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const update = args.includes("--update");
const home = resolve(args.find((a) => !a.startsWith("--")) || process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"));
const mod = join(source, "mods", "fxq");
const dest = join(home, "mods", "fxq");

if (existsSync(dest)) {
  if (!update) throw new Error(`Refusing to overwrite ${dest}. Run with --update to replace it (the old copy is backed up).`);
  const backup = join(home, `fxq-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  cpSync(dest, join(backup, "mods", "fxq"), { recursive: true });
  console.log(`Backed up the installed copy to ${backup}`);
}

// Assets and modules first, main.js last. Files Herdr writes itself stay out.
mkdirSync(dest, { recursive: true });
const skip = new Set(["main.js", "gpui-kit.d.ts", "jsconfig.json"]);
for (const name of readdirSync(mod)) {
  if (!skip.has(name)) cpSync(join(mod, name), join(dest, name), { recursive: true });
}
cpSync(join(mod, "main.js"), join(dest, "main.js"));
console.log(`Installed 飞行棋 in ${dest}
Open it in any layout: herdr-app do mod.open --name fxq
A status-bar button for your own layout: {"id": "fxq", "size": {"px": 34}, "content": {"mod": "fxq", "props": {"role": "launcher", "block": "fxq"}}}`);
