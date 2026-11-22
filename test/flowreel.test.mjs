import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FlowError, parseScene, render, renderFlowreel } from "../dist/index.js";

const here = new URL(".", import.meta.url).pathname;
const example = readFileSync(join(here, "../examples/cache-aside.yaml"), "utf8");
const cli = join(here, "../dist/cli.js");

// The example's SVG is kept in test/cache-aside.svg.snap. Run with UPDATE=1 to accept a deliberate change.
test("the example draws the same SVG as last time", () => {
  const snap = join(here, "cache-aside.svg.snap");
  const svg = renderFlowreel(example);
  if (process.env.UPDATE || !existsSync(snap)) writeFileSync(snap, svg);
  assert.equal(svg, readFileSync(snap, "utf8"));
});

test("every ball step becomes one moving dot, and the loop length adds up", () => {
  const { svg, duration } = render(example);
  const balls = parseScene(example).steps.flat().filter((a) => a.kind === "ball").length;
  assert.equal((svg.match(/<animateMotion/g) ?? []).length, balls);
  assert.ok(Math.abs(duration - 10.75) < 1e-9, `loop is ${duration}s`); // 9.6s of steps + 0.55s landing glow + 0.6s hold
});

test("minimal has no glow effects; glow has them", () => {
  const minimal = renderFlowreel(example);
  const glow = renderFlowreel("style: glow\n" + example);
  assert.ok(!minimal.includes("<filter"));
  assert.ok(glow.includes('id="glowblur"') && glow.includes('id="shadow"'));
});

test("labels shrink to fit their block without a browser", () => {
  const svg = renderFlowreel("blocks:\n  db: {label: A very long database name, shape: circle, size: 70}\n");
  const size = Number(svg.match(/font-size="(\d+)"/)[1]);
  assert.equal(size, 12);
});

test("text in labels can't break out of the SVG", () => {
  const svg = renderFlowreel('blocks:\n  a: {label: "</text><script>x</script>"}\n');
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;script&gt;"));
});

const mistakes = [
  ["blocks: {A: {}}\nsteps: [A -> B]", /no block called 'B'/],
  ["blocks: {A: {shape: hex}}", /shape 'hex' isn't known/],
  ["blocks: {A: {}, B: {}}\narrows: [A => B]", /write arrows like/],
  ["blocks: {A: {}, B: {}}\nsteps: [A -> B 2x]", /'2x' isn't a colour/],
  ["blocks: {A: {right-of: B}, B: {left-of: A}}", /none has a position/],
  ['blocks: {A: {}}\nsteps: ["say hi"]', /put the caption in quotes/],
  ["blocks: {A: {}}\nstep: []", /unknown top-level setting 'step'/],
  ["blocks: [", /isn't valid YAML/],
  ['blocks: {A: {}}\nsteps: [say "note: hi"]', /makes YAML read it as a setting/],
  ["style: fancy\nblocks: {A: {}}", /style 'fancy' isn't known/],
  ["steps: []", /add at least one block/],
];
for (const [scene, message] of mistakes) {
  test(`mistake is explained: ${message.source}`, () => {
    assert.throws(() => renderFlowreel(scene), (e) => e instanceof FlowError && message.test(e.message));
  });
}

test("the command writes an SVG next to the scene", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-"));
  try {
    writeFileSync(join(dir, "s.yaml"), example);
    const r = spawnSync(process.execPath, [cli, join(dir, "s.yaml")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote .*s\.svg \(10\.8s loop/);
    assert.equal(readFileSync(join(dir, "s.svg"), "utf8"), renderFlowreel(example));
    const bad = spawnSync(process.execPath, [cli, join(dir, "missing.yaml")], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /missing\.yaml doesn't exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview serves the drawing and reports mistakes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-"));
  const file = join(dir, "s.yaml");
  writeFileSync(file, example);
  const port = 17000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [cli, "preview", file, "--port", String(port)], { stdio: "pipe" });
  const base = `http://127.0.0.1:${port}`;
  const get = async (path) => {
    for (let i = 0; i < 50; i++) {
      try {
        return await fetch(base + path);
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("preview never started");
  };
  try {
    assert.equal((await get("/")).status, 200);
    const svg = await get("/reel.svg");
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.equal(await svg.text(), renderFlowreel(example));
    writeFileSync(file, "blocks: {A: {}}\nsteps: [A -> B]\n");
    await new Promise((r) => setTimeout(r, 800));
    const status = await (await get("/status")).json();
    assert.match(status.error, /no block called 'B'/);
    assert.equal(status.version, 1); // the last good drawing stays up
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 0.2.0: labels on dots, background steps, set, repeat, pulse, labels that fit ----

const two = "blocks:\n  a: A\n  b: B\narrows:\n  - a -> b\n";

test("a ball can carry a label that travels with it", () => {
  const svg = renderFlowreel(two + 'steps:\n  - a -> b "want [model.pt]"\n');
  const ball = svg.slice(svg.indexOf('<g class="balls">'));
  assert.ok(ball.includes("want [model.pt]"), "label sits inside the moving ball group");
});

test("& starts an action and lets the next steps run alongside it", () => {
  const steps = (amp) => `steps:\n  - a -> b 10s${amp}\n  - b -> a 1s\n  - b -> a 1s\n`;
  // 10s background ball overlaps the two 1s balls, so the loop is 10s + 0.55s landing glow + 0.6s hold
  assert.ok(Math.abs(render(two + steps(" &")).duration - 11.15) < 1e-9);
  assert.ok(Math.abs(render(two + steps("")).duration - 13.15) < 1e-9);
  assert.throws(() => renderFlowreel(two + "steps:\n  - pause 1s &\n"), /can't run in the background/);
});

test("set changes a block's colour and label, cross-fading between looks", () => {
  const svg = renderFlowreel("blocks:\n  job: {label: running}\nsteps:\n  - pause 1s\n  - set job green \"done\"\n");
  assert.ok(svg.includes(">running<") && svg.includes(">done<"));
  assert.equal((svg.match(/>done</g) ?? []).length, 1);
  assert.ok(svg.includes(`stroke="#4ade80"`), "green outline in the second look");
});

test("set turns an arrow's flow on and off", () => {
  const svg = renderFlowreel(two + "steps:\n  - set a -> b flow\n  - pause 2s\n  - set a -> b noflow\n");
  assert.equal((svg.match(/attributeName="stroke-dashoffset" values="13;0"/g) ?? []).length, 1, "one flowing look");
  assert.ok((svg.match(/marker-end=/g) ?? []).length >= 2, "a solid look and a flowing look");
  assert.throws(() => renderFlowreel(two + "steps:\n  - set b -> c flow\n"), /no block called 'c'/);
  assert.throws(() => renderFlowreel("blocks: {a: A, b: B}\nsteps:\n  - set a -> b flow\n"), /no arrow between 'a' and 'b'/);
  assert.throws(() => renderFlowreel(two + "steps:\n  - set a\n"), /say what changes/);
});

test("repeat writes steps out several times", () => {
  const count = (yaml) => (renderFlowreel(two + yaml).match(/<animateMotion/g) ?? []).length;
  assert.equal(count("steps:\n  - repeat 3 [b -> a 0.4s blue]\n"), 3);
  assert.equal(count('steps:\n  - repeat 2 [a -> b, say "a, b"]\n'), 2, "commas inside quotes don't split");
  assert.equal(count("steps:\n  - repeat: 2\n    steps:\n      - a -> b\n      - b -> a\n"), 4);
  assert.throws(() => renderFlowreel(two + "steps:\n  - repeat 0 [a -> b]\n"), /whole number from 1 to 100/);
  assert.throws(() => renderFlowreel(two + "steps:\n  - repeat: 2\n    do: [a -> b]\n"), /unknown setting 'do'/);
});

test("pulse makes a block's outline breathe for its duration", () => {
  const svg = renderFlowreel("blocks:\n  b: B\nsteps:\n  - pulse b 1.2s amber\n");
  const ring = svg.match(/<g opacity="0" fill="none"><animate attributeName="opacity"[^>]*values="([^"]*)"/);
  assert.ok(ring, "the ring is animated");
  assert.equal(ring[1].split(";").filter((v) => v === "0.85").length, 2, "two 0.6s breaths in 1.2s");
});

test("blocks without a size grow so their labels fit", () => {
  const big = parseScene("blocks:\n  r: {label: A results folder, shape: circle}\n").blocks.r;
  assert.ok(big.w > 76 && big.w < 110 && big.w === big.h, `circle grew to ${big.w}, wrapping rather than growing huge`);
  assert.equal(big.label, "A results\nfolder");
  const done = parseScene("blocks:\n  r: {label: A results folder, shape: circle}\nsteps:\n  - set r \"3 results\"\n");
  assert.equal(done.steps[0][0].look.label, "3 results", "a later label that fits stays on one line");
  assert.equal(renderFlowreel("blocks:\n  r: {label: A results folder, shape: circle}\n").match(/font-size="(\d+)"/)[1], "14");
  const later = parseScene("blocks:\n  j: {label: run}\nsteps:\n  - set j \"waiting for the very long download\"\n").blocks.j;
  assert.ok(later.w > 124, "grows for labels set later too");
  assert.equal(parseScene("blocks:\n  r: {label: A results folder, shape: circle, size: 60}\n").blocks.r.w, 60, "an explicit size is kept");
});
