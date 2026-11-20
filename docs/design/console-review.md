# Owner console — design review (Phase 6, increment 1 → 1.1)

Reviewed on the running console (real API, demo seed) at 1440×900 and 390×844, with every screen
screenshotted, an axe-core scan of each route, token contrast computed, and keyboard/ARIA read
from the code. Skills: creative direction (refresh), design-review (visual, UX heuristics, a11y,
motion), design critique, accessibility review (WCAG 2.1 AA), dataviz, UX copy, design system.

**Design read:** operations console · one technical owner · calm, precise, "mission control at
night" · Apple grouped surfaces over a space backdrop.

## Direction (refresh, depth: evolution)

Theme statement: **quiet, orbital precision**. Black space, opaque grouped panels, one luminous
accent (the horizon blue from the icon), white primary actions. Nothing glows except the horizon.

| Trait                                                                      | Verdict | Why                                                                                                                                     |
| -------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Space art (original render), sign-in over Earth's limb                     | Keep    | Distinctive and owned, not stock                                                                                                        |
| Mona Sans wide titles, Hubot Sans controls, Martian Mono keys              | Keep    | Recognisable type voice; no default-AI fonts                                                                                            |
| Wordmark traced from the icon                                              | Keep    | Matches the icon letter for letter                                                                                                      |
| Borderless grouped panels, inset separators, glass only on floating layers | Keep    | Correct depth grammar for dark mode                                                                                                     |
| Space only behind the Overview header (barely visible)                     | Evolve  | The theme vanished on every other page: a fixed, faded star field now sits behind all pages                                             |
| Icon + wordmark side by side in the sidebar                                | Retire  | The 28 px icon repeats "ARC" illegibly next to the wordmark; replaced by the wordmark over a faint horizon glow                         |
| Blue filled primary buttons                                                | Retire  | White on `#4f93e3` is 3.2:1 (fails AA), and blue pills are the generic SaaS tell; primary is now the white pill already used on sign-in |
| Martian Mono for every number                                              | Evolve  | Reads as a terminal in tables; figures now use Mona Sans tabular numerals, mono stays for keys, IDs and timestamps                      |
| `0.19 %` (space before %)                                                  | Retire  | Not English/Apple convention; `0.19%`                                                                                                   |
| Errors drawn on the requests axis                                          | Retire  | Dual-scale anti-pattern: errors sat flat on the baseline. Errors get their own strip                                                    |

## What works

- Status is never colour-alone: every dot carries a text label ("Healthy", "Resting", "Rejected").
- Overview leads with "Needs you": an action list with verbs ("Review", "Classify", "Rotate"),
  the right first thing for an owner (H1, H6).
- `prefers-reduced-motion` is honoured globally; motion is short, ease-out, transform/opacity only.
- Destructive actions go through a confirm dialog; toasts are a polite live region.
- Secrets are shown once with copy, and only hints (`****d87d`) afterwards.

## Findings

Severity: P0 blocker · P1 major · P2 minor · P3 cosmetic. All fixed in this increment unless noted.

| #   | Sev | Area             | Finding                                                                                                       | Fix                                                                         |
| --- | --- | ---------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | P0  | 1.4.3 contrast   | `--text-3` (labels, hints, nav groups, table heads, placeholders) is 2.6–2.8:1; axe flags 8–65 nodes per page | `--text-3` → 0.55 alpha (5.2–5.5:1)                                         |
| 2   | P0  | 1.4.3 contrast   | Primary button: white on `#4f93e3` 3.2:1                                                                      | White pill, black label (19:1)                                              |
| 3   | P0  | 2.1.1 keyboard   | App, model and key rows open only on mouse click (`tr onClick`)                                               | The name cell is a real link/button; the row click remains a mouse shortcut |
| 4   | P1  | 2.4.3 / 2.1.2    | Sheets and dialogs don't trap focus or return it on close; no accessible name                                 | Focus trap, return focus to the opener, `aria-labelledby` the title         |
| 5   | P1  | 4.1.2 / keyboard | Action menu: no Escape, no arrow keys, focus not moved into the menu                                          | Menu pattern: focus first item, ↑/↓/Home/End, Escape returns to the button  |
| 6   | P1  | 1.4.11 non-text  | Focus ring (blue at 55%) is 2.6:1 on black                                                                    | Solid `#79b3f2` 2px ring, 2px offset (8.4:1)                                |
| 7   | P1  | Visual           | Switches in fixed tables render a stray "…" (ellipsis overflow)                                               | Action cells don't clip                                                     |
| 8   | P1  | Data viz         | Errors share the requests axis and read as a flat line                                                        | Separate errors strip with its own scale; summary in the chart's label      |
| 9   | P2  | 1.4.11           | Off switch track 1.5:1 against the panel                                                                      | Inset edge on the track                                                     |
| 10  | P2  | 1.3.1            | Empty `<th>` for action columns (axe)                                                                         | Visually hidden "Actions"/"On" headers                                      |
| 11  | P2  | 2.4.1            | No skip link; sign-in has no `main` landmark                                                                  | Skip link to `main`; sign-in wrapped in `main`                              |
| 12  | P2  | 2.5.5            | Icon buttons 30 px, switch 26 px, nav rows 34 px on touch                                                     | 44 px hit areas under `pointer: coarse`                                     |
| 13  | P2  | Consistency      | Failing-keys count is amber in the nav, red on Overview                                                       | Red in both                                                                 |
| 14  | P2  | Mobile           | Providers table clips the share column at 390 px                                                              | Key and share columns hidden on small screens; the sheet shows them         |
| 15  | P2  | Disabled switch  | Unknown models show a dimmed switch with no reason                                                            | Tooltip and accessible description: "Classify first"                        |
| 16  | P3  | Brand            | Sidebar repeats ARC twice                                                                                     | Wordmark only, faint horizon glow behind it                                 |
| 17  | P3  | Glass            | No `prefers-reduced-transparency` fallback                                                                    | Opaque floating layers when requested                                       |
| 18  | P3  | Space            | Backdrop present only on Overview                                                                             | Fixed, faded star field on all pages                                        |

Not changed: sign-in keeps visually hidden labels (placeholders read as labels, and the fields
have real `<label>`s); Martian Mono stays for keys and timestamps.

## Copy (UX copy pass)

Labels are already sentence case, verb-first, and specific ("Add key", "Explain route",
"Classify →"). Changes: percentages without the space; empty table headers named; the
disabled switch explains itself. No marketing filler, no emoji, no placeholder names.

## Verification

- axe-core (wcag2a, wcag2aa, best-practice) on every route: no violations after the fixes (before:
  serious contrast failures on all ten routes, empty table headers on four).
- Keyboard walk-through: skip link first; Enter on an app's name opens it; the action menu opens
  on Enter, moves with arrows, Escape returns to its button; a sheet keeps focus inside and
  returns it to the row on close.
- Screens re-shot at desktop and mobile and compared with the "before" set.
