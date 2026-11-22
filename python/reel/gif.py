"""Draws a scene frame by frame into a GIF, for places that won't show an SVG (chat apps, email)."""
import io
import math

from PIL import Image, ImageDraw, ImageFilter

from .common import Timeline, arrow_curve, font, label_size, link_path, mix
from .scene import EASES

HIT_TIME = 0.35  # how long a block glows after a ball lands, in seconds


def draw_head(d, tip, back, colour, length, half):
    dx, dy = tip[0] - back[0], tip[1] - back[1]
    n = math.hypot(dx, dy) or 1
    ux, uy = dx / n, dy / n
    bx, by = tip[0] - ux * length, tip[1] - uy * length
    d.polygon([tip, (bx - uy * half, by + ux * half), (bx + uy * half, by - ux * half)], fill=colour)


def draw_arrow(d, path, arrow, colour, bg, text_colour):
    if path.length < 2:
        return
    width = arrow.width or 2
    head = 7 + width * 2
    width = round(width)
    start = head * 0.8 if arrow.heads == "both" else 0
    end = path.length - (head * 0.8 if arrow.heads != "none" else 0)
    if end > start:
        if arrow.dashed or arrow.flow:
            s = start
            while s < end:
                d.line(path.cut(s, min(s + 8, end)), fill=colour, width=width)
                s += 14
        else:
            d.line(path.cut(start, end), fill=colour, width=width, joint="curve")
    if arrow.heads != "none":
        draw_head(d, path.point(path.length), path.point(path.length - head), colour, head, head * 0.55)
    if arrow.heads == "both":
        draw_head(d, path.point(0), path.point(head), colour, head, head * 0.55)
    if arrow.label:
        x, y = path.at(0.5)
        l, t, r, b = d.textbbox((x, y), arrow.label, font=font(13), anchor="mm")
        d.rounded_rectangle([l - 6, t - 4, r + 6, b + 4], radius=6, fill=bg)
        d.text((x, y), arrow.label, font=font(13), fill=text_colour, anchor="mm")


def draw_text_centred(d, xy, text, fnt, fill):
    l, t, r, b = d.multiline_textbbox((0, 0), text, font=fnt, align="center", spacing=4)
    d.multiline_text((xy[0] - (l + r) / 2, xy[1] - (t + b) / 2), text, font=fnt, fill=fill, align="center", spacing=4)


def block_outline(d, block, centre, pad, **kw):
    x, y = centre
    box = [x - block.w / 2 - pad, y - block.h / 2 - pad, x + block.w / 2 + pad, y + block.h / 2 + pad]
    if block.shape == "circle":
        d.ellipse(box, **kw)
    elif block.shape == "rect":
        d.rectangle(box, **kw)
    else:
        radius = (block.h / 2 + pad) if block.shape == "pill" else 10 + pad
        d.rounded_rectangle(box, radius=radius, **kw)


def soft(layer, radius):
    """Blurs a see-through layer without dark fringes around the colours."""
    return layer.convert("RGBa").filter(ImageFilter.GaussianBlur(radius)).convert("RGBA")


def draw_frame(scene, tl, t):
    th, bg = scene.theme, scene.theme["bg"]
    blocks, ball = scene.blocks, scene.ball
    pos, seen = tl.blocks_at(t)
    img = Image.new("RGB", scene.size, bg)
    d = ImageDraw.Draw(img)
    cache = {}

    def path(a, b, curve):
        key = (a, b, curve)
        if key not in cache:
            cache[key] = link_path(blocks[a], pos[a], blocks[b], pos[b], curve)
        return cache[key]

    if scene.tracks:
        linked = {frozenset((ar.a, ar.b)) for ar in scene.arrows}
        done = set()
        for _, a in tl.events:
            pair = frozenset((a.src, a.dst))
            if a.kind == "ball" and a.src != a.dst and pair not in linked and pair not in done:
                done.add(pair)
                vis = min(seen[a.src], seen[a.dst])
                if vis > 0 and path(a.src, a.dst, 0.0).length > 1:
                    d.line(path(a.src, a.dst, 0.0).pts, fill=mix(th["track"], bg, vis), width=2)

    for ar in scene.arrows:
        vis = min(seen[ar.a], seen[ar.b])
        if vis > 0:
            draw_arrow(d, path(ar.a, ar.b, ar.curve), ar, mix(ar.colour or th["arrow"], bg, vis), bg,
                       mix(th["text"], bg, vis * 0.8))

    glow = Image.new("RGBA", scene.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cores, hits = [], {}
    for start, a in tl.events:
        if a.kind != "ball":
            continue
        end = start + a.time
        colour = a.colour or ball["colour"]
        size = a.size or ball["size"]
        if start <= t < end:
            bp = path(a.src, a.dst, arrow_curve(scene, a.src, a.dst))
            tail = -1 if scene.style == "minimal" else ball["tail"]  # minimal: no glow and no tail
            for k in range(tail, -1, -1):
                tk = t - k / scene.fps
                if tk < start:
                    continue
                x, y = bp.at(EASES[a.ease]((tk - start) / a.time))
                fade = 1 - k / (tail + 1)
                r = size * 2.2 * fade
                gd.ellipse([x - r, y - r, x + r, y + r], fill=colour + (round(255 * fade),))
            cores.append((bp.at(EASES[a.ease]((t - start) / a.time)), colour, size))
        elif end <= t < end + HIT_TIME:
            k = 1 - (t - end) / HIT_TIME
            if k > hits.get(a.dst, (0, None))[0]:
                hits[a.dst] = (k, colour)
    for name, (k, colour) in hits.items():
        if scene.style == "minimal":
            break
        block_outline(gd, blocks[name], pos[name], 4, outline=colour + (round(255 * k * seen[name]),), width=6)
    box = glow.getbbox()
    if box:
        # only blur the part of the picture that has something glowing in it
        pad = round(ball["glow"] * 3)
        box = (max(0, box[0] - pad), max(0, box[1] - pad),
               min(scene.size[0], box[2] + pad), min(scene.size[1], box[3] + pad))
        part = soft(glow.crop(box), ball["glow"])
        base = img.crop(box).convert("RGBA")
        base.alpha_composite(part)
        base.alpha_composite(part)  # twice, so the glow reads on light backgrounds too
        img.paste(base.convert("RGB"), box[:2])

    for name, b in blocks.items():
        vis = seen[name]
        if vis <= 0:
            continue
        edge = b.edge or th["edge"]
        if name in hits:
            k, colour = hits[name]
            edge = mix(colour, edge, k)
        block_outline(d, b, pos[name], 0, fill=mix(b.fill or th["fill"], bg, vis), outline=mix(edge, bg, vis), width=2)
        draw_text_centred(d, pos[name], b.label, font(label_size(b)), mix(b.text or th["text"], bg, vis))

    for (x, y), colour, size in cores:
        d.ellipse([x - size, y - size, x + size, y + size], fill=colour)
        if scene.style == "minimal":
            continue
        r = size / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=mix((255, 252, 240), colour, 0.85))

    for start, a in tl.events:
        if a.kind == "say" and start <= t < start + a.time:
            vis = max(0.0, min(1.0, (t - start) / 0.15, (start + a.time - t) / 0.15))
            x, y = scene.size[0] / 2, scene.size[1] - 30
            l, top, r, bot = d.textbbox((x, y), a.text, font=font(17), anchor="mm")
            d.rounded_rectangle([l - 14, top - 8, r + 14, bot + 8], radius=(bot - top) / 2 + 8,
                                fill=mix(th["fill"], bg, vis), outline=mix(th["edge"], bg, vis), width=1)
            d.text((x, y), a.text, font=font(17), fill=mix(th["text"], bg, vis), anchor="mm")
    return img


def render_frames(scene):
    tl = Timeline(scene)
    last = tl.total + (HIT_TIME if any(a.kind == "ball" for _, a in tl.events) else 0)
    count = math.floor(last * scene.fps + 1e-6) + 1
    frames = [draw_frame(scene, tl, i / scene.fps) for i in range(count)]
    frames += [frames[-1]] * round(scene.hold * scene.fps)  # hold the last picture before looping
    return frames


def gif_bytes(frames, fps):
    # one shared palette taken from frames across the whole run, so colours don't flicker
    picks = [frames[len(frames) * i // 8] for i in range(min(8, len(frames)))]
    w, h = frames[0].size
    sample = Image.new("RGB", (w, h * len(picks)))
    for i, f in enumerate(picks):
        sample.paste(f, (0, h * i))
    palette = sample.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    out = [f.quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG) for f in frames]
    buf = io.BytesIO()
    out[0].save(buf, format="GIF", save_all=True, append_images=out[1:], duration=round(1000 / fps),
                loop=0, optimize=False, disposal=1)
    return buf.getvalue()


def render_gif(scene):
    """The finished GIF as bytes, and how many frames it has."""
    frames = render_frames(scene)
    return gif_bytes(frames, scene.fps), len(frames)
