import YAML from "yaml";
import { tableWidth } from "./widths.js";

// Reads a flowreel scene (YAML text) into plain objects and places the blocks that have no position.
// No Node or browser APIs here, so it runs anywhere.

export class FlowError extends Error {}

export type RGB = [number, number, number];
export type Pt = [number, number];

// each colour name has a shade for dark backgrounds and a deeper one for light backgrounds
export const COLOURS: Record<string, [string, string]> = {
  amber: ["fbbf24", "d97706"], orange: ["fb923c", "ea580c"], red: ["f87171", "dc2626"],
  pink: ["f472b6", "db2777"], purple: ["a78bfa", "7c3aed"], blue: ["60a5fa", "2563eb"],
  cyan: ["22d3ee", "0891b2"], teal: ["2dd4bf", "0d9488"], green: ["4ade80", "16a34a"],
  white: ["f8fafc", "ffffff"], grey: ["94a3b8", "64748b"], black: ["0f172a", "0f172a"],
};

export type Theme = {
  bg: RGB; bg2: RGB; fill: RGB; fill_top: RGB; edge: RGB; text: RGB;
  arrow: RGB; track: RGB; dots: RGB; ball: RGB; glow: number;
};

export const THEMES: Record<string, Theme> = {
  dark: {
    bg: [11, 14, 20], bg2: [21, 26, 36], fill: [24, 29, 39], fill_top: [33, 39, 52], edge: [58, 67, 85],
    text: [226, 232, 240], arrow: [84, 95, 117], track: [36, 43, 56], dots: [28, 34, 46], ball: [251, 191, 36], glow: 0.9,
  },
  light: {
    bg: [246, 246, 243], bg2: [255, 255, 255], fill: [255, 255, 255], fill_top: [255, 255, 255], edge: [200, 205, 214],
    text: [30, 35, 45], arrow: [150, 158, 172], track: [225, 228, 233], dots: [226, 227, 230], ball: [217, 119, 6], glow: 0.55,
  },
};

export const EASES: Record<string, (t: number) => number> = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) ** 2,
};

const STYLES = ["minimal", "glow"];
const SHAPES = ["box", "rect", "pill", "circle"] as const;
const LAYOUTS = ["auto", "circle", "row", "column", "grid"];
const SIDES: Record<string, Pt> = { "right-of": [1, 0], "left-of": [-1, 0], above: [0, -1], below: [0, 1] };
const FLAGS: Record<string, [string, boolean]> = { dashed: ["dashed", true], solid: ["dashed", false], flow: ["flow", true], noflow: ["flow", false] };
const TIME_RE = /^(\d+(?:\.\d+)?|\.\d+)(s|ms)?$/;

export type Block = {
  name: string;
  label: string;
  shape: (typeof SHAPES)[number];
  w: number;
  h: number;
  fill: RGB | null;
  edge: RGB | null;
  text: RGB | null;
  at: Pt | null; // where the file pins it
  beside: [string, string, number] | null; // (side, other block, gap) when placed next to another block
  hidden: boolean;
  sized: boolean; // the file gave a size, so it never grows to fit its label
  pos: Pt; // where it ends up at the start
};

export type Arrow = {
  a: string;
  b: string;
  heads: "end" | "both" | "none";
  curve: number;
  dashed: boolean;
  flow: boolean; // dashes keep moving along the arrow
  colour: RGB | null;
  label: string;
  width: number | null; // null means the style's own line width
};

// What a `set` step changes. Anything left out stays as it was.
export type Look = { colour?: RGB; fill?: RGB; text?: RGB; label?: string; flow?: boolean; dashed?: boolean };

export type Action = {
  kind: "ball" | "show" | "hide" | "move" | "say" | "pause" | "pulse" | "set";
  background: boolean; // written with a trailing &: starts with its step, but the next step doesn't wait for it
  label: string | null; // the text that travels with a ball
  arrow: number | null; // for `set a -> b`: which arrow
  look: Look | null; // for `set`: what changes
  time: number;
  src: string;
  dst: string;
  colour: RGB | null;
  ease: string;
  size: number | null;
  to: Pt | null;
  text: string;
};

export type Scene = {
  size: Pt;
  title: string;
  style: "minimal" | "glow"; // minimal: flat and quiet; glow: gradients, glow and comet tails
  themeName: string;
  theme: Theme;
  ball: { colour: RGB; size: number; glow: number; tail: number };
  layout: string;
  tracks: boolean;
  grid: boolean;
  hold: number;
  blocks: Record<string, Block>;
  arrows: Arrow[];
  steps: Action[][];
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown) => (typeof v === "string" ? `'${v}'` : JSON.stringify(v));

function parseColour(value: unknown, where: string, theme: string): RGB {
  if (Array.isArray(value) && value.length === 3) return value.map((v) => Math.round(Number(v))) as RGB;
  let s = typeof value === "number" && Number.isInteger(value) ? String(value).padStart(6, "0") : String(value).toLowerCase(); // YAML reads 123456 as a number
  s = COLOURS[s] ? COLOURS[s][theme === "light" ? 1 : 0] : s.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/.test(s)) return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;
  throw new FlowError(`${where}: ${show(value)} isn't a colour. Use ${Object.keys(COLOURS).join(", ")} or hex like 5cc8ff.`);
}

function parseTime(value: unknown, where: string): number {
  const m = String(value).trim().match(TIME_RE);
  if (!m) throw new FlowError(`${where}: ${show(value)} isn't a time. Write it like 0.6s or 600ms.`);
  return parseFloat(m[1]) / (m[2] === "ms" ? 1000 : 1);
}

function parseNumber(value: unknown, where: string, name: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new FlowError(`${where}: ${name} should be a number, got ${show(value)}.`);
  return n;
}

// A pixel value, or a share of the canvas when written as a decimal between 0 and 1.
function coord(value: unknown, full: number, where: string): number {
  const n = parseNumber(value, where, "a position");
  return n > 0 && n < 1 ? n * full : n;
}

function parsePoint(value: unknown, size: Pt, where: string): Pt {
  const parts = typeof value === "string" ? value.trim().replace(/^[[(]|[\])]$/g, "").split(",") : value;
  if (!Array.isArray(parts) || parts.length !== 2) throw new FlowError(`${where}: a position is two numbers like [120, 200] or [0.25, 0.5].`);
  return [coord(parts[0], size[0], where), coord(parts[1], size[1], where)];
}

// Takes out a quoted label, then splits the rest on spaces, with arrows as their own words.
function splitLine(text: string): [string[], string | null] {
  let label: string | null = null;
  const m = text.match(/"([^"]*)"|'([^']*)'/);
  if (m) {
    label = m[1] ?? m[2];
    text = text.slice(0, m.index) + " " + text.slice(m.index! + m[0].length);
  }
  text = text.replace(/(<->|->|--)/g, " $1 ");
  return [text.split(/\s+/).filter(Boolean), label];
}

type Options = { time?: number; colour?: RGB; fill?: RGB; text?: RGB; ease?: string; dashed?: boolean; flow?: boolean; curve?: number; width?: number; size?: number };

// Turns words like 0.6s, blue, dashed, ease=out into settings.
function readOptions(tokens: string[], where: string, allowed: string[], theme: string): Options {
  const out: Record<string, unknown> = {};
  for (const tok of tokens) {
    let key: string;
    let val: string | boolean;
    if (tok.includes("=")) {
      const i = tok.indexOf("=");
      key = tok.slice(0, i).toLowerCase();
      if (key === "color") key = "colour";
      val = tok.slice(i + 1);
    } else if (TIME_RE.test(tok)) [key, val] = ["time", tok];
    else if (FLAGS[tok.toLowerCase()]) [key, val] = FLAGS[tok.toLowerCase()];
    else [key, val] = ["colour", tok];
    if (!allowed.includes(key)) throw new FlowError(`${where}: '${tok}' doesn't fit here. This line takes: ${allowed.join(", ")}.`);
    if (key === "time") out.time = parseTime(val, where);
    else if (key === "colour" || key === "fill" || key === "text") out[key] = parseColour(val, where, theme);
    else if (key === "ease") {
      if (!EASES[String(val)]) throw new FlowError(`${where}: ease=${val} isn't known. Use ${Object.keys(EASES).join(", ")}.`);
      out.ease = val;
    } else if (key === "dashed" || key === "flow") out[key] = val;
    else out[key] = parseNumber(val, where, key);
  }
  return out as Options;
}

function parseBlock(name: string, raw: unknown, size: Pt, where: string, theme: string): Block {
  if (raw == null) raw = {};
  if (typeof raw === "string" || typeof raw === "number") raw = { label: String(raw) };
  if (!isObj(raw)) throw new FlowError(`${where}: expected settings like {label: API, shape: pill}.`);
  const known = ["label", "at", "shape", "size", "colour", "color", "fill", "text", "hidden", "gap", ...Object.keys(SIDES)];
  const unknown = Object.keys(raw).filter((k) => !known.includes(k)).sort();
  if (unknown.length) throw new FlowError(`${where}: unknown setting '${unknown[0]}'. Known: ${[...known].sort().join(", ")}.`);
  const shape = String(raw.shape ?? "box") as Block["shape"];
  if (!SHAPES.includes(shape)) throw new FlowError(`${where}: shape '${shape}' isn't known. Use ${SHAPES.join(", ")}.`);
  let [w, h] = shape === "circle" ? [76, 76] : [124, 56];
  if ("size" in raw) {
    const s = raw.size;
    if (Array.isArray(s) && s.length === 2) [w, h] = [parseNumber(s[0], where, "size"), parseNumber(s[1], where, "size")];
    else {
      w = parseNumber(s, where, "size");
      if (shape === "circle") h = w;
    }
  }
  const edge = raw.colour ?? raw.color;
  const sides = Object.keys(SIDES).filter((s) => s in raw);
  const at = "at" in raw ? parsePoint(raw.at, size, where) : null;
  if (sides.length > 1 || (sides.length && at)) throw new FlowError(`${where}: give a block one of at, right-of, left-of, above, below.`);
  return {
    name,
    label: String(raw.label ?? name),
    shape,
    w,
    h,
    hidden: Boolean(raw.hidden),
    sized: "size" in raw,
    edge: edge != null ? parseColour(edge, where, theme) : null,
    fill: "fill" in raw ? parseColour(raw.fill, where, theme) : null,
    text: "text" in raw ? parseColour(raw.text, where, theme) : null,
    at,
    beside: sides.length ? [sides[0], String(raw[sides[0]]), parseNumber(raw.gap ?? 80, where, "gap")] : null,
    pos: [0, 0],
  };
}

function parseArrow(text: string, blocks: Record<string, Block>, theme: string): Arrow {
  const where = `arrow '${text}'`;
  const [tokens, label] = splitLine(text);
  if (tokens.length < 3 || !["->", "<->", "--"].includes(tokens[1])) throw new FlowError(`${where}: write arrows like 'A -> B', 'A <-> B' or 'A -- B'.`);
  const [a, op, b] = tokens;
  for (const n of [a, b]) if (!blocks[n]) throw new FlowError(`${where}: there's no block called '${n}'.`);
  const o = readOptions(tokens.slice(3), where, ["colour", "curve", "dashed", "flow", "width"], theme);
  return {
    a,
    b,
    heads: op === "->" ? "end" : op === "<->" ? "both" : "none",
    label: label ?? "",
    curve: o.curve ?? 0,
    dashed: o.dashed ?? false,
    flow: o.flow ?? false,
    colour: o.colour ?? null,
    width: o.width ?? null,
  };
}

const MOVE_RE = /^\s*move\s+(\w+)\s+to\s+\[?\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]?(.*)$/;
const action = (a: Partial<Action> & Pick<Action, "kind">): Action => ({
  time: 1, src: "", dst: "", colour: null, ease: "smooth", size: null, to: null, text: "",
  background: false, label: null, arrow: null, look: null, ...a,
});

function parseAction(text: string, blocks: Record<string, Block>, arrows: Arrow[], size: Pt, theme: string): Action {
  const where = `step '${text}'`;
  // a trailing & means: start this, and let the next step begin without waiting for it
  const background = /&\s*$/.test(text);
  const a = parseOne(text.replace(/&\s*$/, ""), where, blocks, arrows, size, theme);
  if (background && a.kind === "pause") throw new FlowError(`${where}: a pause can't run in the background; it would do nothing.`);
  return { ...a, background };
}

function parseOne(text: string, where: string, blocks: Record<string, Block>, arrows: Arrow[], size: Pt, theme: string): Action {
  const [tokens, label] = splitLine(text);
  if (!tokens.length) throw new FlowError(`${where}: empty step.`);
  const needBlock = (n: string) => {
    if (!blocks[n]) throw new FlowError(`${where}: there's no block called '${n}'.`);
    return n;
  };
  const word = tokens[0];
  if (word === "pause") {
    if (tokens.length !== 2) throw new FlowError(`${where}: write it like 'pause 0.5s'.`);
    return action({ kind: "pause", time: parseTime(tokens[1], where) });
  }
  if (word === "say") {
    if (label == null) throw new FlowError(`${where}: put the caption in quotes, like say "Cache miss" 1.5s.`);
    const o = readOptions(tokens.slice(1), where, ["time"], theme);
    return action({ kind: "say", text: label, time: o.time ?? 1.5 });
  }
  if (word === "show" || word === "hide") {
    if (tokens.length < 2) throw new FlowError(`${where}: write it like '${word} B 0.4s'.`);
    const o = readOptions(tokens.slice(2), where, ["time", "ease"], theme);
    return action({ kind: word, src: needBlock(tokens[1]), time: o.time ?? 0.4, ease: o.ease ?? "smooth" });
  }
  if (word === "pulse") {
    if (tokens.length < 2) throw new FlowError(`${where}: write it like 'pulse B 1s'.`);
    const o = readOptions(tokens.slice(2), where, ["time", "colour"], theme);
    return action({ kind: "pulse", src: needBlock(tokens[1]), time: o.time ?? 0.6, colour: o.colour ?? null });
  }
  if (word === "set") {
    if (tokens.length >= 4 && ["->", "<->", "--"].includes(tokens[2])) {
      const [x, y] = [needBlock(tokens[1]), needBlock(tokens[3])];
      const i = arrows.findIndex((ar) => (ar.a === x && ar.b === y) || (ar.a === y && ar.b === x));
      if (i < 0) throw new FlowError(`${where}: there's no arrow between '${x}' and '${y}' in arrows:.`);
      const o = readOptions(tokens.slice(4), where, ["colour", "flow", "dashed", "time"], theme);
      const look: Look = {};
      if (o.colour) look.colour = o.colour;
      if (o.flow !== undefined) look.flow = o.flow;
      if (o.dashed !== undefined) look.dashed = o.dashed;
      if (!Object.keys(look).length) throw new FlowError(`${where}: say what changes, like 'set ${x} -> ${y} flow', 'noflow', 'dashed' or a colour.`);
      return action({ kind: "set", arrow: i, look, time: o.time ?? 0.3 });
    }
    if (tokens.length < 2) throw new FlowError(`${where}: write it like 'set B green "done"'.`);
    const o = readOptions(tokens.slice(2), where, ["colour", "fill", "text", "time"], theme);
    const look: Look = {};
    if (o.colour) look.colour = o.colour;
    if (o.fill) look.fill = o.fill;
    if (o.text) look.text = o.text;
    if (label != null) look.label = label;
    if (!Object.keys(look).length) throw new FlowError(`${where}: say what changes, like a colour, fill=green, text=white or a new label in quotes.`);
    return action({ kind: "set", src: needBlock(tokens[1]), look, time: o.time ?? 0.3 });
  }
  if (word === "move") {
    const m = text.match(MOVE_RE);
    if (!m) throw new FlowError(`${where}: write it like 'move B to 300,200 1s' or 'move B to 0.5,0.5'.`);
    const o = readOptions(m[4].split(/\s+/).filter(Boolean), where, ["time", "ease"], theme);
    return action({ kind: "move", src: needBlock(m[1]), to: parsePoint([m[2], m[3]], size, where), time: o.time ?? 1, ease: o.ease ?? "smooth" });
  }
  if (tokens.length >= 3 && tokens[1] === "->") {
    const o = readOptions(tokens.slice(3), where, ["time", "colour", "ease", "size"], theme);
    return action({
      kind: "ball", src: needBlock(tokens[0]), dst: needBlock(tokens[2]), label,
      time: o.time ?? 1, colour: o.colour ?? null, ease: o.ease ?? "smooth", size: o.size ?? null,
    });
  }
  throw new FlowError(`${where}: expected 'A -> B', 'pause', 'say', 'show', 'hide', 'move', 'pulse', 'set' or 'repeat'.`);
}

const REPEAT_RE = /^\s*repeat\s+(\d+)\s*\[(.*)\]\s*$/;
const MAX_REPEAT = 100;

// Splits "a -> b, say \"x, y\"" on the commas that are outside quotes.
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of text) {
    if (quote) quote = ch === quote ? "" : quote;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ",") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function repeatCount(value: unknown, where: string): number {
  const n = parseNumber(value, where, "repeat");
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT) throw new FlowError(`${where}: repeat takes a whole number from 1 to ${MAX_REPEAT}.`);
  return n;
}

// The steps list, with repeats written out. Each step is the actions that start together.
function parseSteps(list: unknown, blocks: Record<string, Block>, arrows: Arrow[], size: Pt, theme: string): Action[][] {
  const steps: Action[][] = [];
  const one = (t: unknown) => parseAction(String(t), blocks, arrows, size, theme);
  for (const item of Array.isArray(list) ? list : list == null ? [] : [list]) {
    if (isObj(item)) {
      // - repeat: 3
      //   steps: [...]
      if (!("repeat" in item)) {
        throw new FlowError(`step ${JSON.stringify(item)}: a ': ' inside a step makes YAML read it as a setting. Drop the colon, or wrap the whole step in single quotes.`);
      }
      const where = `repeat ${JSON.stringify(item.repeat)}`;
      const extra = Object.keys(item).filter((k) => k !== "repeat" && k !== "steps");
      if (extra.length) throw new FlowError(`${where}: unknown setting '${extra[0]}'. A repeat has repeat: and steps:.`);
      const inner = parseSteps(item.steps, blocks, arrows, size, theme);
      if (!inner.length) throw new FlowError(`${where}: add the steps to repeat under steps:.`);
      for (let i = repeatCount(item.repeat, where); i > 0; i--) steps.push(...inner);
      continue;
    }
    const m = typeof item === "string" ? item.match(REPEAT_RE) : null;
    if (m) {
      // repeat 3 [a -> b, say "x"]: the bracket runs together, three times over
      const step = splitTop(m[2]).map(one);
      if (!step.length) throw new FlowError(`step '${item}': put what to repeat inside the brackets.`);
      for (let i = repeatCount(m[1], `step '${item}'`); i > 0; i--) steps.push(step);
      continue;
    }
    const items: unknown[] = Array.isArray(item) ? item : [item];
    if (items.some(isObj))
      throw new FlowError(`step ${JSON.stringify(item)}: a ': ' inside a step makes YAML read it as a setting. Drop the colon, or wrap the whole step in single quotes.`);
    if (items.length) steps.push(items.map(one));
  }
  return steps;
}

// How wide some text is drawn, in pixels.
type Measure = (text: string, size: number, weight: number) => number;

// A one-line label split into two lines at the space nearest its middle, when that makes it narrower.
function twoLines(label: string, width: (s: string) => number): string {
  if (label.includes("\n") || !label.includes(" ")) return label;
  let best = label;
  let bestWidth = width(label);
  for (let i = label.indexOf(" "); i >= 0; i = label.indexOf(" ", i + 1)) {
    const w = Math.max(width(label.slice(0, i)), width(label.slice(i + 1)));
    if (w < bestWidth) [best, bestWidth] = [label.slice(0, i) + "\n" + label.slice(i + 1), w];
  }
  return best;
}

// Blocks without a size of their own widen (and circles grow) so every label they will show fits.
// A circle first wraps a long label onto two lines, since growing to fit one long line makes it huge.
function fitLabels(sc: Scene, measure: Measure) {
  const [size, weight] = sc.style === "minimal" ? [14, 500] : [17, 600];
  for (const b of Object.values(sc.blocks)) {
    if (b.sized) continue;
    const sets = sc.steps.flat().filter((a) => a.kind === "set" && a.src === b.name && a.look?.label != null);
    if (b.shape === "circle") {
      const widest = (l: string) => Math.max(...l.split("\n").map((line) => measure(line, size, weight)));
      const wrap = (l: string) => (widest(l) <= b.w * 0.72 ? l : twoLines(l, (x) => measure(x, size, weight)));
      b.label = wrap(b.label);
      // later labels only wrap if they don't fit the size the first label needs
      b.w = b.h = Math.ceil(Math.max(b.w, widest(b.label) / 0.72));
      for (const a of sets) a.look = { ...a.look, label: wrap(a.look!.label!) };
    }
    const labels = [b.label, ...sets.map((a) => a.look!.label!)];
    const lines = labels.flatMap((l) => l.split("\n"));
    const widest = Math.max(...lines.map((line) => measure(line, size, weight)));
    const tall = Math.max(...labels.map((l) => l.split("\n").length)) * size * 1.25;
    if (b.shape === "circle") b.w = b.h = Math.ceil(Math.max(b.w, widest / 0.72, (tall + 16) / 0.72));
    else {
      b.w = Math.ceil(Math.max(b.w, widest / 0.86));
      b.h = Math.ceil(Math.max(b.h, tall + 22));
    }
  }
}

export function parseScene(source: string, measure: Measure = tableWidth): Scene {
  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (e) {
    throw new FlowError(`the scene isn't valid YAML:\n${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw == null) raw = {};
  if (!isObj(raw)) throw new FlowError("the scene should be a set of settings like blocks: and steps:.");
  const known = ["size", "fps", "title", "style", "theme", "background", "ball", "layout", "tracks", "grid", "hold", "blocks", "arrows", "steps"];
  const unknown = Object.keys(raw).filter((k) => !known.includes(k)).sort();
  if (unknown.length) throw new FlowError(`unknown top-level setting '${unknown[0]}'. Known: ${[...known].sort().join(", ")}.`);

  let size: Pt = [720, 400];
  if ("size" in raw) {
    const s = raw.size;
    if (!(Array.isArray(s) && s.length === 2)) throw new FlowError("size: write it like [720, 400].");
    size = [Math.round(parseNumber(s[0], "size", "width")), Math.round(parseNumber(s[1], "size", "height"))];
  }
  const themeName = String(raw.theme ?? "dark");
  if (!THEMES[themeName]) throw new FlowError(`theme '${themeName}' isn't known. Use ${Object.keys(THEMES).join(", ")}.`);
  const theme = { ...THEMES[themeName] };
  if ("background" in raw) theme.bg = theme.bg2 = parseColour(raw.background, "background", themeName);
  const style = String(raw.style ?? "minimal");
  if (!STYLES.includes(style)) throw new FlowError(`style '${style}' isn't known. Use ${STYLES.join(", ")}.`);
  const minimal = style === "minimal";
  const ball = raw.ball ?? {};
  if (!isObj(ball)) throw new FlowError("ball: write it like {colour: amber, size: 4}.");
  const layout = String(raw.layout ?? "auto");
  if (!LAYOUTS.includes(layout)) throw new FlowError(`layout '${layout}' isn't known. Use ${LAYOUTS.join(", ")}.`);

  const rawBlocks = raw.blocks;
  if (!isObj(rawBlocks) || !Object.keys(rawBlocks).length) throw new FlowError("blocks: add at least one block, like  blocks: {A: {}, B: {}}.");
  const blocks: Record<string, Block> = {};
  for (const [n, v] of Object.entries(rawBlocks)) blocks[n] = parseBlock(n, v, size, `block ${n}`, themeName);
  for (const b of Object.values(blocks))
    if (b.beside && !blocks[b.beside[1]]) throw new FlowError(`block ${b.name}: ${b.beside[0]} '${b.beside[1]}', but there's no such block.`);

  const arrows = (Array.isArray(raw.arrows) ? raw.arrows : raw.arrows == null ? [] : [raw.arrows]).map((a) => parseArrow(String(a), blocks, themeName));
  const steps = parseSteps(raw.steps, blocks, arrows, size, themeName);

  const sc: Scene = {
    size,
    title: String(raw.title ?? ""),
    style: style as Scene["style"],
    themeName,
    theme,
    ball: {
      colour: "colour" in ball ? parseColour(ball.colour, "ball", themeName) : minimal ? theme.text : theme.ball,
      size: parseNumber(ball.size ?? (minimal ? 4 : 6), "ball", "size"),
      glow: parseNumber(ball.glow ?? 9, "ball", "glow"),
      tail: Math.round(parseNumber(ball.tail ?? 6, "ball", "tail")),
    },
    layout,
    tracks: raw.tracks == null ? true : Boolean(raw.tracks),
    grid: raw.grid == null ? !minimal : Boolean(raw.grid),
    hold: parseTime(raw.hold ?? 0.6, "hold"),
    blocks,
    arrows,
    steps,
  };
  fitLabels(sc, measure);
  place(sc);
  return sc;
}

// ---- placing blocks ----

function ovalSlots(n: number, w: number, h: number, mx: number, my: number): Pt[] {
  const [cx, cy, rx, ry] = [w / 2, h / 2, w / 2 - mx, h / 2 - my];
  if (n === 1) return [[cx, cy]];
  if (n === 2) return [[cx - rx, cy], [cx + rx, cy]];
  // start at the left so 3 blocks make a triangle pointing right, 4 a diamond
  return Array.from({ length: n }, (_, i) => [cx - rx * Math.cos((2 * Math.PI * i) / n), cy - ry * Math.sin((2 * Math.PI * i) / n)] as Pt);
}

const spread = (n: number, lo: number, hi: number) => (n === 1 ? [(lo + hi) / 2] : Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1)));
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// every order of `items`
function* orders<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++)
    for (const rest of orders([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
}

// Gives every block a starting position: pinned, laid out, or next to another block.
function place(sc: Scene) {
  const blocks = sc.blocks;
  const list = Object.values(blocks);
  const w = sc.size[0];
  let h = sc.size[1];
  // keep the bottom strip free when there are captions to show there
  if (sc.steps.some((s) => s.some((a) => a.kind === "say"))) h -= 56;
  const mx = Math.max(...list.map((b) => b.w)) / 2 + 30;
  const my = Math.max(...list.map((b) => b.h)) / 2 + 24;
  const pos: Record<string, Pt> = {};
  for (const b of list) if (b.at) pos[b.name] = b.at;
  const free = list.filter((b) => !b.at && !b.beside).map((b) => b.name);
  const pairs: [string, string][] = [
    ...sc.steps.flat().filter((a) => a.kind === "ball").map((a) => [a.src, a.dst] as [string, string]),
    ...sc.arrows.map((a) => [a.a, a.b] as [string, string]),
  ];

  if (free.length && sc.layout === "row") spread(free.length, mx, w - mx).forEach((x, i) => (pos[free[i]] = [x, h / 2]));
  else if (free.length && sc.layout === "column") spread(free.length, my, h - my).forEach((y, i) => (pos[free[i]] = [w / 2, y]));
  else if (free.length && sc.layout === "grid") {
    const cols = Math.ceil(Math.sqrt(free.length));
    const rows = Math.ceil(free.length / cols);
    const xs = spread(cols, mx, w - mx);
    const ys = spread(rows, my, h - my);
    free.forEach((n, i) => (pos[n] = [xs[i % cols], ys[Math.floor(i / cols)]]));
  } else if (free.length) {
    const slots = ovalSlots(free.length + Object.keys(pos).length, w, h, mx, my);
    for (const [x, y] of Object.values(pos)) {
      // pinned blocks take the slot nearest to them
      let best = 0;
      slots.forEach((s, i) => {
        if ((s[0] - x) ** 2 + (s[1] - y) ** 2 < (slots[best][0] - x) ** 2 + (slots[best][1] - y) ** 2) best = i;
      });
      slots.splice(best, 1);
    }
    if (sc.layout === "auto" && free.length <= 7) {
      // try every order and keep the one where the balls travel least
      let bestCost = Infinity;
      let bestOrder = slots;
      for (const order of orders(slots)) {
        const p: Record<string, Pt> = { ...pos };
        free.forEach((n, i) => (p[n] = order[i]));
        const cost = pairs.reduce((sum, [a, b]) => (p[a] && p[b] ? sum + dist(p[a], p[b]) : sum), 0);
        if (cost < bestCost) [bestCost, bestOrder] = [cost, order];
      }
      free.forEach((n, i) => (pos[n] = bestOrder[i]));
    } else free.forEach((n, i) => (pos[n] = slots[i]));
  }

  let pending = list.filter((b) => b.beside).map((b) => b.name);
  while (pending.length) {
    const done = pending.filter((n) => pos[blocks[n].beside![1]]);
    if (!done.length) throw new FlowError(`blocks ${pending.join(", ")} are each placed next to the other, so none has a position.`);
    for (const n of done) {
      const [side, other, gap] = blocks[n].beside!;
      const [dx, dy] = SIDES[side];
      const [ox, oy] = pos[other];
      pos[n] = [ox + dx * (gap + (blocks[n].w + blocks[other].w) / 2), oy + dy * (gap + (blocks[n].h + blocks[other].h) / 2)];
    }
    pending = pending.filter((n) => !done.includes(n));
  }
  for (const b of list) b.pos = pos[b.name];
}
