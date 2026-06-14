# Icons

`scaffold.sh` generates **placeholder** `icon-192.png` and `icon-512.png` here, tinted to
your theme color (via `scripts/gen-icons.mjs`). They are real, valid, installable PNGs —
the app is installable from minute one — but they're plain placeholders.

**Replace them** with your real artwork when you have it. Requirements:

- `icon-192.png` — exactly 192×192
- `icon-512.png` — exactly 512×512 (also used as the maskable icon, so keep important
  content inside the centre ~80% "safe zone")
- PNG, square, ideally with a solid (non-transparent) background for the maskable variant

Regenerate placeholders in a different color anytime:

```bash
node scripts/gen-icons.mjs 192 "#2563eb" public/icons/icon-192.png
node scripts/gen-icons.mjs 512 "#2563eb" public/icons/icon-512.png
```
