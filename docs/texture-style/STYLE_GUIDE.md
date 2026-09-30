# starfi.fun texture style guide (measured)

Everything here was measured from the SVG sources in `public/textures/` with a parser script (not from memory or
the old style document). Numbers are from the files as they exist on 2026-09-30. "On-grid" means a coordinate is a
multiple of 8 (±0.05 px, so Figma noise like `8.00002` counts as on-grid).

---

## 1. Inventory

142 files in total: 141 SVG, 1 PNG. The only PNG is `rocks/_old/rock5.png` (old, unused).

| Category | Folder(s) | Count | Canvas sizes (px) | In use? |
|---|---|---|---|---|
| Rocks (normal) | `rocks/<N>/` | 19 | 48, 64, 80, 96, 112, 120, 128 (4), 144 (4), 176, 208, 224, 240, 256; all square | yes (folder scan) |
| Rocks (old) | `rocks/_old/` | 7 (6 SVG + 1 PNG) | 128, 144, 208, 224, 240, 256 | **no** (the `_old` folder name isn't numeric, so it's skipped) |
| Gold rocks | `goldrocks/<N>/` | 5 | 208, 224, 240, 256 (2) | yes (folder scan) |
| XP ore rocks | `xporerocks/<N>/` | 16 | 64 (8), 80 (8) | yes (folder scan) |
| Ships | `ships/*/` | 4 | 128×128 (2), 128×144 (2) | `shipbasic1.svg`, `prototwink.svg`, `snipership.svg` yes; `basicship.svg` **no** |
| Bullets | `ships/*/*bullet*.svg` | 6 | 8×32, 24×32 (3), 24×56, 32×40 | `basicbullet`, `sniperbullet`, `prototwinkshortbullet`, `prototwinklongbullet` yes; `basicship_bullet`, `shipbasic1bullet` **no** |
| Ship cards (HUD) | `interface/shipcards/` | 3 | 240×208, 256×208 (2) | yes |
| Class-menu art | `interface/classes/` | 5 | 256×224 (4), 1920×1080 (layout mockup) | `*_art.svg` yes; `twinkicon.svg`, `snipericon.svg`, `demoscreenupgrade.svg` **no** (mockup/reference) |
| Upgrade icons | `interface/upgrades/` | 13 | 80×112 (10), 6×16 (2), 20×18 (1) | yes |
| Main-menu icons | `interface/mainmenu/` | 4 | 64×64 (3), 1920×1080 | **no** (the menu buttons are inline SVG in `index.html`) |
| Gold pickups | `particles/gold/{1,3,5}gold/` | 9 | 16×16 (1 and 3 gold), 24×24 (5 gold) | yes (folder scan) |
| XP pickups | `particles/xp/{1,3,5}xp/` | 12 | 16×16 (1 XP), 16×24 (3 XP), 16×32 (5 XP) | yes (folder scan) |
| Gold-rock break particles | `particles/goldrock/{big,small}/` | 5 | 16×16 (2), 32×16, 32×32, 32×48 | yes (hard-coded list `GOLD_PARTICLE_FILES` in `src/main.js`) |
| Ember particles | `particles/amber/` | 9 | 8×24, 8×32, 8×40, 16×16 (2), 16×32, 16×40, 32×32, **33×16** | yes (folder scan) |
| Frost particles / crystals | `particles/cold/` | 12 | 16×16 (2), 16×24, 16×32, 24×24 (4), 32×32 (3), **33×32** | yes (folder scan) |
| Wasteland dust | `particles/wasteland/` | 8 | 8×16, 8×24, 8×32, 16×16, 24×24 (2), 24×32, 32×32 | yes (hard-coded list in `WASTELAND_DUST_CONFIG`) |
| Cursor | `particles/cursor.svg` | 1 | 32×32 | yes (CSS in `index.html`) |
| Minimap frame | `minimapframe.svg` | 1 | 144×144 | yes |
| Biome map (design) | `design/biomemap.svg` | 1 | 32×32 | referenced from `shared/biomes.js` (data, not drawn) |
| Misc root | `starship-1.svg`, `interfacedemo.svg` | 2 | 128×128, 1920×1080 | **no** |

Canvas sizes are multiples of 8 everywhere except `amber7.svg` (33×16), `cold12.svg` (33×32) and two upgrade
pip files (6×16, 20×18).

---

## 2. Measured style, per category

### 2.1 Summary table

| Category | Coords on 8 px grid | on 4 px | Path commands | Colors | Paths/file |
|---|---|---|---|---|---|
| Rocks | 96.8 % of 3166 | 97.9 % | M, L, H, V, Z only | white, black (+ one `#FBFBFB`) | 2 (18 files), 6 (1) |
| XP ore rocks | 99.5 % of 1780 | 99.6 % | M, L, H, V, Z | white, black + one accent (`#8BA400` / `#658910` / `#46830B` / `#006215`) at 0.5 opacity | 4–5 |
| Gold rocks | 97.9 % of 2476 | 98.2 % | M, L, H, V, Z | white, black, `#D69919`, `#936503` (0.7 opacity) | 16–21 |
| Ships | 86.5 % of 430 | **98.8 %** | M, L, H, V, Z | white, black | 2 (3 files), 5 (1) |
| Bullets | 100 % of 44 | 100 % | M, L, H, V, Z | white | 1 |
| Frost particles | 95.7 % of 164 | 95.7 % | M, L, H, V, Z | white | 1 (9), 2 (2), 4 (1) |
| Ember particles | 94.1 % of 68 | 94.1 % | M, L, H, V, Z | white | 1 |
| Wasteland dust | 100 % of 86 | 100 % | M, H, V, Z (+ 3 `<rect>`) | white | 0–1 |
| Gold pickups | 100 % of 388 | 100 % | M, L, H, V, Z | `#D69919` / `#936503` / `#BA7F00` + black/white at 0.5 | 3–6 |
| XP pickups | 98.6 % of 288 | 98.6 % | M, L, H, V, Z | one green + black/white at 0.5 | 3 |
| Gold-rock particles | 100 % of 50 | 100 % | M, L, H, V, Z | `#D69919` or `#936503` at 0.7 | 1 |
| Ship cards | 1.5 % | 4.7 % | M, L, H, V, Z | white, black; frame = black at 0.5 + white 8 px stroke | 3–7 |
| Upgrade icons | 7.6 % | 12.4 % | M, L, H, V, Z | white, black, `#D9D9D9`; white strokes | 0–7 |
| Main-menu icons (unused) | 8.6 % | 10.8 % | **C curves** (24), `<circle>`, `<image>` | white, black, `#FCAFFF`, pattern fills | 1–8 |
| Cursor | 0 % | 0 % | M, L, H, V, Z | white | 4 (on a 2 px offset, 4 px arms) |

- **No lowercase (relative) commands** in any file. Every path uses absolute uppercase M/L/H/V/Z.
- **No curves** in any in-game texture. The only C commands are in the unused `interface/mainmenu/Frame 91.svg`
  (24) and `interfacedemo.svg` (4).
- **No `fill-rule="evenodd"` in any file (0 of 141).** **No strokes** on rocks, ships, bullets, particles or pickups.
- Off-grid values are almost all Figma export noise: `.5` half-pixels (`8.5`, `24.5`, `100.5`, `72.5`), long
  decimals (`24.0001`, `16.0736`, `55.9419`) or the 33 px-wide particle canvases (`16.5`, `32.5`).

### 2.2 Rocks (normal, XP ore, gold) — the core style

**Construction (every rock, all sizes):**
1. Path 1: the full outer silhouette, `fill="white"`.
2. Path 2: one black shape drawn on top of it, `fill="black"`. It follows the silhouette **inset by 8 px** and has
   notches and slits cut into it.
3. The result reads as: a **white outline ring 8 px thick** around a **black body**, with **white interior
   details** where the black shape is notched, slit or has holes. The details are white gaps in the black body,
   not black marks on white.

Measured outline ring (median distance from the white silhouette to the black body, per file):

| Size | 48 | 64 | 80 | 96 | 112 | 120 | 128 | 144 | 176 | 208 | 224 | 240 | 256 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Ring (px) | 8.0 | 8.0 | 8.0 | 8.0 | 8.0 | 8.0 | 8.0 | 7.2–8.0 | 7.8 | 8.0 | 7.2 | 8.0 | 7.8 |

The ring is 8 px at every size (7.2 on some diagonal edges, where an 8 px grid step measures shorter).

**Silhouette jaggedness** (vertices in the white outline path):

| Size | 48 | 64 | 80 | 96 | 112 | 120 | 128 | 144 | 176 | 208 | 224 | 240 | 256 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Outline vertices | 10 | 13 | 13 | 12 | 16 | 14 | 21–24 | 18–21 | 25 | 23 | 22 | 24 | 31 |

Roughly `8 + size / 10`. Edges are horizontal, vertical or diagonal at 8 px steps (mostly 45°, some 2:1 slopes
such as 8 across / 16 down).

**Interior detail** (black-shape vertices more than ~12 px inside the silhouette, i.e. notches, slits and holes):

| Size | 48 | 64 | 80 | 96 | 112 | 128 | 144 | 176 | 208–224 | 240 | 256 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Detail vertices | 5 | 10 | 7 | 14 | 25 | 28–47 | 28–56 | 51 | 39–46 | 96 | 146 |

Detail shapes are straight-edged: slits 8 px wide, diagonal cracks, small squares, triangles and stair-stepped
notches running in from the ring. Typically 1–2 features at 48–64 px, 3–6 at 112–144 px, 8+ at 240–256 px.

**Colors:** only `white` and `black` for normal rocks. `rock224.svg` uses `#FBFBFB` for the silhouette (near
white, a one-off). One file (`rock256.svg`) splits the black body into 5 black paths; all others use exactly one.

**XP ore rocks** add 2–3 accent paths in one green (`#8BA400`, `#658910`, `#46830B` or `#006215`) at
`fill-opacity="0.5"`, drawn on top of the black body. **Gold rocks** add many small facets in `#D69919` and
`#936503` at `fill-opacity="0.7"`.

**Unusual:** 16 of 19 rocks, all XP rocks and 4 of 5 gold rocks are wrapped in a Figma
`<g clip-path="url(#clip…)">` with `<defs><clipPath><rect …/></clipPath></defs>`. The clip is the full canvas, so
it changes nothing visually; the game's parser ignores it.

### 2.3 Ships

- Two paths: a **white hull silhouette** and **one black core shape** inside it (cockpit or body plate). `basicship.svg`
  (unused) has 4 black shapes.
- Built on a **4 px grid**: only 86.5 % of coordinates are multiples of 8, but 98.8 % are multiples of 4 (values
  like 4, 20, 28, 76, 100, 124).
- No outline ring: the white hull *is* the visible outer shape, and black is only the inner core. The white area
  is thick (22–40 px around the core).
- Nose points **up** (toward y = 0). Canvas 128 wide; 128 or 144 tall.

### 2.4 Bullets

A single white path: rectangles or pointed bars. 100 % on the 8 px grid. For example `shipbasic1bullet.svg` is an
8×16 white bar centered in a 24×32 canvas. Nose points up.

### 2.5 Background particles (frost, ember, wasteland)

- **Frost (`cold`)** and **ember (`amber`)**: 1–4 **white** paths per file, no outline and no black: flat
  silhouettes of diamonds, slivers, triangles, X-shapes and 4-point stars. Multi-path files (`cold3`, `cold4`,
  `cold13`) are overlapping pieces that form one shape.
- **Wasteland**: flat white rectangles and small blocks. 3 of 8 files use `<rect>` instead of `<path>`.
- Sizes: 8–40 px. 8 px steps everywhere except the two 33 px-wide files.

### 2.6 Pickups (gold coins, XP drops)

A colored base shape (a diamond, or diamond-like stacks for bigger denominations) plus **two facet triangles**
over its lower half: the **lower-left in black at `fill-opacity="0.5"`** (shadow) and the **lower-right in white
at `fill-opacity="0.5"`** (highlight). There's no outline.

- Gold colors: `#D69919`, `#936503`, `#BA7F00`.
- XP colors: `#8BA400`, `#658910`, `#46830B`, `#006215`.

`1coin1.svg` contains a duplicated base path (harmless).

### 2.7 HUD and interface art (ship cards, class art, upgrade icons, minimap frame)

These **don't follow the grid** (1.5–8.6 % on-grid) and use features the game textures avoid:
- `<rect>` with `rx` (rounded corners), `stroke="white"` with `stroke-width="8"`.
- `transform="rotate(…)"`: the ship art on cards is rotated about 30°.
- `fill-opacity="0.5"` black panels, clip paths, `#D9D9D9` placeholders.

They are drawn as-is by the browser, so none of that breaks anything. They're a separate "UI" style: white
8 px frames on 50 % black panels.

---

## 3. How the game uses textures (constraints)

| Category | How it's loaded and used | Hard constraints |
|---|---|---|
| **Rocks** (`rocks/<N>/`, `goldrocks/<N>/`, `xporerocks/<N>/`) | Server scans numeric folders at boot. **Radius = N / 2 from the folder name**, not from the SVG `width`. Exact collision shape = the `<path>` with the **largest area**, parsed by `parseSvgPathD` in `server.js`, centered at (N/2, N/2). The client gets the same shapes. | Canvas must be **square and equal to the folder number**. The silhouette must be a `<path>` using only **M/L/H/V/Z** (absolute or relative): C/Q/A/S/T are ignored, so the shape comes out wrong. **No `transform`** on paths (not applied). `<rect>`, `<polygon>`, `<circle>` are ignored by the parser. `<g clip-path>` wrappers are harmless. |
| Biome tint on rocks | Client fills the texture's alpha with the biome color (`source-in`) and draws it at 15 %. | Every opaque pixel is tinted, whatever its color. |
| **XP ore rocks** | `extractAccentColor` (shared/svgAccent.js) picks the particle color. | **Exactly one** fill color other than black/white/none, or the particles fall back to white with a console warning. `#FBFBFB` counts as a color. |
| Crystal / explosion rocks | Built at runtime on normal rock textures of **112 or 128 px**. Explosion fragments use normal rocks of **32–64 px** (today 48 and 64). | New sizes join automatically once their folder exists. |
| **Ships** | Path hard-coded in `SHIP_TYPES` (server.js). Drawn at **60/128 world units per px**, nose up. Gun and engine positions are texture pixel coordinates. **Tinted by multiply** with the player color: **white takes the player color, black stays black**, transparent stays transparent. Spawn clearance uses the convex hull of the **first** `d="…"` path. Hit collision is a circle (r = 30), not the shape. | The first path must be the hull outline, with straight commands. Keep the hull white and the details black, or the tint won't read. |
| **Bullets** | Path in `BULLET_TYPES`. Same multiply tint (white → player color), same 60/128 scale × per-type `scale`. | White body, nose up. |
| **Frost / ember particles** (`particles/cold`, `particles/amber`) | Folder scan. **Every `<path>`** becomes an exact collision polygon (M/L/H/V/Z), centered on the canvas. Drawn as a **solid one-color silhouette** (crystals: `#BCC8EE` / `#87B4E9` / `#3C5787` at 80 %; explosion: `#971E1D` / `#E43B3B` at 60 %). Size from `width`/`height` (or `viewBox`). | Shapes must be `<path>` elements (a `<rect>` would draw but have no collision). Internal color detail is invisible: only the silhouette matters. Any size works; keep them small (8–40 px). |
| Wasteland dust | Hard-coded file list, drawn as-is (white). | Nothing is parsed. Adding a file needs a code change. |
| **Gold / XP pickups** | Folder scan. **Drawn size = native size** from `width`/`height` (else `viewBox`, else PNG pixels). **Pickup radius = max(w, h) × 0.5 (gold) or × 5/16 (XP)**. Drawn as-is with random rotation. | The canvas size *is* the gameplay size. |
| Gold-rock break particles | Hard-coded list `GOLD_PARTICLE_FILES`. | Adding a file needs a code change. |
| **Ship cards** | `interface/shipcards/{classId}icon1.svg`, drawn as-is at 75 % scale, pre-rendered crisply. | Any SVG features work. Width 240–256 sets the HUD bar width. |
| Class-menu art | `interface/classes/*_art.svg`, multiply-tinted with the player color. | White = takes the player color. |
| Upgrade icons, minimap frame, cursor | Drawn as-is (the cursor through CSS). | None beyond size. |

Everything is rendered as an `<img>` by the browser, so any valid SVG *displays*. Only the **server's path parser**
(rocks, crystal/ember particles, ship hulls) restricts construction: straight commands only, no transforms, and
the shape must be in `<path>` elements.

---

## 4. Where the old style document is wrong

The old document is `~/Downloads/texture-style-rules.md` (not in the repo). Compared with the real files:

| Old document says | Real files | Verdict |
|---|---|---|
| "Silhouette is filled solid white" with a **black outline** | Rocks: white silhouette, but the visible result is a **white 8 px outline around a black body** | **Wrong for rocks**, which are the main set it was written from. |
| Outline built as a **second path with `fill-rule="evenodd"`** punching a ring | **No file uses `evenodd`** (0 of 141). The ring comes from stacking a smaller black shape on top of the white silhouette. | **Wrong.** |
| Details are **black** primitives, "own closed subpaths in the same black path" | Details are **white gaps** (notches, slits, holes) in the black body, mostly within one black contour | **Wrong** (inverted). |
| Outline inset **8–16 px** | **8 px** (7.2–8.0 measured) at every size | **Too loose.** |
| **Strictly 2 colors** | True for normal rocks, ships, bullets and particles. False for XP rocks (green at 0.5), gold rocks (2 golds at 0.7), pickups (color + black/white facets at 0.5) and UI (0.5 black panels, `#D9D9D9`). | **Incomplete.** |
| **Every** vertex on the 8 px grid | Rocks 96.8 %, particles 94–100 %; **ships use a 4 px grid** (98.8 % on 4, 86.5 % on 8); UI art is off-grid | **Partly wrong.** |
| Canvas sizes 128–256 | Rocks go down to **48**; particles 8–40; pickups 16–32 | **Outdated.** |
| Template syntax `M48,0 L80,0 …` with commas | Real files use Figma syntax `M48 0H80L96 8…` with heavy **H/V** use | Style difference only (both parse). |
| Don't use `stroke`; no curves | Correct for all in-game textures | **Correct.** |

Also correct: straight segments only, angular primitives, and complexity scaling with size.

---

## 5. Examples to copy from

- Smallest clean rock: `rocks/48/rock48.svg` (2 paths).
- Ship: `ships/basic_ship/shipbasic1.svg` (hull + one core, 4 px grid).
- XP pickup: `particles/xp/1xp/1xp1.svg` (diamond + two 50 % facets).
- Crystal: `particles/cold/cold3.svg` (two overlapping white pieces).
- XP ore rock: `xporerocks/64/xprock64_1.svg` (rock + one green accent at 0.5).
