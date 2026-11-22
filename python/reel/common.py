"""Shapes, lines between blocks, timing and text sizes, shared by the SVG and GIF writers."""
import bisect
import math
from pathlib import Path

from PIL import ImageFont

from .scene import EASES

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]
_fonts = {}


def font(size):
    if size not in _fonts:
        path = next((p for p in FONT_PATHS if Path(p).exists()), None)
        _fonts[size] = ImageFont.truetype(path, size) if path else ImageFont.load_default()
    return _fonts[size]


def text_width(text, size):
    return max(font(size).getlength(line) for line in text.split("\n"))


def label_size(block, biggest=17):
    """The biggest font size, from `biggest` down to 12, that keeps the label inside the block."""
    room = block.w * (0.72 if block.shape == "circle" else 0.86)
    for size in range(biggest, 11, -1):
        if text_width(block.label, size) <= room:
            return size
    return 12


def mix(c, bg, a):
    """Colour c faded toward bg: a=1 is full colour, a=0 is bg."""
    return tuple(round(b + (x - b) * a) for x, b in zip(c, bg))


# ---- lines between blocks ----

def inside(block, centre, x, y):
    cx, cy = centre
    hw, hh = block.w / 2, block.h / 2
    if block.shape == "circle":
        return ((x - cx) / hw) ** 2 + ((y - cy) / hh) ** 2 <= 1
    return abs(x - cx) <= hw and abs(y - cy) <= hh


def crossing(f, block, centre):
    """The spot along f, between 0 and 0.5, where it leaves the block."""
    lo, hi = 0.0, 0.5
    for _ in range(24):
        mid = (lo + hi) / 2
        if inside(block, centre, *f(mid)):
            lo = mid
        else:
            hi = mid
    return hi


def quad_at(p, c, q, t):
    u = 1 - t
    return u * u * p[0] + 2 * u * t * c[0] + t * t * q[0], u * u * p[1] + 2 * u * t * c[1] + t * t * q[1]


def link_curve(b1, p, b2, q, curve):
    """The curve from block b1's outline to block b2's outline, as (start, bend point, end).

    None when the blocks overlap and there is nothing to draw."""
    c = ((p[0] + q[0]) / 2 - (q[1] - p[1]) * curve, (p[1] + q[1]) / 2 + (q[0] - p[0]) * curve)
    f = lambda t: quad_at(p, c, q, t)  # noqa: E731
    if inside(b1, p, *f(0.5)) or inside(b2, q, *f(0.5)):
        return None
    t0 = crossing(f, b1, p)
    t1 = 1 - crossing(lambda t: f(1 - t), b2, q)
    # the bend point of just the visible piece of the curve
    k = ((1 - t0) * (1 - t1) * p[0] + (t0 * (1 - t1) + t1 * (1 - t0)) * c[0] + t0 * t1 * q[0],
         (1 - t0) * (1 - t1) * p[1] + (t0 * (1 - t1) + t1 * (1 - t0)) * c[1] + t0 * t1 * q[1])
    return f(t0), k, f(t1)


class Line:
    """A line made of many short pieces, measured so we can find the point at any share of its length."""

    def __init__(self, pts):
        self.pts = pts
        self.cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            self.cum.append(self.cum[-1] + math.dist(a, b))
        self.length = self.cum[-1]

    def point(self, dist):
        if self.length == 0:
            return self.pts[0]
        dist = max(0.0, min(self.length, dist))
        i = min(bisect.bisect_right(self.cum, dist) - 1, len(self.pts) - 2)
        seg = self.cum[i + 1] - self.cum[i]
        k = (dist - self.cum[i]) / seg if seg else 0
        (ax, ay), (bx, by) = self.pts[i], self.pts[i + 1]
        return ax + (bx - ax) * k, ay + (by - ay) * k

    def at(self, share):
        return self.point(share * self.length)

    def cut(self, start, end):
        inner = [p for p, c in zip(self.pts, self.cum) if start < c < end]
        return [self.point(start), *inner, self.point(end)]


def curve_line(curve):
    if curve is None:
        return Line([(0, 0)])
    p, k, q = curve
    return Line([quad_at(p, k, q, i / 48) for i in range(49)])


def link_path(b1, p, b2, q, curve):
    return curve_line(link_curve(b1, p, b2, q, curve))


def arrow_curve(scene, a, b):
    """How much the line from a to b bends: the arrow's bend if one joins them, else straight."""
    for ar in scene.arrows:
        if (ar.a, ar.b) == (a, b):
            return ar.curve
        if (ar.a, ar.b) == (b, a):
            return -ar.curve  # same curve, walked the other way
    return 0.0


# ---- time ----

class Timeline:
    """When every action starts, and the state of the blocks at any moment."""

    def __init__(self, scene):
        self.scene = scene
        self.events = []
        t = 0.0
        for step in scene.steps:
            for a in step:
                self.events.append((t, a))
            t += max(a.time for a in step)
        self.total = t

    def blocks_at(self, t):
        pos = {n: b.pos for n, b in self.scene.blocks.items()}
        seen = {n: 0.0 if b.hidden else 1.0 for n, b in self.scene.blocks.items()}
        for start, a in self.events:
            if start > t:
                break
            if a.kind not in ("show", "hide", "move"):
                continue
            p = EASES[a.ease](min(1.0, (t - start) / a.time) if a.time > 0 else 1.0)
            if a.kind == "move":
                (x, y), (tx, ty) = pos[a.src], a.to
                pos[a.src] = (x + (tx - x) * p, y + (ty - y) * p)
            else:
                target = 1.0 if a.kind == "show" else 0.0
                seen[a.src] += (target - seen[a.src]) * p
        return pos, seen
