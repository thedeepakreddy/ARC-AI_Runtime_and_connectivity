---
name: ARC
description: AI Runtime & Connectivity — the owner console and the customer dashboard
source:
  - packages/ui/src/styles.css
  - packages/ui/src/index.tsx
  - packages/ui/src/Wordmark.tsx
  - packages/ui/src/fonts.ts
  - scripts/art/render_space.py
generatedAt: '2026-11-20'
colors:
  bg: '#000000'
  surface: '#121315'
  surface-2: '#1c1d20'
  surface-3: '#26272b'
  sidebar: '#0a0a0c'
  fill: 'rgba(118, 118, 128, 0.22)'
  fill-strong: 'rgba(118, 118, 128, 0.32)'
  separator: 'rgba(84, 84, 88, 0.42)'
  text: '#f5f5f7'
  text-2: 'rgba(235, 235, 245, 0.74)'
  text-3: 'rgba(235, 235, 245, 0.55)'
  primary: 'linear-gradient(180deg, #1a3d6b, #0d2341)'
  primary-rim: 'linear-gradient(100deg, #96c4f5, #559ade 45%, #96c4f5)'
  on-primary: '#ffffff'
  accent: '#4f93e3'
  accent-text: '#79b3f2'
  focus: '#79b3f2'
  horizon: '#559ade'
  ok: '#30d158'
  warn: '#ffb340'
  bad: '#ff5f57'
typography:
  large-title:
    fontFamily: 'Instrument Serif'
    fontSize: '40px'
    fontWeight: 400
    letterSpacing: '-0.012em'
    lineHeight: 1.05
  figure:
    fontFamily: 'Instrument Serif'
    fontSize: '40px'
    fontWeight: 400
    letterSpacing: '-0.01em'
  section-title: { fontFamily: 'Geist Variable', fontSize: '19px', fontWeight: 650 }
  body: { fontFamily: 'Geist Variable', fontSize: '15px', fontWeight: 400, lineHeight: 1.47 }
  control: { fontFamily: 'Geist Variable', fontSize: '14px', fontWeight: 600 }
  label: { fontFamily: 'Geist Variable', fontSize: '13px', fontWeight: 600 }
  mono: { fontFamily: 'Geist Mono Variable', fontSize: '12px' }
radius:
  sm: '8px'
  field: '10px'
  md: '12px'
  menu: '14px'
  lg: '16px'
  sheet: '26px'
  pill: '999px'
spacing: { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '20px', 2xl: '32px', 3xl: '40px' }
shadows:
  - {
      name: 'pop',
      value: '0 24px 64px rgba(0,0,0,0.6), 0 2px 10px rgba(0,0,0,0.4)',
      purpose: 'Floating layers only: sheets, dialogs, menus, toasts, chart tooltips',
    }
  - {
      name: 'glass-light',
      value: 'inset 0 1px 0 rgba(255,255,255,0.24)',
      purpose: 'Specular top edge of glass layers',
    }
motion:
  - { name: 'ease', value: 'cubic-bezier(0.2, 0.8, 0.2, 1)', purpose: 'Every transition; ease-out' }
  - { name: 'micro', value: '0.1–0.15s', purpose: 'Hover, press, colour changes' }
  - { name: 'layer', value: '0.2–0.28s', purpose: 'Menus, dialogs, sheets entering' }
breakpoints:
  - { name: 'sm', value: '900px', purpose: 'Sidebar becomes a drawer; tables drop hide-sm columns' }
icons:
  set: 'ARC stroke set (inline SVG, 16px grid)'
  source: 'packages/ui/src/index.tsx'
  sizes: { sm: '14px', md: '16px' }
  style: { variant: 'outline', strokeWidth: 1.5 }
  color: 'currentColor'
components:
  button-primary:
    source: 'packages/ui/src/styles.css'
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    radius: '{radius.pill}'
    height: '34px'
    states: [hover, active, focus-visible, disabled]
  button:
    source: 'packages/ui/src/styles.css'
    backgroundColor: '{colors.fill}'
    textColor: '{colors.text}'
    radius: '{radius.pill}'
  panel:
    source: 'packages/ui/src/styles.css'
    backgroundColor: '{colors.surface}'
    radius: '{radius.lg}'
  input:
    source: 'packages/ui/src/styles.css'
    backgroundColor: '{colors.fill}'
    radius: '{radius.field}'
    height: '38px'
    states: [focus, disabled]
  sheet:
    source: 'packages/ui/src/index.tsx'
    radius: '{radius.sheet}'
    material: glass
    states: [open, focus-trapped]
  switch:
    source: 'packages/ui/src/index.tsx'
    on: "horizon art: Earth's limb glowing under stars ({colors.horizon})"
    off: 'dark space with faint stars, 1px edge'
    states: [on, off, disabled-with-reason]
  traffic-chart:
    source: 'packages/ui/src/index.tsx'
    series: '{colors.horizon}'
    errors: '{colors.bad} (own strip and scale)'
---

# Design System: ARC

## Overview

**Creative North Star: "Mission control at night."**

ARC sits between a person's apps and the AI providers, so its screens are instruments, not
marketing. Black space behind everything; opaque, borderless grouped panels in front, the way
Apple's grouped lists sit on their background; one luminous colour, the horizon blue from the
icon, where Earth's limb catches the sunrise. The art is original (rendered by
`scripts/art/render_space.py`), and the ARC wordmark is traced from the icon, letter for letter.

It must never look like a generic AI dashboard: no purple gradients, no neon glows, no
gradient text, no flat blue SaaS buttons, no emoji, no "✨", no glass cards stacked on glass. It must
also never look like a game or a sci-fi HUD: the space is a backdrop, never decoration on
controls.

**Key characteristics:**

- Space backdrop on every page: stars and the Milky Way, fixed, faded towards the bottom.
- Opaque grouped panels with inset hairline separators; glass only for what floats.
- Instrument Serif large titles and figures (high-contrast, editorial); Geist for reading text and
  controls; Geist Mono only for keys, IDs and timestamps.
- Horizon primary actions: deep orbit blue with a luminous rim; blue also for links, selection
  and data.
- Status in words with a dot, never colour alone.

## Colors

A near-monochrome system on true black: greys carry structure, one blue carries attention.

### Surfaces

- **Space** (`#000`): the page and the backdrop art.
- **Panel** (`#121315`): grouped panels and tables. **Raised** (`#1c1d20`) and **High**
  (`#26272b`) for nested surfaces and tooltips.
- **Fill** (`rgba(118,118,128,.22)`): secondary buttons, inputs, badges.

### Text

- **Label** (`#f5f5f7`), **Secondary** (74%), **Tertiary** (55%, the floor: ≥ 4.5:1 on every
  surface).

### Accent

- **Horizon Blue** (`#559ade` data, `#4f93e3` selection, `#79b3f2` links and the focus ring).

### Status

- **Go** (`#30d158`), **Caution** (`#ffb340`), **Fault** (`#ff5f57`), each with a 16% tint for
  badge backgrounds. Reserved for state; never a chart series colour.

**The Floor Rule.** No text below `--text-3`; nothing quieter than 4.5:1.

**The One Light Rule.** Blue is the only chromatic colour outside status. Never a second accent.

**The One Horizon Rule.** A screen has at most one primary (horizon) button per area.

## Typography

**Display:** Instrument Serif (regular and italic) · **Text and controls:** Geist Variable ·
**Mono:** Geist Mono Variable. All self-hosted, SIL OFL.

**Character:** a rare, high-contrast serif at the top, like a premium editorial cover over the
space scene; precise and technical in the controls. The display serif has one weight: never bold
it (`font-synthesis: none`); its italic is the one accent.

### Hierarchy

- **Large title** (Instrument Serif 400, 40px): one per page; the sign-in title too.
- **Figure** (Instrument Serif 400, 40px): stat tiles. In tables, figures stay in Geist (tabular).
- **Section title** (Geist 650, 19px).
- **Body** (400, 15px/1.47): reading text, table cells; tabular numerals for figures.
- **Control / label** (Geist 600, 13–14px): buttons, column heads, field labels; sentence
  case, never all caps.
- **Mono** (Geist Mono 12px): key hints, slugs, IDs, timestamps. Never for
  figures.

## Elevation

Tonal in the page, glass in the air. Panels are flat and opaque; depth comes from tone
(panel on black). Only floating layers (sheets, dialogs, menus, toasts, the bulk bar, the
mobile bar) get the glass material and the `pop` shadow. `prefers-reduced-transparency` makes
them opaque.

**The Flat Page Rule.** Nothing in the page flow has a shadow or a border.

## Motion

Ease-out everywhere (`cubic-bezier(.2,.8,.2,1)`), 100–150 ms for feedback, 200–280 ms for layers;
transform and opacity only. `prefers-reduced-motion` turns all of it off.

## Responsive / Layout

Sidebar (248px) + content (max 1200px, 44/52px padding). Below 900px the sidebar becomes a
drawer behind a glass bar, padding drops to 16px, tables drop `hide-sm` columns (details stay in
the sheet), stat grids go to two columns. Touch (`pointer: coarse`) gets 44px hit areas.

## Components

The implementation in `packages/ui` is the source of truth.

- **Buttons:** pills. Primary in horizon blue with a luminous rim and soft glow; secondary on fill; ghost in link blue; danger as
  red text. Press scales to 0.97.
- **Panels and tables:** 16px corners, no borders, hairline separators inset from the left.
  A row's name is a real link or button; clicking anywhere in the row is a mouse shortcut.
- **Inputs:** filled, 10px corners, focus shows the 2px blue ring.
- **Sheets and dialogs:** glass, 26px corners; focus moves in, stays in, and returns to the
  opener; labelled by their title.
- **Menus:** menu-button pattern (↑/↓/Home/End, Escape returns focus).
- **Switch:** on shows the icon's sunrise (Earth's limb glowing under stars), off is dark space;
  the off track has an edge; disabled switches say why. Never iOS green.
- **Traffic chart:** one series per plot; errors on their own strip and scale; crosshair with
  a tooltip; a text summary for screen readers.

## Icons

**Set:** ARC's own 16px outline set, stroke 1.5, defined once in `packages/ui/src/index.tsx`.
**Color:** `currentColor`.

- Close → `close`, more actions → `more`, add → `plus`, copy → `copy`, go → `arrow`.

**The One Set Rule.** No icon libraries, no emoji as icons.

## Do's and Don'ts

### Do:

- **Do** use the space backdrop on every authenticated page, faded towards the bottom.
- **Do** write status as a word with a dot ("Healthy", "Rejected").
- **Do** format percentages without a space (`0.19%`) and units with one (`1.6 ms`).
- **Do** give every action a verb label ("Add key", "Create app", "Revoke").

### Don't:

- **Don't** use flat bright-blue SaaS buttons, purple, gradients on text, or neon glows (the
  horizon button's soft rim glow is the one exception).
- **Don't** put space art behind text inside a panel; panels are opaque.
- **Don't** put two series with different scales on one axis.
- **Don't** use Geist Mono for numbers in tables or tiles, or bold the display serif.
- **Don't** show secrets after creation; show the hint (`****d87d`) only.

## Known Deviations

- **Inline styles** (rule: component classes, tokens and the spacing utilities in
  `packages/ui/src/styles.css` / actual: ~40 `style={{…}}` left, nearly all dynamic values
  such as bar widths and chart positions / status: acceptable where the value is computed).
- **Hard-coded greys outside `:root`** (rule: colour tokens / actual: `#5e5f66` segmented thumb,
  `#1c1d20` glass fallback, `#e8ecf2` sign-in hover / where: `packages/ui/src/styles.css` /
  count: 6 / status: to fix).
