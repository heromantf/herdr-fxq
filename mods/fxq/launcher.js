// The 飞行棋 button for a layout's status bar (props { role: "launcher" }):
// the icon, plus what the table is doing when there's something to say, in the
// bar's own colors; a click opens or hides the game window (mod.open fxq).
// When it's your turn and the window isn't open, the text blinks in the
// theme's "needs you" color.
// With props { block: "<its block id>" } it sizes its own block (layout.resize):
// ICON_ONLY wide with just the icon, WITH_TEXT wide with text, so several of
// these sit side by side without gaps. Without `block` the layout decides.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, shared, theme, run } from "herdr";
import { Link } from "./net.js";
import { icon, OPEN } from "./table.js";
import { HOME } from "./rules.js";

const ICON_ONLY = 34, WITH_TEXT = 168;

export default class Launcher {
  init(_p, cx) {
    this.hot = false;
    this.width = null;
    this.link = new Link();
    this.link.start(cx);
  }

  /** Fits the block to what's shown, once per change. */
  fit(cx, text) {
    const block = props()?.block;
    const want = text ? WITH_TEXT : ICON_ONLY;
    if (!block || want === this.width) return;
    this.width = want;
    cx.spawn(async () => { try { await run("layout.resize", { id: block, px: want }); } catch {} });
  }

  /** Only while there's something to say; not at a table, the icon alone. */
  text(d, s, yours) {
    if (yours) return s.phase === "roll" ? "轮到你掷骰子" : "轮到你走棋";
    const home = s?.planes?.[s.you]?.filter((p) => p === HOME).length ?? 0;
    if (d.ai && s && (s.phase === "roll" || s.phase === "move")) return `AI 代下中 · 到达 ${home}/4`;
    if (d.status === "connecting") return "连接中";
    if (!s) return d.status === "lost" ? "掉线了" : null;
    if (s.phase === "lobby") return `房间 ${s.seats.filter(Boolean).length}/4`;
    if (s.phase === "over") return s.result?.winner === s.you ? "你赢了" : "本局结束";
    return `对局中 · 到达 ${home}/4`;
  }

  render(cx) {
    const t = theme();
    const d = this.link.view();
    const s = d.status === "online" ? d.state : null;
    const open = Boolean(shared(OPEN));
    // An AI playing your seat (mcp.mjs) or 托管 means nothing needs you.
    const yours = Boolean(s && (s.phase === "roll" || s.phase === "move") && s.turn === s.you && !s.seats?.[s.you]?.auto && !d.ai);
    const text = this.text(d, s, yours);
    this.fit(cx, text);
    const label = text && div().text_color(yours ? t.blocked : this.hot ? t.foreground : t.muted).child(text);
    const button = h_flex().id("fxq-launcher").h_full().px(10).gap(6).items_center().cursor_pointer()
      .bg(this.hot ? t.hover : t.chrome)
      .on_hover((on, cx) => { this.hot = on; cx.notify(); })
      .on_click(() => run("mod.open", { name: "fxq" }))
      .child(icon("fxq", 14))
      .when(Boolean(label), (el) => el.child(yours && !open ? label.loop("opacity", { from: 0.35, to: 1, period: 900 }) : label));
    return h_flex().size_full().justify_end().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).child(button);
  }
}
