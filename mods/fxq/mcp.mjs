#!/usr/bin/env node
// 飞行棋 for an AI, as an MCP server (stdio): the AI plays *your* seat, the
// one in your Herdr window, and you watch it there. It talks to your game
// window's client (client.mjs, the terminal fxq-client) over its local
// control port, found in the client's state file. Add it to an agent, e.g.
// Claude Code:
//
//   claude mcp add fxq -- node <this file>
//
// Options: --state <file> (default <Herdr home>/data/fxq/state.json, the
// Herdr home being $HERDR_APP_HOME or ~/.config/herdr-app). If the client
// isn't running it is started (needs hc). No dependencies.

import net from "node:net";
import os from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { COLORS, HOME, LAST, FLY_FROM, FLY_TO, TAKEOFF, TEAM_NAMES, where, ring, danger, botChoose, homeCount } from "./rules.js";

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const APP_HOME = process.env.HERDR_APP_HOME || join(os.homedir(), ".config", "herdr-app");
const STATE = arg("state", join(APP_HOME, "data", "fxq", "state.json"));
const HERE = dirname(fileURLToPath(import.meta.url));

let link = null, view = null, linking = null;
const listeners = new Set();
const changed = () => { for (const f of [...listeners]) f(); };

function until(test, ms) {
  return new Promise((resolve) => {
    if (test()) return resolve(true);
    const done = (v) => { listeners.delete(check); clearTimeout(t); resolve(v); };
    const check = () => { if (test()) done(true); };
    const t = setTimeout(() => done(false), ms);
    listeners.add(check);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return null; } };

/** Your game window's client: started if it isn't running, then its control port. */
async function connect() {
  if (link) return;
  if (linking) return linking;
  linking = (async () => {
    let st = readState();
    for (let k = 0; k < 2 && !link; k++) {
      if (st?.control) {
        try {
          await new Promise((resolve, reject) => {
            const c = net.connect(st.control.port, "127.0.0.1", () => resolve());
            c.once("error", reject);
            c.setEncoding("utf8");
            let buf = "";
            c.on("data", (chunk) => {
              buf += chunk;
              let nl;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                try { const m = JSON.parse(line); if (m.t === "view") { view = m.view; changed(); } } catch {}
              }
            });
            c.on("close", () => { if (link === c) link = null; changed(); });
            c.write(JSON.stringify({ t: "_auth", token: st.control.token }) + "\n");
            link = c;
          });
          await until(() => view, 3000);
          break;
        } catch { link = null; }
      }
      if (k === 0) {
        // Not running (or gone): start it as the game window would.
        const name = os.userInfo().username;
        spawnSync("hc", ["run", "--bg", "--no-parent", "--name", "fxq-client", "--", "node", join(HERE, "client.mjs"), STATE, name], { stdio: "ignore", shell: process.platform === "win32" });
        for (let w = 0; w < 30 && !(readState()?.control); w++) await sleep(200);
        st = readState();
      }
    }
    if (!link) throw new Error("连不上你的飞行棋客户端：先在 Herdr 里打开飞行棋窗口");
  })().finally(() => { linking = null; });
  return linking;
}

function send(m) {
  link.write(JSON.stringify(m) + "\n");
}

// ---- what the agent reads

const PHASES = { lobby: "等待开始", roll: "掷骰子", move: "走棋", over: "本局结束" };

/** One option in words: where the plane goes and what happens on the way. */
function describe(s, o) {
  const parts = [o.takeoff ? "起飞到起点" : o.to === HOME ? "到达终点" : `走到${where(o.stops[0])}`];
  if (o.jump) parts.push("踩本色格跳 4 格");
  if (o.fly) parts.push(`从飞行格飞到第 ${FLY_TO} 步`);
  if (o.bounce) parts.push(`倒退到${where(o.to)}`);
  if ((o.jump || o.fly) && !o.bounce && o.to !== HOME) parts.push(`最后停在${where(o.to)}`);
  for (const h of o.captures) parts.push(`撞回${COLORS[h.seat]}方 ${h.plane + 1} 号机（它在${where(h.from)}）`);
  return `${o.plane + 1} 号机（在${where(o.from)}）：${parts.join("，")}`;
}

function summary() {
  const v = view ?? {};
  const s = v.state;
  const base = { connection: v.status ?? "idle", room: v.addr ?? null, error: v.error ?? undefined };
  if (v.status !== "online" || !s) return { ...base, hint: "还没进房间：用 fxq_rooms 找房间，fxq_join 加入（需要房间密码），或者让主人在 Herdr 里开房/加入。" };
  const me = s.you;
  const yourTurn = s.turn === me && (s.phase === "roll" || s.phase === "move");
  const takeoff = TAKEOFF[s.config?.takeoff] ?? TAKEOFF[6];
  const teams = s.teams ?? null;
  const mate = teams ? s.seats.findIndex((p, i) => p && i !== me && teams[i] === teams[me]) : -1;
  const out = {
    ...base,
    phase: PHASES[s.phase] ?? s.phase,
    you: me,
    your_color: `${COLORS[me]}方`,
    you_are_host: s.host,
    mode: teams ? "2v2 组队" : "个人赛",
    your_team: teams ? TEAM_NAMES[teams[me]] : undefined,
    teammate: mate >= 0 ? `${COLORS[mate]}方 ${s.seats[mate].name}${s.seats[mate].bot ? "（电脑）" : s.seats[mate].ai ? "（AI）" : ""}` : undefined,
    your_turn: yourTurn,
    seconds_left: yourTurn && s.deadline != null ? Math.round(s.deadline / 1000) : null,
    takeoff_rolls: takeoff.join("、"),
    last_roll: s.dice != null && s.rolledBy >= 0 ? `${COLORS[s.rolledBy]}方掷出 ${s.dice}` : null,
    players: s.seats.map((p, i) => p && {
      seat: i, color: `${COLORS[i]}方`, name: p.name, bot: p.bot, ai: p.ai, wins: p.wins, playing: s.players.includes(i),
      team: teams ? TEAM_NAMES[teams[i]] : undefined, all_home: s.done?.includes(i) || undefined,
      planes: s.planes[i]?.map((q, j) => ({ plane: j + 1, where: where(q), progress: q, square: q >= 1 && q <= LAST ? ring(i, q) : null })),
      home: s.planes[i] ? homeCount(s.planes[i]) : 0,
    }),
    message: s.msg,
    recent: s.log.slice(-6),
    chat: chatLines(s).slice(-10),
    rules: `每架飞机从起点走 ${HOME} 步到终点（第 ${LAST} 步之后进入只有本色能走的终点跑道，安全）。停在本色格跳到下一个本色格（+4）；第 ${FLY_FROM} 步是本色飞行格，停在那里沿虚线飞到第 ${FLY_TO} 步。停在对手所在的格子把它撞回机场。进终点要正好，多的倒退。掷出 6 走完再掷一次，连续三个 6 本回合作废。${teams ? "2v2：对面坐的是队友，队友之间不会互撞；先到齐的人之后不再掷骰；本队 8 架飞机全部到达就赢。可以用 fxq_chat 跟队友商量（to: team 只有队友能看到）。" : ""}`,
  };
  if (s.phase === "move" && yourTurn && s.options) {
    out.dice = s.dice;
    out.options = s.options.map((o) => ({
      plane: o.plane + 1,
      text: describe(s, o),
      danger_after: o.to <= LAST ? danger(s.planes.map((ps, c) => ps && ps.map((q, j) => (c === me && j === o.plane ? o.to : o.captures.some((h) => h.seat === c && h.plane === j) ? -1 : q))), me, o.to, teams) : 0,
    }));
    const pick = botChoose(s.planes, me, s.dice, takeoff, teams);
    if (pick !== null) out.suggestion = `电脑会选 ${pick + 1} 号机`;
    out.advice = "fxq_move 选一架飞机（plane 是 1～4）。优先撞回对手、起飞、进终点跑道；danger_after 是走完后身后 6 格内的对手飞机数，越小越安全。";
  }
  if (s.phase === "roll" && yourTurn) out.advice = "轮到你掷骰子：调用 fxq_roll。";
  if (s.result) {
    const won = s.result.winners ?? [s.result.winner];
    out.result = {
      winner: s.result.team != null ? `${TEAM_NAMES[s.result.team]}（${won.map((w) => `${COLORS[w]}方 ${s.seats[w]?.name}`).join("、")}）` : `${COLORS[s.result.winner]}方 ${s.seats[s.result.winner]?.name}`,
      you_won: won.includes(me), your_place: s.result.ranks.indexOf(me) + 1,
    };
  }
  if (v.toast && Date.now() - v.toast.at < 10000) out.last_error = v.toast.msg;
  return out;
}

/** The chat you can see, in words. */
function chatLines(s) {
  return (s.chat ?? []).map((c) => ({
    id: c.id, from: `${COLORS[c.seat]}方 ${c.name}${c.seat === s.you ? (c.ai ? "（你）" : "（主人，在 Herdr 窗口里打的）") : ""}`, by_ai: c.ai || undefined,
    to: c.to === "team" ? "队内" : "全场", text: c.text,
  }));
}
const lastChatId = () => Math.max(0, ...(view?.state?.chat ?? []).map((c) => c.id));

const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 1) }] });

/** Sends an action and waits for the table to answer (the next state, or an error). */
async function act(m) {
  await connect();
  const sentAt = Date.now();
  const before = view?.state?.moves ?? -1, phase = view?.state?.phase;
  send(m);
  const ok = await until(() => (view?.toast?.at ?? 0) >= sentAt || (view?.state && (view.state.moves !== before || view.state.phase !== phase)), 4000);
  const err = (view?.toast?.at ?? 0) >= sentAt ? view.toast.msg : null;
  if (err) return text({ ok: false, error: err, state: summary() });
  return text({ ok, state: summary() });
}

// ---- the tools

const TOOLS = [
  { name: "fxq_state", description: "看棋盘（你在 Herdr 里的那个座位）：每方飞机在哪、上一次掷骰、该谁、轮到你走棋时每架飞机的走法和建议。", inputSchema: { type: "object", properties: {} } },
  {
    name: "fxq_wait", description: "等到轮到你（掷骰子或选飞机）、本局结束，或者有人发来新的聊天，再返回棋盘（woke 说明是哪一种，new_chat 是新消息）。每次行动前先调用它。",
    inputSchema: { type: "object", properties: {
      timeout_seconds: { type: "number", description: "最多等多久，默认 60" },
      wake_on_chat: { type: "boolean", description: "别人发聊天时也返回，默认 true" },
    } },
  },
  {
    name: "fxq_chat", description: "在牌桌上说话：to=all 全场都能看到，to=team 只有队友能看到（2v2）。跟队友商量谁冲谁守、提醒危险，或者跟大家打个招呼。一次一两句，别刷屏。",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "说的话（200 字以内）" }, to: { type: "string", enum: ["all", "team"], description: "默认 all" } }, required: ["text"] },
  },
  { name: "fxq_roll", description: "掷骰子（轮到你掷的时候）。返回掷出的点数和能走的飞机。", inputSchema: { type: "object", properties: {} } },
  {
    name: "fxq_move", description: "走棋：选一架飞机（1～4，见 fxq_state 的 options）。只有一架能走时服务器会自动走。",
    inputSchema: { type: "object", properties: { plane: { type: "integer", minimum: 1, maximum: 4 } }, required: ["plane"] },
  },
  { name: "fxq_rooms", description: "搜索局域网里的飞行棋房间（地址、房主、人数、阶段）。", inputSchema: { type: "object", properties: {} } },
  {
    name: "fxq_join", description: "带着你的座位加入一个房间（Herdr 里的游戏窗口会跟着进去）。",
    inputSchema: { type: "object", properties: { host: { type: "string", description: "房主地址，如 192.168.1.5 或 192.168.1.5:17787" }, password: { type: "string" } }, required: ["host", "password"] },
  },
  { name: "fxq_add_bot", description: "加一个电脑玩家（房主，开局前）。", inputSchema: { type: "object", properties: {} } },
  { name: "fxq_start", description: "开始游戏（房主，至少 2 人）。", inputSchema: { type: "object", properties: {} } },
  { name: "fxq_again", description: "本局结束后再来一局。", inputSchema: { type: "object", properties: {} } },
  { name: "fxq_auto", description: "托管：on=true 让电脑替你下，false 取消。", inputSchema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } },
];

async function call(name, a = {}) {
  await connect();
  switch (name) {
    case "fxq_state": return text(summary());
    case "fxq_wait": {
      const secs = Math.min(Math.max(Number(a.timeout_seconds) || 60, 1), 600);
      const since = lastChatId();
      const turn = () => {
        const s = view?.state;
        return s && (s.phase === "over" || (s.turn === s.you && (s.phase === "roll" || (s.phase === "move" && s.options)) && !s.seats[s.you]?.auto));
      };
      // Anyone but you: other seats, and your owner typing in the window.
      const heard = () => a.wake_on_chat !== false && (view?.state?.chat ?? []).some((c) => c.id > since && !(c.seat === view.state.you && c.ai));
      const ok = await until(() => !link || turn() || heard(), secs * 1000);
      const s = view?.state;
      const fresh = s ? chatLines(s).filter((c) => c.id > since) : [];
      return text({ ready: ok, woke: !ok ? "timeout" : s?.phase === "over" ? "over" : turn() ? "your_turn" : "chat", new_chat: fresh.length ? fresh : undefined, state: summary() });
    }
    case "fxq_roll": return act({ t: "roll" });
    case "fxq_move": return act({ t: "move", plane: Number(a.plane) - 1 });
    case "fxq_start": return act({ t: "start" });
    case "fxq_again": return act({ t: "again" });
    case "fxq_auto": return act({ t: "auto", on: Boolean(a.on) });
    case "fxq_chat": {
      const since = lastChatId(), sentAt = Date.now();
      send({ t: "chat", text: String(a.text ?? ""), to: a.to === "team" ? "team" : "all" });
      await until(() => (view?.toast?.at ?? 0) >= sentAt || lastChatId() > since, 3000);
      if ((view?.toast?.at ?? 0) >= sentAt) return text({ ok: false, error: view.toast.msg });
      return text({ ok: true, chat: chatLines(view.state).slice(-6) });
    }
    case "fxq_add_bot": {
      const n = view?.state?.seats?.filter(Boolean).length ?? 0;
      const sentAt = Date.now();
      send({ t: "bot" });
      await until(() => (view?.toast?.at ?? 0) >= sentAt || (view?.state?.seats?.filter(Boolean).length ?? 0) !== n, 3000);
      return text((view?.toast?.at ?? 0) >= sentAt ? { ok: false, error: view.toast.msg } : { ok: true, state: summary() });
    }
    case "fxq_rooms": {
      const at = view?.scannedAt ?? 0;
      send({ t: "_scan" });
      await until(() => (view?.scannedAt ?? 0) > at, 5000);
      return text(view?.rooms ?? []);
    }
    case "fxq_join": {
      send({ t: "_join", addr: String(a.host), password: String(a.password ?? "") });
      await until(() => view?.status === "error" || (view?.status === "online" && view?.state), 6000);
      return text(summary());
    }
    default: throw new Error(`没有这个工具：${name}`);
  }
}

// ---- MCP over stdio (JSON-RPC 2.0, one message per line)

const reply = (id, result, error) => process.stdout.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) + "\n");

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notifications
  try {
    switch (m.method) {
      case "initialize":
        return reply(m.id, {
          protocolVersion: m.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "herdr-fxq", version: "1.0.0" },
          instructions: "你在替主人下局域网飞行棋，座位就是主人 Herdr 窗口里的那个，主人会看着你下。流程：fxq_state 看看在不在房间 → 循环 fxq_wait；轮到你掷骰子就 fxq_roll，轮到你走棋就看 options 用 fxq_move 选飞机（优先撞回对手、起飞、安全进终点跑道）→ 本局结束后 fxq_again。牌桌上能聊天：fxq_wait 因为新消息醒来时（woke=chat），看看 new_chat，需要的话用 fxq_chat 回一句；2v2 时用 to=team 跟队友商量。说话简短，像真人打牌一样。",
        });
      case "ping": return reply(m.id, {});
      case "tools/list": return reply(m.id, { tools: TOOLS });
      case "tools/call":
        try { return reply(m.id, await call(m.params?.name, m.params?.arguments ?? {})); }
        catch (e) { return reply(m.id, { ...text(`出错了：${e?.message ?? e}`), isError: true }); }
      default: return reply(m.id, null, { code: -32601, message: `unknown method ${m.method}` });
    }
  } catch (e) {
    reply(m.id, null, { code: -32603, message: String(e?.message ?? e) });
  }
});

if (!existsSync(STATE)) console.error(`飞行棋状态文件还不存在：${STATE}（在 Herdr 里打开飞行棋后就有了）`);
