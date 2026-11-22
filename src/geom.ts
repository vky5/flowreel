import { EASES, type Action, type Block, type Pt, type Scene } from "./scene.js";

// Shapes, the lines between blocks, and where everything is at any moment.

export function inside(block: Block, [cx, cy]: Pt, x: number, y: number): boolean {
  const hw = block.w / 2;
  const hh = block.h / 2;
  if (block.shape === "circle") return ((x - cx) / hw) ** 2 + ((y - cy) / hh) ** 2 <= 1;
  return Math.abs(x - cx) <= hw && Math.abs(y - cy) <= hh;
}

// The spot along f, between 0 and 0.5, where it leaves the block.
function crossing(f: (t: number) => Pt, block: Block, centre: Pt): number {
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inside(block, centre, ...f(mid))) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function quadAt(p: Pt, c: Pt, q: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * p[0] + 2 * u * t * c[0] + t * t * q[0], u * u * p[1] + 2 * u * t * c[1] + t * t * q[1]];
}

export type Curve = [Pt, Pt, Pt]; // start, bend point, end

// The curve from block b1's outline to block b2's outline. null when the blocks overlap.
export function linkCurve(b1: Block, p: Pt, b2: Block, q: Pt, curve: number): Curve | null {
  const c: Pt = [(p[0] + q[0]) / 2 - (q[1] - p[1]) * curve, (p[1] + q[1]) / 2 + (q[0] - p[0]) * curve];
  const f = (t: number) => quadAt(p, c, q, t);
  if (inside(b1, p, ...f(0.5)) || inside(b2, q, ...f(0.5))) return null;
  const t0 = crossing(f, b1, p);
  const t1 = 1 - crossing((t) => f(1 - t), b2, q);
  // the bend point of just the visible piece of the curve
  const mix = (i: 0 | 1) => (1 - t0) * (1 - t1) * p[i] + (t0 * (1 - t1) + t1 * (1 - t0)) * c[i] + t0 * t1 * q[i];
  return [f(t0), [mix(0), mix(1)], f(t1)];
}

// A curve's length and the point halfway along it.
export function measureCurve(curve: Curve): { length: number; middle: Pt } {
  const pts = Array.from({ length: 49 }, (_, i) => quadAt(curve[0], curve[1], curve[2], i / 48));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = cum[cum.length - 1];
  const half = length / 2;
  let i = cum.findIndex((c) => c >= half);
  if (i <= 0) return { length, middle: pts[0] };
  const k = (half - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return { length, middle: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k] };
}

// How much the line from a to b bends: the arrow's bend if one joins them, else straight.
export function arrowCurve(scene: Scene, a: string, b: string): number {
  for (const ar of scene.arrows) {
    if (ar.a === a && ar.b === b) return ar.curve;
    if (ar.a === b && ar.b === a) return -ar.curve; // same curve, walked the other way
  }
  return 0;
}

// When every action starts, and the state of the blocks at any moment.
export class Timeline {
  events: [number, Action][] = [];
  total = 0;

  constructor(private scene: Scene) {
    let t = 0;
    for (const step of scene.steps) {
      for (const a of step) this.events.push([t, a]);
      t += Math.max(...step.map((a) => a.time));
    }
    this.total = t;
  }

  blocksAt(t: number): { pos: Record<string, Pt>; seen: Record<string, number> } {
    const pos: Record<string, Pt> = {};
    const seen: Record<string, number> = {};
    for (const b of Object.values(this.scene.blocks)) {
      pos[b.name] = b.pos;
      seen[b.name] = b.hidden ? 0 : 1;
    }
    for (const [start, a] of this.events) {
      if (start > t) break;
      if (a.kind !== "show" && a.kind !== "hide" && a.kind !== "move") continue;
      const p = EASES[a.ease](a.time > 0 ? Math.min(1, (t - start) / a.time) : 1);
      if (a.kind === "move") {
        const [x, y] = pos[a.src];
        const [tx, ty] = a.to!;
        pos[a.src] = [x + (tx - x) * p, y + (ty - y) * p];
      } else {
        const target = a.kind === "show" ? 1 : 0;
        seen[a.src] += (target - seen[a.src]) * p;
      }
    }
    return { pos, seen };
  }
}
