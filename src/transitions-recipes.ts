// Selected portable recipes from https://github.com/Jakubantalik/transitions.dev
// Keep recipe CSS intact; Standing Orders overrides and wiring live separately.
export const TRANSITIONS_CSS = `
/* Transitions.dev — 05-menu-dropdown.md */
:root {
  --dropdown-open-dur: 250ms;
  --dropdown-close-dur: 150ms;
  --dropdown-pre-scale: 0.97;
  --dropdown-closing-scale: 0.99;
  --dropdown-ease: cubic-bezier(0.22, 1, 0.36, 1);
}

.t-dropdown {
  transform-origin: top left;
  transform: scale(var(--dropdown-pre-scale));
  opacity: 0;
  pointer-events: none;
  transition:
    transform var(--dropdown-open-dur) var(--dropdown-ease),
    opacity   var(--dropdown-open-dur) var(--dropdown-ease);
  will-change: transform, opacity;
}
.t-dropdown[data-origin="top-right"]     { transform-origin: top right; }
.t-dropdown[data-origin="top-center"]    { transform-origin: top center; }
.t-dropdown[data-origin="bottom-left"]   { transform-origin: bottom left; }
.t-dropdown[data-origin="bottom-center"] { transform-origin: bottom center; }
.t-dropdown[data-origin="bottom-right"]  { transform-origin: bottom right; }

.t-dropdown.is-open {
  transform: scale(1);
  opacity: 1;
  pointer-events: auto;
}
.t-dropdown.is-closing {
  transform: scale(var(--dropdown-closing-scale));
  opacity: 0;
  pointer-events: none;
  transition:
    transform var(--dropdown-close-dur) var(--dropdown-ease),
    opacity   var(--dropdown-close-dur) var(--dropdown-ease);
}

@media (prefers-reduced-motion: reduce) {
  .t-dropdown { transition: none !important; }
}

/* Transitions.dev — 07-panel-reveal.md */
:root {
  --panel-open-dur: 400ms;
  --panel-close-dur: 350ms;
  --panel-translate-y: 100px;
  --panel-blur: 2px;
  --panel-ease: cubic-bezier(0.22, 1, 0.36, 1);
}

.t-panel-slide {
  transform: translateY(var(--panel-translate-y));
  opacity: 0;
  filter: blur(var(--panel-blur));
  pointer-events: none;
  transition:
    transform var(--panel-close-dur) var(--panel-ease),
    opacity   var(--panel-close-dur) var(--panel-ease),
    filter    var(--panel-close-dur) var(--panel-ease);
  will-change: transform, opacity, filter;
}
.t-panel-slide[data-open="true"] {
  transform: translateY(0);
  opacity: 1;
  filter: blur(0);
  pointer-events: auto;
  transition:
    transform var(--panel-open-dur) var(--panel-ease),
    opacity   var(--panel-open-dur) var(--panel-ease),
    filter    var(--panel-open-dur) var(--panel-ease);
}

@media (prefers-reduced-motion: reduce) {
  .t-panel-slide { transition: none !important; }
}

/* Transitions.dev — 16-tabs-sliding.md */
:root {
  --tabs-dur: 250ms;
  --tabs-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --tabs-text-muted: rgba(15, 15, 15, 0.8);
  --tabs-text-active: #0f0f0f;
  --tabs-bar-bg: #f1f1f1;
  --tabs-pill-bg: #ffffff;
}

/* The bar is just a flex container with padding for the pill
   to sit inside. Tabs sit on z-index: 1, the pill on z-index: 0,
   so labels read above the pill background. */
.t-tabs {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border-radius: 48px;
  background: var(--tabs-bar-bg);
}
.t-tab {
  position: relative;
  appearance: none;
  border: 0;
  background: transparent;
  height: 30px;
  padding: 4px 12px;
  color: var(--tabs-text-muted);
  cursor: pointer;
  border-radius: 48px;
  z-index: 1;
  transition: color var(--tabs-dur) var(--tabs-ease);
}
.t-tab:not([aria-selected="true"]):hover,
.t-tab[aria-selected="true"] {
  color: var(--tabs-text-active);
}

/* The pill: width + transform are written inline by JS so
   the transition tweens between the previous and next
   measured positions. */
.t-tabs-pill {
  position: absolute;
  top: 3px;
  left: 0;
  height: 30px;
  width: 0;
  background: var(--tabs-pill-bg);
  border-radius: 48px;
  transform: translateX(0);
  transition:
    transform var(--tabs-dur) var(--tabs-ease),
    width     var(--tabs-dur) var(--tabs-ease);
  will-change: transform, width;
  z-index: 0;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .t-tabs-pill, .t-tab { transition: none !important; }
}

/* Transitions.dev — 21-accordion.md */
:root {
  --acc-expand: 250ms;
  --acc-collapse: 250ms;
  --acc-chevron: 250ms;
  --acc-ease: cubic-bezier(0.22, 1, 0.36, 1);
}

/* grid-template-rows 0fr → 1fr gives a clean height animation
   with no JS measurement; the inner element clips overflow. */
.t-acc-panel {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--acc-collapse) var(--acc-ease);
}
.t-acc[data-open="true"] .t-acc-panel {
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--acc-expand) var(--acc-ease);
}
.t-acc-panel-inner {
  overflow: hidden;
  opacity: 0;
  filter: blur(2px);
  transition:
    opacity var(--acc-collapse) var(--acc-ease),
    filter var(--acc-collapse) var(--acc-ease);
}
.t-acc[data-open="true"] .t-acc-panel-inner {
  opacity: 1;
  filter: blur(0);
  transition:
    opacity var(--acc-expand) var(--acc-ease),
    filter var(--acc-expand) var(--acc-ease);
}
/* Flip the chevron vertically to turn the "v" into a "^".
   scaleY(-1) about the centre passes through a flat line at
   the midpoint (same look as a \`d:\` path morph) but animates
   in every browser, unlike CSS \`d:\` morphing (Chromium only).
   The chevron path is symmetric about the 16x16 viewBox
   centre, so the flip lands exactly on the "^"; non-scaling
   -stroke keeps the stroke width constant through the flip. */
.t-acc-chevron {
  display: inline-flex;
  transform: scaleY(1);
  transform-origin: center;
  transition: transform var(--acc-chevron) var(--acc-ease);
}
.t-acc-chevron path { vector-effect: non-scaling-stroke; }
.t-acc[data-open="true"] .t-acc-chevron {
  transform: scaleY(-1);
}

@media (prefers-reduced-motion: reduce) {
  .t-acc-panel, .t-acc-panel-inner, .t-acc-chevron {
    transition: none !important;
  }
}
`;
