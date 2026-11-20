#!/usr/bin/env python3
"""
Renders the console's space backdrop: Earth's limb at orbital sunrise, a star field with a
realistic magnitude spread and colour temperatures, and a faint Milky Way band with dust lanes.

    python3 scripts/art/render_space.py apps/console/public/space.webp

Deterministic (fixed seed). Needs numpy and Pillow. Original artwork, no third-party imagery.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

W, H = 2880, 1620
rng = np.random.default_rng(27)
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)


def fbm(octaves, base, persistence=0.55, shape=(H, W), seed=0):
    """Fractal value noise: random grids upsampled smoothly and summed."""
    r = np.random.default_rng(seed)
    out = np.zeros(shape, np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        n = max(2, int(base * 2**o))
        grid = r.random((max(2, int(n * shape[0] / shape[1])), n)).astype(np.float32)
        img = Image.fromarray((grid * 255).astype(np.uint8)).resize((shape[1], shape[0]), Image.BICUBIC)
        out += amp * (np.asarray(img, np.float32) / 255.0)
        total += amp
        amp *= persistence
    return out / total


img = np.zeros((H, W, 3), np.float32)

# --- Deep space: barely-there blue at the horizon side, true black above.
img += (np.clip(yy / H, 0, 1) ** 3)[..., None] * np.array([0.004, 0.010, 0.026])

# --- Milky Way: a soft diagonal band (upper left → right) with dust lanes.
angle = np.deg2rad(-16)
cx, cy = W * 0.55, H * 0.30
u = (xx - cx) * np.cos(angle) + (yy - cy) * np.sin(angle)
v = -(xx - cx) * np.sin(angle) + (yy - cy) * np.cos(angle)
band = np.exp(-((v / (H * 0.11)) ** 2)) * np.exp(-((u / (W * 0.62)) ** 4))
cloud = fbm(7, 6, 0.58, seed=3)
dust = fbm(6, 10, 0.6, seed=8)
lanes = np.clip((dust - 0.48) * 4.5, 0, 1) * np.exp(-((v / (H * 0.035)) ** 2))
glow = band * np.clip(cloud * 1.6 - 0.35, 0, 1) * (1 - 0.85 * lanes)
core = np.exp(-(((u + W * 0.08) / (W * 0.16)) ** 2)) * band
img += glow[..., None] * np.array([0.10, 0.11, 0.135])
img += (core * glow)[..., None] * np.array([0.10, 0.08, 0.06])

# --- Stars: power-law magnitudes, colour temperatures, extra density inside the band.
def colour(t):
    pal = np.array([[0.62, 0.74, 1.0], [0.82, 0.88, 1.0], [1.0, 1.0, 1.0], [1.0, 0.93, 0.80], [1.0, 0.80, 0.60]])
    i = np.clip(t * (len(pal) - 1), 0, len(pal) - 1.001)
    lo = pal[i.astype(int)]
    hi = pal[i.astype(int) + 1]
    f = (i - i.astype(int))[:, None]
    return lo * (1 - f) + hi * f

def stars(n, density=None):
    if density is None:
        xs, ys = rng.random(n) * W, rng.random(n) * H
    else:
        p = (density / density.sum()).ravel()
        idx = rng.choice(p.size, size=n, p=p)
        ys, xs = np.divmod(idx, W)
        xs = xs + rng.random(n)
        ys = ys + rng.random(n)
    mag = rng.pareto(2.2, n) * 0.22 + 0.06
    return xs, ys, np.clip(mag, 0, 3), colour(rng.beta(2.2, 2.0, n))

layer = np.zeros_like(img)
for xs, ys, mag, col in (stars(11000), stars(5000, band * cloud + 1e-6)):
    ix, iy = xs.astype(int), ys.astype(int)
    ok = (ix > 1) & (iy > 1) & (ix < W - 2) & (iy < H - 2)
    for k in np.nonzero(ok)[0]:
        b = min(mag[k], 2.5)
        layer[iy[k], ix[k]] += col[k] * b
        if b > 0.5:  # brighter stars bleed into neighbours
            for dx, dy, w in ((1, 0, 0.35), (-1, 0, 0.35), (0, 1, 0.35), (0, -1, 0.35)):
                layer[iy[k] + dy, ix[k] + dx] += col[k] * b * w
# A soft halo only around the brightest stars.
halo = np.asarray(Image.fromarray(np.uint8(np.clip(layer * 90, 0, 255))).filter(ImageFilter.GaussianBlur(3.2)), np.float32) / 255
img += layer + halo * 0.35

# --- Earth: a sphere far below the frame; we see a thin lit crescent at sunrise.
R = W * 2.1
ecx, ecy = W * 0.5, H * 0.80 + R
dx, dy = xx - ecx, yy - ecy
dist = np.sqrt(dx * dx + dy * dy)
inside = dist < R
z = np.sqrt(np.clip(R * R - dist * dist, 0, None))
nx, ny, nz = dx / R, dy / R, z / R
sun = np.array([-0.55, -0.80, -0.24])
sun /= np.linalg.norm(sun)
lit = np.clip(nx * sun[0] + ny * sun[1] + nz * sun[2], 0, 1)
# Surface texture wrapped on the sphere (sampled by longitude/latitude), so it foreshortens
# towards the horizon like an orbital photograph.
TW, TH = 4096, 2048
land_tex = fbm(7, 4, 0.55, shape=(TH, TW), seed=11)
cloud_tex = fbm(8, 10, 0.62, shape=(TH, TW), seed=21)
streak = fbm(6, 3, 0.5, shape=(TH, TW), seed=22)
lon = np.arctan2(nx, nz)
lat = np.arcsin(np.clip(-ny, -1, 1))
tu = ((lon / np.pi * 0.5 + 0.5) * TW * 6 + TW * 0.25).astype(np.int64) % TW
tv = ((lat / np.pi + 0.5) * TH * 8).astype(np.int64) % TH
land = np.clip((land_tex[tv, tu] - 0.55) * 7, 0, 1)
clouds = np.clip((cloud_tex[tv, tu] * 0.75 + streak[tv, tu] * 0.45 - 0.62) * 3.2, 0, 1)
surface = (1 - land)[..., None] * np.array([0.012, 0.045, 0.11]) + land[..., None] * np.array([0.045, 0.055, 0.04])
surface = surface * (1 - clouds[..., None] * 0.8) + clouds[..., None] * np.array([0.55, 0.60, 0.68])
day = surface * (lit[..., None] ** 0.8) * 1.15
# Night side: faint city lights where land is dark.
cities = (fbm(4, 40, 0.7, seed=31) > 0.74) & (land > 0.5) & (lit < 0.02)
night = cities[..., None] * np.array([0.55, 0.36, 0.14]) * 0.6
earth = (day + night) * inside[..., None]
img = img * (~inside)[..., None] + earth

# --- Atmosphere: thin blue shell above the limb, brightest towards the sun; haze inside.
h = (dist - R) / (R * 0.0045)
toward_sun = np.clip(0.35 + 0.65 * np.clip(-(nx * sun[0] + ny * sun[1]) * -1.4, 0, 1), 0, 1)
shell = np.where(dist >= R, np.exp(-np.clip(h, 0, None) * 1.6), 0) * toward_sun
haze = np.where(inside, np.exp(-(R - dist) / (R * 0.004)), 0) * toward_sun
img += shell[..., None] * np.array([0.30, 0.58, 1.0]) * 1.25
img += haze[..., None] * np.array([0.18, 0.40, 0.85]) * 0.9
# Sunrise: a warm point on the limb with a bloom along it.
sx, sy = W * 0.22, None
limb_y = ecy - np.sqrt(np.clip(R * R - (xx - ecx) ** 2, 0, None))
along = np.exp(-(((xx - sx) / (W * 0.10)) ** 2))
near_limb = np.exp(-np.abs(yy - limb_y) / (H * 0.010))
img += (along * near_limb)[..., None] * np.array([1.0, 0.72, 0.40]) * 0.9
bloom = np.exp(-(((xx - sx) / (W * 0.20)) ** 2 + ((yy - limb_y) / (H * 0.10)) ** 2))
img += bloom[..., None] * np.array([0.30, 0.20, 0.12]) * 0.35

# Film-like finish: gentle tone curve and fine grain (avoids banding in gradients).
img = 1 - np.exp(-img * 1.35)
img += (rng.random((H, W, 1)) - 0.5) / 255 * 1.6
out = Image.fromarray(np.uint8(np.clip(img, 0, 1) * 255))
dest = sys.argv[1] if len(sys.argv) > 1 else 'space.webp'
out.save(dest, 'WEBP', quality=84, method=6)
out.resize((W // 2, H // 2), Image.LANCZOS).save(dest.replace('.webp', '-small.webp'), 'WEBP', quality=84, method=6)
print('wrote', dest)
