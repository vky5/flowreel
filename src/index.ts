import { parseScene } from "./scene.js";
import { FONT, Writer, type Measure } from "./svg.js";
import { tableWidth } from "./widths.js";

// flowreel: a small YAML scene of blocks, arrows and moving dots, drawn as an SVG that animates itself.

export { FlowError, parseScene } from "./scene.js";
export type { Scene, Block, Arrow, Action, RGB, Pt } from "./scene.js";
export type { Measure } from "./svg.js";

export type Options = {
  // How wide text is drawn, so labels fit their blocks. By default the browser measures it,
  // and outside a browser a built-in table of character widths is used.
  measure?: Measure;
};

let ctx: CanvasRenderingContext2D | null | undefined;

// Measures with the browser's own fonts when there is a browser, else uses the width table.
const autoMeasure: Measure = (text, size, weight) => {
  if (ctx === undefined) ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!ctx) return tableWidth(text, size, weight);
  ctx.font = `${weight} ${size}px ${FONT}`;
  return ctx.measureText(text).width;
};

// The SVG and how long one loop lasts, in seconds. Throws FlowError when the scene has a mistake.
export function render(source: string, options: Options = {}): { svg: string; duration: number } {
  const measure = options.measure ?? autoMeasure;
  const writer = new Writer(parseScene(source, measure), measure);
  return { svg: writer.render(), duration: writer.total };
}

// Just the SVG text. Throws FlowError when the scene has a mistake.
export function renderFlowreel(source: string, options: Options = {}): string {
  return render(source, options).svg;
}
