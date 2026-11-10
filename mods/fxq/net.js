// The link to a 飞行棋 table. The mod never opens a socket itself (a stuck
// connect in the mod runtime takes every mod down): client.mjs runs as the
// herdr-core terminal fxq-client and holds the TCP connection, the AES and the
// LAN discovery. Commands go into it with `hc send`; it writes everything the
// window shows to data/fxq/state.json:
//   { status, addr, password, error, toast, state, rooms, scanning, seq }
// Each copy of this mod (the game window, the status-bar button) follows that
// file on its own, so closing or hiding the window keeps your seat.
// Hosting also runs the server, server.mjs, as the terminal fxq-server.
// Both need node.

import * as fs from "fs/promises";
import { randomBytes } from "crypto";
import { shared, setShared, hc, appHome, home, readTextFile, watchFolder } from "herdr";

export const PORT = 17787;
/** True while this machine runs the room's server. */
const HOSTING = "fxq.hosting";

const playerName = () => (home() ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "玩家";
const newPassword = () => { const b = randomBytes(3); return String(100000 + ((b[0] << 16) | (b[1] << 8) | b[2]) % 900000); };
const dir = () => `${appHome()}/data/fxq`;
export const script = (name) => `${appHome()}/mods/fxq/${name}`;

function wait(cx, ms) {
  return new Promise((resolve) => cx.timer.after(ms, () => resolve()));
}

async function alive(name) {
  try {
    const r = await hc(["get", name, "--json"]);
    return r.code === 0 && JSON.parse(r.stdout)?.state === "live";
  } catch {
    return false;
  }
}

export class Link {
  constructor() {
    this.v = { status: "idle", seq: -1 };
    this.queue = [];
    this.busy = false;
  }

  /** What to show: client.mjs's last state, and whether this machine hosts. */
  view() {
    return { ...this.v, host: Boolean(shared(HOSTING)) };
  }

  /** Follows the state file; `ready(cx)` runs once the first look is in, `changed(cx)` on every new one (before the redraw). */
  start(cx, ready, changed) {
    cx.spawn(async (cx) => {
      try { await fs.mkdir(dir(), { recursive: true }); } catch {}
      // No client running (Herdr or the computer restarted): nothing is connected,
      // whatever the file still says.
      if (await alive("fxq-client")) await this.load();
      else if (shared(HOSTING) && !(await alive("fxq-server"))) setShared(HOSTING, false);
      changed?.(cx);
      ready?.(cx);
      cx.notify();
      for (;;) {
        try { await watchFolder(dir()); } catch { return; }
        if (await this.load()) { changed?.(cx); cx.notify(); }
      }
    });
  }

  async load() {
    try {
      const text = await readTextFile(`${dir()}/state.json`);
      if (!text) return false;
      const v = JSON.parse(text);
      if (v.seq === this.v.seq) return false;
      this.v = v;
      return true;
    } catch {
      return false;
    }
  }

  /** Queues a message for the table (or "_host" / "_join" / "_leave" / "_scan"); sent in order. */
  send(cx, m) {
    this.queue.push(m);
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      while (this.queue.length) {
        try { await this.handle(cx, this.queue.shift()); } catch {}
        cx.notify();
      }
      this.busy = false;
    });
  }

  /** Leaves the room and stops the client (and the server, when hosting). Await it before closing. */
  async leave(cx) {
    if (await alive("fxq-client")) {
      try { await hc(["send", "fxq-client", JSON.stringify({ t: "_leave" })]); } catch {}
      await wait(cx, 300);
      try { await hc(["kill", "fxq-client"]); } catch {}
    }
    if (shared(HOSTING)) {
      setShared(HOSTING, false);
      try { await hc(["kill", "fxq-server"]); } catch {}
    }
    this.v = { ...this.v, status: "idle", state: null, error: null };
  }

  fail(error) {
    this.v = { ...this.v, status: "error", error };
  }

  async client(cx) {
    if (await alive("fxq-client")) return true;
    const r = await hc(["run", "--bg", "--no-parent", "--name", "fxq-client", "--", "node", script("client.mjs"), `${dir()}/state.json`, playerName()]);
    if (r.code !== 0) {
      this.fail(`飞行棋客户端没有启动（需要安装 node）：${(r.stderr || r.stdout || "").trim()}`);
      return false;
    }
    await wait(cx, 700);
    return true;
  }

  async post(cx, m) {
    if (!(await this.client(cx))) return;
    await hc(["send", "fxq-client", JSON.stringify(m)]);
  }

  async handle(cx, m) {
    if (m.t === "_host") {
      const password = String(m.password ?? "").trim() || newPassword();
      setShared(HOSTING, true);
      this.v = { ...this.v, status: "connecting", error: null, state: null, password };
      try { await hc(["kill", "fxq-server"]); } catch {}
      const r = await hc(["run", "--bg", "--no-parent", "--rm", "--name", "fxq-server", "--", "node", script("server.mjs"), String(PORT), password]);
      if (r.code !== 0) {
        setShared(HOSTING, false);
        return this.fail(`房间没有开起来（需要安装 node）：${(r.stderr || r.stdout || "").trim()}`);
      }
      return this.post(cx, { t: "_join", addr: `127.0.0.1:${PORT}`, password, tries: 20, first: { t: "config", takeoff: m.takeoff, mode: m.mode ?? "solo" } });
    }
    if (m.t === "_leave") return this.leave(cx);
    if (m.t === "_join") setShared(HOSTING, false);
    return this.post(cx, m);
  }
}
