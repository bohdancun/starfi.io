// Ship class tree, shared by server.js (authoritative) and src/main.js (menu).
// Plain ESM, no dependencies. A class id is also its SHIP_TYPES key on the server.
// Adding a tier = adding entries whose fromClass is an existing class.
//   fromClass: class you must currently be to pick this one
//   level:     level at which the choice unlocks
//   icon:      card art relative to /textures/ (frameless; the menu draws the card frame)
//   hint:      one short line shown while the card is hovered

export const CLASS_TREE = [
  { id: 'twink',  name: 'twink',  fromClass: 'basic', level: 15, icon: 'interface/classes/twinkicon_art.svg',  hint: '2 short guns + 2 fast long-range guns' },
  { id: 'sniper', name: 'sniper', fromClass: 'basic', level: 15, icon: 'interface/classes/snipericon_art.svg', hint: '2 basic guns + 1 heavy long-range shot' },
];

// Classes a player of `fromClass` at `level` may switch to, in tree order.
export function classChoicesFor(fromClass, level) {
  return CLASS_TREE.filter(c => c.fromClass === fromClass && level >= c.level);
}

export function classById(id) {
  return CLASS_TREE.find(c => c.id === id) || null;
}
