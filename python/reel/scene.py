"""Reads a scene file into plain objects and places the blocks that have no position."""
import math
import re
from dataclasses import dataclass, field
from itertools import permutations
from pathlib import Path

import yaml


class SceneError(Exception):
    """A mistake in the scene file, worded for the person who wrote it."""


# each colour name has a shade for dark backgrounds and a deeper one for light backgrounds
COLOURS = {
    "amber": ("fbbf24", "d97706"), "orange": ("fb923c", "ea580c"), "red": ("f87171", "dc2626"),
    "pink": ("f472b6", "db2777"), "purple": ("a78bfa", "7c3aed"), "blue": ("60a5fa", "2563eb"),
    "cyan": ("22d3ee", "0891b2"), "teal": ("2dd4bf", "0d9488"), "green": ("4ade80", "16a34a"),
    "white": ("f8fafc", "ffffff"), "grey": ("94a3b8", "64748b"), "black": ("0f172a", "0f172a"),
}

THEMES = {
    "dark": {"bg": (11, 14, 20), "bg2": (21, 26, 36), "fill": (24, 29, 39), "fill_top": (33, 39, 52),
             "edge": (58, 67, 85), "text": (226, 232, 240), "arrow": (84, 95, 117), "track": (36, 43, 56),
             "dots": (28, 34, 46), "ball": (251, 191, 36), "glow": 0.9},
    "light": {"bg": (246, 246, 243), "bg2": (255, 255, 255), "fill": (255, 255, 255), "fill_top": (255, 255, 255),
              "edge": (200, 205, 214), "text": (30, 35, 45), "arrow": (150, 158, 172), "track": (225, 228, 233),
              "dots": (226, 227, 230), "ball": (217, 119, 6), "glow": 0.55},
}

EASES = {
    "linear": lambda t: t,
    "smooth": lambda t: t * t * (3 - 2 * t),
    "in": lambda t: t * t,
    "out": lambda t: 1 - (1 - t) ** 2,
}

STYLES = ("minimal", "glow")
SHAPES = ("box", "rect", "pill", "circle")
LAYOUTS = ("auto", "circle", "row", "column", "grid")
SIDES = {"right-of": (1, 0), "left-of": (-1, 0), "above": (0, -1), "below": (0, 1)}
FLAGS = {"dashed": ("dashed", True), "solid": ("dashed", False), "flow": ("flow", True)}
TIME_RE = re.compile(r"^(\d+(?:\.\d+)?|\.\d+)(s|ms)?$")


@dataclass
class Block:
    name: str
    label: str
    shape: str = "box"
    w: float = 120
    h: float = 56
    fill: tuple = None
    edge: tuple = None
    text: tuple = None
    at: tuple = None       # where the file pins it
    beside: tuple = None   # (side, other block, gap) when placed next to another block
    hidden: bool = False
    pos: tuple = None      # where it ends up at the start


@dataclass
class Arrow:
    a: str
    b: str
    heads: str = "end"     # end, both or none
    curve: float = 0.0
    dashed: bool = False
    flow: bool = False     # dashes keep moving along the arrow
    colour: tuple = None
    label: str = ""
    width: float = None    # None means the style's own line width


@dataclass
class Action:
    kind: str              # ball, show, hide, move, say or pause
    time: float = 1.0
    src: str = ""
    dst: str = ""
    colour: tuple = None
    ease: str = "smooth"
    size: float = None
    to: tuple = None
    text: str = ""


@dataclass
class Scene:
    size: tuple = (720, 400)
    fps: int = 25
    title: str = ""
    style: str = "minimal"   # minimal: flat and quiet; glow: gradients, glow and comet tails
    theme_name: str = "dark"
    theme: dict = field(default_factory=lambda: dict(THEMES["dark"]))
    ball: dict = field(default_factory=dict)
    layout: str = "auto"
    tracks: bool = True
    grid: bool = True
    hold: float = 0.6
    blocks: dict = field(default_factory=dict)
    arrows: list = field(default_factory=list)
    steps: list = field(default_factory=list)


def parse_colour(value, where, theme="dark"):
    if isinstance(value, int) and not isinstance(value, bool):
        value = f"{value:06d}"  # YAML reads 123456 as a number
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return tuple(int(v) for v in value)
    s = str(value).lower()
    s = COLOURS[s][theme == "light"] if s in COLOURS else s.lstrip("#")
    if re.fullmatch(r"[0-9a-f]{6}", s):
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    raise SceneError(f"{where}: {value!r} isn't a colour. Use {', '.join(COLOURS)} or hex like 5cc8ff.")


def parse_time(value, where):
    m = TIME_RE.match(str(value).strip())
    if not m:
        raise SceneError(f"{where}: {value!r} isn't a time. Write it like 0.6s or 600ms.")
    return float(m.group(1)) / (1000 if m.group(2) == "ms" else 1)


def parse_number(value, where, name):
    try:
        return float(value)
    except (TypeError, ValueError):
        raise SceneError(f"{where}: {name} should be a number, got {value!r}.") from None


def coord(value, full, where):
    """A pixel value, or a share of the canvas when it is between 0 and 1 (datlas reads it the same way)."""
    n = parse_number(value, where, "a position")
    return n * full if 0 < n < 1 else n


def parse_point(value, size, where):
    if isinstance(value, str):
        value = value.strip().strip("[]()").split(",")
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise SceneError(f"{where}: a position is two numbers like [120, 200] or [0.25, 0.5].")
    return coord(value[0], size[0], where), coord(value[1], size[1], where)


def split_line(text):
    """Takes out a quoted label, then splits the rest on spaces, with arrows as their own words."""
    label = None
    m = re.search(r'"([^"]*)"|\'([^\']*)\'', text)
    if m:
        label = m.group(1) if m.group(1) is not None else m.group(2)
        text = text[:m.start()] + " " + text[m.end():]
    text = re.sub(r"(<->|->|--)", r" \1 ", text)
    return text.split(), label


def read_options(tokens, where, allowed, theme):
    """Turns words like 0.6s, blue, dashed, ease=out into a dict."""
    out = {}
    for tok in tokens:
        if "=" in tok:
            key, val = tok.split("=", 1)
            key = {"color": "colour"}.get(key.lower(), key.lower())
        elif TIME_RE.match(tok):
            key, val = "time", tok
        elif tok.lower() in FLAGS:
            key, val = FLAGS[tok.lower()]
        else:
            key, val = "colour", tok
        if key not in allowed:
            raise SceneError(f"{where}: {tok!r} doesn't fit here. This line takes: {', '.join(allowed)}.")
        if key == "time":
            out[key] = parse_time(val, where)
        elif key == "colour":
            out[key] = parse_colour(val, where, theme)
        elif key == "ease":
            if val not in EASES:
                raise SceneError(f"{where}: ease={val} isn't known. Use {', '.join(EASES)}.")
            out[key] = val
        elif key in ("dashed", "flow"):
            out[key] = val
        else:
            out[key] = parse_number(val, where, key)
    return out


def parse_block(name, raw, size, where, theme):
    if raw is None:
        raw = {}
    if isinstance(raw, (str, int, float)):
        raw = {"label": str(raw)}
    if not isinstance(raw, dict):
        raise SceneError(f"{where}: expected settings like {{label: API, shape: pill}}.")
    known = {"label", "at", "shape", "size", "colour", "color", "fill", "text", "hidden", "gap", *SIDES}
    unknown = sorted(set(raw) - known)
    if unknown:
        raise SceneError(f"{where}: unknown setting {unknown[0]!r}. Known: {', '.join(sorted(known))}.")
    shape = raw.get("shape", "box")
    if shape not in SHAPES:
        raise SceneError(f"{where}: shape {shape!r} isn't known. Use {', '.join(SHAPES)}.")
    w, h = (76, 76) if shape == "circle" else (124, 56)
    if "size" in raw:
        s = raw["size"]
        if isinstance(s, (list, tuple)) and len(s) == 2:
            w, h = parse_number(s[0], where, "size"), parse_number(s[1], where, "size")
        else:
            w = parse_number(s, where, "size")
            h = w if shape == "circle" else h
    b = Block(name=name, label=str(raw.get("label", name)), shape=shape, w=w, h=h,
              hidden=bool(raw.get("hidden", False)))
    edge = raw.get("colour", raw.get("color"))
    b.edge = parse_colour(edge, where, theme) if edge is not None else None
    b.fill = parse_colour(raw["fill"], where, theme) if "fill" in raw else None
    b.text = parse_colour(raw["text"], where, theme) if "text" in raw else None
    if "at" in raw:
        b.at = parse_point(raw["at"], size, where)
    sides = [s for s in SIDES if s in raw]
    if len(sides) > 1 or (sides and b.at):
        raise SceneError(f"{where}: give a block one of at, right-of, left-of, above, below.")
    if sides:
        b.beside = (sides[0], str(raw[sides[0]]), parse_number(raw.get("gap", 80), where, "gap"))
    return b


def parse_arrow(text, blocks, theme):
    where = f"arrow {text!r}"
    tokens, label = split_line(text)
    if len(tokens) < 3 or tokens[1] not in ("->", "<->", "--"):
        raise SceneError(f"{where}: write arrows like 'A -> B', 'A <-> B' or 'A -- B'.")
    a, op, b = tokens[:3]
    for n in (a, b):
        if n not in blocks:
            raise SceneError(f"{where}: there's no block called {n!r}.")
    opts = read_options(tokens[3:], where, ("colour", "curve", "dashed", "flow", "width"), theme)
    return Arrow(a=a, b=b, heads={"->": "end", "<->": "both", "--": "none"}[op], label=label or "",
                 curve=opts.get("curve", 0.0), dashed=opts.get("dashed", False), flow=opts.get("flow", False),
                 colour=opts.get("colour"), width=opts.get("width"))


MOVE_RE = re.compile(r"^\s*move\s+(\w+)\s+to\s+\[?\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]?(.*)$")


def parse_action(text, blocks, size, theme):
    where = f"step {text!r}"
    tokens, label = split_line(text)
    if not tokens:
        raise SceneError(f"{where}: empty step.")

    def need_block(n):
        if n not in blocks:
            raise SceneError(f"{where}: there's no block called {n!r}.")
        return n

    word = tokens[0]
    if word == "pause":
        if len(tokens) != 2:
            raise SceneError(f"{where}: write it like 'pause 0.5s'.")
        return Action(kind="pause", time=parse_time(tokens[1], where))
    if word == "say":
        if label is None:
            raise SceneError(f"{where}: put the caption in quotes, like say \"Cache miss\" 1.5s.")
        opts = read_options(tokens[1:], where, ("time",), theme)
        return Action(kind="say", text=label, time=opts.get("time", 1.5))
    if word in ("show", "hide"):
        if len(tokens) < 2:
            raise SceneError(f"{where}: write it like '{word} B 0.4s'.")
        opts = read_options(tokens[2:], where, ("time", "ease"), theme)
        return Action(kind=word, src=need_block(tokens[1]), time=opts.get("time", 0.4),
                      ease=opts.get("ease", "smooth"))
    if word == "move":
        m = MOVE_RE.match(text)
        if not m:
            raise SceneError(f"{where}: write it like 'move B to 300,200 1s' or 'move B to 0.5,0.5'.")
        opts = read_options(m.group(4).split(), where, ("time", "ease"), theme)
        return Action(kind="move", src=need_block(m.group(1)), to=parse_point([m.group(2), m.group(3)], size, where),
                      time=opts.get("time", 1.0), ease=opts.get("ease", "smooth"))
    if len(tokens) >= 3 and tokens[1] == "->":
        opts = read_options(tokens[3:], where, ("time", "colour", "ease", "size"), theme)
        return Action(kind="ball", src=need_block(tokens[0]), dst=need_block(tokens[2]),
                      time=opts.get("time", 1.0), colour=opts.get("colour"),
                      ease=opts.get("ease", "smooth"), size=opts.get("size"))
    raise SceneError(f"{where}: expected 'A -> B', 'pause', 'say', 'show', 'hide' or 'move'.")


def parse(raw):
    if not isinstance(raw, dict):
        raise SceneError("the scene file should be a set of settings like blocks: and steps:.")
    known = {"size", "fps", "title", "style", "theme", "background", "ball", "layout", "tracks", "grid", "hold",
             "blocks", "arrows", "steps"}
    unknown = sorted(set(raw) - known)
    if unknown:
        raise SceneError(f"unknown top-level setting {unknown[0]!r}. Known: {', '.join(sorted(known))}.")
    sc = Scene()
    if "size" in raw:
        s = raw["size"]
        if not (isinstance(s, (list, tuple)) and len(s) == 2):
            raise SceneError("size: write it like [720, 400].")
        sc.size = (int(parse_number(s[0], "size", "width")), int(parse_number(s[1], "size", "height")))
    sc.fps = int(parse_number(raw.get("fps", 25), "fps", "fps"))
    sc.title = str(raw.get("title", ""))
    theme = raw.get("theme", "dark")
    if theme not in THEMES:
        raise SceneError(f"theme {theme!r} isn't known. Use {', '.join(THEMES)}.")
    sc.theme_name = theme
    sc.theme = dict(THEMES[theme])
    if "background" in raw:
        sc.theme["bg"] = sc.theme["bg2"] = parse_colour(raw["background"], "background", theme)
    sc.style = raw.get("style", "minimal")
    if sc.style not in STYLES:
        raise SceneError(f"style {sc.style!r} isn't known. Use {', '.join(STYLES)}.")
    minimal = sc.style == "minimal"
    ball = raw.get("ball") or {}
    if not isinstance(ball, dict):
        raise SceneError("ball: write it like {colour: amber, size: 6, glow: 9, tail: 6}.")
    sc.ball = {
        "colour": parse_colour(ball["colour"], "ball", theme) if "colour" in ball
                  else sc.theme["text"] if minimal else sc.theme["ball"],
        "size": parse_number(ball.get("size", 4 if minimal else 6), "ball", "size"),
        "glow": parse_number(ball.get("glow", 9), "ball", "glow"),
        "tail": int(parse_number(ball.get("tail", 6), "ball", "tail")),
    }
    sc.layout = raw.get("layout", "auto")
    if sc.layout not in LAYOUTS:
        raise SceneError(f"layout {sc.layout!r} isn't known. Use {', '.join(LAYOUTS)}.")
    sc.tracks = bool(raw.get("tracks", True))
    sc.grid = bool(raw.get("grid", not minimal))
    sc.hold = parse_time(raw.get("hold", 0.6), "hold")

    blocks = raw.get("blocks") or {}
    if not isinstance(blocks, dict) or not blocks:
        raise SceneError("blocks: add at least one block, like  blocks: {A: {}, B: {}}.")
    sc.blocks = {str(n): parse_block(str(n), v, sc.size, f"block {n}", theme) for n, v in blocks.items()}
    for b in sc.blocks.values():
        if b.beside and b.beside[1] not in sc.blocks:
            raise SceneError(f"block {b.name}: {b.beside[0]} {b.beside[1]!r}, but there's no such block.")
    sc.arrows = [parse_arrow(str(a), sc.blocks, theme) for a in raw.get("arrows") or []]
    for item in raw.get("steps") or []:
        items = item if isinstance(item, list) else [item]
        if any(isinstance(t, dict) for t in items):
            raise SceneError(f"step {item!r}: a ': ' inside a step makes YAML read it as a setting. "
                             "Drop the colon, or wrap the whole step in single quotes.")
        if not items:
            continue
        sc.steps.append([parse_action(str(t), sc.blocks, sc.size, theme) for t in items])
    place(sc)
    return sc


def load(path):
    try:
        raw = yaml.safe_load(Path(path).read_text())
    except yaml.YAMLError as e:
        raise SceneError(f"the file isn't valid YAML:\n{e}") from None
    return parse(raw or {})


# ---- placing blocks ----

def oval_slots(n, w, h, mx, my):
    cx, cy, rx, ry = w / 2, h / 2, w / 2 - mx, h / 2 - my
    if n == 1:
        return [(cx, cy)]
    if n == 2:
        return [(cx - rx, cy), (cx + rx, cy)]
    # start at the left so 3 blocks make a triangle pointing right, 4 a diamond
    return [(cx - rx * math.cos(2 * math.pi * i / n), cy - ry * math.sin(2 * math.pi * i / n)) for i in range(n)]


def spread(n, lo, hi):
    return [(lo + hi) / 2] if n == 1 else [lo + (hi - lo) * i / (n - 1) for i in range(n)]


def place(sc):
    """Gives every block a starting position: pinned, laid out, or next to another block."""
    blocks = sc.blocks
    w, h = sc.size
    # keep the bottom strip free when there are captions to show there
    if any(a.kind == "say" for step in sc.steps for a in step):
        h -= 56
    mx = max(b.w for b in blocks.values()) / 2 + 30
    my = max(b.h for b in blocks.values()) / 2 + 24
    pos = {n: b.at for n, b in blocks.items() if b.at}
    free = [n for n, b in blocks.items() if not b.at and not b.beside]
    pairs = [(a.src, a.dst) for step in sc.steps for a in step if a.kind == "ball"]
    pairs += [(ar.a, ar.b) for ar in sc.arrows]

    if free and sc.layout == "row":
        pos.update(zip(free, ((x, h / 2) for x in spread(len(free), mx, w - mx))))
    elif free and sc.layout == "column":
        pos.update(zip(free, ((w / 2, y) for y in spread(len(free), my, h - my))))
    elif free and sc.layout == "grid":
        cols = math.ceil(math.sqrt(len(free)))
        rows = math.ceil(len(free) / cols)
        xs, ys = spread(cols, mx, w - mx), spread(rows, my, h - my)
        pos.update({n: (xs[i % cols], ys[i // cols]) for i, n in enumerate(free)})
    elif free:
        slots = oval_slots(len(free) + len(pos), w, h, mx, my)
        for x, y in list(pos.values()):  # pinned blocks take the slot nearest to them
            slots.remove(min(slots, key=lambda s: (s[0] - x) ** 2 + (s[1] - y) ** 2))
        if sc.layout == "auto" and len(free) <= 7:
            # try every order and keep the one where the balls travel least
            def cost(assign):
                p = {**pos, **assign}
                return sum(math.dist(p[a], p[b]) for a, b in pairs if a in p and b in p)
            pos.update(min((dict(zip(free, perm)) for perm in permutations(slots, len(free))), key=cost))
        else:
            pos.update(zip(free, slots))

    pending = [n for n, b in blocks.items() if b.beside]
    while pending:
        done = [n for n in pending if blocks[n].beside[1] in pos]
        if not done:
            raise SceneError(f"blocks {', '.join(pending)} are each placed next to the other, so none has a position.")
        for n in done:
            side, other, gap = blocks[n].beside
            dx, dy = SIDES[side]
            ox, oy = pos[other]
            dist_x = gap + (blocks[n].w + blocks[other].w) / 2
            dist_y = gap + (blocks[n].h + blocks[other].h) / 2
            pos[n] = (ox + dx * dist_x, oy + dy * dist_y)
            pending.remove(n)
    for n, b in blocks.items():
        b.pos = pos[n]
