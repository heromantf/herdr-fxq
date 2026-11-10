// The 飞行棋 table server for a LAN game. No dependencies:
//   node server.mjs [port] [password]
// Clients speak newline-delimited JSON over TCP, every line sealed with the
// room password (aes.js):
//   → { t: "hello", name, key, ai? } { t: "ctl", key } { t: "config", takeoff?, mode? }
//     { t: "bot" } { t: "kick", seat } { t: "seat", to } { t: "swap", a, b } { t: "start" }
//     { t: "roll" } { t: "move", plane } { t: "chat", text, to, ai? }
//     { t: "auto", on } { t: "ai", on } { t: "again" } { t: "bye" }
//   ← { t: "state", ... } (each seat its own view), { t: "error", msg }, { t: "ping" }
// Four seats, one color each (红 黄 绿 蓝); two to four players, computer
// players fill in. Or 2v2 (mode "team"): 红 and 绿 against 黄 and 蓝, four
// players; teammates never send each other home, a player whose planes are
// all home sits out, and the first team with all eight home wins. Before a
// game, players can move to an empty seat and the host can swap seats 2–4 (to
// pick partners). Chat goes to everyone, or (2v2) to your team only; a line an
// AI typed for its seat is marked ai. The server holds the dice and the rules
// (rules.js); seat 0 is the host and picks the takeoff roll and the mode. A person has TURN_MS to roll or to
// pick a plane (an AI player, through mcp.mjs, AI_TURN_MS): when it runs out
// the computer does it, and after two in a row it takes over (托管) until they
// take it back. With only one plane able to move, it moves by itself. A seat
// whose player drops out mid-game is played by the computer until they return
// under the same name. LAN discovery answers on UDP DISCOVERY_PORT.

import net from "node:net";
import dgram from "node:dgram";
import os from "node:os";
import crypto from "node:crypto";
import { cipher } from "./aes.js";
import { COLORS, HOME, LAST, TAKEOFF, TEAM_OF, TEAM_NAMES, options, apply, botChoose, ranking, homeCount, teamDone, where, walkMs, ROLL_MS } from "./rules.js";

const PORT = Number(process.argv[2]) || 17787;
const PASSWORD = process.argv[3] ?? "";
const DISCOVERY_PORT = 17788;
const TURN_MS = 20000;
const AI_TURN_MS = 120000;
/** --fast (tests): the computer doesn't pause to let people see its rolls and moves. */
const FAST = process.argv.includes("--fast");
const BOT_NAMES = ["电脑·阿飞", "电脑·小鹰", "电脑·云雀", "电脑·大雁"];
const box = cipher(PASSWORD, crypto);

/** @type {({ name: string, bot: boolean, ai?: boolean, sock: any, key?: string, auto: boolean, timeouts: number, wins: number } | null)[]} */
const seats = [null, null, null, null];
const config = { takeoff: 6, mode: "solo" };
let game = null;
let msg = "等待玩家加入";
let timer = null;
let scheduled = null;
/** The chat: { id, seat, name, ai, to: "all" | "team", team, text, at }, the last CHAT_KEEP. */
const chat = [];
const CHAT_KEEP = 60;
let chatId = 0;
const spoke = new Map();

const ips = () => Object.values(os.networkInterfaces()).flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);

const nameOf = (i) => seats[i]?.name ?? `座位${i + 1}`;
const who = (i) => `${COLORS[i]}方 ${nameOf(i)}`;
const human = (i) => seats[i] && !seats[i].bot && seats[i].sock && !seats[i].auto;
const takeoff = () => TAKEOFF[config.takeoff] ?? TAKEOFF[6];
/** Each seat's team in 2v2 (the game's once it started), else null. */
const teamsNow = () => game?.teams ?? (config.mode === "team" ? [0, 1, 2, 3].map(TEAM_OF) : null);

function view(i) {
  const g = game;
  const mine = g && g.phase === "move" && g.turn === i;
  const teams = teamsNow();
  return {
    t: "state", you: i, host: i === 0, port: PORT, ips: ips(), msg, config, teams,
    seats: seats.map((s) => s && { name: s.name, bot: s.bot, ai: Boolean(s.ai), online: s.bot || Boolean(s.sock), auto: s.auto, wins: s.wins }),
    done: g?.done ?? [],
    chat: chat.filter((c) => c.to === "all" || (teams && c.team === teams[i])).slice(-40),
    phase: g?.phase ?? "lobby",
    players: g?.players ?? [],
    moves: g?.moves ?? 0,
    turn: g?.turn ?? -1,
    dice: g?.dice ?? null,
    rolledBy: g?.rolledBy ?? -1,
    rollN: g?.rollN ?? null,
    sixes: g?.sixes ?? 0,
    planes: g?.planes ?? [null, null, null, null],
    options: mine ? g.opts : null,
    last: g?.last ?? null,
    log: g?.log.slice(-12) ?? [],
    deadline: g && g.deadline && g.turn >= 0 ? Math.max(0, g.deadline - Date.now()) : null,
    result: g?.result ?? null,
  };
}

function send(sock, m) {
  try { sock.write(box.seal(JSON.stringify(m)) + "\n"); } catch {}
}

function broadcast() {
  schedule();
  seats.forEach((s, i) => { if (s?.sock) send(s.sock, view(i)); });
}

function note(text) {
  msg = text;
  game.log.push(text);
  if (game.log.length > 40) game.log.splice(0, game.log.length - 40);
}

// ---- the game

function begin() {
  const players = seats.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  const first = players[crypto.randomInt(players.length)];
  const teams = config.mode === "team" ? [0, 1, 2, 3].map(TEAM_OF) : null;
  game = {
    phase: "roll", players, teams, done: [], turn: first, moves: 0, deadline: null,
    planes: seats.map((s) => (s ? [-1, -1, -1, -1] : null)),
    dice: null, rolledBy: -1, sixes: 0, opts: null, last: null, log: [], result: null,
  };
  note(`${teams ? "2v2：红绿队对黄蓝队，" : ""}${who(first)} 先掷骰子（${config.takeoff === 56 ? "5、6" : "6"} 点起飞）`);
}

/** The next player round the table who still has planes to bring home. */
function nextTurn() {
  const g = game;
  let at = g.players.indexOf(g.turn);
  for (let k = 0; k < g.players.length; k++) {
    at = (at + 1) % g.players.length;
    if (!g.done.includes(g.players[at])) break;
  }
  g.turn = g.players[at];
  g.phase = "roll";
  g.sixes = 0;
  g.opts = null;
}

function roll(i) {
  const g = game;
  if (g?.phase !== "roll" || g.turn !== i) return "还没轮到你掷骰子";
  const d = crypto.randomInt(1, 7);
  g.moves++;
  g.dice = d;
  g.rolledBy = i;
  // Each roll has its number (windows tumble the die for it); the computer waits for the die to land.
  g.rollN = g.moves;
  g.shownAt = Date.now() + ROLL_MS;
  g.sixes = d === 6 ? g.sixes + 1 : 0;
  if (g.sixes === 3) {
    note(`${who(i)} 连续掷出三个 6，本回合作废`);
    nextTurn();
    return null;
  }
  const opts = options(g.planes, i, d, takeoff(), g.teams);
  if (!opts.length) {
    if (d === 6) { note(`${who(i)} 掷出 6，没有能走的飞机，再掷一次`); return null; }
    note(`${who(i)} 掷出 ${d}，没有能走的飞机`);
    nextTurn();
    return null;
  }
  g.phase = "move";
  g.opts = opts;
  msg = `${who(i)} 掷出 ${d}${d === 6 ? "，走完还能再掷" : ""}，选一架飞机`;
  return null;
}

function move(i, plane) {
  const g = game;
  if (g?.phase !== "move" || g.turn !== i) return "还没轮到你走棋";
  const mv = g.opts.find((o) => o.plane === Number(plane));
  if (!mv) return "这架飞机这次走不了";
  g.moves++;
  g.planes = apply(g.planes, i, mv);
  g.last = { n: g.moves, seat: i, plane: mv.plane, from: mv.from, to: mv.to, stops: mv.stops, captures: mv.captures, takeoff: mv.takeoff, jump: mv.jump, fly: mv.fly, bounce: mv.bounce };
  // The windows show the move square by square: the computer waits for it before its next step.
  g.shownAt = Date.now() + walkMs(mv);
  const parts = [];
  if (mv.takeoff) parts.push("起飞");
  else if (mv.to === HOME) parts.push("到达终点");
  else {
    parts.push(`走到${where(mv.stops[0])}`);
    if (mv.jump) parts.push("踩到本色格，跳 4 格");
    if (mv.fly) parts.push("从飞行格沿虚线飞越对面的终点跑道");
    if (mv.bounce) parts.push("点数多了，倒退回来");
  }
  for (const s of new Set(mv.captures.map((h) => h.seat))) {
    const n = mv.captures.filter((h) => h.seat === s).length;
    parts.push(`撞回 ${who(s)} ${n} 架飞机`);
  }
  note(`${who(i)} 的 ${mv.plane + 1} 号机${parts.join("，")}`);
  if (homeCount(g.planes[i]) === 4) {
    if (!g.teams || teamDone(g.planes, g.teams, g.teams[i])) return finish(i);
    // 2v2: done, the teammate isn't: sit out from now on.
    g.done.push(i);
    note(`${who(i)} 四架飞机全部到达，等队友到齐`);
    nextTurn();
    return null;
  }
  if (g.dice === 6) { g.phase = "roll"; g.opts = null; msg += "，再掷一次"; }
  else nextTurn();
  return null;
}

function finish(winner) {
  const g = game;
  g.phase = "over";
  g.turn = -1;
  g.deadline = null;
  g.opts = null;
  const team = g.teams ? g.teams[winner] : null;
  const winners = g.teams ? g.players.filter((p) => g.teams[p] === team) : [winner];
  for (const p of winners) seats[p].wins++;
  const ranks = ranking(g.planes, g.players, winner, g.teams);
  g.result = { winner, team, winners, ranks, home: g.planes.map((ps) => (ps ? homeCount(ps) : 0)) };
  note(g.teams ? `${TEAM_NAMES[team]}（${winners.map(who).join("、")}）八架飞机全部到达，获胜！` : `${who(winner)} 四架飞机全部到达，获胜！`);
  return null;
}

// ---- turns the computer takes: computer seats, 托管, dropped players, a person's turn that ran out,
// and a person's move when only one plane can go

function autoMove(i) {
  const g = game;
  try {
    if (g.phase === "roll") return roll(i);
    if (g.phase === "move") return move(i, botChoose(g.planes, i, g.dice, takeoff(), g.teams));
  } catch (e) {
    // Never leave a table stuck on a turn.
    console.error(`代打出错（座位 ${i}）：${e?.stack ?? e}`);
    if (g.phase === "move" && g.opts?.length) move(i, g.opts[0].plane);
  }
}

/** One choice to make: every movable plane does the same thing. */
const forced = (g) => g.phase === "move" && new Set(g.opts.map((o) => o.from)).size === 1;

/** One timer for whoever's turn it is, set again only when the turn changes. */
function schedule() {
  const g = game;
  const i = g?.turn ?? -1;
  const mode = !g || g.phase === "over" || i < 0 ? null : human(i) ? (forced(g) && !seats[i].ai ? "f" : "p") : "c";
  const key = mode && `${g.moves}:${i}:${g.phase}:${mode}`;
  if (key === scheduled) return;
  scheduled = key;
  clearTimeout(timer);
  timer = null;
  if (!key) return;
  if (mode === "p") {
    const ms = seats[i].ai ? AI_TURN_MS : TURN_MS;
    g.deadline = Date.now() + ms;
    timer = setTimeout(() => {
      timer = null;
      if (game !== g || g.turn !== i || !human(i)) return;
      const s = seats[i];
      s.timeouts++;
      autoMove(i);
      if (s.timeouts >= 2) { s.auto = true; msg = `${s.name} 超时两次，已托管`; }
      broadcast();
    }, ms);
  } else {
    g.deadline = null;
    timer = setTimeout(() => {
      timer = null;
      if (game !== g || g.turn !== i) return;
      autoMove(i);
      broadcast();
    }, FAST ? 0 : Math.max(0, (g.shownAt ?? 0) - Date.now()) + (mode === "f" ? 650 : g.phase === "roll" ? 550 + Math.random() * 300 : 450 + Math.random() * 200));
  }
}

// ---- connections
//
// A player keeps two sockets: the feed, where they said hello and the server
// talks (states, errors, a ping every 3 s), and a control socket that only
// sends ({ t: "ctl", key } first). One socket can do both (node clients).

function join(sock, m) {
  let name = String(m.name || "玩家").slice(0, 16);
  // Back under the same name: the seat the computer has been keeping.
  let i = seats.findIndex((s) => s && !s.bot && !s.sock && s.name === name);
  if (i < 0) {
    if (seats.some((s) => s && s.name === name)) name = `${name}${crypto.randomInt(10, 100)}`;
    const open = !game || game.phase === "over";
    i = open ? seats.findIndex((s) => !s) : -1;
    if (i < 0 && open) i = seats.findIndex((s) => s?.bot);
    if (i < 0) {
      send(sock, { t: "error", msg: open ? "房间已满" : "对局进行中，请稍后再来" });
      return sock.end();
    }
    seats[i] = { name, bot: false, sock: null, auto: false, timeouts: 0, wins: 0 };
  }
  Object.assign(seats[i], { sock, key: String(m.key ?? ""), ai: Boolean(m.ai) });
  sock.seat = i;
  msg = `${name}${m.ai ? "（AI）" : ""} 进入了房间，执${COLORS[i]}色`;
  broadcast();
}

/** The seat a socket speaks for (seats move before a game): its feed, or a control socket holding the seat's key. */
function seatOf(sock) {
  if (sock.ctl) return sock.key ? seats.findIndex((s) => s && s.key === sock.key) : -1;
  return seats.findIndex((s) => s && s.sock === sock);
}

/** Who sits where changed: move two seats' contents (either may be empty). */
function swapSeats(a, b) {
  [seats[a], seats[b]] = [seats[b], seats[a]];
  game = null;
}

function say(i, m) {
  const text = String(m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!text) return "说点什么吧";
  const now = Date.now(), recent = (spoke.get(i) ?? []).filter((t) => now - t < 5000);
  if (recent.length >= 6) return "说得太快了，歇一下";
  spoke.set(i, [...recent, now]);
  const teams = teamsNow();
  const to = m.to === "team" && teams ? "team" : "all";
  chat.push({ id: ++chatId, seat: i, name: seats[i].name, ai: Boolean(m.ai), to, team: to === "team" ? teams[i] : null, text, at: now });
  if (chat.length > CHAT_KEEP) chat.splice(0, chat.length - CHAT_KEEP);
  return null;
}

function handle(sock, m) {
  if (m.t === "hello") return join(sock, m);
  if (m.t === "ctl") {
    sock.ctl = true;
    sock.key = String(m.key ?? "");
    return;
  }
  const i = seatOf(sock);
  if (i < 0) return;
  const s = seats[i];
  const idle = !game || game.phase === "over";
  let err = null;
  switch (m.t) {
    case "config": {
      if (i !== 0) { err = "只有房主能改规则"; break; }
      if (!idle) { err = "对局进行中"; break; }
      if (m.takeoff != null) {
        const t = Number(m.takeoff);
        if (!TAKEOFF[t]) { err = "起飞点数只能是 6 或 5、6"; break; }
        config.takeoff = t;
        msg = `房主设置：掷出 ${t === 56 ? "5 或 6" : "6"} 才能起飞`;
      }
      if (m.mode != null) {
        if (!["solo", "team"].includes(m.mode)) { err = "模式只能是个人赛或 2v2"; break; }
        if (m.mode !== config.mode) game = null;
        config.mode = m.mode;
        msg = m.mode === "team" ? "房主设置：2v2 组队（红绿队对黄蓝队，对面坐的是队友）" : "房主设置：个人赛";
      }
      break;
    }
    case "seat": {
      // Move yourself to an empty seat (the host stays 红).
      const to = Number(m.to);
      if (!idle) { err = "对局进行中"; break; }
      if (i === 0) { err = "房主固定执红色，可以用「换位」调整别人的座位"; break; }
      if (!(to >= 1 && to <= 3) || seats[to]) { err = "那个座位有人了"; break; }
      swapSeats(i, to);
      msg = `${s.name} 换到了${COLORS[to]}色`;
      break;
    }
    case "swap": {
      const a = Number(m.a), b = Number(m.b);
      if (i !== 0) { err = "只有房主能换位"; break; }
      if (!idle) { err = "对局进行中"; break; }
      if (!(a >= 1 && a <= 3 && b >= 1 && b <= 3 && a !== b)) { err = "只能在黄、绿、蓝三个座位之间换"; break; }
      swapSeats(a, b);
      msg = `房主把${COLORS[a]}色和${COLORS[b]}色的座位换了`;
      break;
    }
    case "chat": err = say(i, m); break;
    case "bot": {
      if (i !== 0) { err = "只有房主能添加电脑"; break; }
      if (!idle) { err = "对局进行中"; break; }
      const k = seats.findIndex((x) => !x);
      if (k < 0) { err = "房间已满"; break; }
      const used = new Set(seats.map((x) => x?.name));
      seats[k] = { name: BOT_NAMES.find((n) => !used.has(n)) ?? "电脑", bot: true, sock: null, auto: false, timeouts: 0, wins: 0 };
      msg = `${seats[k].name} 加入了房间，执${COLORS[k]}色`;
      break;
    }
    case "kick":
      if (i !== 0 || !seats[m.seat]?.bot || !idle) { err = "不能移除"; break; }
      seats[m.seat] = null;
      game = null;
      msg = "已移除电脑玩家";
      break;
    case "start":
    case "again": {
      if (seats.filter(Boolean).length < 2) { err = "至少需要 2 名玩家（可以添加电脑）"; break; }
      if (config.mode === "team" && seats.some((x) => !x)) { err = "2v2 需要坐满 4 人（可以添加电脑）"; break; }
      if (!idle) { err = "对局进行中"; break; }
      begin();
      break;
    }
    case "auto":
      s.auto = Boolean(m.on);
      s.timeouts = 0;
      scheduled = null;
      msg = s.auto ? `${s.name} 开启了托管` : `${s.name} 取消了托管`;
      break;
    case "ai":
      // The player handed their seat to an AI (mcp.mjs through their client), or took it back.
      s.ai = Boolean(m.on);
      scheduled = null;
      msg = s.ai ? `${s.name} 交给 AI 代打` : `${s.name} 收回了 AI 代打`;
      break;
    case "roll": err = roll(i); if (!err) s.timeouts = 0; break;
    case "move": err = move(i, m.plane); if (!err) s.timeouts = 0; break;
    case "bye": s.sock?.end(); return;
    default: return;
  }
  if (err) { if (s.sock) send(s.sock, { t: "error", msg: err }); }
  else broadcast();
}

function leave(sock) {
  const i = seats.findIndex((s) => s && s.sock === sock);
  if (i < 0) return;
  if (game && game.phase !== "over" && game.players.includes(i)) {
    seats[i].sock = null;
    msg = `${seats[i].name} 掉线了，电脑代打`;
  } else {
    msg = `${seats[i].name} 离开了房间`;
    seats[i] = null;
    game = null;
  }
  broadcast();
}

const server = net.createServer((sock) => {
  sock.setEncoding("utf8");
  sock.setNoDelay(true);
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const text = box.open(line);
      if (text === null) {
        // Not our password: say so in the clear, and hang up.
        try { sock.write(JSON.stringify({ t: "error", msg: "房间密码不对", plain: true }) + "\n"); } catch {}
        sock.end();
        return;
      }
      try {
        handle(sock, JSON.parse(text));
      } catch (e) {
        const i = seatOf(sock);
        if (i >= 0 && seats[i].sock) send(seats[i].sock, { t: "error", msg: String(e?.message ?? e) });
      }
    }
  });
  sock.on("close", () => leave(sock));
  sock.on("error", () => {});
});

// A ping on every feed, so a client's read never sits idle long enough to time out.
// And a watchdog: a game whose turn has no timer behind it gets one.
setInterval(() => {
  for (const s of seats) if (s?.sock) send(s.sock, { t: "ping" });
  if (game && game.phase !== "over" && game.turn >= 0 && !timer) { scheduled = null; broadcast(); }
}, 3000);

// LAN discovery: "herdr-fxq?" on UDP gets the room, in the clear (nothing secret in it).
const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
udp.on("message", (data, rinfo) => {
  if (String(data).trim() !== "herdr-fxq?") return;
  const room = { t: "fxq-room", v: 1, port: PORT, name: seats[0]?.name ?? "飞行棋", players: seats.filter(Boolean).length, phase: game?.phase ?? "lobby", mode: config.mode };
  udp.send(JSON.stringify(room), rinfo.port, rinfo.address);
});
udp.on("error", (e) => console.error(`局域网发现不可用：${e?.message ?? e}`));
udp.bind(DISCOVERY_PORT);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`飞行棋房间已开在端口 ${PORT}（局域网发现端口 ${DISCOVERY_PORT}）`);
  for (const ip of ips()) console.log(`  也可以手动输入: ${ip}:${PORT}`);
});
server.on("error", (e) => { console.error(String(e?.message ?? e)); process.exit(1); });
