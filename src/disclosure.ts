/** One disclosure glyph everywhere: the chevron. It points right while a fold is shut and turns down when it opens,
 * on the server pages, the enhanced folds (workspace-motion.ts) and the React views (lucide's ChevronRight). Every
 * other marker (the native triangle, ▸/▾, +/−, ⌄ and the old arrows) is turned off here, last, so no page can bring
 * a second glyph back. A summary that carries its own icon keeps it. Drawn with two borders: the page's content
 * policy allows no image, not even a data: one. */
export const DISCLOSURE_CSS = `details>summary{list-style:none}details>summary::-webkit-details-marker{display:none}` +
  `details>summary::after{content:none!important}` +
  `details>summary:not(:has(>svg))::before{content:""!important;display:inline-block;flex:none;box-sizing:border-box;width:7px!important;height:7px!important;` +
  `margin:0 .55rem 0 .2rem!important;padding:0!important;position:static!important;vertical-align:.1em;font-size:0;background:none!important;` +
  `border:0 solid currentColor!important;border-right-width:1.5px!important;border-bottom-width:1.5px!important;opacity:.65;` +
  `transform:rotate(-45deg)!important;transition:transform .15s ease}` +
  `details[open]>summary:not(:has(>svg))::before{transform:rotate(45deg)!important}` +
  `@media (prefers-reduced-motion:reduce){details>summary::before{transition:none!important}}`;
