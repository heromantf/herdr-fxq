// The window's link (client.mjs) against a real server, driven as the mod
// drives it: JSON lines in, the state file out. node tests/client.mjs
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fxq = join(here, "../mods/fxq");
const port = 22000 + Math.floor(Math.random() * 900);
const file = join(mkdtempSync(join(tmpdir(), "fxq-")), "state.json");
const server = spawn(process.execPath, [join(fxq, "server.mjs"), String(port), "112233", "--fast"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => server.stdout.once("data", r));
const client = spawn(process.execPath, [join(fxq, "client.mjs"), file, "测试者"], { stdio: ["pipe", "pipe", "inherit"] });
await new Promise((r) => client.stdout.once("data", r));

const say = (m) => client.stdin.write(JSON.stringify(m) + "\n");
const read = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
const until = async (test, what, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (test(read())) return read();
  console.error("FAIL:", what, JSON.stringify(read()).slice(0, 400));
  client.kill(); server.kill(); process.exit(1);
};

say({ t: "_join", addr: `127.0.0.1:${port}`, password: "wrong", tries: 3 });
await until((v) => v.status === "error" && v.error === "房间密码不对", "a wrong password is reported");
say({ t: "_join", addr: `127.0.0.1:${port}`, password: "112233", tries: 3, first: { t: "config", takeoff: 56 } });
await until((v) => v.status === "online" && v.state?.config?.takeoff === 56, "joined and configured");
say({ t: "start" });
await until((v) => v.toast?.msg?.includes("至少需要 2 名玩家"), "a table of one can't start");
say({ t: "bot" }); say({ t: "bot" });
await until((v) => v.state?.seats?.filter(Boolean).length === 3, "two computer players");
say({ t: "auto", on: true });
say({ t: "start" });
const over = await until((v) => v.state?.phase === "over", "a whole three-player game under 托管", 120000);
console.log(`game: ${over.state.msg}, home ${over.state.result.home.join("/")}`);
say({ t: "_scan" });
const scanned = await until((v) => v.scanning === false && v.rooms?.some((r) => r.port === port), "the room is found on the LAN");
console.log(`found: ${scanned.rooms.map((r) => r.addr).join(", ")}`);
say({ t: "_leave" });
await until((v) => v.status === "idle", "left");
console.log("client ok");
client.kill();
server.kill();
