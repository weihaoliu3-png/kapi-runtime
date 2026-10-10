// Vertical layout of everything that lives in the transparent space above the pet: the care card, the chat input and
// the speech bubble. Nothing may cover the pet or what sits on its head (the typing flower), so the overlays form one
// stack above the measured content top, and the window grows upward (pet feet fixed on screen) when the stack needs
// more room than the current top padding gives. Pure functions; main.js supplies the measurements.
(function (global) {
  'use strict';
  const BASE_TOP = 130;
  const CARD_GAP = 16;
  const STACK_GAP = 12;        // px between the content top and the first overlay, and between overlays
  const EDGE = 4;              // px kept free at the window's top edge

  /**
   * Stack overlays above the content. `overhang` = how far the drawn content (pet + flower + props) reaches ABOVE the
   * pet's pad line (PAD_TOP), in px (0 when nothing pokes above it). `items` are bottom-to-top, nearest the pet first:
   * [{ id, h }]. Returns { tops: {id: y relative to the pad line, negative = above it}, needPad: the top padding that
   * keeps the whole stack inside the window }.
   */
  function stack(overhang, items, gap = STACK_GAP) {
    const tops = {}; let y = -Math.max(0, overhang || 0);
    for (const it of items) { y -= gap + it.h; tops[it.id] = y; }
    return { tops, needPad: Math.max(BASE_TOP, Math.ceil(-y + EDGE)) };
  }

  global.CareLayout = {
    BASE_TOP, STACK_GAP, EDGE,
    topPadding(cardBottom) {
      return Math.max(BASE_TOP, Math.ceil(cardBottom + CARD_GAP));
    },
    windowTop(petScreenTop, padding, monitorTop) {
      return Math.round(Math.max(monitorTop, petScreenTop - padding));
    },
    /** true when growing the padding to `padding` would push the window above the monitor (pet would be shoved down) */
    blocked(petScreenTop, padding, monitorTop) {
      return petScreenTop - padding < monitorTop;
    },
    stack,
  };
})(typeof window !== 'undefined' ? window : globalThis);
