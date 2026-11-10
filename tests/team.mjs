// 2v2, seats and chat, over TCP with two people at the table: node tests/team.mjs
// The host picks 2v2 and swaps seats so the guest is their partner; team chat
// reaches only the team, chat to everyone reaches everyone; a whole 2v2 game
// under 托管: teammates never send each other home, a player all home sits out,
// and the team with all eight home wins together.
import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HOME } from "../mods/fxq/rules.js";
import { cipher } from "../mods/fxq/aes.js";

const here = dirname(fileURLToPath(import.meta.url));
const port = 24000 + Math.floor(Math.random() * 900);
const box = cipher("777000", crypto);
const server = spawn(process.execPath, [join(here, "../mods/fxq/server.mjs"), String(port), "777000", "--fast"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => server.stdout.once("data", r));
const fail = (what, s) => { console.error("FAIL:", what, s ? JSON.stringify(s).slice(0, 500) : ""); host.sock.destroy(); guest.sock.destroy(); server.kill(); process.exit(1); };

function player(name) {
  const p = { last: null, errors: [], waiters: [] };
  p.sock = net.connect(port, "127.0.0.1");
  p.sock.setEncoding("utf8");
  p.sock.on("error", () => {});
  let buf = "";
  p.sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(box.open(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
      if (m.t === "state") p.last = m;
      if (m.t === "error") p.errors.push(m.msg);
      for (const w of [...p.waiters]) w();
    }
  });
  p.send = (m) => p.sock.write(box.seal(JSON.stringify(m)) + "\n");
  p.until = (test, what, ms = 6000) => new Promise((resolve) => {
    const t = setTimeout(() => fail(what, p.last), ms);
    const check = () => { if (p.last && test(p.last)) { clearTimeout(t); p.waiters = p.waiters.filter((w) => w !== check); resolve(p.last); } };
    p.waiters.push(check);
    check();
  });
  p.send({ t: "hello", name, key: crypto.randomUUID() });
  return p;
}

const host = player("房主");
await host.until((s) => s.you === 0, "the host sits at 红");
const guest = player("客人");
await guest.until((s) => s.you === 1, "the guest sits at 黄");
host.send({ t: "config", mode: "team" });
await host.until((s) => s.config.mode === "team" && s.teams?.join() === "0,1,0,1", "2v2 is on");
host.send({ t: "start" });
await host.until(() => host.errors.some((e) => e.includes("坐满 4 人")), "2v2 needs four");
// The guest moves to 绿 (the host's partner), then the host swaps them back and forth.
guest.send({ t: "seat", to: 2 });
await guest.until((s) => s.you === 2, "the guest moves to an empty seat");
host.send({ t: "bot" }); host.send({ t: "bot" });
await host.until((s) => s.seats.every(Boolean), "computers fill the table");
host.send({ t: "swap", a: 2, b: 3 });
await guest.until((s) => s.you === 3, "the host's swap moves the guest");
host.send({ t: "swap", a: 3, b: 2 });
await guest.until((s) => s.you === 2 && s.teams[2] === s.teams[0], "the guest is the host's partner again");
console.log("seats ok: guest moved, host swapped twice");

// Chat: team lines stay in the team.
host.send({ t: "chat", to: "team", text: "我先冲，你断后" });
await guest.until((s) => s.chat.some((c) => c.text === "我先冲，你断后" && c.to === "team"), "the partner reads team chat");
guest.send({ t: "chat", to: "all", text: "大家好", ai: true });
await host.until((s) => s.chat.some((c) => c.text === "大家好" && c.to === "all" && c.ai && c.name === "客人"), "everyone reads chat to all, AI-marked");
host.send({ t: "chat", to: "all", text: "" });
await host.until(() => host.errors.includes("说点什么吧"), "an empty line is refused");
console.log("chat ok: team line stays in the team, line to all reaches all");

// A whole 2v2 game under 托管.
host.send({ t: "auto", on: true });
guest.send({ t: "auto", on: true });
host.send({ t: "start" });
let seen = -1, hits = 0, sat = false;
const over = await host.until((s) => {
  if (s.last && s.last.n !== seen) {
    seen = s.last.n;
    for (const h of s.last.captures) {
      if (s.teams[h.seat] === s.teams[s.last.seat]) fail("a teammate was sent home", s.last);
      hits++;
    }
  }
  if (s.done.length && s.phase !== "over") {
    if (s.turn >= 0 && s.done.includes(s.turn)) fail("a player who's done still plays", s);
    sat = true;
  }
  return s.phase === "over";
}, "a whole 2v2 game", 200000);
const r = over.result;
if (r.team == null || r.winners.length !== 2 || r.winners.some((w) => over.teams[w] !== r.team)) fail("the winners are one team", r);
if (!r.winners.every((w) => over.planes[w].every((p) => p === HOME))) fail("both winners have every plane home", r);
if (!r.winners.every((w) => over.seats[w].wins === 1)) fail("both winners get the win", over.seats);
if (over.teams[r.ranks[0]] !== r.team || over.teams[r.ranks[1]] !== r.team) fail("the winning team ranks first", r);
console.log(`2v2 game: ${over.msg} (${hits} captures, none of a teammate${sat ? "; a finished player sat out" : ""})`);
console.log("team ok");
host.sock.destroy(); guest.sock.destroy();
server.kill();
