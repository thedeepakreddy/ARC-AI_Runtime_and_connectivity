#!/usr/bin/env python3
"""Builds the website's night sky from real catalogues (run once; the outputs are committed).

    npm pack d3-celestial && tar xzf d3-celestial-*.tgz
    python3 apps/site/scripts/build-sky.py package/data

Inputs (d3-celestial, BSD-3-Clause, by Olaf Frohn):
  mw.json        the Milky Way Outline Catalog (Jose R. Vieira), five brightness steps
  stars.8.json   stars to magnitude 8 from XHIP, the extended Hipparcos compilation (ESA)
  stars.14.json  fainter stars, used only for the band's grain of unresolved starlight

Outputs, in apps/site/src/sky/ (imported by src/skyAssets.ts, so built with hashed names):
  milkyway_4096.jpg  the Milky Way, equirectangular in galactic coordinates (l across, b down)
  stars.bin          Int16 records [x, y, z, mag*1000, bv*1000], brightest first; x, y, z is the
                     star's direction in the scene's galactic frame (scaled by 32767):
                     x = cos b cos l, y = sin b, z = -cos b sin l
"""

import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

W, H = 4096, 2048
OUT = Path(__file__).resolve().parent.parent / "src" / "sky"

# ICRS (J2000 equatorial) to galactic.
EQ2GAL = np.array(
    [
        [-0.0548755604, -0.8734370902, -0.4838350155],
        [0.4941094279, -0.4448296300, 0.7469822445],
        [-0.8676661490, -0.1980763734, 0.4559837762],
    ]
)


def to_galactic(ra_deg, dec_deg):
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    v = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])
    g = EQ2GAL @ v
    l = np.degrees(np.arctan2(g[1], g[0])) % 360.0
    b = np.degrees(np.arcsin(np.clip(g[2], -1, 1)))
    return l, b


def rasterise(rings):
    """Even-odd fill of rings on the (l, b) cylinder, one column at a time. Rings that circle
    the whole sky (the band's two edges) cross every column once, so the band fills between them."""
    crossings = [[] for _ in range(W)]
    for ring in rings:
        a = np.array(ring, dtype=float)
        l, b = to_galactic(a[:, 0] % 360.0, a[:, 1])
        x = l / 360.0 * W
        y = (90.0 - b) / 180.0 * H
        for i in range(len(x) - 1):
            x1, y1, x2, y2 = x[i], y[i], x[i + 1], y[i + 1]
            dx = x2 - x1
            if dx > W / 2:
                dx -= W
            elif dx < -W / 2:
                dx += W
            if abs(dx) < 1e-9:
                continue
            lo, hi = (x1, x1 + dx) if dx > 0 else (x1 + dx, x1)
            c0 = math.ceil(lo - 0.5)
            c1 = math.floor(hi - 0.5)
            for c in range(c0, c1 + 1):
                xc = c + 0.5
                t = (xc - x1) / dx if dx > 0 else (x1 - xc) / -dx
                if not (0 <= t < 1):
                    continue
                crossings[c % W].append(y1 + (y2 - y1) * t)
    img = np.zeros((H, W), dtype=np.float32)
    for c in range(W):
        ys = sorted(crossings[c])
        for k in range(0, len(ys) - 1, 2):
            img[max(0, int(round(ys[k]))) : min(H, int(round(ys[k + 1]))), c] = 1.0
    return img


def _box(a, r, axis, wrap):
    if r < 1:
        return a
    pad = [(0, 0), (0, 0)]
    pad[axis] = (r + 1, r)
    p = np.pad(a, pad, mode="wrap" if wrap else "edge")
    c = np.cumsum(p, axis=axis, dtype=np.float64)
    n = a.shape[axis]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a, sigma):
    """Gaussian blur in float (three box passes); wraps around in longitude."""
    if sigma < 0.5:
        return a.astype(np.float32)
    r = max(1, int(round(math.sqrt(12 * sigma * sigma / 3 + 1) / 2)))
    out = a.astype(np.float32)
    for _ in range(3):
        out = _box(out, r, 1, True)
        out = _box(out, r, 0, False)
    return out


def noise(seed, sx, sy, octaves=5):
    """Fractal value noise; sx, sy stretch it (wider along the band than across)."""
    rng = np.random.default_rng(seed)
    out = np.zeros((H, W), dtype=np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        cw, ch = max(2, int(W / (sx / 2**o))), max(2, int(H / (sy / 2**o)))
        small = rng.random((ch, cw)).astype(np.float32)
        big = np.asarray(
            Image.fromarray((small * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC),
            dtype=np.float32,
        ) / 255.0
        out += big * amp
        total += amp
        amp *= 0.55
    return out / total


def main(data):
    data = Path(data)
    OUT.mkdir(parents=True, exist_ok=True)

    # 1. The band: the outline catalogue's five brightness steps, softened.
    mw = json.loads((data / "mw.json").read_text())
    levels = []
    for feat in sorted(mw["features"], key=lambda f: f["id"]):
        rings = [r for poly in feat["geometry"]["coordinates"] for r in poly]
        levels.append(rasterise(rings))
        print("level", feat["id"], "filled", float(levels[-1].mean()))
    band = sum(blur(lv, 10) * (0.55 + 0.45 * i) for i, lv in enumerate(levels))
    band += sum(blur(lv, 3) * 0.25 for lv in levels[2:])
    halo = blur(levels[0], 48) + blur(levels[1], 24) * 0.6  # the broad diffuse glow around the band

    # 2. Grain: real faint starlight, per unit of sky.
    stars = json.loads((data / "stars.14.json").read_text())["features"]
    ra = np.array([s["geometry"]["coordinates"][0] for s in stars]) % 360.0
    dec = np.array([s["geometry"]["coordinates"][1] for s in stars])
    mag = np.array([s["properties"]["mag"] for s in stars], dtype=float)
    l, b = to_galactic(ra, dec)
    xs = np.clip((l / 360.0 * W).astype(int), 0, W - 1)
    ys = np.clip(((90.0 - b) / 180.0 * H).astype(int), 0, H - 1)
    faint = mag >= 6.5  # brighter stars are drawn as points in the scene
    grain = np.zeros((H, W), dtype=np.float32)
    np.add.at(grain, (ys[faint], xs[faint]), 1.0)
    lat = np.radians(90.0 - (np.arange(H) + 0.5) / H * 180.0)
    grain /= np.maximum(0.2, np.cos(lat))[:, None]
    grain = blur(grain, 9)
    grain = np.clip(grain / max(1e-6, np.percentile(grain, 99.5)), 0, 1)

    # 3. Structure and dust lanes, strongest close to the galactic plane.
    lgrid = (np.arange(W) + 0.5) / W * 360.0
    bgrid = 90.0 - (np.arange(H) + 0.5) / H * 180.0
    L, B = np.meshgrid(lgrid, bgrid)
    dl = (L + 180.0) % 360.0 - 180.0  # galactic longitude, centred on the core
    clouds = noise(11, 520, 260)
    ridge = 1.0 - np.abs(noise(23, 340, 60) * 2.0 - 1.0)
    plane = np.exp(-((B / 3.2) ** 2))
    dust = np.clip((ridge - 0.55) * 3.0, 0, 1) * plane * (0.5 + 0.5 * np.exp(-((dl / 70.0) ** 2)))
    core = np.exp(-((dl / 28.0) ** 2)) * np.exp(-((B / 9.0) ** 2))

    lum = band / max(1e-6, np.percentile(band[band > 0], 99.0))
    # Faint-star counts only shape the band (they're nearly uniform elsewhere); between the arms the sky stays dark.
    lum = lum * (0.5 + 0.9 * clouds) * (0.7 + 0.6 * grain) + core * 0.45
    lum += halo / max(1e-6, halo.max()) * 0.35 * (0.6 + 0.8 * clouds)
    lum *= 1.0 - dust * 0.65
    # Unresolved starlight: a fine sparkle, as dense as the band is bright.
    rng = np.random.default_rng(5)
    sparkle = (rng.random((H, W)) < 0.035).astype(np.float32) * rng.random((H, W)).astype(np.float32) ** 3
    sparkle = blur(sparkle, 0.6) + sparkle * 0.6
    lum = lum * (0.85 + 1.6 * sparkle / max(1e-6, sparkle.max()))
    lum = 1.0 - np.exp(-2.4 * np.clip(lum, 0, None))  # soft roll-off: the core glows, the arms still show
    cool = np.array([0.78, 0.85, 1.0], dtype=np.float32)
    warm = np.array([1.0, 0.86, 0.66], dtype=np.float32)
    w = np.clip(core * 1.2 + np.exp(-((dl / 60.0) ** 2)) * 0.2, 0, 0.85)[..., None]
    col = cool * (1 - w) + warm * w
    col = col * (1.0 - (dust * 0.25)[..., None] * np.array([0.0, 0.25, 0.45]))
    rgb = np.clip(col * lum[..., None] * 255.0, 0, 255).astype(np.uint8)
    Image.fromarray(rgb).save(OUT / "milkyway_4096.jpg", quality=88, optimize=True, progressive=True)

    # 4. The catalogue's stars, brightest first.
    bright = json.loads((data / "stars.8.json").read_text())["features"]
    rows = []
    for s in bright:
        m = float(s["properties"]["mag"])
        if m > 7.5:
            continue
        try:
            bv = float(s["properties"].get("bv") or 0.6)
        except ValueError:
            bv = 0.6
        lg, bg = to_galactic(np.array([s["geometry"]["coordinates"][0] % 360.0]), np.array([s["geometry"]["coordinates"][1]]))
        lr, br = math.radians(lg[0]), math.radians(bg[0])
        x, y, z = math.cos(br) * math.cos(lr), math.sin(br), -math.cos(br) * math.sin(lr)
        rows.append((m, x, y, z, max(-0.5, min(2.5, bv))))
    rows.sort()
    with open(OUT / "stars.bin", "wb") as f:
        for m, x, y, z, bv in rows:
            f.write(struct.pack("<5h", round(x * 32767), round(y * 32767), round(z * 32767), round(m * 1000), round(bv * 1000)))
    print("stars", len(rows))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "package/data")
