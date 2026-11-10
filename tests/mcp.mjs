// An AI plays *your* seat through the MCP server, the way it does from
// Claude Code: the client (your game window's link) is at the table, the MCP
// server drives it over its control port, and the state file (what your
// window shows) follows every move. node tests/mcp.mjs
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fxq = join(here, "../mods/fxq");
const port = 23000 + Math.floor(Math.random() * 900);
const file = join(mkdtempSync(join(tmpdir(), "fxq-")), "state.json");
const server = spawn(process.execPath, [join(fxq, "server.mjs"), String(port), "135790", "--fast"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => server.stdout.once("data", r));
const client = spawn(process.execPath, [join(fxq, "client.mjs"), file, "主人"], { stdio: ["pipe", "pipe", "inherit"] });
await new Promise((r) => client.stdout.once("data", r));
client.stdin.write(JSON.stringify({ t: "_join", addr: `127.0.0.1:${port}`, password: "135790", tries: 3 }) + "\n");
const read = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
for (let k = 0; k < 50 && read().status !== "online"; k++) await new Promise((r) => setTimeout(r, 100));

const mcp = spawn(process.execPath, [join(fxq, "mcp.mjs"), "--state", file], { stdio: ["pipe", "pipe", "inherit"] });
let id = 0;
const pending = new Map();
readline.createInterface({ input: mcp.stdout }).on("line", (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
const rpc = (method, params) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
const tool = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const t = r.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(t); } catch { return t; }
};
const cleanup = (code = 0) => { mcp.kill(); client.kill(); server.kill(); process.exit(code); };
const fail = (m) => { console.error("FAIL:", m); cleanup(1); };
setTimeout(() => fail("timed out"), 200000);

const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
if (init.result?.serverInfo?.name !== "herdr-fxq") fail("initialize");
const list = await rpc("tools/list", {});
console.log("tools:", list.result.tools.map((t) => t.name).join(" "));
const first = await tool("fxq_state");
if (first.connection !== "online" || first.you !== 0 || first.your_color !== "红方") fail(`the AI sits in your seat: ${JSON.stringify(first).slice(0, 300)}`);
for (let k = 0; k < 30 && !(read().ai && read().state?.seats?.[0]?.ai); k++) await new Promise((r) => setTimeout(r, 100));
if (!read().ai || !read().state.seats[0].ai) fail("your window and the table show the seat as AI-played");

// Chat: the AI speaks (marked AI in your window); you type in the window and the AI wakes to read it.
const said = await tool("fxq_chat", { text: "大家好，我来替主人下", to: "all" });
if (!said.ok) fail(`chat: ${JSON.stringify(said)}`);
for (let k = 0; k < 30 && !read().state?.chat?.some((c) => c.text === "大家好，我来替主人下"); k++) await new Promise((r) => setTimeout(r, 100));
if (!read().state.chat.some((c) => c.text === "大家好，我来替主人下" && c.ai)) fail("your window shows the AI's line, marked AI");
const waiting = tool("fxq_wait", { timeout_seconds: 10 });
await new Promise((r) => setTimeout(r, 300));
client.stdin.write(JSON.stringify({ t: "chat", text: "稳一点，别冒进", to: "all" }) + "\n");
const woke = await waiting;
if (woke.woke !== "chat" || !woke.new_chat?.some((c) => c.text === "稳一点，别冒进" && c.from.includes("主人") && !c.by_ai)) fail(`the AI wakes for its owner's line: ${JSON.stringify(woke).slice(0, 400)}`);
console.log("chat ok: the AI spoke (marked AI) and woke for its owner's line");

for (let k = 0; k < 3; k++) await tool("fxq_add_bot");
const started = await tool("fxq_start");
if (!started.ok) fail(`start: ${JSON.stringify(started)}`);
let rolls = 0, moves = 0, captures = 0;
for (;;) {
  const w = await tool("fxq_wait", { timeout_seconds: 30 });
  const s = w.state;
  if (s.phase === "本局结束") {
    console.log(`over: ${s.message}; the AI came ${s.result.your_place}, after ${rolls} rolls and ${moves} moves (${captures} that captured)`);
    break;
  }
  if (!s.your_turn) continue;
  let r;
  if (s.phase === "掷骰子") { rolls++; r = await tool("fxq_roll"); }
  else if (s.options?.length) {
    // Prefer a capture, then the computer's suggestion.
    const hit = s.options.find((o) => o.text.includes("撞回"));
    const pick = hit?.plane ?? Number(s.suggestion?.match(/(\d) 号机/)?.[1] ?? s.options[0].plane);
    if (hit) captures++;
    moves++;
    r = await tool("fxq_move", { plane: pick });
  } else continue;
  if (!r.ok) fail(`action: ${JSON.stringify(r).slice(0, 400)}`);
}
for (let k = 0; k < 20 && read().state?.phase !== "over"; k++) await new Promise((r) => setTimeout(r, 50));
if (read().state.phase !== "over") fail("the state file (your window) shows the finished game");
mcp.kill();
for (let k = 0; k < 30 && read().ai; k++) await new Promise((r) => setTimeout(r, 100));
if (read().ai) fail("the seat goes back to you when the AI disconnects");
console.log("mcp ok");
cleanup(0);
