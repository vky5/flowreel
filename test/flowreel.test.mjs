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
