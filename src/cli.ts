#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, resolve } from "node:path";
import { FlowError, render } from "./index.js";

const HELP = `flowreel: turn a scene file into an SVG of blocks with dots moving between them.

  flowreel scene.yaml                  writes scene.svg, which animates by itself
  flowreel scene.yaml -o other.svg     writes somewhere else
  flowreel preview scene.yaml          live page at http://127.0.0.1:7788 that redraws on save
           [--port 7788] [--open]

The scene format: https://www.npmjs.com/package/@vky5/flowreel`;

function fail(message: string): never {
  console.error(`flowreel: ${message}`);
  process.exit(1);
}

function draw(file: string) {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    throw new FlowError(`${file} doesn't exist.`);
  }
  return render(source);
}

function renderCommand(args: string[]) {
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) fail("give a scene file, like: flowreel scene.yaml");
  const o = args.indexOf("-o");
  const out = o >= 0 ? args[o + 1] : file.slice(0, file.length - extname(file).length) + ".svg";
  if (!out) fail("-o needs a file name.");
  if (out.toLowerCase().endsWith(".gif")) fail("GIF output is in the Python tool: python/flowreel_gif.py in the flowreel repo.");
  try {
    const { svg, duration } = draw(file);
    writeFileSync(out, svg);
    console.log(`flowreel: wrote ${out} (${duration.toFixed(1)}s loop, ${Math.round(Buffer.byteLength(svg) / 1024)} KB)`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

const PAGE = (name: string, stem: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>flowreel · ${name}</title>
<style>
body{margin:0;padding:24px 16px;font:14px/1.45 system-ui,sans-serif;background:#0d0f13;color:#d8dce4;display:flex;flex-direction:column;align-items:center;gap:12px}
header{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;width:min(100%,960px)}
h1{font-size:15px;margin:0;font-weight:600} #info{color:#8a90a0} a{color:#fbbf24;margin-left:auto}
#stage{background:#1a1d24;border-radius:10px;padding:12px;max-width:100%;box-sizing:border-box}
img{display:block;max-width:100%;height:auto}
#error{display:none;white-space:pre-wrap;margin:0;font:13px/1.45 ui-monospace,monospace;background:#3a1218;color:#ffb3bf;border-radius:8px;padding:12px 14px;width:min(100%,960px);box-sizing:border-box}
</style></head><body>
<header><h1>${name}</h1><span id="info">drawing…</span><a href="/reel.svg" download="${stem}.svg">download SVG</a></header>
<pre id="error"></pre>
<div id="stage"><img id="reel" alt="the scene"></div>
<script>
let shown = -1;
async function poll() {
  try {
    const s = await (await fetch('/status', {cache: 'no-store'})).json();
    document.getElementById('info').textContent = s.info;
    const err = document.getElementById('error');
    err.textContent = s.error;
    err.style.display = s.error ? 'block' : 'none';
    if (s.version !== shown && s.version > 0) {
      shown = s.version;
      document.getElementById('reel').src = '/reel.svg?v=' + shown;
    }
  } catch (e) {
    document.getElementById('info').textContent = 'preview stopped. Run flowreel preview again.';
  }
  setTimeout(poll, 400);
}
poll();
</script></body></html>`;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function previewCommand(args: string[]) {
  const file = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--port");
  if (!file) fail("give a scene file, like: flowreel preview scene.yaml");
  const p = args.indexOf("--port");
  const port = p >= 0 ? Number(args[p + 1]) : 7788;
  if (!Number.isInteger(port) || port <= 0) fail("--port needs a number.");
  const path = resolve(file);
  const state = { svg: "", version: 0, error: "", info: "" };

  // draws again whenever the file's modified time changes; the last good drawing stays up after a mistake
  let last = -1;
  const check = () => {
    let stamp: number;
    try {
      stamp = statSync(path).mtimeMs;
    } catch {
      stamp = 0;
    }
    if (stamp === last) return;
    last = stamp;
    const started = Date.now();
    try {
      const { svg, duration } = draw(path);
      Object.assign(state, { svg, version: state.version + 1, error: "", info: `${duration.toFixed(1)}s loop · ${Math.round(Buffer.byteLength(svg) / 1024)} KB · drawn in ${Date.now() - started} ms` });
      console.log(`flowreel: ${state.info}`);
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      console.log(`flowreel: error: ${state.error.split("\n")[0]}`);
    }
  };
  check();
  setInterval(check, 300);

  const page = PAGE(escapeHtml(basename(path)), escapeHtml(basename(path, extname(path))));
  const server = createServer((req, res) => {
    const route = (req.url ?? "/").split("?")[0];
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    if (route === "/") send(200, "text/html; charset=utf-8", page);
    else if (route === "/reel.svg" && state.svg) send(200, "image/svg+xml", state.svg);
    else if (route === "/status") send(200, "application/json", JSON.stringify({ version: state.version, error: state.error, info: state.info }));
    else send(404, "text/plain", "not found");
  });
  server.on("error", (e: NodeJS.ErrnoException) => fail(`can't use port ${port} (${e.code}). Try --port ${port + 1}.`));
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`flowreel: previewing ${basename(path)} at ${url}  (Ctrl+C to stop)`);
    if (args.includes("--open")) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    }
  });
}

const args = process.argv.slice(2);
if (!args.length || args[0] === "-h" || args[0] === "--help") console.log(HELP);
else if (args[0] === "preview") previewCommand(args.slice(1));
else renderCommand(args[0] === "render" ? args.slice(1) : args);
