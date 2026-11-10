// The board and the moves, without a server: node tests/rules.mjs
import * as R from "../mods/fxq/rules.js";

const assert = (ok, what) => { if (!ok) { console.error("FAIL:", what); process.exit(1); } };
const key = ([x, y]) => `${x},${y}`;
const N = R.GRID, H = R.HANGAR_SIZE;

// ---- the board
assert(R.RING.length === 52 && new Set(R.RING.map((q) => [q.x, q.y, q.w, q.h, q.half].join())).size === 52, "52 distinct ring squares");
for (let k = 0; k < 52; k++) {
  const [a, b] = [R.ringSpot(k), R.ringSpot((k + 1) % 52)];
  assert(Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1.25, `ring square ${k} is next to the next one`);
}
// Squares are 1 × 2 cells or halves of 2 × 2 squares, inside the board, never overlapping.
const cover = new Map();
R.RING.forEach((q, k) => {
  assert(q.half ? q.w === 2 && q.h === 2 : (q.w === 1 && q.h === 2) || (q.w === 2 && q.h === 1), `square ${k}'s shape`);
  assert(q.x >= 0 && q.y >= 0 && q.x + q.w <= N && q.y + q.h <= N, `square ${k} is on the board`);
  for (let x = q.x; x < q.x + q.w; x++) for (let y = q.y; y < q.y + q.h; y++) {
    const c = key([x, y]);
    cover.set(c, [...(cover.get(c) ?? []), q]);
  }
});
for (const [c, qs] of cover) assert(qs.length === 1 || (qs.length === 2 && qs.every((q) => q.half && q.x === qs[0].x && q.y === qs[0].y)), `cell ${c} belongs to one square (or both halves of one)`);
// Each hangar's inner corner is one 2 × 2 square cut into two halves, one after the other;
// each side ends in a 2 × 2 square whose other half is empty or a takeoff pad.
const halves = R.RING.map((q, k) => [q, k]).filter(([q]) => q.half);
const corners = halves.filter(([q]) => halves.some(([o]) => o !== q && o.x === q.x && o.y === q.y));
assert(corners.length === 8 && halves.length === 16, "four cut inner corners, eight side ends");
for (const [q, k] of corners) {
  const [q2, k2] = corners.find(([o, j]) => j !== k && o.x === q.x && o.y === q.y);
  assert(Math.abs(k - k2) === 1 && ({ ll: "ur", ur: "ll", ul: "lr", lr: "ul" })[q.half] === q2.half, `corner ${q.x},${q.y} is two halves in a row`);
}
for (let c = 0; c < 4; c++) {
  assert(R.squareColor(R.ring(c, R.LAST)) === c, `${R.COLORS[c]} turns off on its own color`);
  assert(R.squareColor(R.FLY_SQUARES[c]) === c && R.squareColor(R.FLY_LANDINGS[c]) === c, `${R.COLORS[c]}'s flight starts and ends on its color`);
  assert([...Array(52).keys()].filter((k) => R.squareColor(k) === c).length === 13, `${R.COLORS[c]} owns 13 squares`);
  for (let h = 1; h < R.HOME - R.LAST; h++) {
    const cell = key(R.homeCell(c, h));
    assert(!cover.has(cell), `home column ${c}/${h} is off the ring`);
  }
  const e = R.RING[R.ring(c, R.LAST)], first = R.homeCell(c, 1), [ex, ey] = R.ringSpot(R.ring(c, R.LAST));
  assert(Math.abs(ex - (first[0] + 0.5)) + Math.abs(ey - (first[1] + 0.5)) <= 1.5 && [ex, ey].some((v) => v === N / 2), `${R.COLORS[c]} turns off at the middle of its side`);
  assert(!e.half, "a turn-off is a whole square");
  // The pad is the empty half of the square its first step is on, beside its hangar.
  const p1 = R.RING[R.ring(c, 1)], [px, py] = R.PAD[c];
  assert(p1.half && px > p1.x && px < p1.x + 2 && py > p1.y && py < p1.y + 2 && !halves.some(([o]) => o !== p1 && o.x === p1.x && o.y === p1.y), `${R.COLORS[c]}'s pad shares a side end with its first square`);
  const [hx, hy] = R.HANGAR[c];
  assert(Math.max(hx - px, px - (hx + H), 0) + Math.max(hy - py, py - (hy + H), 0) < 1.5, `${R.COLORS[c]}'s pad is by its hangar`);
  // The flight is level, from one inner corner to the next, over the opposite color's home column.
  const [fx, fy] = R.ringSpot(R.FLY_SQUARES[c]), [lx, ly] = R.ringSpot(R.FLY_LANDINGS[c]);
  assert(Math.abs(fx - lx) < 1e-9 || Math.abs(fy - ly) < 1e-9, `${R.COLORS[c]}'s flight is straight`);
  assert(corners.some(([, k]) => k === R.FLY_SQUARES[c]) && corners.some(([, k]) => k === R.FLY_LANDINGS[c]), `${R.COLORS[c]} flies corner to corner`);
  assert(key([Math.floor((fx + lx) / 2), Math.floor((fy + ly) / 2)]) === key(R.homeCell((c + 2) % 4, 3)), `${R.COLORS[c]} flies over the opposite home column`);
}
// Hangars fill the corners, and nothing else sits in them.
for (const [hx, hy] of R.HANGAR) {
  assert((hx === 0 || hx + H === N) && (hy === 0 || hy + H === N), "a hangar fills a corner");
  for (const cell of cover.keys()) {
    const [x, y] = cell.split(",").map(Number);
    assert(!(x >= hx && x < hx + H && y >= hy && y < hy + H), `square ${cell} is off the hangars`);
  }
}
for (let c = 0; c < 4; c++) for (let j = 0; j < 4; j++) {
  const [x, y] = R.hangarSpot(c, j), [hx, hy] = R.HANGAR[c];
  assert(x - 0.7 > hx && x + 0.7 < hx + H && y - 0.7 > hy && y + 0.7 < hy + H, "parking spots fit their hangar");
}

// ---- moves
const s = (c, p, d, t) => R.step(c, p, d, t && R.TAKEOFF[t]);
assert(s(0, -1, 6)?.to === 0 && s(0, -1, 5) === null && s(0, -1, 5, 56)?.to === 0, "takeoff on 6 (or 5 with the 5/6 rule), onto the pad");
assert(s(0, 0, 1).to === 1 && R.posOf(0, 0).join() === R.PAD[0].join(), "from the pad, a 1 is the first ring square");
const own = [...Array(R.LAST).keys()].map((i) => i + 1).filter((p) => R.squareColor(R.ring(0, p)) === 0);
const a = own.find((p) => p + 4 <= R.LAST && p + 4 !== R.FLY_FROM && p !== R.FLY_FROM && p - 3 > 0);
assert(s(0, a - 3, 3).to === a + 4 && s(0, a - 3, 3).jump, "own color jumps 4");
assert(s(0, R.FLY_FROM - 4, 4).to === R.FLY_TO && s(0, R.FLY_FROM - 4, 4).fly, "the flight square flies 12");
assert(s(0, 47, 3).to === 50 && !s(0, 47, 3).jump, "no jump past the turn-off");
assert(s(0, 54, 5).to === 53 && s(0, 54, 5).bounce, "an overshoot walks back");
assert(s(0, 52, 4).to === R.HOME && s(0, R.HOME, 1) === null, "home on the exact count, then done");
// Nothing is captured on a pad.
const padded = [[3, -1, -1, -1], [0, -1, -1, -1], null, null];
assert(R.options(padded, 0, 1).every((o) => !o.captures.length), "pads are safe");
for (let c = 0; c < 4; c++) for (let p = 0; p < R.HOME; p++) for (let d = 1; d <= 6; d++) {
  const m = R.step(c, p, d);
  assert(m && m.to >= 1 && m.to <= R.HOME && (m.to !== p || m.bounce), `step ${c}/${p}/${d} goes somewhere`);
  const w = R.walk(m);
  assert(w.at(-1).p === m.to && w.filter((x) => !x.hop).length === (m.bounce ? 2 * R.HOME - p - m.stops[0] : m.stops[0] - p), `walk ${c}/${p}/${d} passes every square`);
}
// Yellow's plane sits on one of red's own squares; red lands there (and jumps on): yellow goes home.
const landing = own.find((p) => p > 10 && p + 4 <= R.LAST && p !== R.FLY_FROM && p + 4 !== R.FLY_FROM);
const planes = [[landing - 6, -1, -1, -1], [(R.ring(0, landing) - R.START[1] + 52) % 52, -1, -1, -1], null, null];
const hit = R.options(planes, 0, 6).find((o) => o.plane === 0);
assert(hit.jump && hit.captures.length === 1 && hit.captures[0].seat === 1 && hit.captures[0].at === landing, "landing on an opponent sends it home, even before a jump");
assert(R.apply(planes, 0, hit)[1][0] === -1 && R.apply(planes, 0, hit)[0][0] === landing + 4, "apply moves and sends home");

// ---- whole games between computer players
let longest = 0, captures = 0, flights = 0, jumps = 0;
for (let game = 0; game < 300; game++) {
  const n = 2 + (game % 3);
  const ps = [0, 1, 2, 3].map((c) => (c < n ? [-1, -1, -1, -1] : null));
  const rule = game % 2 ? R.TAKEOFF[56] : R.TAKEOFF[6];
  let turn = 0, rolls = 0, winner = -1;
  while (winner < 0) {
    assert(++rolls < 5000, "a game ends");
    const d = 1 + Math.floor(Math.random() * 6);
    const pick = R.botChoose(ps, turn, d, rule);
    if (pick !== null) {
      const mv = R.options(ps, turn, d, rule).find((o) => o.plane === pick);
      captures += mv.captures.length; flights += mv.fly; jumps += mv.jump;
      const next = R.apply(ps, turn, mv);
      for (let c = 0; c < 4; c++) ps[c] = next[c];
      for (let c = 0; c < n; c++) for (let j = 0; j < 4; j++) {
        const p = ps[c][j];
        if (p < 1 || p > R.LAST) continue;
        for (let o = 0; o < n; o++) if (o !== c) for (const q of ps[o]) assert(!(q >= 1 && q <= R.LAST && R.ring(o, q) === R.ring(c, p)), "no two colors share a square");
      }
      if (R.homeCount(ps[turn]) === 4) winner = turn;
    }
    if (d !== 6) turn = (turn + 1) % n;
  }
  longest = Math.max(longest, rolls);
  const ranks = R.ranking(ps, [...Array(n).keys()], winner);
  assert(ranks[0] === winner && ranks.length === n, "the winner ranks first");
}
console.log(`300 computer games: longest ${longest} rolls, ${captures} captures, ${flights} flights, ${jumps} jumps`);
console.log("rules ok");
