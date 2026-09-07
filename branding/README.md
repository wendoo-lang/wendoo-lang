# Wendoo Branding

Brand assets for Wendoo: the mark, the logotype, the color palettes, and the
typeface. Every app in this repository draws its Wendoo branding from here.

## Files

| Path | What it is |
| --- | --- |
| `wendoo-brand.html` | The brand page: mark, logotype, palettes, and type on one self-contained page. Open it in a browser. |
| `ecosim-og-image.svg` | Source for the Ecosystem Simulator social card, 1200 x 630: logotype, title, and description on ink. |
| `wendoo-banner.svg`, `wendoo-banner.png` | README banner, 1200 x 300: logotype and tagline on ink. Link it from a README header. |
| `logo/wendoo-mark.svg` | The mark, 24-unit master grid. Use at 24px and above. |
| `logo/wendoo-mark-small.svg` | The mark, 16-unit small cut. Use at 20px and below. |
| `logo/wendoo-logotype.svg` | The logotype, construction B (tile-native). The recommended wordmark. |
| `logo/wendoo-logotype-round.svg` | The logotype, construction A (round monoline). Kept for comparison, not for use. |
| `logo/wendoo-app-icon.svg` | The mark knocked out of a dark rounded square. |
| `logo/wendoo-app-icon-round.svg` | The mark knocked out of a dark circle. |

The mark and logotype files are drawn in `currentColor`, so the color comes
from the CSS `color` of the element that embeds them. Inline them as SVG when
the color must follow a theme; as an `<img>` they render black.

## The mark

Two tiles side by side, each with an eye. The left tile (WHEN) is a hollow ring
with a solid pupil; the right tile (DO) is solid with the pupil knocked out.
The knockout is evenodd geometry, so the mark is always one color per placement.

Master, 24-unit grid:

- Both tile silhouettes are 10 x 10 with a gap of 2, so the pair spans 22 of 24.
- Corner radius 2.8 outer, 0.8 inner. This pair of radii is the brand's corner
  language everywhere else.
- Stroke 2. The same stroke becomes the letter stroke of the logotype.
- Pupil radius 1.9, offset +0.55 from the tile center, at 0.46 of tile height,
  with 0.55 units of clearance to the ring.

Small cut, 16-unit grid, for 20px and below:

- Tiles 7.4, gap 1.2, stroke 1.8, pupil radius 1.1 offset +0.3.
- Pupil clearance is 0.5 of 16, which is half a pixel at 16px. Nothing below
  that survives rasterisation.

## The logotype

Construction B (tile-native) is the recommended wordmark: every counter in
w, e, n, d is the tile, and the two tiles at the end read as the oo. Shared
rules for both constructions:

- x-height equals tile height (10).
- Letter stroke equals ring stroke (2).
- Letter gap equals tile gap (2).
- Letter silhouettes are 10 wide, w is 14, so the tiles occupy exactly two
  letter slots.

The viewBox is 78 x 19. At a 28px header height the logotype is 115px wide.
On a dark surface set it in the paper color; on a light surface set it in ink.

## Color

The mark is always one color. Accents live in surfaces and UI. Ink and paper
are toned, never pure. Two palettes are defined; neither has been chosen yet.

Palette 1, Blueprint (cool ink, ultramarine, one LED amber):

| Role | Value |
| --- | --- |
| Ink | `oklch(0.20 0.015 260)` |
| Paper | `oklch(0.97 0.005 240)` |
| Ultramarine (surfaces: buttons, selection) | `oklch(0.50 0.20 265)` |
| Amber (status only: running, warning) | `oklch(0.82 0.16 80)` |

Palette 2, Kiln (warm ink, one magenta accent):

| Role | Value |
| --- | --- |
| Ink | `oklch(0.20 0.012 50)` |
| Paper | `oklch(0.965 0.008 70)` |
| Magenta (the only accent) | `oklch(0.58 0.22 350)` |
| Clay (dividers, disabled) | `oklch(0.86 0.02 70)` |

## Typography

The brand typeface is M PLUS Rounded 1c at weights 400, 500, and 700, loaded
from Google Fonts, with `system-ui, sans-serif` as the fallback stack.

It is for first-party, Wendoo-focused surfaces: the brand page, wendoo.com,
social cards, and banners. Apps that integrate Wendoo are not expected to
adopt it and should keep their own type.

## Guidelines for apps that integrate Wendoo

- The Wendoo mark identifies the language, not the app. An app that
  integrates Wendoo is not required to display the mark or the logotype.
- Apps are encouraged to link to <https://wendoo.com> somewhere convenient,
  such as an about screen, a footer, or a help menu, so people who meet the
  language through the app can find its home.
- Take the favicon from the app's own corpus rather than from the Wendoo
  branding. A favicon identifies the app.
- Keep the app's own typeface. M PLUS Rounded 1c is reserved for first-party
  Wendoo surfaces.

## Where the apps use it

- `apps/ecosim/src/components/WendooLogo.tsx` inlines the logotype and the
  mark as React components; the logotype is the canvas watermark. Keep its
  geometry in step with `logo/wendoo-logotype.svg` and `logo/wendoo-mark.svg`.
- `apps/ecosim/public/og-image.png` is `ecosim-og-image.svg` rasterised at
  1200 x 630.
- `apps/vscode-extension/assets/wendoo_256.png` is `logo/wendoo-app-icon.svg`
  rasterised at 256 x 256 for the Marketplace listing, and
  `assets/wendoo-mark.svg` is the mark with explicit fills for the extension's
  Explorer view icon. Its README and the repository's root README both open
  with `wendoo-banner.png`.

## Rasterising on macOS

Quick Look renders SVG to PNG without extra tools, but it always produces a
square thumbnail, so wide images need a square canvas and a crop:

```bash
qlmanage -t -s 256 -o out/ branding/logo/wendoo-app-icon.svg
```

For the social card, wrap the 1200 x 630 content in a 1200 x 1200 canvas
translated down by 285, render at 1200, then crop the centre band:

```bash
sips -c 630 1200 out/card.svg.png --out og-image.png
```
