// The table server over TCP, as a player speaks to it: node tests/server.mjs
// Discovery, a wrong password, then games against computer players: the
// first two with this seat playing (rolling, picking planes), the last under 托管.
import { spawn } from "node:child_process";
import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { botChoose, TAKEOFF, HOME } from "../mods/fxq/rules.js";
import { cipher } from "../mods/fxq/aes.js";

const here = dirname(fileURLToPath(import.meta.url));
const assert = (ok, what) => { if (!ok) throw new Error(what); };
const port = 21000 + Math.floor(Math.random() * 900);
const PASSWORD = "246810";
const box = cipher(PASSWORD, crypto);
const server = spawn(process.execPath, [join(here, "../mods/fxq/server.mjs"), String(port), PASSWORD, "--fast"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => server.stdout.once("data", r));

const room = await new Promise((resolve, reject) => {
  const u = dgram.createSocket("udp4");
  u.on("message", (d) => { const r = JSON.parse(String(d)); if (r.port === port) { u.close(); resolve(r); } });
  u.bind(0, () => u.send("herdr-fxq?", 17788, "127.0.0.1"));
  setTimeout(() => reject(new Error("no discovery answer")), 3000);
});
assert(room.t === "fxq-room", "discovery");
const refused = await new Promise((resolve) => {
  const w = net.connect(port, "127.0.0.1", () => w.write(cipher("000000", crypto).seal(JSON.stringify({ t: "hello", name: "x" })) + "\n"));
  w.setEncoding("utf8");
  w.on("data", (d) => { resolve(JSON.parse(d.split("\n")[0])); w.destroy(); });
  w.on("error", () => {});
});
assert(refused.plain && refused.msg === "房间密码不对", "wrong password refused");
console.log("discovery and password ok");

const sock = net.connect(port, "127.0.0.1");
sock.setEncoding("utf8");
sock.on("error", () => {});
const send = (m) => sock.write(box.seal(JSON.stringify(m)) + "\n");
send({ t: "hello", name: "测试" });
const GAMES = 3;
let buf = "", games = 0, rolls = 0, moves = 0, last = null, setup = 0, autoOn = false, seen = -1;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 240000);
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(box.open(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        if (m.t === "ping") continue;
        if (m.t === "error") { clearTimeout(timer); return reject(new Error(m.msg)); }
        last = m;
        const n = m.seats.filter(Boolean).length;
        if (m.phase === "lobby") {
          if (setup === 0) { setup = 1; send({ t: "config", takeoff: 56 }); }
          else if (setup === 1 && m.config.takeoff === 56) { setup = 2; send({ t: "bot" }); send({ t: "bot" }); send({ t: "bot" }); }
          else if (setup === 2 && n === 4) { setup = 3; send({ t: "start" }); }
          continue;
        }
        // Planes never share a square across colors; counts stay 4 each.
        assert(m.players.length === 4 && m.planes.every((ps) => ps.length === 4), "four players, four planes each");
        if (m.phase === "over") {
          if (m.moves === seen) continue;
          seen = m.moves;
          games++;
          const w = m.result.winner;
          assert(m.planes[w].every((p) => p === HOME) && m.result.ranks[0] === w, "the winner has every plane home");
          assert(m.seats[w].wins >= 1, "the win is counted");
          console.log(`game ${games}: ${m.msg} ranks ${m.result.ranks.join(">")} home ${m.result.home.join("/")}`);
          if (games === GAMES) { clearTimeout(timer); return resolve(); }
          if (games === GAMES - 1) { autoOn = true; send({ t: "auto", on: true }); }
          send({ t: "again" });
          continue;
        }
        if (m.turn !== m.you || autoOn || m.moves === seen) continue;
        seen = m.moves;
        assert(m.deadline > 0 || m.phase === "move", "a person's turn has a deadline");
        if (m.phase === "roll") { rolls++; send({ t: "roll" }); }
        else if (m.phase === "move" && m.options) {
          // A single choice moves by itself; otherwise pick like the computer would.
          if (new Set(m.options.map((o) => o.from)).size === 1) continue;
          moves++;
          send({ t: "move", plane: botChoose(m.planes, m.you, m.dice, TAKEOFF[m.config.takeoff]) });
        }
      }
    });
  });
  console.log(`server ok: ${games} games (the last under 托管), ${rolls} rolls and ${moves} choices by this seat`);
} catch (e) {
  console.error("FAIL:", e.message, JSON.stringify(last)?.slice(0, 600));
  process.exitCode = 1;
} finally {
  sock.destroy();
  server.kill();
}
