// The game window's link to a 飞行棋 table, as a small node program the mod
// runs in a herdr-core terminal (fxq-client): it holds the TCP connection,
// the AES and the LAN discovery, so the mod itself never touches a socket.
//
//   node client.mjs <state file> <name>
//
// Commands arrive as JSON lines on stdin (the mod types them with `hc send`):
//   { t: "_join", addr, password, first? } { t: "_leave" } { t: "_scan" }
//   and anything else goes to the table as is.
// Everything the window shows is written to the state file (whole, atomically):
//   { status, addr, password, error, toast, state, rooms, scanning, ai, control, seq }
//
// An AI plays *this* seat through mcp.mjs: it connects to the local control
// port (control: { port, token } in the state file, 127.0.0.1 only), sends
// { t: "_auth", token } and then the same commands, and gets every new state
// pushed. While one is connected the seat is marked as AI-played (ai: true
// here, and on the server, for its longer clock), and the window shows it.

import net from "node:net";
import dgram from "node:dgram";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { writeFileSync, renameSync } from "node:fs";
import { cipher } from "./aes.js";

const FILE = process.argv[2];
const NAME = process.argv[3] || os.userInfo().username;
const DEFAULT_PORT = 17787;
const DISCOVERY_PORT = 17788;

let view = { status: "idle", seq: 0 };
let sock = null, box = null, gen = 0;
const controls = new Set();

function save(patch) {
  view = { ...view, ...patch, seq: view.seq + 1 };
  for (const c of controls) { try { c.write(JSON.stringify({ t: "view", view }) + "\n"); } catch {} }
  flush();
}

// On Windows a rename over a file someone is reading fails: try again shortly, the latest view wins.
let retry = null;
function flush() {
  clearTimeout(retry);
  try {
    writeFileSync(`${FILE}.tmp`, JSON.stringify(view));
    renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    retry = setTimeout(flush, 40);
    if (!["EPERM", "EBUSY", "EACCES"].includes(e?.code)) console.error(`写状态失败：${e?.message ?? e}`);
  }
}

function discover(ms = 1500) {
  return new Promise((resolve) => {
    const rooms = new Map();
    const u = dgram.createSocket("udp4");
    u.on("message", (d, rinfo) => {
      try {
        const r = JSON.parse(String(d));
        if (r.t !== "fxq-room") return;
        const key = `${r.name}:${r.port}`;
        // The same room heard on loopback and the LAN: keep the LAN address.
        if (rooms.has(key) && rinfo.address.startsWith("127.")) return;
        rooms.set(key, { ...r, ip: rinfo.address, addr: `${rinfo.address}:${r.port}` });
      } catch {}
    });
    u.on("error", () => {});
    u.bind(0, () => {
      u.setBroadcast(true);
      const targets = new Set(["255.255.255.255", "127.0.0.1"]);
      for (const a of Object.values(os.networkInterfaces()).flat()) {
        if (!a || a.family !== "IPv4" || a.internal || !a.netmask) continue;
        const ip = a.address.split(".").map(Number), m = a.netmask.split(".").map(Number);
        targets.add(ip.map((b, i) => b | (255 ^ m[i])).join("."));
      }
      for (const t of targets) u.send("herdr-fxq?", DISCOVERY_PORT, t, () => {});
    });
    setTimeout(() => { try { u.close(); } catch {} resolve([...rooms.values()]); }, ms);
  });
}

function close() {
  gen++;
  try { sock?.destroy(); } catch {}
  sock = null;
}

function join(addr, password, first, tries = 1) {
  close();
  const g = gen;
  const [h, p] = String(addr ?? "").trim().split(":");
  if (!h) return save({ status: "error", error: "请输入房主的地址，或在列表里选一个房间" });
  const port = Number(p) || DEFAULT_PORT;
  box = cipher(password ?? "", crypto);
  save({ status: "connecting", error: null, addr: `${h}:${port}`, password: password ?? "", state: null });
  const attempt = (left) => {
    if (g !== gen) return;
    const s = net.connect(port, h);
    let opened = false;
    s.setEncoding("utf8");
    s.setNoDelay(true);
    s.on("connect", () => {
      opened = true;
      sock = s;
      s.write(box.seal(JSON.stringify({ t: "hello", name: NAME, key: crypto.randomUUID() })) + "\n");
      if (first) s.write(box.seal(JSON.stringify(first)) + "\n");
      if (controls.size) s.write(box.seal(JSON.stringify({ t: "ai", on: true })) + "\n");
      save({ status: "online" });
    });
    let buf = "", why = "";
    s.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || g !== gen) continue;
        const text = box.open(line);
        try {
          const m = JSON.parse(text ?? line);
          if (m.t === "state") save({ state: m, host: m.host });
          else if (m.t === "error" && m.plain) why = m.msg;
          else if (m.t === "error") save({ toast: { msg: m.msg, at: Date.now() } });
        } catch {}
      }
    });
    s.on("error", (e) => { why ||= e?.code === "ECONNREFUSED" ? "" : String(e?.message ?? e); });
    s.on("close", () => {
      if (g !== gen) return;
      if (!opened && left > 1) return setTimeout(() => attempt(left - 1), 300);
      sock = null;
      if (!opened) return save({ status: "error", error: `连不上 ${h}:${port}，请确认地址和防火墙${why ? `（${why}）` : ""}` });
      const wrong = why === "房间密码不对";
      save({ status: wrong ? "error" : "lost", error: wrong ? "房间密码不对" : `和房间的连接断开了${why ? `（${why}）` : ""}` });
    });
  };
  attempt(tries);
}

async function command(m) {
  switch (m.t) {
    case "_join": return join(m.addr, m.password, m.first ?? null, m.tries ?? 1);
    case "_leave":
      try { if (sock && box) sock.write(box.seal(JSON.stringify({ t: "bye" })) + "\n"); } catch {}
      close();
      return save({ status: "idle", state: null, error: null, host: false });
    case "_scan": {
      save({ scanning: true });
      const rooms = await discover();
      return save({ scanning: false, rooms, scannedAt: Date.now() });
    }
    default:
      if (sock && box) sock.write(box.seal(JSON.stringify(m)) + "\n");
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  // From the window: a person typed it.
  try { const m = JSON.parse(line.trim()); command(m.t === "chat" ? { ...m, ai: false } : m); } catch {}
});

// ---- the AI's way in (mcp.mjs), this machine only

const TOKEN = crypto.randomUUID();

function aiChanged() {
  const on = controls.size > 0;
  if (sock && box) sock.write(box.seal(JSON.stringify({ t: "ai", on })) + "\n");
  save({ ai: on });
}

const control = net.createServer((c) => {
  c.setEncoding("utf8");
  let buf = "", authed = false;
  c.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (!authed) {
        if (m.t !== "_auth" || m.token !== TOKEN) return c.destroy();
        authed = true;
        controls.add(c);
        c.write(JSON.stringify({ t: "view", view }) + "\n");
        aiChanged();
        continue;
      }
      // From mcp.mjs: the AI typed it.
      command(m.t === "chat" ? { ...m, ai: true } : m);
    }
  });
  const gone = () => { if (controls.delete(c)) aiChanged(); };
  c.on("close", gone);
  c.on("error", gone);
});
control.listen(0, "127.0.0.1", () => save({ control: { port: control.address().port, token: TOKEN } }));

save({ status: "idle", state: null, ai: false });
console.log(`飞行棋客户端已就绪（${NAME}），状态写在 ${FILE}`);
