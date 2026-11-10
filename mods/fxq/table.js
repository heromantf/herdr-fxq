// The 飞行棋 window, for any layout: a title bar in the layout's theme over a
// sky-blue table. Opened as a window (`mod.open fxq`), or as a pane
// (`tab.new {mod: "fxq"}`), where the pane draws the frame.
// Not at a table: create a room (which roll takes off, a password) or join one
// found on the LAN or by address. At the table's lobby: the four colored
// seats, the password and addresses for the others, computer players, the
// command that hands your seat to an AI, and Start for the host. In a game:
// the board (hangars in the corners, the ring, the home columns, the center),
// and beside it the players, the die and what happened. On your turn you roll,
// then click one of the bouncing planes; hovering one shows where it lands.
// Every move is shown square by square (a jump or a flight as one glide), and
// the planes it sends home fly back once it lands.
// Every rule lives on the server; this only draws its view and sends what you do.

import { div, image, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { props, setShared, exec, theme, settings, closeOverlay } from "herdr";
import { Link, script } from "./net.js";
import {
  COLORS, HEX, GRID, RING, HOME, LAST, START, FLY_SQUARES, FLY_LANDINGS, CENTER, TEAM_NAMES,
  squareColor, ringSpot, homeCell, HANGAR, HANGAR_SIZE, hangarSpot, PAD, posOf, walk, STEP_MS, HOP_MS, HIT_MS, FLY_HOME_MS, ROLL_MS,
} from "./rules.js";

export const A = "mods/fxq";
export const FONT = "Microsoft YaHei UI";
/** Shared: true while the game window is open (the status-bar button blinks only when it isn't). */
export const OPEN = "fxq.open";

export const icon = (name, w, h = w) => image(`${A}/icons/${name}.svg`).w(w).h(h).flex_none();
const planeGlyph = (size, color) => svg(`${A}/icons/plane.svg`).w(size).h(size).flex_none().text_color(color);

const SIDE = 292;
const TITLE = 34;
/** Where each count's pips sit on a 3 × 3 grid. */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
/** The two halves of a cut corner square (percent of the cell), a little apart so the cut shows. */
const HALVES = {
  ll: [[2, 6], [94, 98], [2, 98]],
  ur: [[6, 2], [98, 2], [98, 94]],
  ul: [[2, 2], [94, 2], [2, 94]],
  lr: [[98, 6], [98, 98], [6, 98]],
};
const pct = (pts) => pts.map(([x, y]) => [`${x}%`, `${y}%`]);
/** Arrowheads (darts with a notch) pointing right, left, down and up, in percent of their box. */
const ARROWS = {
  r: [[8, 8], [96, 50], [8, 92], [34, 50]],
  l: [[92, 8], [4, 50], [92, 92], [66, 50]],
  d: [[8, 8], [50, 96], [92, 8], [50, 34]],
  u: [[8, 92], [50, 4], [92, 92], [50, 66]],
};
/** A triangle pulled in toward its middle by f (its colored face inside its edge). */
function shrink(pts, f) {
  const mx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, my = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
  return pts.map(([x, y]) => [mx + (x - mx) * f, my + (y - my) * f]);
}
/** The center's four triangles, one per color (红 left, 黄 top, 绿 right, 蓝 bottom). */
const TRIANGLES = [
  [["0%", "0%"], ["0%", "100%"], ["50%", "50%"]],
  [["0%", "0%"], ["100%", "0%"], ["50%", "50%"]],
  [["100%", "0%"], ["100%", "100%"], ["50%", "50%"]],
  [["0%", "100%"], ["100%", "100%"], ["50%", "50%"]],
];

function shape(points) {
  let b = PathBuilder.fill().move_to(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) b = b.line_to(x, y);
  return b.close().build();
}

/** A layer filling its (relative) parent with a gradient; 180 runs top to bottom. */
function fill(from, to, angle = 180) {
  return window.paint_path(shape([["0%", "0%"], ["100%", "0%"], ["100%", "100%"], ["0%", "100%"]]), Background.linear_gradient(angle, from, to)).absolute().top(0).left(0).size_full();
}

/** A press on a control is the control's, not a drag of the window. */
const own = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

export default class Table {
  init(_p, cx) {
    this.over = null;
    this.preview = null;
    this.seen = null;
    this.deadlineAt = null;
    this.rules = false;
    this.leaving = false;
    this.size = null;
    this.takeoff = 6;
    this.mode = "solo";
    this.swapFrom = null;
    this.tab = "chat";
    this.chatTo = "all";
    this.chatSeen = 0;
    this.inAddr = InputState.new({ value: "" });
    this.inPass = InputState.new({ value: "" });
    this.inHostPass = InputState.new({ value: "" });
    this.inChat = InputState.new({ placeholder: "说点什么，回车发送" });
    this.inChat.on("submit", (_e, cx) => { this.sendChat(cx); cx.notify(); });
    this.copied = 0;
    this.overlay = props()?.overlay ?? null;
    if (this.overlay) setShared(OPEN, true);
    this.anim = null;
    this.animGen = 0;
    this.lastN = undefined;
    this.bumps = 0;
    this.roll = null;
    this.rollGen = 0;
    this.rollSeen = undefined;
    this.link = new Link();
    // Who's hosting on the LAN, as soon as the window opens; every new state may bring a move to show.
    this.link.start(cx,
      (cx) => { if (this.link.view().status !== "online") this.link.send(cx, { t: "_scan" }); },
      (cx) => this.animate(cx));
    // The clock and errors fade: redraw once a second while either shows.
    cx.timer.every(1000, (cx) => {
      const d = this.link.view();
      if ((d.state && this.deadlineAt && this.deadlineAt > Date.now() - 1000) || (d.toast && Date.now() - d.toast.at < 4000)) cx.notify();
    });
  }

  async close() {
    if (this.overlay) setShared(OPEN, false);
  }

  send(cx, m) {
    this.link.send(cx, m);
  }

  hover(id) {
    return (on, cx) => { this.over = on ? id : this.over === id ? null : this.over; cx.notify(); };
  }

  // ---- parts

  /** A flat push button. `onClick` gets the click's cx. */
  button(id, text, onClick, o = {}) {
    const hot = this.over === id && !o.disabled;
    const bg = o.disabled ? "#e9edf2" : o.primary ? (hot ? "#3d8ce6" : "#2f7fd8") : hot ? "#eef4fb" : "#ffffff";
    return own(div().id(id)).h(o.h ?? 30).w(o.w ?? 88).flex_none().rounded(6).flex().items_center().justify_center()
      .bg(bg).border_1().border_color(o.disabled ? "#d3dae3" : o.primary ? "#1f63b0" : hot ? "#8fb6e3" : "#c5cfdb")
      .text_size(o.size ?? 13).text_color(o.disabled ? "#9aa5b1" : o.primary ? "#ffffff" : "#1d3557")
      .when(!o.disabled, (el) => el.cursor_pointer())
      .on_hover(this.hover(id))
      .on_click((_e, cx) => { if (!o.disabled) onClick(cx); cx.notify(); })
      .child(text);
  }

  field(state, w, key) {
    return own(div().id(`f-${key}`)).w(w).h(28).px(8).flex().items_center().bg("#ffffff").border_1().border_color("#a9b8c9").rounded(5)
      .child(Input.new(state).w_full().text_size(13).text_color("#000000"));
  }

  pill(text, bg, color = "#ffffff") {
    return div().px(6).py(1).rounded(8).bg(bg).text_size(11).font_weight(700).text_color(color).child(text);
  }

  panel(children, w = 560) {
    return v_flex().w(w).p(20).gap(12).rounded(10).bg("#ffffffee").border_1().border_color("#0b2447").shadow_lg().children(children);
  }

  avatar(p, size) {
    return div().w(size).h(size).flex_none().rounded(5).overflow_hidden().border_1().border_color("#ffffffc0").bg("#ffffff")
      .flex().items_center().justify_center()
      .child(p.bot ? icon("computer", size - 6) : icon("user", size - 2));
  }

  /** A row of toggles, one of them on: [[value, text], …]. */
  toggles(id, value, choices, onPick) {
    return h_flex().gap(6).children(choices.map(([v, text]) => {
      const key = `${id}-${v}`, on = value === v;
      return own(div().id(key)).h(28).px(12).flex().items_center().rounded(6).cursor_pointer()
        .bg(on ? "#2f7fd8" : this.over === key ? "#eef4fb" : "#ffffff").border_1().border_color(on ? "#1f63b0" : "#c5cfdb")
        .text_color(on ? "#ffffff" : "#1d3557").on_hover(this.hover(key))
        .on_click((_e, cx) => { onPick(v, cx); cx.notify(); })
        .child(text);
    }));
  }

  /** Which roll takes off. */
  takeoffPicker(value, onPick) {
    return this.toggles("takeoff", value, [[6, "掷出 6 起飞"], [56, "掷出 5、6 都能起飞"]], onPick);
  }

  /** Everyone for themselves, or 2v2. */
  modePicker(value, onPick) {
    return this.toggles("mode", value, [["solo", "个人赛"], ["team", "2v2 组队"]], onPick);
  }

  teamPill(t) {
    return this.pill(TEAM_NAMES[t], t === 0 ? "#a0412f" : "#2c5d8a");
  }

  /** A die showing n; `turned` draws the face a quarter turn round (2, 3 and 6 look different), for tumbling. */
  die(n, size, color, turned = false) {
    const pip = size * 0.17;
    const grid = div().relative().w(size).h(size).flex_none().rounded(size * 0.18).bg("#ffffff").border_2().border_color(color).shadow_md();
    if (!n) return grid.child(div().size_full().flex().items_center().justify_center().text_size(size * 0.4).text_color("#9aa5b1").child("?"));
    for (const k of PIPS[n]) {
      const r = Math.floor(k / 3), c = turned ? 2 - (k % 3) : k % 3;
      const red = n === 1 || n === 4;
      grid.child(div().absolute().left(size * (0.2 + c * 0.3) - pip / 2).top(size * (0.2 + r * 0.3) - pip / 2).w(pip).h(pip).rounded_full().bg(red ? "#d62828" : "#1d3557"));
    }
    return grid;
  }

  // ---- chat

  sendChat(cx) {
    const text = this.inChat.value().trim();
    if (!text) return;
    this.send(cx, { t: "chat", text, to: this.chatTo });
    this.inChat.set_value("");
  }

  chatLine(s, c) {
    const C = HEX[c.seat];
    const you = c.seat === s.you && !c.ai;
    return v_flex().gap(1).flex_none()
      .child(h_flex().gap(4).items_center()
        .child(div().w(8).h(8).flex_none().rounded_full().bg(C.main))
        .child(div().text_size(11.5).font_weight(600).text_color(C.dark).child(you ? "你" : c.name))
        .when(c.ai, (el) => el.child(this.pill("AI", "#7a3db8")))
        .when(c.to === "team", (el) => el.child(this.pill("队内", "#5b4b8a"))))
      .child(div().text_size(12.5).text_color("#1d2a3a").child(c.text));
  }

  /** The chat: newest at the bottom, and a line to type in (全场 or, in 2v2, 队内). */
  chatBox(s, max = 14) {
    const lines = (s.chat ?? []).slice(-max);
    const team = Boolean(s.teams);
    if (!team) this.chatTo = "all";
    const list = v_flex().flex_1().min_h(0).overflow_hidden().justify_end().gap(5)
      .children(lines.map((c) => this.chatLine(s, c)));
    if (!lines.length) list.child(div().text_size(12).text_color("#8d99a6").child(team ? "跟大家打个招呼，或切到「队内」跟队友商量" : "跟大家打个招呼吧"));
    const seg = (to, text) => {
      const key = `chat-to-${to}`, on = this.chatTo === to;
      return own(div().id(key)).h(26).px(8).flex().items_center().cursor_pointer().text_size(12)
        .bg(on ? (to === "team" ? "#5b4b8a" : "#1d3557") : this.over === key ? "#eef4fb" : "#ffffff").text_color(on ? "#ffffff" : "#1d3557")
        .on_hover(this.hover(key)).on_click((_e, cx) => { this.chatTo = to; cx.notify(); }).child(text);
    };
    const input = h_flex().gap(6).items_center().flex_none()
      .when(team, (el) => el.child(h_flex().flex_none().rounded(6).overflow_hidden().border_1().border_color("#c5cfdb").child(seg("all", "全场")).child(seg("team", "队内"))))
      .child(own(div().id("chat-in")).flex_1().min_w(0).h(28).px(8).flex().items_center().bg("#ffffff").rounded(5)
        .border_1().border_color(this.chatTo === "team" ? "#7d6bb3" : "#a9b8c9")
        .child(Input.new(this.inChat).w_full().text_size(12.5).text_color("#000000")))
      .child(this.button("chat-send", "发送", (cx) => this.sendChat(cx), { w: 48, h: 28, size: 12, primary: true }));
    return v_flex().flex_1().min_h(0).gap(6).child(list).child(input);
  }

  // ---- not at a table

  lobby(d) {
    const err = d.status === "error" || d.status === "lost" ? d.error : null;
    const busy = d.status === "connecting";
    return this.panel([
      h_flex().gap(12).items_center()
        .child(icon("fxq", 48))
        .child(v_flex().child(div().text_size(20).text_color("#1d3557").child("局域网飞行棋"))
          .child(div().text_color("#4d5b6a").child("红黄绿蓝四方，个人赛或 2v2，人不够可以加电脑，也可以让 AI 替你下。"))),
      div().h(1).bg("#d5dde7"),
      div().text_size(14).text_color("#1d3557").child("创建房间（你当房主）"),
      h_flex().gap(10).items_center()
        .child(this.modePicker(this.mode, (v) => { this.mode = v; }))
        .child(div().flex_1())
        .child(this.button("host", "创建房间", (cx) => this.send(cx, { t: "_host", takeoff: this.takeoff, mode: this.mode, password: this.inHostPass.value() }), { primary: true, disabled: busy })),
      h_flex().gap(10).items_center().child(this.takeoffPicker(this.takeoff, (v) => { this.takeoff = v; })),
      h_flex().gap(10).items_center()
        .child(div().text_color("#333").child("房间密码")).child(this.field(this.inHostPass, 120, "hostpass"))
        .child(div().text_color("#8d99a6").text_size(11).child("留空自动生成；对局内容用它 AES 加密")),
      div().text_color("#6d7a88").text_size(11).child("首次开房时 Windows 防火墙可能询问 node，请允许专用网络。"),
      div().h(1).bg("#d5dde7"),
      h_flex().gap(8).items_center()
        .child(div().text_size(14).text_color("#1d3557").child("加入房间"))
        .child(div().text_color("#6d7a88").text_size(11).child(d.scanning ? "正在搜索局域网…" : `局域网里找到 ${(d.rooms ?? []).length} 个房间`))
        .child(div().flex_1())
        .child(this.button("scan", "刷新", (cx) => this.send(cx, { t: "_scan" }), { w: 60, h: 26, size: 12, disabled: d.scanning })),
      v_flex().gap(4).children((d.rooms ?? []).map((r) => {
        const id = `room-${r.addr}`;
        const picked = this.inAddr.value() === r.addr;
        return own(h_flex().id(id)).h(34).px(10).gap(10).items_center().rounded(6).cursor_pointer()
          .border_1().border_color(picked ? "#7da2ce" : this.over === id ? "#b8d6fb" : "#d5dde7").bg(picked ? "#dcebfc" : "#ffffff")
          .on_hover(this.hover(id))
          .on_click((_e, cx) => { this.inAddr.set_value(r.addr); cx.notify(); })
          .child(icon("fxq", 20))
          .child(div().text_color("#000").child(`${r.name} 的房间`))
          .when(r.mode === "team", (el) => el.child(this.pill("2v2", "#5b4b8a")))
          .child(div().text_color("#6d7a88").child(`${r.players}/4 人 · ${{ lobby: "等待中", roll: "对局中", move: "对局中", over: "刚下完" }[r.phase] ?? r.phase}`))
          .child(div().flex_1())
          .child(div().text_color("#8d99a6").text_size(11).child(r.addr));
      })),
      h_flex().gap(10).items_center()
        .child(div().text_color("#333").child("地址")).child(this.field(this.inAddr, 180, "addr"))
        .child(div().text_color("#333").child("密码")).child(this.field(this.inPass, 100, "pass"))
        .child(div().flex_1())
        .child(this.button("join", "加入", (cx) => this.send(cx, { t: "_join", addr: this.inAddr.value(), password: this.inPass.value() }), { primary: true, disabled: busy })),
      busy ? div().text_color("#1d3557").child("正在连接…") : err ? div().text_color("#c42b1c").child(err) : div().h(0),
    ]);
  }

  /** The command that hands your seat to an AI (Claude Code here) through mcp.mjs. */
  aiCommand() {
    return `claude mcp add fxq -- node "${script("mcp.mjs")}"`;
  }

  copy(text) {
    this.copied = Date.now();
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value $args[0]", text]).catch(() => {});
  }

  /** What you can do with a seat before the game: sit there, or (host) swap it with another. */
  seatAction(s, p, i) {
    const small = { w: 56, h: 26, size: 12 };
    if (s.host) {
      if (i === 0) return null;
      const from = this.swapFrom;
      if (from == null) return p ? this.button(`sw-${i}`, "换位", () => { this.swapFrom = i; }, small) : null;
      if (from === i) return this.button(`sw-${i}`, "取消", () => { this.swapFrom = null; }, small);
      return this.button(`sw-${i}`, "换到这里", (cx) => { this.send(cx, { t: "swap", a: from, b: i }); this.swapFrom = null; }, { ...small, w: 76, primary: true });
    }
    return !p && i !== 0 ? this.button(`sit-${i}`, "坐这里", (cx) => this.send(cx, { t: "seat", to: i }), small) : null;
  }

  room(s, d) {
    const team = Boolean(s.teams);
    const rows = s.seats.map((p, i) => {
      const C = HEX[i];
      const chip = div().w(30).h(30).flex_none().rounded_full().bg(C.main).border_2().border_color("#ffffff").flex().items_center().justify_center().child(planeGlyph(18, "#ffffff"));
      const act = this.seatAction(s, p, i);
      const picked = this.swapFrom === i;
      if (!p) return h_flex().h(44).px(10).gap(10).items_center().rounded(6).border_1().border_color("#d5dde7")
        .child(chip.opacity(0.35)).child(div().text_color("#8d99a6").child(`${COLORS[i]}方 · 空位`))
        .when(team, (el) => el.child(this.teamPill(s.teams[i])))
        .child(div().flex_1()).when(Boolean(act), (el) => el.child(act));
      return h_flex().h(44).px(10).gap(10).items_center().rounded(6).border_1().border_color(picked ? "#1d3557" : C.main).bg(C.light)
        .child(chip).child(this.avatar(p, 30))
        .child(div().text_size(14).text_color("#000").child(p.name))
        .when(i === 0, (el) => el.child(this.pill("房主", "#1d3557")))
        .when(i === s.you, (el) => el.child(this.pill("你", "#5aa81e")))
        .when(p.bot, (el) => el.child(this.pill("电脑", "#7b8794")))
        .when(p.ai, (el) => el.child(this.pill("AI", "#7a3db8")))
        .when(team, (el) => el.child(this.teamPill(s.teams[i])))
        .child(div().flex_1())
        .when(p.wins > 0, (el) => el.child(div().text_color(C.dark).child(`胜 ${p.wins}`)))
        .when(s.host && p.bot, (el) => el.child(this.button(`kick-${i}`, "移除", (cx) => this.send(cx, { t: "kick", seat: i }), { w: 56, h: 26, size: 12 })))
        .when(Boolean(act), (el) => el.child(act));
    });
    const n = s.seats.filter(Boolean).length;
    const ready = team ? n === 4 : n >= 2;
    const panel = this.panel([
      h_flex().gap(12).items_center().child(icon("fxq", 40))
        .child(v_flex().child(div().text_size(18).text_color("#1d3557").child("飞行棋房间"))
          .child(div().text_color("#4d5b6a").child(`${team ? "2v2 组队（对面坐的是队友）" : "个人赛"} · ${s.config.takeoff === 56 ? "掷出 5、6" : "掷出 6"} 起飞 · ${n}/4 人`))),
      s.host
        ? v_flex().gap(4).p(10).rounded(6).bg("#fff8dc").border_1().border_color("#e6cf7a")
          .child(h_flex().gap(8).items_center().child(div().text_color("#5c4500").child("房间密码"))
            .child(div().text_size(18).font_weight(700).text_color("#000").child(d.password ?? "")))
          .child(div().text_color("#5c4500").child("其他人打开飞行棋会自动搜到这个房间，输入密码即可加入；也可以手动输入："))
          .child(div().font_weight(700).text_color("#000").child(s.ips.length ? s.ips.map((ip) => `${ip}:${s.port}`).join("   ") : `本机:${s.port}`))
        : div().text_color("#4d5b6a").child(`已连接到 ${d.addr}（加密）`),
      v_flex().gap(6).children(rows),
      v_flex().gap(4).p(8).rounded(6).bg("#eef4fb").border_1().border_color("#b8cde6")
        .child(h_flex().gap(8).items_center()
          .child(div().text_color("#1d3557").child("让 AI 替你下：在 Claude Code 里加这个 MCP，再对它说「替我下飞行棋」"))
          .child(div().flex_1())
          .child(this.button("copy-ai", Date.now() - this.copied < 3000 ? "已复制" : "复制命令", () => this.copy(this.aiCommand()), { w: 80, h: 26, size: 12 })))
        .child(div().text_size(11).text_color("#4d5b6a").child(this.aiCommand())),
      div().text_color("#1d3557").child(s.msg ?? ""),
      ...(s.host ? [h_flex().gap(8).items_center()
        .child(this.modePicker(s.config.mode, (v, cx) => this.send(cx, { t: "config", mode: v })))
        .child(this.takeoffPicker(s.config.takeoff, (v, cx) => this.send(cx, { t: "config", takeoff: v })))] : []),
      h_flex().gap(8).items_center()
        .child(div().flex_1().text_color("#6d7a88").text_size(11).child(this.overlay ? "– 只是隐藏窗口，座位还在；× 会离开房间。" : "关掉标签页不会离开房间。"))
        .when(s.host, (el) => el.child(this.button("bot", "添加电脑", (cx) => this.send(cx, { t: "bot" }), { disabled: n >= 4 })))
        .when(s.host, (el) => el.child(this.button("start", "开始游戏", (cx) => this.send(cx, { t: "start" }), { primary: true, disabled: !ready })))
        .child(this.button("leave", "离开房间", (cx) => this.send(cx, { t: "_leave" }))),
    ], 590);
    const chat = v_flex().w(280).h(470).p(12).gap(8).rounded(10).bg("#ffffffee").border_1().border_color("#0b2447").shadow_lg()
      .child(div().text_size(14).text_color("#1d3557").child("聊天"))
      .child(this.chatBox(s, 12));
    return h_flex().gap(12).items_start().child(panel).child(chat);
  }

  // ---- moves, shown square by square

  /**
   * The die tumbles: random faces, each a little longer than the last (about
   * ROLL_MS in all), shaking as it goes, then the roll. It shows beside the
   * board and, big, over the board's center, which then fades.
   */
  tumble(cx, n, seat) {
    const gen = ++this.rollGen;
    this.roll = { n, seat, face: 1 + Math.floor(Math.random() * 6), turned: false, jx: 0, jy: 0, landed: false, fading: false };
    cx.spawn(async (cx) => {
      const wait = (ms) => new Promise((r) => cx.timer.after(ms, () => r()));
      const live = () => gen === this.rollGen;
      const beats = [50, 55, 60, 70, 80, 95, 115, 140, 175];
      const scale = ROLL_MS / beats.reduce((a, b) => a + b, 0);
      for (const ms of beats) {
        if (!live()) return;
        let f;
        do f = 1 + Math.floor(Math.random() * 6); while (f === this.roll.face);
        Object.assign(this.roll, { face: f, turned: Math.random() < 0.5, jx: (Math.random() - 0.5) * 0.36, jy: (Math.random() - 0.5) * 0.36 });
        cx.notify();
        await wait(ms * scale);
      }
      if (!live()) return;
      Object.assign(this.roll, { face: n, turned: false, jx: 0, jy: 0, landed: true });
      cx.notify();
      await wait(700);
      if (!live()) return;
      this.roll.fading = true;
      cx.notify();
      await wait(320);
      if (!live()) return;
      this.roll = null;
      cx.notify();
    });
  }

  /**
   * A new state: if it carries a move this window hasn't shown, walk that plane
   * along its path (a square every STEP_MS, a takeoff, jump or flight as one
   * HOP_MS glide). Where it lands on someone: a bump (a ring bursting out and
   * 撞!), then whoever it hit flies home (FLY_HOME_MS) while it goes on.
   */
  animate(cx) {
    const s = this.link.view().state;
    // The first look is what was already there when the window opened: shown as it is, not played.
    if (this.rollSeen === undefined) {
      this.rollSeen = s?.rollN ?? null;
      this.lastN = s?.last?.n ?? null;
      return;
    }
    // A roll this window hasn't shown: tumble the die first.
    if (s?.rollN != null && s.rollN !== this.rollSeen) {
      this.rollSeen = s.rollN;
      if (s.dice) this.tumble(cx, s.dice, s.rolledBy);
    }
    const last = s?.last;
    if (!last || last.n == null || last.n === this.lastN) return;
    this.lastN = last.n;
    if (!s.planes?.[last.seat]) return;
    const steps = walk(last);
    const path = [posOf(last.seat, last.from, last.plane), ...steps.map((w) => posOf(last.seat, w.p, last.plane))];
    const captures = (last.captures ?? []).map((h) => ({ ...h, idx: 1 + Math.max(0, steps.findIndex((w) => w.p === h.at)), home: false }));
    const gen = ++this.animGen;
    this.anim = { seat: last.seat, plane: last.plane, path, hops: [false, ...steps.map((w) => w.hop)], i: 0, captures, bump: null };
    cx.spawn(async (cx) => {
      const wait = (ms) => new Promise((r) => cx.timer.after(ms, () => r()));
      const live = () => gen === this.animGen;
      for (let i = 1; i < path.length; i++) {
        if (!live()) return;
        this.anim.i = i;
        cx.notify();
        await wait(this.anim.hops[i] ? HOP_MS : STEP_MS);
        const hits = captures.filter((h) => h.idx === i);
        if (!hits.length || !live()) continue;
        // The bump: drawn small, then grown and faded by its transitions.
        this.anim.bump = { at: path[i], n: ++this.bumps, open: false };
        cx.notify();
        await wait(40);
        if (!live()) return;
        this.anim.bump.open = true;
        cx.notify();
        await wait(HIT_MS - 40);
        if (!live()) return;
        for (const h of hits) h.home = true;
        cx.notify();
      }
      if (captures.length) await wait(FLY_HOME_MS);
      if (!live()) return;
      this.anim = null;
      cx.notify();
    });
  }

  /** Where plane j of color c is drawn now (grid units, its middle), and how long it glides there. */
  placeOf(s, c, j) {
    const a = this.anim;
    if (a?.seat === c && a.plane === j) return { at: a.path[a.i], ms: (a.hops[a.i] ? HOP_MS : STEP_MS) - 40, moving: true };
    const h = a?.captures.find((h) => h.seat === c && h.plane === j);
    if (h) return h.home ? { at: posOf(c, s.planes[c][j], j), ms: FLY_HOME_MS - 60, hit: false } : { at: posOf(c, h.from, j), ms: 0, hit: a.i >= h.idx };
    return { at: posOf(c, s.planes[c][j], j), ms: 300 };
  }

  // ---- the board

  board(s, u) {
    const B = GRID * u;
    const at = (x, y, w = 1, h = 1) => div().absolute().left(x * u).top(y * u).w(w * u).h(h * u);
    const dot = (x, y, d) => div().absolute().left(x * u - d / 2).top(y * u - d / 2).w(d).h(d).rounded_full();
    const el = div().relative().w(B).h(B).flex_none();
    el.child(div().absolute().top(0).left(0).w(B).h(B).rounded(u * 0.5).bg("#fbf6e9").border_1().border_color("#d8ccb0").shadow_lg());

    // Hangars: the 4 × 4 corners, four parking spots each; the one whose turn it is stands out.
    HANGAR.forEach(([hx, hy], c) => {
      const C = HEX[c];
      const playing = s.players.includes(c);
      const turn = s.turn === c && s.phase !== "over";
      el.child(at(hx + 0.15, hy + 0.15, HANGAR_SIZE - 0.3, HANGAR_SIZE - 0.3).rounded(u * 0.45).bg(C.main)
        .border_2().border_color(turn ? "#1d3557" : C.dark).when(turn, (e) => e.shadow_lg())
        .opacity(playing || s.phase === "lobby" ? 1 : 0.45));
      for (let j = 0; j < 4; j++) {
        const [x, y] = hangarSpot(c, j);
        el.child(dot(x, y, u * 1.4).bg("#ffffffd8").border_1().border_color(C.dark));
      }
      // The takeoff pad, in the empty half of the square at the end of its side.
      const [px, py] = PAD[c];
      el.child(dot(px, py, u * 0.98).bg("#ffffff").border_2().border_color(C.main).flex().items_center().justify_center()
        .opacity(playing || s.phase === "lobby" ? 1 : 0.45)
        .child(div().text_size(u * 0.4).font_weight(700).text_color(C.dark).child("起")));
    });

    // Ring squares: 1 × 2 cells, and halves of 2 × 2 squares cut on the diagonal; a white spot in each.
    RING.forEach((q, k) => {
      const C = HEX[squareColor(k)];
      if (q.half) {
        el.child(at(q.x, q.y, q.w, q.h)
          .child(window.paint_path(shape(pct(HALVES[q.half])), C.dark).absolute().top(0).left(0).size_full())
          .child(window.paint_path(shape(pct(shrink(HALVES[q.half], 0.9))), C.main).absolute().top(0).left(0).size_full()));
      } else {
        el.child(at(q.x, q.y, q.w, q.h).p(Math.max(1, u * 0.05))
          .child(div().size_full().rounded(u * 0.14).bg(C.main).border_1().border_color(C.dark)));
      }
      const [mx, my] = ringSpot(k);
      el.child(dot(mx, my, u * 0.68).bg("#ffffff"));
    });

    // Home columns, and the center's four triangles.
    for (let c = 0; c < 4; c++) for (let h = 1; h < HOME - LAST; h++) {
      const [x, y] = homeCell(c, h);
      el.child(at(x, y).p(Math.max(1, u * 0.05)).child(div().size_full().rounded(u * 0.14).bg(HEX[c].main).border_1().border_color(HEX[c].dark)));
      el.child(dot(x + 0.5, y + 0.5, u * 0.68).bg("#ffffff"));
    }
    const center = at(CENTER[0], CENTER[1], 3, 3).relative();
    TRIANGLES.forEach((pts, c) => center.child(window.paint_path(shape(pts), HEX[c].main).absolute().top(0).left(0).size_full()));
    el.child(center);

    // Flight paths: dashes straight across the opposite color's arm, on the middle line of the
    // home-column square they cross (so they go through its spot), with arrowheads the way it flies.
    for (let c = 0; c < 4; c++) {
      const [fx, fy] = ringSpot(FLY_SQUARES[c]), [lx, ly] = ringSpot(FLY_LANDINGS[c]);
      const level = Math.abs(ly - fy) < 1e-6;
      const [ax, ay] = level ? [fx, Math.floor(fy) + 0.5] : [Math.floor(fx) + 0.5, fy];
      const [bx, by] = level ? [lx, ay] : [ax, ly];
      const len = Math.hypot(bx - ax, by - ay), n = Math.round(len * 2.6);
      const heads = [0.27, 0.73];
      const [w, h] = level ? [u * 0.26, u * 0.12] : [u * 0.12, u * 0.26];
      for (let t = 1; t < n; t++) {
        const f = t / n;
        if (f * len < 0.55 || (1 - f) * len < 0.55 || heads.some((g) => Math.abs(f - g) * len < 0.3)) continue;
        const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
        el.child(div().absolute().left(x * u - w / 2).top(y * u - h / 2).w(w).h(h).rounded(u * 0.04).bg(HEX[c].main).border_1().border_color(HEX[c].dark));
      }
      const way = level ? (bx > ax ? "r" : "l") : (by > ay ? "d" : "u");
      for (const g of heads) {
        const x = ax + (bx - ax) * g, y = ay + (by - ay) * g, a = u * 0.46;
        el.child(div().absolute().left(x * u - a / 2).top(y * u - a / 2).w(a).h(a)
          .child(window.paint_path(shape(pct(ARROWS[way])), HEX[c].dark).absolute().top(0).left(0).size_full()));
      }
    }

    // The last move's landing spot, once it's been shown.
    const last = s.last;
    if (last && s.phase !== "lobby" && !this.anim) {
      const [x, y] = posOf(last.seat, last.to, last.plane);
      el.child(dot(x, y, u * 1.2).border_2().border_color("#1d3557").bg("#ffffff40"));
    }

    // Where the hovered plane would land.
    const mine = s.phase === "move" && s.turn === s.you && !s.seats[s.you]?.auto && !this.anim ? s.options ?? [] : [];
    const pv = mine.find((o) => o.plane === this.preview);
    if (pv) {
      // The way there: a dot on every square it passes (and where a jump or flight takes off).
      for (const w of walk(pv).slice(0, -1)) {
        const [tx, ty] = posOf(s.you, w.p, pv.plane);
        el.child(dot(tx, ty, u * 0.4).bg(HEX[s.you].main).border_2().border_color("#ffffff").shadow_sm());
      }
      const [x, y] = posOf(s.you, pv.to, pv.plane);
      el.child(dot(x, y, u * 1.24).bg(`${HEX[s.you].main}66`).border_2().border_color("#ffcc00"));
      // 撞 where it would send someone home (on the way, before a jump or flight, or where it lands).
      for (const at of new Set(pv.captures.map((h) => h.at))) {
        const [hx, hy] = posOf(s.you, at, pv.plane);
        el.child(div().absolute().left(hx * u - u * 0.42).top(hy * u - u * 0.95).w(u * 0.84).h(u * 0.5).rounded(u * 0.25)
          .bg("#d62828").border_1().border_color("#ffffff").flex().items_center().justify_center()
          .text_size(Math.max(10, u * 0.32)).font_weight(700).text_color("#ffffff").child("撞"));
      }
    }

    // Planes, each its own element so moves glide; planes sharing a spot stack with a count.
    const planes = [];
    s.players.forEach((c) => (s.planes[c] ?? []).forEach((_p, j) => planes.push({ c, j, ...this.placeOf(s, c, j), opt: c === s.you ? mine.find((o) => o.plane === j) : null })));
    const stacks = new Map();
    for (const p of planes) {
      if (p.moving) continue;
      const key = `${p.at[0].toFixed(2)},${p.at[1].toFixed(2)}`;
      stacks.set(key, [...(stacks.get(key) ?? []), p]);
    }
    for (const list of stacks.values()) list.forEach((p, k) => { p.depth = k; p.count = k === list.length - 1 ? list.length : 0; });
    // Movable planes, then the moving one, on top.
    planes.sort((a, b) => (a.moving ? 2 : a.opt ? 1 : 0) - (b.moving ? 2 : b.opt ? 1 : 0));
    const choosing = mine.length > 0;
    for (const p of planes) el.child(this.token(p, u, choosing && p.c === s.you && !p.opt));

    // The die, big over the center while it tumbles, then a moment on the roll before it fades.
    const r = this.roll;
    if (r) {
      const size = u * 2.4, [mx, my] = [CENTER[0] + 1.5 + r.jx, CENTER[1] + 1.5 + r.jy];
      const shake = { duration: 70, easing: "ease-out" };
      el.child(div().id("big-die").absolute().left(mx * u - size / 2).top(my * u - size / 2).w(size).h(size)
        .transition("left", shake).transition("top", shake)
        .opacity(r.fading ? 0 : 1).transition("opacity", { duration: 300, easing: "ease-in" })
        .child(this.die(r.face, size, HEX[r.seat]?.main ?? "#c5cfdb", r.turned).shadow_lg()));
    }

    // The bump where a move lands on someone: a ring bursting out, and 撞!
    const bump = this.anim?.bump;
    if (bump) {
      const [x, y] = bump.at;
      const d = bump.open ? u * 2.6 : u * 0.7;
      const grow = { duration: 520, easing: "ease-out" };
      el.child(div().id(`bump-${bump.n}`).absolute().left(x * u - d / 2).top(y * u - d / 2).w(d).h(d).rounded_full()
        .border_2().border_color("#ff6a00").bg("#ffd16655").opacity(bump.open ? 0 : 1)
        .transition("left", grow).transition("top", grow).transition("width", grow).transition("height", grow)
        .transition("opacity", { duration: 620, easing: "ease-in" }));
      el.child(div().id(`bang-${bump.n}`).absolute().left(x * u - u * 0.7).top((y - (bump.open ? 1.5 : 0.95)) * u).w(u * 1.4).h(u * 0.62)
        .rounded(u * 0.31).bg("#d62828").border_1().border_color("#ffffff").flex().items_center().justify_center()
        .text_size(u * 0.38).font_weight(700).text_color("#ffffff").child("撞！")
        .opacity(bump.open ? 0 : 1)
        .transition("top", { duration: 600, easing: "ease-out" }).transition("opacity", { duration: 300, delay: 380, easing: "ease-in" }));
    }
    return el;
  }

  /** The die beside the board: the roll, or while it tumbles, its faces going by with a shake. */
  sideDie(s, roller) {
    const r = this.roll;
    const color = r ? HEX[r.seat]?.main : roller >= 0 ? HEX[roller].main : "#c5cfdb";
    const shake = { duration: 70, easing: "ease-out" };
    return div().relative().w(60).h(60).flex_none()
      .child(div().id("side-die").absolute().left(2 + (r ? r.jx * 14 : 0)).top(2 + (r ? r.jy * 14 : 0))
        .transition("left", shake).transition("top", shake)
        .child(this.die(r ? r.face : s.dice, 56, color, r?.turned)));
  }

  token(p, u, dim) {
    const C = HEX[p.c];
    const t = u * 0.84;
    const lift = (p.depth ?? 0) * u * 0.09;
    const [x, y] = p.at;
    let el = div().id(`pl-${p.c}-${p.j}`).absolute().left(x * u - t / 2 - lift).top(y * u - t / 2 - lift).w(t).h(t)
      .transition("left", { duration: Math.max(1, p.ms), easing: "ease-in-out" })
      .transition("top", { duration: Math.max(1, p.ms), easing: "ease-in-out" })
      .when(dim, (e) => e.opacity(0.6));
    // A plane you can move: a gold ring that slowly brightens and dims.
    if (p.opt) el = el.child(div().absolute().left(-u * 0.13).top(-u * 0.13).w(t + u * 0.26).h(t + u * 0.26).rounded_full()
      .border_2().border_color("#ffb800").bg("#fff3a055").loop("opacity", { from: 0.55, to: 1, period: 1600 }));
    // White with a plane in the color, so it reads on any square (its own color included). A hit plane goes red-rimmed.
    el = el.child(div().absolute().left(0).top(0).size_full().rounded_full().bg(p.hit ? "#ffe0e0" : "#ffffff")
      .border_2().border_color(p.hit ? "#d62828" : p.opt ? "#1d3557" : C.dark).shadow_md()
      .flex().items_center().justify_center().child(planeGlyph(t * 0.66, C.main)));
    if (p.count > 1) el = el.child(div().absolute().right(-u * 0.14).top(-u * 0.14).min_w(u * 0.4).h(u * 0.4).px(2).rounded_full()
      .bg("#1d3557").border_1().border_color("#ffffff").flex().items_center().justify_center()
      .text_size(Math.max(9, u * 0.27)).font_weight(700).text_color("#ffffff").child(String(p.count)));
    if (!p.opt) return el;
    const plane = p.opt.plane;
    return own(el).cursor_pointer()
      .on_hover((on, cx) => { this.preview = on ? plane : this.preview === plane ? null : this.preview; cx.notify(); })
      .on_click((_e, cx) => { this.preview = null; this.send(cx, { t: "move", plane }); cx.notify(); });
  }

  // ---- beside the board

  side(s, d, h) {
    const me = s.seats[s.you];
    const toast = d.toast && Date.now() - d.toast.at < 4000 ? d.toast.msg : null;
    const secs = this.deadlineAt ? Math.max(0, Math.ceil((this.deadlineAt - Date.now()) / 1000)) : null;
    const card = () => v_flex().p(10).gap(6).rounded(10).bg("#ffffffe8").border_1().border_color("#0b2447");

    const players = card().children(s.seats.map((p, i) => {
      if (!p) return null;
      const C = HEX[i];
      const turn = s.turn === i && s.phase !== "over";
      const home = (s.planes[i] ?? []).filter((q) => q === HOME).length;
      return h_flex().h(40).px(6).gap(8).items_center().rounded(6)
        .border_1().border_color(turn ? C.main : "#00000000").bg(turn ? C.light : "#00000000")
        .child(div().w(24).h(24).flex_none().rounded_full().bg(C.main).border_2().border_color("#ffffff").flex().items_center().justify_center().child(planeGlyph(14, "#ffffff")))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().gap(4).items_center().child(div().truncate().text_color("#000").child(p.name))
            .when(i === s.you, (el) => el.child(this.pill("你", "#5aa81e")))
            .when(p.bot, (el) => el.child(this.pill("电脑", "#7b8794")))
            .when(p.ai, (el) => el.child(this.pill("AI", "#7a3db8")))
            .when(p.auto && !p.bot, (el) => el.child(this.pill("托管", "#6d6d6d")))
            .when(!p.online, (el) => el.child(this.pill("掉线", "#c42b1c"))))
          .child(h_flex().gap(4).items_center()
            .when(Boolean(s.teams), (el) => el.child(this.teamPill(s.teams[i])))
            .child(div().text_size(11).text_color("#4d5b6a").child(!s.players.includes(i) ? "观战"
              : s.done?.includes(i) ? "全部到达，等队友" : `到达 ${home}/4${p.wins ? ` · 胜 ${p.wins}` : ""}`))))
        .when(turn && secs != null, (el) => el.child(div().px(6).rounded(8).bg(secs <= 5 ? "#c42b1c" : "#1d3557").text_color("#ffffff").child(`${secs}`)));
    }).filter(Boolean));

    const roller = s.rolledBy >= 0 ? s.rolledBy : s.turn;
    const myTurn = s.turn === s.you && !me?.auto;
    let action;
    if (s.phase === "over") {
      const r = s.result;
      const won = r.winners ?? [r.winner];
      const title = r.team != null
        ? `${won.includes(s.you) ? "你们赢了！" : `${TEAM_NAMES[r.team]}获胜`}（${won.map((w) => `${COLORS[w]}方 ${s.seats[w]?.name ?? ""}`).join("、")}）`
        : r.winner === s.you ? "你赢了！" : `${COLORS[r.winner]}方 ${s.seats[r.winner]?.name ?? ""} 获胜`;
      action = v_flex().gap(6)
        .child(div().text_size(r.team != null ? 14 : 16).text_color(HEX[r.winner].dark).font_weight(700).child(title))
        .child(div().text_color("#4d5b6a").child(r.ranks.map((i, k) => `${k + 1}. ${COLORS[i]}方`).join("  ")))
        .child(this.button("again", "再来一局", (cx) => this.send(cx, { t: "again" }), { primary: true, w: 120 }));
    } else if (myTurn && s.phase === "roll") {
      action = this.button("roll", "掷骰子", (cx) => this.send(cx, { t: "roll" }), { primary: true, w: 150, h: 40, size: 16 });
    } else if (myTurn && s.phase === "move") {
      action = div().text_color("#1d3557").child(s.options?.length > 1 ? "点一架带金色圈的飞机走棋（鼠标移上去能看到落点）" : "只有一架能走，自动走…");
    } else {
      action = div().text_color("#4d5b6a").child(s.turn >= 0 ? `等待 ${COLORS[s.turn]}方 ${s.seats[s.turn]?.name ?? ""}…` : "");
    }
    const dice = card().child(h_flex().gap(12).items_center()
      .child(this.sideDie(s, roller))
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(div().text_color("#000").child(this.roll && !this.roll.landed ? `${COLORS[this.roll.seat]}方 掷骰子…`
          : s.dice && s.rolledBy >= 0 ? `${COLORS[s.rolledBy]}方掷出 ${s.dice}` : "还没掷骰子"))
        .child(action)))
      .child(div().text_size(12).text_color("#1d3557").child(s.msg ?? ""))
      .when(Boolean(d.ai), (el) => el.child(div().px(8).py(2).rounded(5).bg("#7a3db8e0").text_color("#ffffff").child("AI 正在替你下（MCP）")))
      .when(Boolean(toast), (el) => el.child(div().px(8).py(2).rounded(5).bg("#c42b1ce0").text_color("#ffffff").child(toast)));

    // 聊天 / 记录, with a count of chat lines you haven't seen (your own don't count).
    const ids = (s.chat ?? []).map((c) => c.id);
    if (this.tab === "chat") this.chatSeen = Math.max(this.chatSeen, ...ids, 0);
    const unread = (s.chat ?? []).filter((c) => c.id > this.chatSeen && !(c.seat === s.you && !c.ai)).length;
    const tab = (key, text, badge = 0) => own(div().id(`tab-${key}`)).h(26).px(10).gap(5).flex().items_center().rounded(6).cursor_pointer().text_size(12.5)
      .bg(this.tab === key ? "#1d3557" : this.over === `tab-${key}` ? "#e3ebf5" : "#00000000").text_color(this.tab === key ? "#ffffff" : "#1d3557")
      .on_hover(this.hover(`tab-${key}`)).on_click((_e, cx) => { this.tab = key; cx.notify(); })
      .child(text)
      .when(badge > 0, (el) => el.child(div().px(5).rounded(8).bg("#d62828").text_size(10.5).text_color("#ffffff").child(String(badge))));
    const talk = card().flex_1().min_h(0).overflow_hidden()
      .child(h_flex().gap(4).flex_none().child(tab("chat", "聊天", unread)).child(tab("log", "记录")))
      .child(this.tab === "chat" ? this.chatBox(s)
        : v_flex().flex_1().min_h(0).overflow_hidden().gap(4)
          .children([...(s.log ?? [])].reverse().slice(0, 12).map((l, k) => div().text_size(12).text_color(k ? "#4d5b6a" : "#000").child(l))));

    return v_flex().w(SIDE).h(h).flex_none().gap(10)
      .child(players)
      .child(dice)
      .child(talk)
      .child(h_flex().gap(8)
        .when(s.phase !== "over", (el) => el.child(this.button("auto", me?.auto ? "取消托管" : "托管", (cx) => this.send(cx, { t: "auto", on: !me?.auto }), { primary: Boolean(me?.auto) })))
        .child(div().flex_1())
        .child(this.button("leave2", "离开房间", (cx) => this.send(cx, { t: "_leave" }))));
  }

  game(s, d) {
    // The reported size is in window pixels; what we draw is scaled by the zoom.
    const z = Number(settings()?.zoom) || 1;
    const W = (this.size?.width ?? 1000 * z) / z, H = (this.size?.height ?? 720 * z) / z;
    const u = Math.max(22, Math.floor(Math.min(W - SIDE - 44, H - TITLE - 24) / GRID));
    return h_flex().size_full().p(12).gap(14).items_center().justify_center()
      .child(this.board(s, u))
      .child(this.side(s, d, GRID * u));
  }

  rulesPanel() {
    const lines = [
      "掷出 6（房主可改成 5 或 6）才能起飞，起飞后停在机场旁边标「起」的起飞点，下一步再上环道",
      "飞机顺时针绕一圈，再从自己颜色的终点跑道进入中心",
      "停在本色格子：跳到前面下一个本色格子（+4 步）",
      "停在本色飞行格（画着飞机）：沿虚线飞越对面那家的终点跑道（+12 步）",
      "停在对手所在的格子：把对手撞回机场；终点跑道里是安全的",
      "进终点要正好点数，多的倒退；掷出 6 走完再掷一次，连续三个 6 本回合作废",
      "先让四架飞机全部到达终点的获胜；每步 20 秒，超时两次自动托管",
    ];
    return div().absolute().top(0).left(0).size_full().flex().items_center().justify_center().bg("#00000060")
      .child(this.panel([
        h_flex().items_center().child(div().text_size(16).text_color("#1d3557").child("规则"))
          .child(div().flex_1())
          .child(this.button("rules-ok", "知道了", () => { this.rules = false; }, { w: 70, h: 26, size: 12 })),
        v_flex().gap(6).children(lines.map((l) => div().text_color("#333").child(l))),
      ], 620));
  }

  // ---- the frame

  /** A flat title-bar button in the layout's theme. */
  tool(t, id, text, onClick, o = {}) {
    const hot = this.over === id;
    return own(div().id(id)).h_full().px(o.px ?? 10).flex().items_center().justify_center().flex_none().cursor_pointer()
      .when(Boolean(o.w), (el) => el.w(o.w))
      .bg(hot ? (o.danger ? "#c42b1c" : t.hover) : "#00000000")
      .text_color(hot && o.danger ? "#ffffff" : t.foreground).text_size(o.size ?? 12.5)
      .on_hover(this.hover(id))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(text);
  }

  titleBar(t, d) {
    const s = d.status === "online" ? d.state : null;
    const where = s ? (d.host ? `房主 · ${COLORS[s.you]}方` : `${COLORS[s.you]}方 · 已连接 ${d.addr}`) : d.status === "connecting" ? "正在连接…" : "";
    const inRoom = Boolean(d.state) || d.status === "online";
    return h_flex().h(TITLE).flex_none().pl(12).items_center().gap(8).bg(t.chrome).border_b(1).border_color(t.border)
      .child(icon("fxq", 18))
      .child(div().text_size(13).font_weight(600).text_color(t.foreground).child("飞行棋"))
      .when(Boolean(where), (el) => el.child(div().text_size(12).text_color(t.muted).truncate().child(where)))
      .child(div().flex_1())
      .child(this.tool(t, "t-rules", "规则", () => { this.rules = !this.rules; }))
      .when(inRoom, (el) => el.child(this.tool(t, "t-leave", "离开房间", (cx) => this.send(cx, { t: "_leave" }))))
      .when(Boolean(this.overlay), (el) => el
        .child(div().w(1).h(16).mx(4).bg(t.border))
        .child(this.tool(t, "t-hide", "–", () => closeOverlay(this.overlay), { w: 40, size: 16 }))
        .child(this.tool(t, "t-close", "×", (cx) => this.quit(cx), { w: 44, size: 18, danger: true })));
  }

  /** ×: leave the room (and stop the server when hosting), then close. */
  quit(cx) {
    if (this.leaving) return;
    this.leaving = true;
    const id = this.overlay;
    cx.spawn(async (cx) => {
      try { await this.link.leave(cx); } catch {}
      closeOverlay(id);
    });
  }

  render(_cx) {
    const t = theme();
    const d = this.link.view();
    const s = d.status === "online" ? d.state : null;
    // A new turn: restart the clock, forget the hovered plane.
    const key = s ? `${s.phase}:${s.moves}:${s.turn}` : null;
    if (key !== this.seen) {
      this.seen = key;
      this.deadlineAt = s?.deadline != null ? Date.now() + s.deadline : null;
      this.preview = null;
    }
    const content = this.leaving ? div().text_color("#ffffff").child("正在离开…")
      : !s ? this.lobby(d) : s.phase === "lobby" ? this.room(s, d) : this.game(s, d);
    return v_flex().id("fxq").relative().size_full().font_family(FONT).text_size(13).overflow_hidden().bg(t.background)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .when(Boolean(this.overlay), (el) => el.rounded(10).border_1().border_color(t.border).shadow_lg())
      .child(this.titleBar(t, d))
      // Only the title bar drags the window.
      .child(own(div().id("fxq-body")).relative().flex_1().min_h(0).overflow_hidden()
        .child(fill("#2b6cb0", "#0f2a52"))
        .child(div().relative().size_full().flex().items_center().justify_center().child(content))
        .when(this.rules, (el) => el.child(this.rulesPanel())));
  }
}
