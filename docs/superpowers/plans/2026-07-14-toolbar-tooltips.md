# Toolbar Hover Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of the 6 toolbar buttons a themed hover/focus tooltip describing its action.

**Architecture:** Pure CSS. Each button gets a `data-tooltip="<description>"` attribute in `app.html`; a shared `::after`/`::before` pseudo-element rule in `app.scss` renders the description as a themed bubble+arrow below the button on `:hover`/`:focus-visible`. No new Angular component, directive, or TypeScript logic.

**Tech Stack:** Angular 21 template syntax, SCSS. No new dependencies.

## Global Constraints

- No new Angular component/directive — CSS-only, per spec's "Non-goals" (docs/superpowers/specs/2026-07-14-toolbar-tooltips-design.md).
- Reuse existing theme tokens verbatim: dark `background #24273a / border #3b3b5c / text #cdd6f4`; light `background #ffffff / border #e9eaeb / text #414651`.
- Entrance animation: 140ms, matching `mm-menu-in`'s timing in `context-menu.scss`. Must respect `prefers-reduced-motion: reduce`.
- Tooltip must trigger on `:focus-visible` as well as `:hover` (keyboard accessibility).
- No automated tests for this task — it's a presentational, non-interactive CSS change with no new logic branches (spec's "Testing" section). Verification is manual: run the app, hover/focus each button in both themes, confirm visually. The existing e2e suite (which locates these buttons by text) must still pass unchanged, since no button text or structure is being removed — only an attribute is being added.

---

### Task 1: Add `data-tooltip` attributes and themed CSS tooltip

**Files:**
- Modify: `src/app/app.html:4-15` (the 6 toolbar `<button>` elements)
- Modify: `src/app/app.scss` (append new tooltip rule block; existing `.theme-toggle` block at lines 45-90 stays as-is)

**Interfaces:**
- Consumes: existing `theme()` signal already used for the `[attr.aria-label]` binding on the theme-toggle button (`app.ts`) — no new signals or inputs.
- Produces: nothing consumed by other tasks — this is the only task in the plan.

- [ ] **Step 1: Add `data-tooltip` attributes to the 6 buttons in `app.html`**

Replace lines 4-15 of `src/app/app.html`:

```html
    <button class="theme-toggle" (click)="mm.resetView()">⟲ Reset</button>
    <button class="theme-toggle" (click)="mm.zoomToFit()">⤢ Fit</button>
    <button class="theme-toggle" (click)="cycleLayoutMode()">⟐ {{ layoutMode() }}</button>
    <button class="theme-toggle" (click)="toggleDataMode()">⎇ {{ dataMode() }}</button>
    <button class="theme-toggle" (click)="toggleCollapseMode()">⊟ {{ collapseMode() }}</button>
    <button class="theme-toggle" (click)="toggleTheme()" [attr.aria-label]="theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'">
```

with:

```html
    <button class="theme-toggle" data-tooltip="Reset pan and zoom to the default view" (click)="mm.resetView()">⟲ Reset</button>
    <button class="theme-toggle" data-tooltip="Zoom and pan to fit the whole graph" (click)="mm.zoomToFit()">⤢ Fit</button>
    <button class="theme-toggle" data-tooltip="Cycle layout: force → radial → hybrid" (click)="cycleLayoutMode()">⟐ {{ layoutMode() }}</button>
    <button class="theme-toggle" data-tooltip="Switch between tree and graph (DAG) sample data" (click)="toggleDataMode()">⎇ {{ dataMode() }}</button>
    <button class="theme-toggle" data-tooltip="Toggle collapse propagation: global vs per-edge" (click)="toggleCollapseMode()">⊟ {{ collapseMode() }}</button>
    <button class="theme-toggle" [attr.data-tooltip]="theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'" (click)="toggleTheme()" [attr.aria-label]="theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'">
```

(The theme-toggle button binds `data-tooltip` dynamically since its description depends on the current theme, same expression already used for `aria-label`. The other 5 are static strings.)

- [ ] **Step 2: Append the tooltip CSS rule block to `app.scss`**

Add this block at the end of `src/app/app.scss` (after the `@keyframes detail-in` block that currently ends the file):

```scss
// Toolbar button hover/focus tooltips — bubble (::after) + arrow (::before),
// positioned below the button. Timing matches context-menu.scss's mm-menu-in (140ms).
.toolbar button[data-tooltip] {
  position: relative;

  &::after,
  &::before {
    position: absolute;
    left: 50%;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    z-index: 10;
    transition: opacity 140ms cubic-bezier(0.0, 0, 0.2, 1),
                transform 140ms cubic-bezier(0.0, 0, 0.2, 1),
                visibility 0s 140ms;
  }

  &::after {
    content: attr(data-tooltip);
    top: calc(100% + 10px);
    transform: translateX(-50%) translateY(-4px);
    padding: 6px 10px;
    border-radius: 6px;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 12px;
    font-weight: 400;
    white-space: nowrap;
  }

  &::before {
    content: '';
    top: calc(100% + 6px);
    width: 8px;
    height: 8px;
    transform: translateX(-50%) translateY(-4px) rotate(45deg);
  }

  &:hover::after,
  &:focus-visible::after {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0);
    transition: opacity 140ms cubic-bezier(0.0, 0, 0.2, 1),
                transform 140ms cubic-bezier(0.0, 0, 0.2, 1),
                visibility 0s;
  }

  &:hover::before,
  &:focus-visible::before {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0) rotate(45deg);
    transition: opacity 140ms cubic-bezier(0.0, 0, 0.2, 1),
                transform 140ms cubic-bezier(0.0, 0, 0.2, 1),
                visibility 0s;
  }

  main[data-theme='dark'] & {
    &::after {
      background: #24273a;
      border: 1px solid #3b3b5c;
      color: #cdd6f4;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    &::before {
      background: #24273a;
      border-left: 1px solid #3b3b5c;
      border-top: 1px solid #3b3b5c;
    }
  }

  main[data-theme='light'] & {
    &::after {
      background: #ffffff;
      border: 1px solid #e9eaeb;
      color: #414651;
      box-shadow: 0 4px 16px rgba(65, 70, 81, 0.14);
    }
    &::before {
      background: #ffffff;
      border-left: 1px solid #e9eaeb;
      border-top: 1px solid #e9eaeb;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .toolbar button[data-tooltip]::after,
  .toolbar button[data-tooltip]::before {
    transition: opacity 0s, visibility 0s;
  }
  .toolbar button[data-tooltip]::after {
    transform: translateX(-50%) translateY(0);
  }
  .toolbar button[data-tooltip]::before {
    transform: translateX(-50%) translateY(0) rotate(45deg);
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b --noEmit`
Expected: no output, exit code 0 (this step only touches `.html`/`.scss`, so this just confirms nothing else broke).

- [ ] **Step 4: Run the existing e2e suite to confirm no regression**

Run: `npx playwright test`
Expected: same pass/fail counts as before this change — specifically, the pre-existing unrelated flaky test `dragging a node in radial mode moves it and it stays put (no snap-back)` may still fail (known, unrelated to this change — see `fix/ctrl-click-context-menu-toggles-node` branch history), but no test that references toolbar buttons (`Fit`, `Reset`, etc. by text) should newly fail, since button text content is unchanged.

- [ ] **Step 5: Manually verify in a real browser**

Start the dev server if not already running: `npm start` (background).
Open `http://localhost:4200` in a browser. For each of the 6 toolbar buttons:
- Hover with the mouse → confirm the themed tooltip bubble+arrow fades in below the button with the correct description text.
- Tab to the button with the keyboard → confirm the same tooltip appears on `:focus-visible`.
- Click the theme toggle → confirm the reset/fit/etc. tooltips still render correctly in the new theme's colors, and the theme-toggle button's own tooltip text flips between "Switch to light theme"/"Switch to dark theme" appropriately.

- [ ] **Step 6: Commit**

```bash
git add src/app/app.html src/app/app.scss
git commit -m "feat: add themed hover/focus tooltips to toolbar buttons"
```
