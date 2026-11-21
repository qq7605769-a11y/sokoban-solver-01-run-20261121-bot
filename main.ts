// Room-by-room push-optimal Sokoban solver.
//
// The levels this bounty draws are a hallway with rooms off it (see the kit's
// RULES.txt): every box stays in its room, so a level's push-optimal count is
// the sum of its rooms' optima. This program therefore
//   1. cuts the level into rooms (the floor off the player's row, the hallway),
//   2. solves each room push-optimally on its own (A* over pushes, with a
//      minimum box-to-goal matching heuristic, dead-square and frozen-block
//      pruning, and a transposition table keyed on the player's reachable
//      region plus the boxes), and
//   3. walks the player between rooms through the hallway and concatenates
//      the rooms' move strings.
// The answer is a string of u/d/l/r moves (an upper letter marks a push);
// only the push count is scored, and the rooms' optima add up to the level's.
//
// Deterministic: no clock, no randomness, no time-based cut-off, so two runs
// write the same bytes. Node 22, standard library only.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** A direction: step (dx, dy) and its move letter. */
const DIRS: { dx: number; dy: number; ch: string }[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (short rows and off-board squares count as walls)
  goal: Uint8Array; // 1 = goal
  boxes: number[]; // sorted
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseBoard(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

/**
 * Flood fill over the cells that are neither walls nor occupied, from `start`.
 * Returns a stamp; a cell belongs to the region when seen[cell] === stamp, and
 * `low` holds the region's lowest cell. Stamp-based, so no allocation per call.
 */
function flooder(size: number) {
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let low = -1;
  return {
    seen,
    get low() {
      return low;
    },
    region(wall: Uint8Array, occ: Uint8Array, start: number, w: number): number {
      stamp += 1;
      const cur = stamp;
      low = -1;
      if (wall[start] === 1 || occ[start] === 1) return cur;
      let n = 0;
      stack[n++] = start;
      seen[start] = cur;
      low = start;
      for (let i = 0; i < n; i++) {
        const c = stack[i]!;
        if (c < low) low = c;
        const x = c % w;
        if (c - w >= 0) {
          const q = c - w;
          if (wall[q] === 0 && occ[q] === 0 && seen[q] !== cur) {
            seen[q] = cur;
            stack[n++] = q;
          }
        }
        if (c + w < size) {
          const q = c + w;
          if (wall[q] === 0 && occ[q] === 0 && seen[q] !== cur) {
            seen[q] = cur;
            stack[n++] = q;
          }
        }
        if (x > 0) {
          const q = c - 1;
          if (wall[q] === 0 && occ[q] === 0 && seen[q] !== cur) {
            seen[q] = cur;
            stack[n++] = q;
          }
        }
        if (x < w - 1) {
          const q = c + 1;
          if (wall[q] === 0 && occ[q] === 0 && seen[q] !== cur) {
            seen[q] = cur;
            stack[n++] = q;
          }
        }
      }
      return cur;
    },
  };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case letters. */
function walkPath(
  wall: Uint8Array,
  occ: Uint8Array,
  from: number,
  to: number,
  w: number,
  size: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    const x = p % w;
    for (let di = 0; di < 4; di++) {
      const d = DIRS[di]!;
      const nx = x + d.dx;
      if (nx < 0 || nx >= w) continue;
      const q = p + d.dy * w + d.dx;
      if (q < 0 || q >= size) continue;
      if (wall[q] === 1 || occ[q] === 1 || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.ch;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** Replay `moves` on a board; null on an illegal move. */
function applyMoves(
  wall: Uint8Array,
  boxes: number[],
  player: number,
  moves: string,
  w: number,
  h: number,
): { player: number; boxes: number[]; pushes: number } | null {
  const boxSet = new Set(boxes);
  let p = player;
  let pushes = 0;
  for (const raw of moves) {
    const ch = raw.toLowerCase();
    const d = DIRS.find((dd) => dd.ch === ch);
    if (d === undefined) return null;
    const x = p % w;
    const y = Math.floor(p / w);
    const nx = x + d.dx;
    const ny = y + d.dy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return null;
    const next = ny * w + nx;
    if (wall[next] === 1) return null;
    if (boxSet.has(next)) {
      const bx = nx + d.dx;
      const by = ny + d.dy;
      if (bx < 0 || bx >= w || by < 0 || by >= h) return null;
      const beyond = by * w + bx;
      if (wall[beyond] === 1 || boxSet.has(beyond)) return null;
      boxSet.delete(next);
      boxSet.add(beyond);
      pushes++;
    }
    p = next;
  }
  return { player: p, boxes: [...boxSet].sort((a, b) => a - b), pushes };
}

/** Replay a full solution: whether it is legal, how many pushes, whether solved. */
function simulate(board: Board, moves: string): { ok: boolean; pushes: number; solved: boolean } {
  const res = applyMoves(board.wall, board.boxes, board.player, moves, board.w, board.h);
  if (res === null) return { ok: false, pushes: 0, solved: false };
  return { ok: true, pushes: res.pushes, solved: res.boxes.every((b) => board.goal[b] === 1) };
}

/** One room: its floor, its boxes and goals, its door and the hallway cell outside it. */
interface Room {
  cells: number[]; // arena floor cells (room floor plus the outside cell), sorted
  boxCells: Uint8Array; // 1 where a box may stand (the room floor only)
  wall: Uint8Array; // 1 where the room search may not go (board wall or outside the arena)
  boxes: number[]; // sorted
  goals: number[]; // sorted
  goalSet: Uint8Array;
  live: Uint8Array; // 1 where a box can still reach some goal through box cells
  cornerDead: Uint8Array; // 1 where a box off its goal can never be pushed again
  distFromGoal: Int32Array[]; // per goal, BFS distance over box cells (-1 unreachable)
  door: number; // the room cell in the wall row, opening onto the hallway
  outside: number; // the hallway cell outside the door
}

/** The minimum box-to-goal assignment cost (BFS distances), or Infinity when none exists. */
function matchingHeuristic(boxes: number[], distFromGoal: Int32Array[], n: number): number {
  let best = Infinity;
  const used = new Array<boolean>(n).fill(false);
  const rec = (bi: number, cost: number): void => {
    if (cost >= best) return;
    if (bi === n) {
      best = cost;
      return;
    }
    const b = boxes[bi]!;
    for (let gi = 0; gi < n; gi++) {
      if (used[gi]) continue;
      const d = distFromGoal[gi]![b]!;
      if (d < 0) continue;
      used[gi] = true;
      rec(bi + 1, cost + d);
      used[gi] = false;
    }
  };
  rec(0, 0);
  return best;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes. */
function frozenAt(
  t: number,
  occ: Uint8Array,
  rWall: Uint8Array,
  goalSet: Uint8Array,
  w: number,
  h: number,
): boolean {
  const tx = t % w;
  const ty = Math.floor(t / w);
  for (const [ox, oy] of [
    [-1, -1],
    [0, -1],
    [-1, 0],
    [0, 0],
  ]) {
    const x = tx + ox;
    const y = ty + oy;
    if (x < 0 || y < 0 || x + 1 >= w || y + 1 >= h) continue;
    const a = y * w + x;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    const filled = (i: number): boolean => rWall[i] === 1 || occ[i] === 1;
    if (!filled(a) || !filled(b) || !filled(c) || !filled(d)) continue;
    const offGoalBox = (i: number): boolean => occ[i] === 1 && goalSet[i] !== 1;
    if (offGoalBox(a) || offGoalBox(b) || offGoalBox(c) || offGoalBox(d)) return true;
  }
  return false;
}

/** A room's derived tables: live squares, corner dead squares, goal distances. */
function prepareRoom(
  board: Board,
  floorCells: number[],
  boxCellList: number[],
  boxes: number[],
  goals: number[],
  door: number,
  outside: number,
): Room {
  const { w, h, wall } = board;
  const size = w * h;
  const arena = new Uint8Array(size);
  for (const c of floorCells) arena[c] = 1;
  arena[outside] = 1;
  const rWall = new Uint8Array(size);
  for (let i = 0; i < size; i++) rWall[i] = wall[i] === 1 || arena[i] !== 1 ? 1 : 0;
  const boxCells = new Uint8Array(size);
  for (const c of boxCellList) boxCells[c] = 1;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  // Live: a box cell from which some goal is reachable through box cells.
  const live = new Uint8Array(size);
  const q: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    q.push(g);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const x = c % w;
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k]!;
      const nx = x + d.dx;
      if (nx < 0 || nx >= w) continue;
      const n = c + d.dy * w + d.dx;
      if (n < 0 || n >= size) continue;
      if (boxCells[n] !== 1 || live[n] === 1) continue;
      live[n] = 1;
      q.push(n);
    }
  }
  // Corner dead: a non-goal box cell with walls on two perpendicular sides.
  const cornerDead = new Uint8Array(size);
  for (const c of boxCellList) {
    if (goalSet[c] === 1) continue;
    const x = c % w;
    const y = Math.floor(c / w);
    const up = y === 0 || rWall[c - w] === 1;
    const down = y === h - 1 || rWall[c + w] === 1;
    const left = x === 0 || rWall[c - 1] === 1;
    const right = x === w - 1 || rWall[c + 1] === 1;
    if ((up && left) || (up && right) || (down && left) || (down && right)) cornerDead[c] = 1;
  }
  // Goal distances over box cells.
  const distFromGoal: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const qq = [g];
    for (let qi = 0; qi < qq.length; qi++) {
      const c = qq[qi]!;
      const x = c % w;
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k]!;
        const nx = x + d.dx;
        if (nx < 0 || nx >= w) continue;
        const n = c + d.dy * w + d.dx;
        if (n < 0 || n >= size) continue;
        if (boxCells[n] !== 1 || dist[n] !== -1) continue;
        dist[n] = dist[c]! + 1;
        qq.push(n);
      }
    }
    distFromGoal.push(dist);
  }
  return {
    cells: floorCells.slice().sort((a, b) => a - b),
    boxCells,
    wall: rWall,
    boxes: boxes.slice().sort((a, b) => a - b),
    goals: goals.slice().sort((a, b) => a - b),
    goalSet,
    live,
    cornerDead,
    distFromGoal,
    door,
    outside,
  };
}

interface RoomSolution {
  pushes: number;
  moves: string;
  endPlayer: number;
}

/**
 * A room's push-optimal solution, A* over pushes from `startPlayer` (the hallway
 * cell outside the door). `requireExit` also demands the player can still reach
 * the outside cell once the boxes are home. Null when the search gives up.
 */
function solveRoom(
  board: Board,
  room: Room,
  startPlayer: number,
  maxStates: number,
  requireExit: boolean,
): RoomSolution | null {
  const { w, h } = board;
  const size = w * h;
  const rWall = room.wall;
  const boxCells = room.boxCells;
  const goals = room.goals;
  const goalSet = room.goalSet;
  const n = goals.length;
  const live = room.live;
  const cornerDead = room.cornerDead;
  const distFromGoal = room.distFromGoal;

  for (const b of room.boxes) if (live[b] !== 1) return null;

  const flood = flooder(size);
  const flood2 = flooder(size);
  const keyOf = (boxes: number[], low: number): string => low + ':' + boxes.join(',');

  const sBoxes: number[][] = [room.boxes.slice()];
  const sPlayer: number[] = [startPlayer];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const sF: number[] = [matchingHeuristic(room.boxes, distFromGoal, n)];
  const sKey: string[] = [];
  if (!Number.isFinite(sF[0]!)) return null;

  const occ0 = new Uint8Array(size);
  for (const b of room.boxes) occ0[b] = 1;
  const stamp0 = flood.region(rWall, occ0, startPlayer, w);
  sKey.push(keyOf(room.boxes, flood.low));
  const best = new Map<string, number>();
  best.set(sKey[0]!, 0);

  const heap: number[] = [0];
  const less = (a: number, b: number): boolean =>
    sF[a]! !== sF[b]! ? sF[a]! < sF[b]! : sG[a]! !== sG[b]! ? sG[a]! > sG[b]! : a < b;
  const heapPush = (idx: number): void => {
    let i = heap.length;
    heap.push(idx);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  const isGoal = (boxes: number[]): boolean => boxes.every((b) => goalSet[b] === 1);

  let expansions = 0;
  let found = -1;
  while (heap.length > 0) {
    const s = heapPop();
    if (best.get(sKey[s]!) !== s) continue; // a better path to this state exists
    const boxes = sBoxes[s]!;
    if (isGoal(boxes)) {
      if (!requireExit) {
        found = s;
        break;
      }
      const occ = new Uint8Array(size);
      for (const b of boxes) occ[b] = 1;
      const st = flood.region(rWall, occ, sPlayer[s]!, w);
      if (flood.seen[room.outside] === st) {
        found = s;
        break;
      }
      continue; // solved but the player is shut in; keep looking
    }
    expansions++;
    if (expansions > maxStates) return null;
    const player = sPlayer[s]!;
    const occ = new Uint8Array(size);
    for (const b of boxes) occ[b] = 1;
    const stamp = flood.region(rWall, occ, player, w);
    const seen = flood.seen;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const hx = bx - d.dx;
        const hy = by - d.dy;
        const tx = bx + d.dx;
        const ty = by + d.dy;
        if (hx < 0 || hx >= w || hy < 0 || hy >= h) continue;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        const behind = hy * w + hx;
        const target = ty * w + tx;
        if (seen[behind] !== stamp) continue; // the player cannot stand behind the box
        if (rWall[target] === 1) continue;
        if (boxCells[target] !== 1) continue; // a box never leaves its room
        if (occ[target] === 1) continue;
        if (live[target] !== 1) continue;
        if (cornerDead[target] === 1) continue;
        const occ2 = occ.slice();
        occ2[b] = 0;
        occ2[target] = 1;
        if (frozenAt(target, occ2, rWall, goalSet, w, h)) continue;
        const nb = boxes.slice();
        nb[bi] = target;
        nb.sort((a, b2) => a - b2);
        const stamp2 = flood2.region(rWall, occ2, b, w);
        const key = keyOf(nb, flood2.low);
        const g2 = sG[s]! + 1;
        const prev = best.get(key);
        if (prev !== undefined && sG[prev]! <= g2) continue;
        const h2 = matchingHeuristic(nb, distFromGoal, n);
        if (!Number.isFinite(h2)) continue;
        const idx = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(target);
        sDir.push(di);
        sG.push(g2);
        sF.push(g2 + h2);
        sKey.push(key);
        best.set(key, idx);
        heapPush(idx);
      }
    }
  }
  if (found < 0) return null;

  // Reconstruct: walk to each push, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = room.boxes.slice();
  for (const s of path) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const d = DIRS[sDir[s]!]!;
    const behind = from - (d.dy * w + d.dx);
    const occ = new Uint8Array(size);
    for (const b of boxes) occ[b] = 1;
    const walk = walkPath(rWall, occ, player, behind, w, size);
    if (walk === null) return null;
    moves += walk;
    moves += d.ch.toUpperCase();
    player = from;
    boxes = boxes.slice();
    boxes[boxes.indexOf(from)] = to;
    boxes.sort((a, b2) => a - b2);
  }
  return { pushes: path.length, moves, endPlayer: player };
}

/** Cut a level into its rooms: the floor off the player's row, the hallway. */
function findRooms(board: Board): Room[] | null {
  const { w, h, wall, goal, boxes, player } = board;
  const size = w * h;
  const hallwayRow = Math.floor(player / w);
  for (const b of boxes) if (Math.floor(b / w) === hallwayRow) return null;
  for (let i = 0; i < size; i++) {
    if (goal[i] === 1 && Math.floor(i / w) === hallwayRow) return null;
  }
  const inRoom = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (wall[i] === 0 && Math.floor(i / w) !== hallwayRow) inRoom[i] = 1;
  }
  const comp = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  for (let i = 0; i < size; i++) {
    if (inRoom[i] !== 1 || comp[i] !== -1) continue;
    const cells: number[] = [];
    const q = [i];
    comp[i] = rooms.length;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      cells.push(c);
      const x = c % w;
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k]!;
        const nx = x + d.dx;
        if (nx < 0 || nx >= w) continue;
        const n = c + d.dy * w + d.dx;
        if (n < 0 || n >= size) continue;
        if (inRoom[n] !== 1 || comp[n] !== -1) continue;
        comp[n] = rooms.length;
        q.push(n);
      }
    }
    cells.sort((a, b) => a - b);
    const rBoxes = boxes.filter((b) => comp[b] === rooms.length);
    const rGoals = cells.filter((c) => goal[c] === 1);
    if (rBoxes.length === 0) {
      if (rGoals.length !== 0) return null;
      continue; // an empty floor pocket, not a room
    }
    if (rBoxes.length !== rGoals.length) return null;
    const doors = cells.filter((c) => {
      const y = Math.floor(c / w);
      if (Math.abs(y - hallwayRow) !== 1) return false;
      return wall[hallwayRow * w + (c % w)] === 0;
    });
    if (doors.length !== 1) return null;
    const door = doors[0]!;
    const outside = hallwayRow * w + (door % w);
    rooms.push(prepareRoom(board, cells, cells, rBoxes, rGoals, door, outside));
  }
  if (rooms.length === 0) return null;
  const inSomeRoom = new Uint8Array(size);
  for (const r of rooms) for (const c of r.cells) inSomeRoom[c] = 1;
  for (const b of boxes) if (inSomeRoom[b] !== 1) return null;
  return rooms;
}

/** The whole level as one room (the fallback when it does not cut into rooms). */
function makeGlobalRoom(board: Board): Room {
  const { wall, goal, boxes, player } = board;
  const size = board.w * board.h;
  const cells: number[] = [];
  for (let i = 0; i < size; i++) if (wall[i] === 0) cells.push(i);
  const goals: number[] = [];
  for (let i = 0; i < size; i++) if (goal[i] === 1) goals.push(i);
  return prepareRoom(board, cells, cells, boxes, goals, player, player);
}

/**
 * Solve a level's rooms in `order` and stitch the answers together, walking the
 * player between rooms through the hallway. Null when any step fails.
 */
function stitch(board: Board, order: Room[]): string | null {
  const { w, h, wall } = board;
  const size = w * h;
  const flood = flooder(size);
  let moves = '';
  let player = board.player;
  let boxes = board.boxes.slice();
  const occOf = (): Uint8Array => {
    const o = new Uint8Array(size);
    for (const b of boxes) o[b] = 1;
    return o;
  };
  for (const room of order) {
    const walk = walkPath(wall, occOf(), player, room.outside, w, size);
    if (walk === null) return null;
    moves += walk;
    player = room.outside;
    let sol = solveRoom(board, room, room.outside, 500_000, false);
    if (sol === null) return null;
    const after = applyMoves(wall, boxes, player, sol.moves, w, h);
    if (after === null) return null;
    const occAfter = new Uint8Array(size);
    for (const b of after.boxes) occAfter[b] = 1;
    const st = flood.region(wall, occAfter, after.player, w);
    if (flood.seen[room.outside] !== st) {
      // The player is shut in the room: re-solve demanding a way out.
      const sol2 = solveRoom(board, room, room.outside, 500_000, true);
      if (sol2 === null) return null;
      const after2 = applyMoves(wall, boxes, player, sol2.moves, w, h);
      if (after2 === null) return null;
      sol = sol2;
      boxes = after2.boxes;
      player = after2.player;
    } else {
      boxes = after.boxes;
      player = after.player;
    }
    moves += sol.moves;
  }
  return moves;
}

/** Solve one level's text into its move string ('' when it cannot be solved). */
function solveLevel(text: string): string {
  const board = parseBoard(text);
  const rooms = findRooms(board);
  if (rooms !== null) {
    const orders = [rooms, [...rooms].reverse()];
    for (const order of orders) {
      const moves = stitch(board, order);
      if (moves === null) continue;
      const sim = simulate(board, moves);
      if (sim.ok && sim.solved) return moves;
    }
    return '';
  }
  const room = makeGlobalRoom(board);
  const sol = solveRoom(board, room, board.player, 500_000, false);
  if (sol === null) return '';
  const sim = simulate(board, sol.moves);
  if (sim.ok && sim.solved) return sol.moves;
  return '';
}

for (const id of readdirSync(I).sort()) {
  const level = readFileSync(join(I, id, 'level.txt'), 'utf8');
  const t0 = Date.now();
  const moves = solveLevel(level);
  const sim = simulate(parseBoard(level), moves);
  console.error(
    `${id}: ${moves.length} moves, ${sim.ok && sim.solved ? sim.pushes + ' pushes' : 'unsolved'} in ${Date.now() - t0}ms`,
  );
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
