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
- `badge.svg` — the same glyph WITHOUT the gradient background: white strokes on a
  fully transparent canvas. Source for the notification badge.
- `badge-96.png` — exactly 96×96 (MDN's recommended badge size), rasterized from
  `badge.svg`. Used as `badge:` in the service worker's `showNotification` calls
  and as the manifest's `purpose: "monochrome"` icon. Android renders the badge
  as a monochrome status-bar icon using only the alpha channel — an opaque
  full-color square (like `icon-192.png`) shows up as a black box, so the badge
  must stay white-on-transparent.

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

## Regenerating `badge-96.png` from `badge.svg`

Same ad-hoc `sharp` approach (keep the transparent background — no `flatten`):

```bash
npm install --no-save sharp
node -e '
  import("sharp").then(async ({default: sharp}) => {
    const fs = await import("node:fs");
    const svg = fs.readFileSync("web/public/icons/badge.svg");
    await sharp(svg, { density: 288 })
      .resize(96, 96, { fit: "fill" })
      .png({ compressionLevel: 9 })
      .toFile("web/public/icons/badge-96.png");
  });
'
```

If the glyph in `icon.svg` changes, mirror the change in `badge.svg` (it is the
same geometry minus the background `<rect>` and gradient `<defs>`).
