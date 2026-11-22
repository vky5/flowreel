# flowreel

Animated diagrams from a small YAML file: blocks, arrows, and dots moving between them in order. The output is an SVG that animates itself and loops like a GIF, but stays sharp at any size and is a few KB.

```yaml
blocks:
  client: Client
  api: API
  cache: Cache
arrows:
  - client -> api
  - api <-> cache
steps:
  - client -> api
  - api -> cache
  - [cache -> api red, say "cache miss"]
```

The SVG uses only SVG's own animation tags, no scripts, so it plays as an `<img>`, in GitHub READMEs and in most docs sites.

## Command line

    npx @vky5/flowreel scene.yaml                 # writes scene.svg next to it
    npx @vky5/flowreel scene.yaml -o out.svg
    npx @vky5/flowreel preview scene.yaml --open  # live page at http://127.0.0.1:7788

Installed globally (`npm install -g @vky5/flowreel`), the command is just `flowreel`.

`preview` redraws every time you save the file. If the file has a mistake, the page shows the error and keeps the last good drawing.

## Library

    npm install @vky5/flowreel

```ts
import { renderFlowreel, render, FlowError } from "@vky5/flowreel";

const svg = renderFlowreel(yamlText);               // the SVG text
const { svg: s, duration } = render(yamlText);      // plus how long one loop lasts, in seconds

try {
  renderFlowreel("blocks: {A: {}}\nsteps: [A -> B]");
} catch (e) {
  if (e instanceof FlowError) console.log(e.message); // step 'A -> B': there's no block called 'B'.
}
```

It runs in browsers and in Node, and its only dependency is `yaml`. In a browser, labels are measured with the page's own fonts so they fit their blocks. In Node, a built-in table of character widths is used, which errs on the wide side. Pass `{ measure: (text, size, weight) => width }` to use your own.

Show the result as an image (`<img src="data:image/svg+xml;charset=utf-8,..."`) rather than pasting it into the page. The animation still plays, and the drawing can't affect the rest of the page.

## GIF

Chat apps and email mostly won't show an SVG. `python/flowreel_gif.py` in this repo draws the same scene as a GIF (needs Python 3 with Pillow and PyYAML). It is a separate Python copy of the scene reader, so a brand-new setting may reach it later. It doesn't know `&`, `pulse`, `set`, `repeat` or ball labels yet.

## Scene file

```yaml
size: [720, 400]          # canvas, default 720x400
title: Cache-aside read   # optional, shown as a tooltip and read by screen readers
style: minimal            # minimal (flat, quiet) or glow (gradients, glow, comet tails)
theme: dark               # dark or light
grid: false               # faint dot grid behind everything, on by default for glow
background: 0d0f13        # optional, overrides the theme
ball: {colour: amber, size: 4}  # glow style also takes glow: 9 and tail: 6
layout: auto              # where blocks without a position go: auto, circle, row, column, grid
tracks: true              # faint line under balls that have no arrow to follow
hold: 0.6s                # pause at the end before the loop starts again
fps: 25                   # GIF tool only

blocks:
  client: Client                          # just a label
  api: {label: API, at: [360, 80]}        # pinned in pixels
  cache: {at: [0.5, 0.8]}                 # decimals between 0 and 1 are shares of the canvas
  db: {label: "Main\ndatabase", shape: circle, size: 90, colour: purple, hidden: true}
  log: {right-of: api, gap: 60}           # also left-of, above, below

arrows:
  - client -> api                         # arrowhead at api
  - api <-> cache curve=0.2 "lookup"      # both ends, bent, with a label
  - api -- db dashed grey width=1         # plain line
  - db -> log flow                        # dashes keep moving along the arrow

steps:                                    # one after another
  - client -> api                         # a ball, 1 second
  - api -> cache 0.6s blue ease=out       # time, colour, ease, size=8
  - [cache -> api red, say "cache miss"]  # a list runs at the same time
  - show db 0.4s                          # fade in; also hide db
  - move db to 0.8,0.5 1s                 # slide somewhere new
  - pause 0.5s
  - api -> db "SELECT *"                  # a label that rides on the dot
  - db -> api 8s teal &                   # &: start this, and carry on with the next steps
  - pulse db 1.2s                         # the block works by itself: its outline breathes
  - set db green "ready"                  # change a block: outline colour, fill=, text= or its label
  - set api -> db flow                    # change an arrow: flow / noflow, dashed / solid, or a colour
  - repeat 3 [db -> api 0.4s blue]        # the bracket, three times over
  - repeat: 2                             # several steps, repeated
    steps:
      - api -> db
      - db -> api
```

Blocks:

- **Shapes:** `box` (default), `rect`, `pill`, `circle`.
- **Colours:** `colour` sets the outline, `fill` the inside, `text` the label.
- **Labels:** `\n` inside double quotes breaks the line. A block without a `size` grows to fit its label, including labels it gets later from `set`; a circle wraps a long label onto two lines first. A block with a `size` keeps it, and its label shrinks to fit instead.

Balls:

- **Paths:** a ball follows the arrow between its two blocks, curves included. With no arrow, it goes straight.
- **Landing:** when a ball arrives, the block's outline briefly takes the ball's colour.
- **Labels:** text in quotes after a ball (`a -> b "GET /user"`) travels with it, so two dots moving at once can say which is which.
- **Glow style:** adds a comet tail behind each ball, plus a pulse and glow when it lands.

Placement:

- **Auto layout:** `auto` puts blocks on an oval in the order where balls travel least.
- **Fixed orders:** `circle`, `row`, `column` and `grid` use the order the blocks are written in.
- **Captions:** when the scene has a `say`, the bottom strip is kept free for it.

Colours can be `amber`, `orange`, `red`, `pink`, `purple`, `blue`, `cyan`, `teal`, `green`, `white`, `grey`, `black`, or six hex digits like `5cc8ff`. Each name has a lighter shade on the dark theme and a deeper one on the light theme.

Eases are `smooth` (default), `linear`, `in` and `out`.

Timing:

- **Steps run one after another.** A `[...]` list starts everything in it together, and the next step waits for all of it.
- **`&` at the end of an action** starts it with its step, but the next step doesn't wait for it, like a long download that runs while other things happen. It works on any action except `pause`.
- **`set`** cross-fades to the new look over 0.3s; give a time (`set db green 1s`) to change that.

## YAML traps

- **Don't write `#5cc8ff`.** YAML treats everything after ` #` as a comment, so the colour silently disappears.
- **Don't put `: ` inside a step.** `say "note: hi"` becomes a setting. Drop the colon, or wrap the whole step in single quotes.

## Versions

flowreel is at 0.x: the scene format may still change between minor versions. Changes are listed in the release notes.
