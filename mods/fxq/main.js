// 飞行棋 for any Herdr layout: a LAN board game for four (红 黄 蓝 绿), with
// computer players and an AI that can play your seat through MCP. One mod in
// two roles:
//   (default)  the game: a window (mod.open fxq) or a pane (tab.new {mod: "fxq"})
//   launcher   a status-bar button that shows the table and opens the window
// The connection lives in node programs (client.mjs, server.mjs), not here.

import { View } from "gpui-kit";
import { props } from "herdr";
import Table from "./table.js";
import Launcher from "./launcher.js";

export default class Fxq extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.role = pr.role === "launcher" ? new Launcher() : new Table();
    this.role.init(pr, cx);
  }

  render(cx) {
    return this.role.render(cx);
  }

  async close(cx) {
    await this.role?.close?.(cx);
  }
}
