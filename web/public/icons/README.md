# Icons

The Relay app icon is the **"Signal Relay"** mark — a white node passing a signal
through, with waves opening both ways — on the brand indigo gradient
(`#818cf8 → #4f46e5`, straddling the `theme_color` `#6366f1`).

`icon.svg` is the **source of truth** (scalable vector, no font dependencies). The
PNGs are rasterized from it:

- `icon.svg` — scalable; referenced by the manifest (`purpose: any`) and as the
  SVG favicon in `web/index.html`.
- `icon-192.png` — exactly 192×192; favicon + `apple-touch-icon` fallback.
- `icon-512.png` — exactly 512×512; also the maskable icon, so the glyph is kept
  inside the centre ~80% "safe zone" and the gradient bleeds full-square.

## Regenerating the PNGs from `icon.svg`

The repo has no rasterizer dependency, so use `sharp` ad-hoc (rendered at 4× then
downscaled for crisp anti-aliasing):

```bash
npm install --no-save sharp
node -e '
  import("sharp").then(async ({default: sharp}) => {
    const fs = await import("node:fs");
    const svg = fs.readFileSync("web/public/icons/icon.svg");
    for (const size of [512, 192]) {
      await sharp(svg, { density: 288 })
        .resize(size, size, { fit: "fill" })
        .png({ compressionLevel: 9 })
        .toFile(`web/public/icons/icon-${size}.png`);
    }
  });
'
```

Edit `icon.svg` to change the artwork, then re-run the above.
