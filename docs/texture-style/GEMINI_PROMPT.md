# Gemini prompt: starfi.fun textures

Paste everything below the line into Gemini, then fill in the template at the end.

---

You are drawing SVG textures for **starfi.fun**, a multiplayer top-down space shooter in the browser (.io style).
Players fly small ships through a field of asteroids, shoot rocks for gold and XP pickups, and fight each other.
All art is hand-built vector "pixel art": flat, high-contrast, angular shapes on a coarse grid. The game loads
your SVG as-is, and for rocks and particles it also **parses your path coordinates into collision shapes**, so the
technical rules below are hard requirements, not preferences.

## Style rules

1. **Grid.** Put every coordinate on a multiple of **8** (0, 8, 16, 24 …). Ships alone may use multiples of **4**.
   Write whole numbers only: no decimals, no `.5`.
2. **Canvas.** `width` and `height` are multiples of 8 and match the requested size exactly. Draw inside
   0…width and 0…height. The shape should touch the canvas edges on at least two sides (no big empty margins).
3. **Edges.** Straight lines only: horizontal, vertical or diagonal. Diagonals step on the grid (8 across / 8 down,
   or 8 across / 16 down). No curves, no circles, no rounded corners.
4. **Silhouette.** An irregular, jagged, angular outline suited to the subject. More steps on bigger canvases:
   about `8 + size ÷ 10` corners (48 px ≈ 10, 128 px ≈ 21, 256 px ≈ 31).
5. **Rocks: white outline, black body.** Draw exactly two paths, in this order:
   - Path 1: the full silhouette, `fill="white"`.
   - Path 2: one `fill="black"` shape that follows the same silhouette **inset by exactly 8 px** on every side.
   This leaves an **8 px white outline around a black body**.
6. **Rock details are white gaps in the black body.** Cut them into path 2 as notches, 8 px-wide slits, diagonal
   cracks, small squares or triangles running in from the outline or sitting inside. Scale with size: 1–2
   features at 48–64 px, 3–6 at 112–144 px, 8+ at 240–256 px. Never draw black details on white.
7. **Ships: white hull, black core.** Path 1 is the hull silhouette, `fill="white"`, nose pointing **up** (toward
   y = 0). Path 2 is one black inner shape (cockpit or body plate), `fill="black"`, with at least 16 px of white
   around it. No outline ring. The game recolors white to the player's color and keeps black black.
8. **Particles (crystals, ember sparks, dust):** 1–4 **white** paths only, no black, no outline. Simple shapes:
   diamonds, slivers, triangles, X-shapes, 4-point stars. Overlapping pieces are fine. The game recolors the
   whole silhouette.
9. **Pickups (coins, XP):** one base shape (usually a diamond) in the given color, plus two facet triangles on its
   lower half: the lower-left `fill="black" fill-opacity="0.5"`, the lower-right `fill="white" fill-opacity="0.5"`.
10. **Colors.** Rocks, ships, bullets, particles: `white` and `black` only. XP ore rocks may add **one** green
    (`#8BA400`, `#658910`, `#46830B` or `#006215`) at `fill-opacity="0.5"`. Gold rocks may add `#D69919` and
    `#936503` at `fill-opacity="0.7"`. Pickups: gold `#D69919`/`#936503`/`#BA7F00`, XP one of the greens above.
    Never use gradients or any other colors.

## Technical SVG rules

11. The root is exactly: `<svg width="N" height="M" viewBox="0 0 N M" fill="none" xmlns="http://www.w3.org/2000/svg">`.
12. Use only `<path d="…" fill="…"/>` elements, optionally with `fill-opacity`. **No** `<g>`, `transform`,
    `<rect>`, `<circle>`, `<polygon>`, `<defs>`, `clipPath`, `mask`, `filter`, `style`, `class`, `stroke`,
    `<text>`, `<image>`, `<use>` or `fill-rule`.
13. Path data uses only **absolute** `M`, `L`, `H`, `V`, `Z` (uppercase). No `C`, `Q`, `S`, `T`, `A`, and no
    lowercase commands. Close every shape with `Z`.
14. Put the largest silhouette first. For rocks, path 1 must be the outer shape, since the game uses the
    largest path as the collision outline.
15. Keep paths minimal: no duplicate paths, no zero-area shapes, no repeated points.
16. **Output only the SVG code**, starting with `<svg` and ending with `</svg>`. No explanation and no Markdown fence.

## Reference files from the game (real sources)

A 48 px rock. The `<g clip-path>` and `<defs>` block are a design-tool export wrapper: **leave them out**
(rule 12), and output only the two paths inside.
```svg
<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_121_41)">
<path d="M16 0H32L40 8L48 24V32L40 40L24 48H8L0 32V16L16 0Z" fill="white"/>
<path d="M16 8H24V16H16V32H32V24H24V16L32 8L40 24V32L24 40H16L8 32V16L16 8Z" fill="black"/>
</g>
<defs>
<clipPath id="clip0_121_41">
<rect width="48" height="48" fill="white"/>
</clipPath>
</defs>
</svg>
```

A ship (128 px, 4 px grid, nose up, white hull with a black core):
```svg
<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M0 80L0 64V48L16 32V16L28 20L32 16L48 0L64 8L80 0L96 16L100 20L112 16V24V32L128 48V64V80L104 128H96H88L96 112V96L80 88L64 96L48 88L32 96V112L40 128H24L16 112L8 96L0 80Z" fill="white"/>
<path d="M32 32L48 16L64 24L80 16L96 32V40H104L112 48L80 56V72L64 80L48 72V56L16 48L24 40H32V32Z" fill="black"/>
</svg>
```

An XP pickup (16 px). `8.00002` is export noise: write `8`.
```svg
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M8 0L16 8L8 16L0 8L8 0Z" fill="#8BA400"/>
<path d="M0 8.00002H8V16L0 8.00002Z" fill="black" fill-opacity="0.5"/>
<path d="M8.00002 16V8H16L8.00002 16Z" fill="white" fill-opacity="0.5"/>
</svg>
```

A crystal particle (24 px, two overlapping white pieces):
```svg
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M16 0L24 16L16 24L8 16L16 0Z" fill="white"/>
<path d="M0 16L16 8L24 16L16 24L0 16Z" fill="white"/>
</svg>
```

## Per category

| Category | Allowed sizes (px) | Extra rules |
|---|---|---|
| Rock | Square: 48, 64, 80, 96, 112, 120, 128, 144, 176, 208, 224, 240, 256 | Rules 5–6. Width = height = the size. |
| XP ore rock | Square: 64, 80 | A rock (rules 5–6) plus 2–3 accent facets in **one** green at 0.5, drawn after the black body. |
| Gold rock | Square: 208, 224, 240, 256 | A rock plus many small `#D69919` / `#936503` facets at 0.7 on the body. |
| Ship | 128 × 128 or 128 × 144 | Rule 7. 4 px grid allowed. Nose up. |
| Bullet | 8–32 wide × 32–56 tall | One white path (bar or pointed bar), centered, nose up. |
| Crystal / ember / dust particle | 8–40 per side | Rule 8. |
| Coin pickup | 16 × 16 (value 1 and 3), 24 × 24 (value 5) | Rule 9, gold colors. The size is the in-game size. |
| XP pickup | 16 × 16 (1), 16 × 24 (3), 16 × 32 (5) | Rule 9, one green. |
| HUD / menu icon | As requested | The grid and color rules still apply. An 8 px white border is allowed for frames. |

## Before you answer, check every item

- [ ] Every number in every `d` attribute is a whole multiple of 8 (multiple of 4 for ships).
- [ ] `width`, `height` and `viewBox` match the requested size.
- [ ] Only `M L H V Z`, all uppercase; no curves.
- [ ] Only `<path>` elements inside `<svg>`: no `<g>`, `transform`, `<rect>`, `stroke`, `fill-rule`, `<defs>`.
- [ ] Only the colors allowed for this category, with opacity only where rule 9 or 10 allows it.
- [ ] Rock: path 1 white silhouette, path 2 black body inset exactly 8 px, details are white gaps.
- [ ] Ship: nose up, white hull, black core with at least 16 px of white around it.
- [ ] Silhouette has about `8 + size ÷ 10` corners and touches the canvas edges.
- [ ] Output is only the SVG code.

## Now create

Now create: **[WHAT]** for **[CATEGORY]**, size **[N]** px, details: **[DESCRIPTION]**
