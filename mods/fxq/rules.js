// 飞行棋 rules, shared by the server, the window and the MCP server. No dependencies.
//
// The board is a 17 × 17 grid with a hangar (4 × 4) in each corner:
// 红 top left, 黄 top right, 绿 bottom right, 蓝 bottom left. A ring of 52
// squares runs clockwise around the hangars in a lane two cells wide: along
// each side 5 squares (1 × 2), with a 2 × 2 square cut on the diagonal at each
// end (the half toward the middle is a square of the ring; the half toward
// the corner is empty, or a color's takeoff pad), then in along a hangar's
// side (2 squares), round its inner corner (a 2 × 2 square cut into two
// triangles, a square each), and back out along its other side (2 squares).
// Each color turns off the ring at the middle square of its own side
// (红 left, 黄 top, 绿 right, 蓝 bottom) into a home column of 5 squares to the
// 3 × 3 center.
// A plane's progress p counts its steps:
//   -1        in the hangar
//   0         on its takeoff pad, beside the hangar (off the ring: safe)
//   1 … 50    on the ring (square ring(c, p)); 50 is its turn-off square
//   51 … 55   the home column (only its own color goes there: safe)
//   56        home (the center)
// Ring squares take the four colors in turn, so each color owns every 4th
// square (its turn-off included). Stopping on your own color jumps you to the
// next one (+4). Each color also has a flight square (p 18, a triangle of a
// hangar's inner corner): stopping there flies you straight across the arm of
// the color opposite, over its home column, to the same color's triangle at
// the next corner (p 30). A jump can carry you onto the flight square, and you fly on; a flight ends the move.
// Stopping where opponents stand sends them back to their hangars. Getting
// home takes the exact count: the rest of the roll walks back out.

export const COLORS = ["红", "黄", "绿", "蓝"];
export const HEX = [
  { main: "#e0443c", light: "#f6c1bc", dark: "#9b231d" },
  { main: "#f0b323", light: "#fbe3a6", dark: "#a97a06" },
  { main: "#36a356", light: "#bfe6c9", dark: "#1d6b34" },
  { main: "#2f7fd8", light: "#b9d6f6", dark: "#1a4f8f" },
];
export const GRID = 17;
export const RING_SIZE = 52;
export const LAST = 50;
export const HOME = 56;
export const JUMP = 4;
export const FLY_FROM = 18;
export const FLY_TO = 30;
/** ring(c, p) for p ≥ 1: START[c] is the square just before a color's first one. */
export const START = [4, 17, 30, 43];
/** Which rolls take a plane off: config.takeoff is 6 (only a six) or 56 (a five or a six). */
export const TAKEOFF = { 6: [6], 56: [5, 6] };

export const ring = (c, p) => (START[c] + p) % RING_SIZE;
export const FLY_SQUARES = [0, 1, 2, 3].map((c) => ring(c, FLY_FROM));
export const FLY_LANDINGS = [0, 1, 2, 3].map((c) => ring(c, FLY_TO));

/** A ring square's color: the four take turns, so each color's turn-off (and flight squares) are its own. */
export const squareColor = (k) => (k + 2) % 4;

// ---- the board on the 17 × 17 grid: x is the column, y the row

/** A quarter turn clockwise about the board's middle, for a piece { x, y, w, h, half } or a point [x, y]. */
const HALF_TURN = { ul: "ur", ur: "lr", lr: "ll", ll: "ul" };
const turn = (p) => ({ x: GRID - (p.y + p.h), y: p.x, w: p.h, h: p.w, half: p.half ? HALF_TURN[p.half] : null });
const turnPoint = ([x, y]) => [GRID - y, x];
const turned = (p, q, f) => { for (let i = 0; i < q; i++) p = f(p); return p; };

/**
 * The ring, clockwise from the bottom of the left side. Each square is a piece
 * { x, y, w, h, half }: a 1 × 2 (or 2 × 1) cell, or half of a 2 × 2 square cut
 * on a diagonal: "ll" / "ur" are the lower-left / upper-right of a cut from the
 * top-left corner, "ul" / "lr" the upper-left / lower-right of a cut from the
 * top-right. One quarter is laid out; the others are it turned.
 */
const QUARTER = [
  { x: 0, y: 10, w: 2, h: 1 }, { x: 0, y: 9, w: 2, h: 1 }, { x: 0, y: 8, w: 2, h: 1 }, { x: 0, y: 7, w: 2, h: 1 }, { x: 0, y: 6, w: 2, h: 1 },
  { x: 0, y: 4, w: 2, h: 2, half: "lr" },
  { x: 2, y: 4, w: 1, h: 2 }, { x: 3, y: 4, w: 1, h: 2 },
  { x: 4, y: 4, w: 2, h: 2, half: "ll" }, { x: 4, y: 4, w: 2, h: 2, half: "ur" },
  { x: 4, y: 3, w: 2, h: 1 }, { x: 4, y: 2, w: 2, h: 1 },
  { x: 4, y: 0, w: 2, h: 2, half: "lr" },
].map((p) => ({ half: null, ...p }));
export const RING = [0, 1, 2, 3].flatMap((q) => QUARTER.map((p) => turned(p, q, turn)));

/** A right triangle's in-centre, from its right angle (legs of 2): as far from all three sides. */
const INSET = 2 - Math.SQRT2;
/** Where a ring square's middle is (a triangle's: the centre of the circle inside it). */
export function ringSpot(k) {
  const { x, y, w, h, half } = RING[k];
  const [fx, fy] = { ul: [INSET, INSET], ur: [2 - INSET, INSET], ll: [INSET, 2 - INSET], lr: [2 - INSET, 2 - INSET] }[half] ?? [w / 2, h / 2];
  return [x + fx, y + fy];
}

/** Home column square h (1…5) of color c: its cell's top left. */
export function homeCell(c, h) {
  const p = turned({ x: 1 + h, y: 8, w: 1, h: 1, half: null }, c, turn);
  return [p.x, p.y];
}

/** The center: 3 × 3, a triangle per color; where each color's planes stand at home. */
export const CENTER = [7, 7];
export const HOME_SPOT = [[7.5, 8.5], [8.5, 7.5], [9.5, 8.5], [8.5, 9.5]];

/** Takeoff pads: the empty half of the 2 × 2 square at the end of each color's side, by its hangar. */
export const PAD = [0, 1, 2, 3].map((c) => turned([INSET, 4 + INSET], c, turnPoint));

/** Hangars: the 4 × 4 corner of each color (top left given), four parking spots in each. */
export const HANGAR = [[0, 0], [13, 0], [13, 13], [0, 13]];
export const HANGAR_SIZE = 4;
/** A parking spot's middle. */
export function hangarSpot(c, j) {
  const [x, y] = HANGAR[c];
  return [x + 1.1 + (j % 2) * 1.8, y + 1.1 + Math.floor(j / 2) * 1.8];
}

/** Where a plane of color c (number j) at progress p stands on the grid: its middle. */
export function posOf(c, p, j = 0) {
  if (p < 0) return hangarSpot(c, j);
  if (p === 0) return PAD[c];
  if (p <= LAST) return ringSpot(ring(c, p));
  if (p < HOME) { const [x, y] = homeCell(c, p - LAST); return [x + 0.5, y + 0.5]; }
  return HOME_SPOT[c];
}

/** Plain words for a position. */
export function where(p) {
  if (p < 0) return "机场";
  if (p === 0) return "起飞点";
  if (p === HOME) return "已到终点";
  if (p > LAST) return `终点跑道第 ${p - LAST} 格`;
  return `第 ${p} 步`;
}

// ---- moves

/**
 * Where a plane of color c at progress p goes on roll d: { from, to, stops,
 * takeoff, jump, fly, bounce }, or null if it can't move. `stops` are the
 * squares it lands on (the roll's, then after a jump or a flight).
 */
export function step(c, p, d, takeoff = TAKEOFF[6]) {
  if (p === HOME) return null;
  if (p < 0) return takeoff.includes(d) ? { from: p, to: 0, stops: [0], takeoff: true, jump: false, fly: false, bounce: false } : null;
  let to = p + d, bounce = false;
  if (to > HOME) { to = 2 * HOME - to; bounce = true; }
  const stops = [to];
  let jump = false, fly = false;
  // A jump may land on the flight square and fly on; a flight ends the move.
  while (!bounce && to <= LAST) {
    if (!fly && to === FLY_FROM) { to = FLY_TO; fly = true; stops.push(to); break; }
    if (!jump && to > 0 && to + JUMP <= LAST && squareColor(ring(c, to)) === c) { to += JUMP; jump = true; stops.push(to); continue; }
    break;
  }
  return { from: p, to, stops, takeoff: false, jump, fly, bounce };
}

/**
 * Teams: `teams[seat]` is a seat's team (2v2: 红 and 绿 against 黄 and 蓝), or
 * null when everyone plays for themselves. Teammates never send each other home.
 */
export const TEAM_OF = (seat) => seat % 2;
export const TEAM_NAMES = ["红绿队", "黄蓝队"];
const mates = (teams, a, b) => Boolean(teams) && teams[a] != null && teams[a] === teams[b];

/** Opponent planes a move sends home: every one on a ring square the move stops on (pads are off the ring). */
export function captures(planes, c, mv, teams = null) {
  const hit = [];
  for (const s of mv.stops) {
    if (s < 1 || s > LAST) continue;
    const k = ring(c, s);
    planes.forEach((ps, o) => {
      if (o === c || !ps || mates(teams, c, o)) return;
      ps.forEach((q, j) => {
        if (q >= 1 && q <= LAST && ring(o, q) === k && !hit.some((h) => h.seat === o && h.plane === j)) hit.push({ seat: o, plane: j, from: q, at: s });
      });
    });
  }
  return hit;
}

/** Every plane of color c that can move on roll d, with what the move does. */
export function options(planes, c, d, takeoff = TAKEOFF[6], teams = null) {
  const out = [];
  planes[c].forEach((p, j) => {
    const mv = step(c, p, d, takeoff);
    if (mv) out.push({ plane: j, ...mv, captures: captures(planes, c, mv, teams) });
  });
  return out;
}

/**
 * How the window shows a move (ms): a step, a takeoff / jump / flight glide,
 * the pause where it hits someone (the bump), and the flight home of whoever it hit.
 */
export const STEP_MS = 300;
export const HOP_MS = 650;
export const HIT_MS = 700;
export const FLY_HOME_MS = 1000;
/** How long the window tumbles the die before it shows the roll (ms). */
export const ROLL_MS = 900;

/**
 * The positions a move passes, one at a time, after where it starts:
 * [{ p, hop }] (hop: a takeoff, jump or flight, drawn as one glide).
 */
export function walk(mv) {
  if (mv.takeoff) return [{ p: 0, hop: true }];
  const out = [];
  const first = mv.stops[0];
  if (mv.bounce) {
    for (let q = mv.from + 1; q <= HOME; q++) out.push({ p: q, hop: false });
    for (let q = HOME - 1; q >= first; q--) out.push({ p: q, hop: false });
  } else for (let q = mv.from + 1; q <= first; q++) out.push({ p: q, hop: false });
  for (const s of mv.stops.slice(1)) out.push({ p: s, hop: true });
  return out;
}

/** How long a move takes to show, the planes it sends home flying back included. */
export const walkMs = (mv) => walk(mv).reduce((t, w) => t + (w.hop ? HOP_MS : STEP_MS), 0)
  + new Set((mv.captures ?? []).map((h) => h.at)).size * HIT_MS + (mv.captures?.length ? FLY_HOME_MS : 0);

/** The planes after a move (a new array). */
export function apply(planes, c, mv) {
  const next = planes.map((ps) => ps && [...ps]);
  next[c][mv.plane] = mv.to;
  for (const h of mv.captures) next[h.seat][h.plane] = -1;
  return next;
}

export const homeCount = (ps) => ps.filter((p) => p === HOME).length;
export const progress = (ps) => ps.reduce((n, p) => n + Math.max(p, 0), 0);

/**
 * How exposed a plane of color c at p is: opponent planes up to six squares
 * behind it, on the ring or their pad (that won't turn off into their home
 * column first). Pads, home columns and teammates are safe.
 */
export function danger(planes, c, p, teams = null) {
  if (p < 1 || p > LAST) return 0;
  const k = ring(c, p);
  let risk = 0;
  planes.forEach((ps, o) => {
    if (o === c || !ps || mates(teams, c, o)) return;
    for (const q of ps) {
      if (q < 0 || q > LAST) continue;
      const dist = (k - ring(o, q) + RING_SIZE) % RING_SIZE;
      if (dist >= 1 && dist <= 6 && q + dist <= LAST) risk += 1;
    }
  });
  return risk;
}

/** The computer's choice of plane for roll d (or null when none can move). */
export function botChoose(planes, c, d, takeoff = TAKEOFF[6], teams = null) {
  const opts = options(planes, c, d, takeoff, teams);
  if (!opts.length) return null;
  let best = null, bestScore = -Infinity;
  for (const mv of opts) {
    const after = apply(planes, c, mv);
    let s = mv.to / 10;
    for (const h of mv.captures) s += 45 + h.from / 2;
    if (mv.takeoff) s += 30;
    if (mv.to === HOME) s += 40;
    if (mv.from <= LAST && mv.to > LAST) s += 22;
    if (mv.fly) s += 14;
    if (mv.jump) s += 7;
    if (mv.bounce) s -= 4;
    s -= danger(after, c, mv.to, teams) * 16;
    s += danger(planes, c, mv.from, teams) * 12;
    s += Math.random() * 0.5;
    if (s > bestScore) { bestScore = s; best = mv; }
  }
  return best.plane;
}

/** A team's planes all home: both its players done. */
export const teamDone = (planes, teams, t) => planes.every((ps, o) => !ps || teams[o] !== t || homeCount(ps) === 4);

/**
 * Final places: the winner (in 2v2, the winning team, its players by planes
 * home and progress), then everyone else by planes home and progress.
 */
export function ranking(planes, players, winner, teams = null) {
  const team = (i) => (teams ? (teams[i] === teams[winner] ? 0 : 1) : i === winner ? 0 : 1);
  return [...players].sort((a, b) =>
    team(a) - team(b) || (a === winner ? -1 : b === winner ? 1 : 0) || homeCount(planes[b]) - homeCount(planes[a]) || progress(planes[b]) - progress(planes[a]));
}
