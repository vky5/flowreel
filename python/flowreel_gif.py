#!/usr/bin/env python3
"""flowreel_gif: draw a flowreel scene as a GIF, for chat apps and email that won't show an SVG.

    python3 flowreel_gif.py scene.yaml              # writes scene.gif
    python3 flowreel_gif.py scene.yaml -o out.gif

The main flowreel tool (npm) writes SVG. This is a separate Python copy of the scene reader, kept
for GIFs only, so a brand-new scene setting may reach it later than the npm package.
Needs Pillow and PyYAML (apt install python3-pil python3-yaml).
"""
import argparse
import sys
from pathlib import Path

# lets it run from anywhere, including through a symlink on PATH
sys.path.insert(0, str(Path(__file__).resolve().parent))

from reel.gif import render_gif  # noqa: E402
from reel.scene import SceneError, load  # noqa: E402


def main():
    ap = argparse.ArgumentParser(prog="flowreel_gif", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scene")
    ap.add_argument("-o", "--out")
    args = ap.parse_args()
    out = Path(args.out or Path(args.scene).with_suffix(".gif"))
    try:
        gif, frames = render_gif(load(args.scene))
    except SceneError as e:
        sys.exit(f"flowreel_gif: {e}")
    except FileNotFoundError:
        sys.exit(f"flowreel_gif: {args.scene} doesn't exist.")
    out.write_bytes(gif)
    print(f"flowreel_gif: wrote {out} ({frames} frames, {len(gif) // 1024} KB)")


if __name__ == "__main__":
    main()
