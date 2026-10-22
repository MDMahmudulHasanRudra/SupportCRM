# UI/UX Design System — Indigo Workspace

## Direction

A calm, organized support workspace: a deep navy navigation rail, clean neutral content surfaces, indigo primary actions, generous hierarchy and purposeful status colors. Use the same system on the overview, inbox, accounts, billing, teams, customers, knowledge, automation, reports, settings and authentication screens. Avoid decorative metrics or interactions without behavior.

## Palette contract

The authoritative values live in `apps/web/src/theme.css`. Screens consume CSS variables rather than selecting their own primary colors.

| Token / role | Light | Dark |
|---|---|---|
| Background | `#F5F7FB` | `#0C1322` |
| Primary surface | `#FFFFFF` | `#141E30` |
| Secondary surface | `#F8FAFD` | `#1B2940` |
| Body text | `#17233B` | `#EDF2FC` |
| Muted text | `#5E6D85` | `#A6B5CB` |
| Border | `#E5EAF3` | `#2A3850` |
| Brand / action | `#4F46E5` | `#A5ADFF` |
| Primary fill | `#4F46E5` | `#5B5EEA` |
| Navigation background | `#111B2E` | `#101929` |
| Success | `#047857` | `#55D4A1` |
| Warning | `#9A570A` | `#F3BE66` |
| Danger | `#C42A46` | `#FC8FA5` |

Indigo expresses selection and action. Green expresses connected/success; amber waiting/attention; red errors/danger. Status text accompanies color. A WhatsApp icon may use the success token; it does not create a second application theme. The stored theme choice wins; otherwise system preference applies.

## Type, spacing and shape

System font stack with Segoe UI and Bengali-capable fallbacks; no remote font dependency. Body 14px/1.6; secondary copy 12–13px; labels 12px/600; page titles 28px with compact tracking; panel headings 14px/650; KPI figures 30–34px with tabular numbers. Avoid all-caps paragraphs; small navigation/category labels may use tracking.

Spacing follows 4/8/12/16/20/24/32/40px. Desktop content padding 32px; tablet 24px; phone 16px. Cards use 16px radius and 22–24px padding; controls 10px radius; dialogs 20px radius. Shadows are subtle and borders carry structure. Interactive elements have visible hover, focus and disabled states.

## Component rules

- Shell: navy sidebar with clear groups and active state; translucent neutral topbar with section/page context, page finder, theme, notifications and user menu.
- Headings: eyebrow or section context, title and concise description; primary action is obvious and secondary actions remain quieter.
- Overview: greeting/work summary, four operational KPIs, trend/recent conversations, then channel and team activity. Metrics are real; unavailable data is not zero.
- Tables: subtle header surface, comfortable row padding, clear numeric alignment, local overflow, distinguishable row actions. Preserve long content without breaking the page.
- Forms: visible labels, consistent control heights, field spacing and meaningful hints. Checkboxes/radios keep native dimensions. Primary buttons use the fill token and sufficient text contrast.
- Dialogs: constrained viewport dimensions, clear heading/footer, keyboard escape, focus containment and restored focus when possible.
- Inbox: stable list/thread/context hierarchy, readable bubbles, local scroll and clear compose/reply states.
- Account pairing: prominent connection action; numbered progress steps; QR on an opaque white field with a quiet border; clear expiry and real connection state.
- Empty/loading/error states: purposeful icon treatment, specific text and a working recovery/next action where appropriate.
- Login: coherent brand introduction and focused form, with a compact layout on small screens.

## Accessibility and responsive acceptance

Target WCAG AA for normal text contrast; check final rendered combinations before claiming conformance. All interactive controls need accessible names, keyboard focus and meaningful enabled/disabled states. Reduced motion disables entrance/transformation effects. The mobile drawer uses a focusable modal surface and closes on navigation, backdrop or Escape.

`pnpm design:check` verifies 20 core text/background pairs against a minimum of 4.5:1. It caught and corrected the initial dark primary fill and light secondary text combinations. It does not inspect composited colors, browser rendering, every status badge or all accessibility criteria.

Review at 375, 768, 1280 and 1440px in both themes: main content must not overflow horizontally; wide tables may scroll within their wrapper. No essential operation is hidden solely for mobile. Validation evidence and unavailable review surfaces are recorded in the phase plan.
