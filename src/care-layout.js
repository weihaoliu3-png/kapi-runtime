// Keep the care card entirely in the transparent space above the pet.
(function (global) {
  'use strict';
  const BASE_TOP = 130;
  const CARD_GAP = 16;
  global.CareLayout = {
    topPadding(cardBottom) {
      return Math.max(BASE_TOP, Math.ceil(cardBottom + CARD_GAP));
    },
    windowTop(petScreenTop, padding, monitorTop) {
      return Math.round(Math.max(monitorTop, petScreenTop - padding));
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
