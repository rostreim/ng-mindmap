# Toolbar hover tooltips

**Status:** Approved, pending implementation
**Component:** `mindmap-app/src/app/` (`app.html`, `app.scss`)

## Goal

Each of the 6 toolbar buttons (Reset, Fit, layout-mode cycle, data-mode toggle, collapse-mode toggle, theme toggle) gets a hover/focus tooltip describing what it does, styled to match the app's existing dark/light theme rather than relying on the browser's native `title` tooltip.

## Non-goals

- No reusable Angular tooltip directive/component. The toolbar is a static row of 6 buttons in a fixed position — there's no dynamic positioning or viewport-edge-flipping problem to solve, so a CSS-only approach is sufficient and avoids unneeded indirection.
- No tooltips outside the toolbar (e.g. on SVG nodes or the context menu) — out of scope for this change.

## Approach

Each button gets a `data-tooltip="<description>"` attribute in `app.html`. A shared CSS rule in `app.scss` (scoped to `.toolbar button[data-tooltip]` or similar) renders the description via a `::after` pseudo-element (text bubble) plus a `::before` pseudo-element (small arrow), positioned below the button, shown on `:hover` and `:focus-visible` via `opacity`/`visibility`.

- **Animation:** fade + slight upward translate, 140ms, matching the existing `mm-menu-in` keyframe timing used by the context menu. Respects `prefers-reduced-motion: reduce` (animation disabled), consistent with `context-menu.scss`'s existing handling.
- **Theming:** reuses the exact tokens already used by `.mm-menu`/`context-menu.scss`, scoped the same way `.theme-toggle` already is (`main[data-theme='dark'] &` / `main[data-theme='light'] &`):
  - Dark: background `#24273a`, border `#3b3b5c`, text `#cdd6f4`.
  - Light: background `#ffffff`, border `#e9eaeb`, text `#414651`.
- **Copy** (one `data-tooltip` value per button):
  - Reset → "Reset pan and zoom to the default view"
  - Fit → "Zoom and pan to fit the whole graph"
  - Layout-mode cycle → "Cycle layout: force → radial → hybrid"
  - Data-mode toggle → "Switch between tree and graph (DAG) sample data"
  - Collapse-mode toggle → "Toggle collapse propagation: global vs per-edge"
  - Theme toggle → reuses its existing `aria-label` text ("Switch to light/dark theme") rather than introducing a second, possibly-diverging description

## Accessibility

`:focus-visible` triggers the tooltip (not just `:hover`), so keyboard users tabbing through the toolbar see the same description sighted mouse users do. The tooltip text is presentational/redundant with each button's existing visible label + (for the theme toggle) `aria-label` — it is not the sole source of the accessible name, so no additional ARIA wiring is needed.

## Testing

This is a CSS-only, non-interactive presentational change with no new logic branches — covered by manual verification (hover/focus each button in both themes), not new unit/e2e tests.
