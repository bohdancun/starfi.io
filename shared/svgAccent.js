// Accent color of a 3-color texture (black + white + one accent), shared by the client and tools.
// Plain ESM, no dependencies.

const NEUTRAL = new Set(['none', 'transparent', 'currentcolor', 'black', '#000', '#000000', 'white', '#fff', '#ffffff']);

// The single fill color that is not black, white or "none" (attribute or inline style), lowercased,
// or null when there are zero or several candidates.
export function extractAccentColor(svgText) {
  const colors = new Set();
  const found = [
    ...svgText.matchAll(/\bfill\s*=\s*"([^"]+)"/gi),
    ...svgText.matchAll(/\bfill\s*:\s*([^;"']+)/gi),
  ];
  for (const m of found) {
    const c = m[1].trim().toLowerCase();
    if (!NEUTRAL.has(c) && !c.startsWith('url(')) colors.add(c);
  }
  return colors.size === 1 ? [...colors][0] : null;
}
