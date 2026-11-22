import { Timeline, arrowCurve, linkCurve, measureCurve, type Curve } from "./geom.js";
import type { Block, Pt, RGB, Scene } from "./scene.js";
import { tableWidth } from "./widths.js";

// Writes a scene as one SVG that animates itself on a loop, using only SVG's own animation tags
// (no scripts), so it plays inside <img>.

const SPLINES: Record<string, string> = { linear: "0 0 1 1", smooth: "0.45 0 0.55 1", in: "0.55 0 1 1", out: "0 0 0.45 1" };
const HIT = 0.55; // seconds a block glows after a ball lands
export const FONT = "Inter, 'Segoe UI', 'Helvetica Neue', 'DejaVu Sans', system-ui, sans-serif";
const WHITE: RGB = [255, 255, 255];

// How wide some text is drawn, in pixels.
export type Measure = (text: string, size: number, weight: number) => number;

// a number written short: 12.5 rather than 12.500000
const n = (x: number, digits = 2) => String(parseFloat(x.toFixed(digits)) || 0);
const hexc = (c: RGB) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const pt = (p: Pt) => `${n(p[0])} ${n(p[1])}`;
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mix = (c: RGB, bg: RGB, a: number): RGB => c.map((x, i) => Math.round(bg[i] + (x - bg[i]) * a)) as RGB;

// How one value changes across the whole loop, written out as SVG animation settings.
class Keys<T> {
  moves: [number, number, T, string][] = []; // (from time, to time, new value, ease)
  constructor(public start: T) {}
  go(t0: number, t1: number, value: T, ease = "smooth") {
    this.moves.push([t0, t1, value, ease]);
  }
  set(t: number, value: T) {
    this.moves.push([t, t, value, "linear"]);
  }
  get any() {
    return this.moves.length > 0;
  }
  build(total: number): [T[], string, string] {
    const times = [0];
    const values = [this.start];
    const eases: string[] = [];
    for (const [a, b, v, ease] of [...this.moves].sort((x, y) => x[0] - y[0])) {
      const t0 = Math.min(Math.max(a, times[times.length - 1]), total);
      const t1 = Math.min(Math.max(b, t0), total);
      if (t0 > times[times.length - 1]) {
        times.push(t0);
        values.push(values[values.length - 1]);
        eases.push("linear");
      }
      times.push(t1);
      values.push(v);
      eases.push(ease);
    }
    if (times[times.length - 1] < total) {
      times.push(total);
      values.push(values[values.length - 1]);
      eases.push("linear");
    }
    let last = 0;
    const shares = times.map((t) => (last = Math.max(last, +(t / total).toFixed(4))));
    shares[shares.length - 1] = 1;
    return [values, shares.map((s) => n(s, 4)).join(";"), eases.map((e) => SPLINES[e]).join(";")];
  }
}

export class Writer {
  tl: Timeline;
  total: number;
  defs = new Map<string, string>();

  constructor(private scene: Scene, private measure: Measure = tableWidth) {
    this.tl = new Timeline(scene);
    const balls = this.tl.events.some(([, a]) => a.kind === "ball");
    this.total = Math.max(0.5, this.tl.total + (balls ? HIT : 0) + scene.hold);
  }

  // ---- animation tags ----

  private loop() {
    return `dur="${n(this.total, 3)}s" repeatCount="indefinite" calcMode="spline"`;
  }

  anim<T>(keys: Keys<T>, attr: string, fmt: (v: T) => string = String) {
    if (!keys.any) return "";
    const [values, times, splines] = keys.build(this.total);
    return `<animate attributeName="${attr}" ${this.loop()} values="${values.map(fmt).join(";")}" keyTimes="${times}" keySplines="${splines}"/>`;
  }

  animTransform<T>(keys: Keys<T>, kind: string, fmt: (v: T) => string) {
    if (!keys.any) return "";
    const [values, times, splines] = keys.build(this.total);
    return `<animateTransform attributeName="transform" type="${kind}" ${this.loop()} values="${values.map(fmt).join(";")}" keyTimes="${times}" keySplines="${splines}"/>`;
  }

  motion(keys: Keys<number>, pathId: string) {
    const [values, times, splines] = keys.build(this.total);
    const points = values.map((v) => n(Math.max(0, Math.min(1, v)), 4)).join(";");
    return `<animateMotion ${this.loop()} keyPoints="${points}" keyTimes="${times}" keySplines="${splines}"><mpath href="#${pathId}" xlink:href="#${pathId}"/></animateMotion>`;
  }

  // ---- shared pieces kept in <defs> ----

  gradientFill(top: RGB, bottom: RGB) {
    const id = `fill-${hexc(top).slice(1)}-${hexc(bottom).slice(1)}`;
    this.defs.set(id, `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hexc(top)}"/><stop offset="1" stop-color="${hexc(bottom)}"/></linearGradient>`);
    return `url(#${id})`;
  }

  ballCore(colour: RGB) {
    const id = `core-${hexc(colour).slice(1)}`;
    this.defs.set(
      id,
      `<radialGradient id="${id}" cx="0.4" cy="0.38" r="0.65"><stop offset="0" stop-color="#ffffff"/>` +
        `<stop offset="0.45" stop-color="${hexc(mix(colour, WHITE, 0.55))}"/><stop offset="1" stop-color="${hexc(colour)}"/></radialGradient>`,
    );
    return `url(#${id})`;
  }

  head(colour: RGB, width: number) {
    const size = 8 + width * 2;
    const id = `head-${hexc(colour).slice(1)}-${n(width).replace(".", "_")}`;
    this.defs.set(
      id,
      `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="${n(size)}" markerHeight="${n(size)}" markerUnits="userSpaceOnUse" orient="auto-start-reverse">` +
        `<path d="M0,0.8 L10,5 L0,9.2 L2.6,5 z" fill="${hexc(colour)}"/></marker>`,
    );
    return `url(#${id})`;
  }

  // ---- timings tied to blocks ----

  curveD(a: string, b: string, curve: number, pos: Record<string, Pt>): [string, Pt] {
    const blocks = this.scene.blocks;
    let c: Curve | null = linkCurve(blocks[a], pos[a], blocks[b], pos[b], curve);
    if (!c) {
      // the blocks overlap: an empty line in the middle
      const m: Pt = [(pos[a][0] + pos[b][0]) / 2, (pos[a][1] + pos[b][1]) / 2];
      c = [m, m, m];
    }
    return [`M${pt(c[0])} Q${pt(c[1])} ${pt(c[2])}`, measureCurve(c).middle];
  }

  // The line's shape and its middle point over time, following any block that moves.
  linkKeys(a: string, b: string, curve: number): [Keys<string>, Keys<Pt>] {
    const [d0, mid0] = this.curveD(a, b, curve, this.tl.blocksAt(0).pos);
    const d = new Keys(d0);
    const mid = new Keys(mid0);
    for (const [start, ev] of this.tl.events) {
      if (ev.kind !== "move" || (ev.src !== a && ev.src !== b)) continue;
      const pieces = ev.time > 0 ? 8 : 1;
      for (let i = 1; i <= pieces; i++) {
        const t0 = start + (ev.time * (i - 1)) / pieces;
        const t1 = start + (ev.time * i) / pieces;
        const [di, mi] = this.curveD(a, b, curve, this.tl.blocksAt(t1 + 1e-9).pos);
        d.go(t0, t1, di, "linear");
        mid.go(t0, t1, mi, "linear");
      }
    }
    return [d, mid];
  }

  // How visible something is over time when it needs all of these blocks shown.
  seenKeys(names: string[]): Keys<number> {
    const seen0 = this.tl.blocksAt(0).seen;
    const k = new Keys(Math.min(...names.map((x) => seen0[x])));
    for (const [start, ev] of this.tl.events) {
      if ((ev.kind === "show" || ev.kind === "hide") && names.includes(ev.src)) {
        const { seen } = this.tl.blocksAt(start + ev.time + 1e-9);
        k.go(start, start + ev.time, Math.min(...names.map((x) => seen[x])), ev.ease);
      }
    }
    return k;
  }

  // ---- drawing ----

  shape(block: Block, pad: number, attrs: string) {
    const w = block.w + pad * 2;
    const h = block.h + pad * 2;
    if (block.shape === "circle") return `<ellipse rx="${n(w / 2)}" ry="${n(h / 2)}" ${attrs}/>`;
    const corner = this.scene.style === "minimal" ? 6 : 11;
    const radius = block.shape === "rect" ? 0 : block.shape === "pill" ? h / 2 : corner + pad;
    return `<rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(radius)}" ${attrs}/>`;
  }

  text(label: string, size: number, colour: RGB, weight = 600) {
    const lines = label.split("\n");
    const gap = size * 1.25;
    const spans = lines.map((s, i) => `<tspan x="0" y="${n((i - (lines.length - 1) / 2) * gap)}">${escape(s)}</tspan>`).join("");
    return `<text text-anchor="middle" dominant-baseline="central" font-size="${size}" font-weight="${weight}" fill="${hexc(colour)}">${spans}</text>`;
  }

  textWidth(text: string, size: number, weight: number) {
    return Math.max(...text.split("\n").map((line) => this.measure(line, size, weight)));
  }

  // The biggest font size, from `biggest` down to 12, that keeps the label inside the block.
  labelSize(block: Block, biggest: number, weight: number) {
    const room = block.w * (block.shape === "circle" ? 0.72 : 0.86);
    for (let size = biggest; size >= 12; size--) if (this.textWidth(block.label, size, weight) <= room) return size;
    return 12;
  }

  render(): string {
    const sc = this.scene;
    const th = sc.theme;
    const [W, H] = sc.size;
    const { blocks, ball } = sc;
    const mini = sc.style === "minimal"; // flat and quiet: no glow, tails, shadows or bounce
    const layers: Record<string, string[]> = { tracks: [], arrows: [], trails: [], blocks: [], labels: [], balls: [], captions: [] };

    // what each block does over time
    const op: Record<string, Keys<number>> = {};
    const scale: Record<string, Keys<number>> = {};
    const place: Record<string, Keys<Pt>> = {};
    const ring: Record<string, Keys<number>> = {};
    const ringColour: Record<string, Keys<RGB>> = {};
    for (const b of Object.values(blocks)) {
      op[b.name] = new Keys(b.hidden ? 0 : 1);
      scale[b.name] = new Keys(b.hidden && !mini ? 0.92 : 1);
      place[b.name] = new Keys(b.pos);
      ring[b.name] = new Keys(0);
      ringColour[b.name] = new Keys(ball.colour);
    }
    const ballEvents = this.tl.events.filter(([, a]) => a.kind === "ball");
    for (const [start, a] of this.tl.events) {
      const end = start + a.time;
      if (a.kind === "show") {
        op[a.src].go(start, end, 1, a.ease);
        if (!mini) scale[a.src].go(start, end, 1, "out");
      } else if (a.kind === "hide") {
        op[a.src].go(start, end, 0, a.ease);
        if (!mini) scale[a.src].go(start, end, 0.94, a.ease);
      } else if (a.kind === "move") place[a.src].go(start, end, a.to!, a.ease);
      else if (a.kind === "ball") {
        ringColour[a.dst].set(end, a.colour ?? ball.colour);
        ring[a.dst].go(end, end + 0.06, 1, "linear");
        ring[a.dst].go(end + 0.06, end + HIT, 0, "out");
        if (!mini) {
          scale[a.dst].go(end, end + 0.12, 1.06, "out");
          scale[a.dst].go(end + 0.12, end + 0.45, 1, "smooth");
        }
      }
    }

    // faint lines under balls that have no arrow to follow
    if (sc.tracks) {
      const linked = new Set(sc.arrows.map((ar) => [ar.a, ar.b].sort().join("\0")));
      const done = new Set<string>();
      for (const [, a] of ballEvents) {
        const pair = [a.src, a.dst].sort().join("\0");
        if (a.src === a.dst || linked.has(pair) || done.has(pair)) continue;
        done.add(pair);
        const [d] = this.linkKeys(a.src, a.dst, 0);
        const vis = this.seenKeys([a.src, a.dst]);
        layers.tracks.push(
          `<path d="${d.start}" fill="none" stroke="${hexc(th.track)}" stroke-width="${mini ? 1 : 1.5}" opacity="${n(vis.start)}">` +
            `${this.anim(d, "d")}${this.anim(vis, "opacity", (v) => n(v))}</path>`,
        );
      }
    }

    for (const ar of sc.arrows) {
      const colour = ar.colour ?? th.arrow;
      const width = ar.width ?? (mini ? 1.25 : 2);
      const [d, mid] = this.linkKeys(ar.a, ar.b, ar.curve);
      const vis = this.seenKeys([ar.a, ar.b]);
      const attrs = [`d="${d.start}"`, `fill="none"`, `stroke="${hexc(colour)}"`, `stroke-width="${n(width)}"`];
      if (ar.heads !== "none") attrs.push(`marker-end="${this.head(colour, width)}"`);
      if (ar.heads === "both") attrs.push(`marker-start="${this.head(colour, width)}"`);
      if (ar.dashed || ar.flow) attrs.push(`stroke-dasharray="6 7"`);
      const flow = ar.flow ? `<animate attributeName="stroke-dashoffset" values="13;0" dur="0.7s" repeatCount="indefinite"/>` : "";
      layers.arrows.push(`<path ${attrs.join(" ")} opacity="${n(vis.start)}">${this.anim(d, "d")}${flow}${this.anim(vis, "opacity", (v) => n(v))}</path>`);
      if (ar.label) {
        let chip: string;
        if (mini) {
          // plain text with the background showing behind it
          const w = this.textWidth(ar.label, 11, 400) + 10;
          chip = `<rect x="${n(-w / 2)}" y="-9" width="${n(w)}" height="18" fill="${hexc(th.bg)}"/>${this.text(ar.label, 11, mix(th.text, th.bg, 0.6), 400)}`;
        } else {
          const w = this.textWidth(ar.label, 12, 500) + 16;
          chip =
            `<rect x="${n(-w / 2)}" y="-11" width="${n(w)}" height="22" rx="11" fill="${hexc(th.fill)}" stroke="${hexc(th.edge)}" stroke-width="1"/>` +
            this.text(ar.label, 12, mix(th.text, th.fill, 0.75), 500);
        }
        layers.labels.push(
          `<g opacity="${n(vis.start)}">${this.anim(vis, "opacity", (v) => n(v))}` +
            `<g transform="translate(${pt(mid.start)})">${this.animTransform(mid, "translate", pt)}${chip}</g></g>`,
        );
      }
    }

    if (!mini) {
      const shadow = sc.themeName === "dark" ? "0.45" : "0.12";
      this.defs.set("shadow", `<filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="${shadow}"/></filter>`);
      this.defs.set("ringblur", `<filter id="ringblur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5"/></filter>`);
    }
    for (const b of Object.values(blocks)) {
      const fill = b.fill ?? th.fill;
      const edge = b.edge ?? th.edge;
      // the ring that lights up when a ball lands, then the block itself
      let ringGlow = "";
      let ringLine: string;
      let body: string;
      let label: string;
      if (mini) {
        ringLine = this.shape(b, 0, `stroke-width="1.5"`);
        body = this.shape(b, 0, `fill="${hexc(fill)}" stroke="${hexc(edge)}" stroke-width="1"`);
        label = this.text(b.label, this.labelSize(b, 14, 500), b.text ?? th.text, 500);
      } else {
        const top = b.fill ? mix(WHITE, fill, 0.06) : th.fill_top;
        ringGlow = this.shape(b, 4, `stroke-width="6" filter="url(#ringblur)"`);
        ringLine = this.shape(b, 1.5, `stroke-width="2"`);
        body = this.shape(b, 0, `fill="${this.gradientFill(top, fill)}" stroke="${hexc(edge)}" stroke-width="1.5" filter="url(#shadow)"`);
        label = this.text(b.label, this.labelSize(b, 17, 600), b.text ?? th.text);
      }
      layers.blocks.push(
        `<g opacity="${n(op[b.name].start)}">${this.anim(op[b.name], "opacity", (v) => n(v))}` +
          `<g transform="translate(${pt(b.pos)})">${this.animTransform(place[b.name], "translate", pt)}` +
          `<g transform="scale(${n(scale[b.name].start)})">${this.animTransform(scale[b.name], "scale", (v) => n(v))}` +
          `<g opacity="0" fill="none">${this.anim(ring[b.name], "opacity", (v) => n(v))}` +
          `<g stroke="${hexc(ball.colour)}">${this.anim(ringColour[b.name], "stroke", hexc)}${ringGlow}${ringLine}</g></g>` +
          `${body}${label}</g></g></g>`,
      );
    }

    // balls; the glow style adds a comet tail lit along each ball's path
    if (!mini) {
      this.defs.set("glowblur", `<filter id="glowblur" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${n(ball.glow * 0.55)}"/></filter>`);
      this.defs.set("tailblur", `<filter id="tailblur" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><feGaussianBlur stdDeviation="2.5"/></filter>`);
    }
    ballEvents.forEach(([start, a], i) => {
      const { pos } = this.tl.blocksAt(start);
      const c = linkCurve(blocks[a.src], pos[a.src], blocks[a.dst], pos[a.dst], arrowCurve(sc, a.src, a.dst));
      if (!c) return;
      const { length } = measureCurve(c);
      const d = `M${pt(c[0])} Q${pt(c[1])} ${pt(c[2])}`;
      const id = `route${i}`;
      this.defs.set(id, `<path id="${id}" d="${d}"/>`);
      const end = start + a.time;
      const colour = a.colour ?? ball.colour;
      const size = a.size ?? ball.size;
      const progress = new Keys(0);
      progress.go(start, end, 1, a.ease);
      const shown = new Keys(0);
      shown.go(start, start + 0.08, 1, "linear");
      if (mini) {
        // just a small dot
        shown.go(end - 0.05, end, 0, "linear");
        layers.balls.push(`<g opacity="0">${this.anim(shown, "opacity", (v) => n(v))}${this.motion(progress, id)}<circle r="${n(size)}" fill="${hexc(colour)}"/></g>`);
        return;
      }
      shown.go(end, end + 0.1, 0, "linear");
      const tailShown = new Keys(0);
      tailShown.go(start, start + 0.08, 1, "linear");
      tailShown.go(end, end + 0.4, 0, "out");
      // three stacked tails, shorter ones brighter, so the comet thins out behind the ball
      const tails = ([[1, size * 1.5, 0.22, true], [0.55, size * 0.9, 0.45, false], [0.25, size * 0.6, 0.9, false]] as const).map(([share, width, alpha, blur]) => {
        const len = length ? Math.min((110 * share) / length, 0.8) : 0;
        const off = new Keys(len);
        off.go(start, end, len - 1, a.ease);
        return (
          `<path d="${d}" fill="none" stroke="${hexc(colour)}" stroke-width="${n(width)}" stroke-linecap="round" pathLength="1" ` +
          `stroke-dasharray="${n(len, 4)} 3" stroke-dashoffset="${n(len, 4)}" opacity="${alpha}"${blur ? ` filter="url(#tailblur)"` : ""}>` +
          `${this.anim(off, "stroke-dashoffset", (v) => n(v, 4))}</path>`
        );
      });
      layers.trails.push(`<g opacity="0">${this.anim(tailShown, "opacity", (v) => n(v))}${tails.join("")}</g>`);
      layers.balls.push(
        `<g opacity="0">${this.anim(shown, "opacity", (v) => n(v))}${this.motion(progress, id)}` +
          `<circle r="${n(size * 2.6)}" fill="${hexc(colour)}" opacity="${n(th.glow * 0.6)}" filter="url(#glowblur)"/>` +
          `<circle r="${n(size)}" fill="${this.ballCore(colour)}"/></g>`,
      );
    });

    for (const [start, a] of this.tl.events) {
      if (a.kind !== "say") continue;
      const end = start + a.time;
      const [x, y] = [W / 2, H - 30];
      const fade = Math.min(0.25, a.time / 3);
      const shown = new Keys(0);
      shown.go(start, start + fade, 1, "out");
      shown.go(end - fade, end, 0, "in");
      if (mini) {
        // plain text that fades in and out
        layers.captions.push(`<g opacity="0" transform="translate(${pt([x, y])})">${this.anim(shown, "opacity", (v) => n(v))}${this.text(a.text, 13, mix(th.text, th.bg, 0.75), 400)}</g>`);
        continue;
      }
      const w = this.textWidth(a.text, 15, 500) + 32;
      const rise = new Keys<Pt>([x, y + 8]);
      rise.go(start, start + fade * 1.4, [x, y], "out");
      layers.captions.push(
        `<g opacity="0">${this.anim(shown, "opacity", (v) => n(v))}` +
          `<g transform="translate(${pt([x, y + 8])})">${this.animTransform(rise, "translate", pt)}` +
          `<rect x="${n(-w / 2)}" y="-17" width="${n(w)}" height="34" rx="17" fill="${hexc(th.fill)}" stroke="${hexc(th.edge)}" stroke-width="1" filter="url(#shadow)"/>` +
          `${this.text(a.text, 15, th.text, 500)}</g></g>`,
      );
    }

    let background: string;
    if (mini) background = `<rect width="${W}" height="${H}" fill="${hexc(th.bg)}"/>`;
    else {
      this.defs.set("bg", `<radialGradient id="bg" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="${hexc(th.bg2)}"/><stop offset="1" stop-color="${hexc(th.bg)}"/></radialGradient>`);
      background = `<rect width="${W}" height="${H}" fill="url(#bg)"/>`;
    }
    if (sc.grid) {
      this.defs.set("dots", `<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="11" cy="11" r="1.1" fill="${hexc(th.dots)}"/></pattern>`);
      background += `<rect width="${W}" height="${H}" fill="url(#dots)"/>`;
    }
    const title = sc.title ? `<title>${escape(sc.title)}</title>` : "";
    const content = Object.entries(layers)
      .filter(([, v]) => v.length)
      .map(([k, v]) => `<g class="${k}">${v.join("")}</g>`)
      .join("\n");
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">${title}\n` +
      `<defs>${[...this.defs.values()].join("")}</defs>\n${background}\n${content}\n</svg>\n`
    );
  }
}
