# Inno Setup wizard bitmaps

14 pre-rendered BMPs (`inno-big-<scale>.bmp` / `inno-small-<scale>.bmp`, scales
100/125/150/175/200/225/250%) — the Windows installer wizard's page-side image
and small corner icon, as referenced by `upstream/build/win32/code.iss`'s
`WizardImageFile`/`WizardSmallImageFile`. These are a separate asset from
`lakshx.ico` (which only covers the installer `.exe`'s own file icon) — without
them, Inno Setup silently falls back to Microsoft's stock VS Code wizard
artwork, which is exactly the bug this fixes.

Installed by `scripts/install-icons.mjs` into `upstream/resources/win32/`.

Pre-rendered rather than generated per-build so CI doesn't need a
Python/Pillow toolchain on the Windows runner just to composite bitmaps.
Regenerate if the logo changes:

```python
from PIL import Image

SRC = "assets/lakshx-512.png"
SCALES = [100, 125, 150, 175, 200, 225, 250]
BIG_BASE, SMALL_BASE = (164, 314), (55, 55)  # width, height, at 100%

src = Image.open(SRC).convert("RGBA")

def composite(w, h, icon_frac):
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    size = int(min(w, h) * icon_frac)
    icon = src.resize((size, size), Image.LANCZOS)
    canvas.paste(icon, ((w - size) // 2, (h - size) // 2), icon)
    return canvas

for scale in SCALES:
    f = scale / 100
    composite(int(BIG_BASE[0] * f), int(BIG_BASE[1] * f), 0.55).save(f"assets/win32/inno-big-{scale}.bmp", "BMP")
    composite(int(SMALL_BASE[0] * f), int(SMALL_BASE[1] * f), 0.85).save(f"assets/win32/inno-small-{scale}.bmp", "BMP")
```

Must stay 24-bit, `Windows 3.x`-format BMP (`file` should report exactly
that) — Pillow's default RGB-image BMP writer produces this; a canvas with
alpha (RGBA) writes a 32-bit BMP instead, which is a different sub-format
than Inno Setup's originals and hasn't been verified to render correctly.
