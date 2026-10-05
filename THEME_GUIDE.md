# Universal Theme Guide

A portable look-and-feel standard for any web app or tool, whatever it does. Drop this file into a project and follow it so every page, panel and dialog looks and behaves the same. It defines appearance and interaction only; names in examples (Owner, Delete, Start) are illustrations, not required features.

---

## 1. Core principles

- **Fully offline.** No CDNs, no Google Fonts, no npm, no external packages, no network calls at runtime. Every font, icon, script and stylesheet is vendored in the repo.
- **One stylesheet.** All pages link one shared theme file (e.g. `css/theme.css`). Pages add only layout-specific rules.
- **Dark first.** Dark is the default. A light palette is optional and only via `prefers-color-scheme`.
- **Flat and quiet.** Flat panels, 1px border lines, no gradients, shadows only on floating things (dialogs, notifications, toasts).
- **Show only what applies.** Hide buttons that can't be used right now instead of cluttering; grey out only "not built yet" features.
- **Relative paths only** for every asset (`../assets/fonts/...`), so the folder can move anywhere.

---

## 2. Fonts (local only)

| Role | Font | Weights | Fallback |
|---|---|---|---|
| UI (everything) | **Exo 2** | 400 regular, 600 semibold | `system-ui, sans-serif` |
| Monospace (logs, code, IDs, numbers in tables) | **Syne Mono** | 400 | `ui-monospace, Consolas, monospace` |

Files live in `assets/fonts/`:
```
assets/fonts/exo2-400.ttf
assets/fonts/exo2-600.ttf
assets/fonts/SyneMono-Regular.ttf
```

```css
@font-face { font-family: 'Exo 2'; font-weight: 400; src: url(../assets/fonts/exo2-400.ttf) format('truetype'); }
@font-face { font-family: 'Exo 2'; font-weight: 600; src: url(../assets/fonts/exo2-600.ttf) format('truetype'); }
@font-face { font-family: 'Syne Mono'; src: url(../assets/fonts/SyneMono-Regular.ttf) format('truetype'); }
```

Rules:
- Only two weights: 400 and 600. Never use 700/bold; "bold" means 600.
- Base size: **14px**. Body text is never bold. List items and option rows are never bold (only the selected/open item may be 600 when it is a header row).

### Type scale

| Use | Size | Weight | Extra |
|---|---|---|---|
| Page title `h1` | 20px | 600 | — |
| Section heading `h2` | 13px | 600 | UPPERCASE, `letter-spacing: .08em`, color `--text-2` |
| Sub heading `h3` | 13px | 600 | — |
| Dialog title | 16px | 600 | — |
| Body / inputs | 14px / 13px | 400 | — |
| Stat value | 18px | 600 | ellipsis on overflow |
| Stat label, sub line, hints | 12px | 400 | color `--muted` |
| KPI number | 28px | 600 | — |
| Badges | 11px | 600 | UPPERCASE, 20px tall |
| Mono text | 12.5–13px | 400 | Syne Mono |

---

## 3. Color tokens

Define on `:root`; never hard-code colors in components except the ones listed as fixed.

### Dark (default)
```css
:root {
  color-scheme: dark;
  --bg: #1a1a19;       /* page background, input background */
  --panel: #242422;    /* panels, table headers, hover rows */
  --panel-2: #2c2c2a;  /* open/expanded rows, toasts */
  --border: #3a3936;   /* all 1px lines */
  --sel: #44433f;      /* selected row, secondary button, disabled bg */
  --text: #ffffff;     /* primary text */
  --text-2: #c3c2b7;   /* secondary text, headings, labels */
  --muted: #8d8b82;    /* hints, stat labels, disabled text */
  --blue: #3987e5;  --blue-h: #5a9cec;   /* primary action + hover */
  --ok: #4cc27f;       /* success / go / start */
  --warn: #d9b343;     /* warning text */
  --orange: #d9822b;   /* warning notifications, 4xx highlights */
  --err: #e24c4c;      /* destructive / error / stop */
  --pink: #f27ab8;     /* system messages */
  --lerr: #ff9090;     /* error text in logs (light red) */
  --time: #aeaca4;     /* timestamps */
  --radius: 4px;
  --mono: 'Syne Mono', ui-monospace, Consolas, monospace;
}
```

### Light (optional, via `@media (prefers-color-scheme: light)`)
```
--bg #fcfcfb  --panel #f4f4f2  --border #dddcd6  --sel #dcdbd5
--text #0b0b0b  --text-2 #52514e  --muted #85837c
--blue #2a78d6  --blue-h #1f66bd  --ok #0a7a3d  --warn #a8850f  --err #c42b2b
--pink #d63a8a  --lerr #e06060  --time #a3a19a
```

### Chart series palette (in order)
`#3987e5` blue · `#d95926` orange · `#199e70` green · `#c9a227` gold · `#9b6bd6` purple · `#d6529a` pink · `#5fb0c9` teal · `#8d8b82` grey

### Badges
Every badge, everywhere, follows one rule. "A yellow badge" means:
- **Border:** 1px solid yellow.
- **Text:** yellow, **bold (600)**, **UPPERCASE**, centered vertically and horizontally.
- **Background:** the same yellow, **50% darker** (`color-mix(in srgb, <color> 50%, #000)`).
- **Size:** exactly **20px tall**, 11px text, `padding: 0 8px 2px` (text sits 2px high), **3px radius**.

```css
.badge {
  --bc: var(--muted);
  display: inline-flex; align-items: center; justify-content: center;
  height: 20px; padding: 0 8px 2px; border: 1px solid var(--bc); border-radius: 3px; /* bottom 2px lifts the text */
  background: color-mix(in srgb, var(--bc) 50%, #000); color: var(--bc);
  font-size: 11px; font-weight: 600; line-height: 1; text-transform: uppercase; white-space: nowrap;
}
.badge.yellow { --bc: #e8c547; }  /* one line per colour */
```

| Class | Color | Typical meaning |
|---|---|---|
| `white` | `#ffffff` | new, not started |
| `pink` | `#f27ab8` | early stage, system |
| `gold` | `#d4a72c` | in progress |
| `blue` | `#5a9cec` | review, info |
| `green` | `#4cc27f` | done, live, ok, safe |
| `purple` | `#b38ae6` | special / restricted category |
| `yellow` | `#e8c547` | caution |
| `orange` | `#f08a3c` | warning |
| `red` | `#ff5c5c` | error, critical |
| `light-blue` | `#7cc4f5` | other |
| `lime` | `#a6cf3f` | other |
| `grey` | `#8d8b82` | inactive (default) |

A stage sequence (e.g. new → planning → building → review → done) uses white → pink → gold → blue → green. Each project maps its own values to these classes; keep one value = one color everywhere.

### Color meaning (always consistent)
| Color | Means |
|---|---|
| Blue | Normal action, links, focus ring, logo, selection accent |
| Green | Primary "go" action (Start, Run, Save-and-continue), success |
| Red | Destructive (Delete, Stop, Remove), errors |
| Orange | Warnings, client errors (4xx) |
| Pink | System messages (app-generated info) |
| Grey (`--sel`) | Cancel, close, secondary, disabled |

---

## 4. Layout

- `* { box-sizing: border-box; }`, `html, body { height: 100%; margin: 0; }`.
- **Header bar:** `padding: 16px 20px`, bottom border 1px `--border`. Left: logo + title + 12px muted sub line.
- **Logo:** 40×40, `border-radius: 8px`, `--blue` background, white 16px 600 initials (2 letters).
- **Sidebar + main:** grid `365px 1fr`. Sidebar padding `20px 25px 20px 20px`, right border 1px, sections stacked with **40px gap**.
- **Main content:** `padding: 20px`, scrolls internally (`overflow: auto`), page itself never scrolls horizontally.
- **Section spacing:** 40px between major groups (e.g. last action button → next field group). 5px between buttons in a group. 12px under form fields. 10px under `h2`.
- **Panels / boxes:** `--panel` bg, 1px border, `border-radius: 8px`, `padding: 14px 16px`. Inside the sidebar, panels are borderless and transparent.
- **Stats:** small muted label (12px) above a big value (18px 600), 2-column grid, 10px gap.
- **Corner radii:** 3px badges · 4px controls · 6px tables/notifications/toasts · 8px panels/dialogs/logo.
- **App windows (optional):** tools that open sub-pages as separate windows center them at a fixed size (e.g. 1400×1000).

---

## 5. Buttons

```css
button {
  height: 25px; line-height: 1; padding: 0 14px 2px; border: 0; border-radius: 4px;
  background: var(--blue); color: #fff; font: inherit; font-weight: 600; cursor: pointer;
  text-transform: capitalize;
}
button:hover { background: var(--blue-h); }
button.go     { background: var(--ok); }    /* main action */
button.danger { background: var(--err); }   /* destructive */
button.go:hover, button.danger:hover { filter: brightness(1.1); }
button.ghost, .cancel { background: var(--sel); color: var(--text); } /* cancel/secondary */
button.ghost:hover   { background: var(--border); }
button.small { height: 21px; padding: 0 8px; font-size: 12px; }
button:disabled { background: var(--sel); color: var(--muted); cursor: not-allowed; filter: none; }
button[hidden] { display: none; }
```

Rules:
- **Button labels are Title Case:** every word starts with a capital ("Add Item", "Clear Log", "Save Changes"). Enforced globally with `text-transform: capitalize`, so it applies even if the HTML is written in lowercase.
- **Buttons side by side are always 5px apart** (the gap of the row/group holding them). Buttons have no margin.
- **Always 25px tall, solid fill, 4px corners, white 600 text.** No outline buttons, no icons-only buttons except the notification ✕.
- **Blue** = every normal action. **Green** = the one main "go" action. **Red** = destructive. **Grey** = Cancel/Close.
- A **toggle** button changes both label and color with state (e.g. green "Start" ↔ red "Stop") and spans the full width of its group.
- **Visibility over disabling:** a button that doesn't apply right now is **hidden**, not greyed (e.g. "Clear log" only when there is something to clear, "Apply" only when something changed, "Open" only when running). Greyed-out is reserved for features that are not built yet.
- **Button groups** are 2-column grids with 5px gap. Visible buttons are **sorted alphabetically** and re-stack when one hides. The main toggle stays first and is not sorted.
- Group spacing stays fixed (40px to the next section) no matter how many buttons show; an empty group collapses fully.

---

## 6. Inputs

```css
input, select, textarea {
  height: 25px; padding: 0 8px; font: inherit; font-size: 13px;
  color: var(--text); background: var(--bg);
  border: 1px solid var(--border); border-radius: 4px;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--blue); outline-offset: -1px; }
textarea { font-family: var(--mono); min-height: 80px; padding: 6px 8px; resize: vertical; }
input[type=checkbox] { accent-color: var(--blue); }
```

- Labels sit **above** the field: `--text-2`, 4px gap, field full width, 12px below.
- Single-letter fields (e.g. middle initial) are narrow (44px), centered, auto-uppercase, `maxlength=1`.
- Drop-downs use the same 25px height and border as inputs.

### Searchable picker (single choice, e.g. an owner or a category)
- Use instead of a plain `<select>` when the list can be long. Looks like an input (`--bg`, 1px border, 4px radius, 400 weight) showing the chosen item, muted placeholder ("Select …") and a muted ▾ on the right.
- Click opens a floating menu directly below: `--panel` bg, 1px border, **6px radius**, shadow `0 6px 20px #0008`, 6px padding.
- Menu = **search box on top** (focused on open), then the list.
- List shows **exactly 10 rows** (26px each, 260px max), always-visible vertical scrollbar, mouse-wheel scrolling that doesn't scroll the page behind it (`overscroll-behavior: contain`).
- Items sorted **alphabetically**; long items end in "…". Hover `--panel-2`, current choice `--sel`.
- Enter picks the first match, Esc or a click outside closes. Empty states are muted ("No match", "Nothing to choose yet").
- Shared lists (people, categories) live in one JSON file that every page reads; the saved value is the displayed text.

### Multi picker (several choices, e.g. team members or tags)
- A blue **"Add"** button stays directly under the label and opens the same searchable menu (already-picked items are hidden from it).
- Picked items show **below the button**, one per line, **alphabetical**, **5px apart**, as badges: `--sel` bg, 4px radius, 25px tall, with a muted ✕ on the right that turns red on hover to remove.
- Nothing shows under the button when the list is empty. Saved as an array of displayed texts.
- Hints under fields: 12px `--muted`.

---

## 7. Lists and tables

### Selectable list (single choice)
- Container: `--bg` background, 1px border, 4px radius, scrolls internally (max-height ~320px).
- Rows: `padding: 5px 8px`, 1px divider between rows, **not bold**.
- Hover: `--panel`. Selected: `--sel`. Optional right-side detail in `<small>` at 70% opacity.

### Data tables
- Wrapper: 1px border, 6px radius, scrolls internally.
- `th`: `--panel` bg, `--text-2`, 600, **sticky** header. Sortable headers show pointer and brighten on hover.
- `td`: `padding: 6px 10px`, bottom border 1px, no wrapping; numbers right-aligned.
- Data cells use Syne Mono 12px; nulls are muted italic.
- Clickable rows: pointer, hover `--panel-2`.

### Expanding rows (standard pattern)
1. Click a row → it expands; its header row gets `--sel` bg and 600 weight. Click again to collapse. Only one row open at a time.
2. The expanded area shows a **button bar** with:
   - **Edit and other actions on the LEFT, in blue.**
   - **Delete on the far RIGHT, in red** (`justify-content: space-between`).
3. **Edit** expands further into inline fields (same grid as the "add" row) plus a **blue confirm button** (e.g. "Assign" / "Save") at the end of the row.
4. Delete asks for confirmation before acting.
5. Empty list shows one muted row: "No items yet."

---

## 8. Dialogs

- **Overlay:** fixed, full screen, `#0009` backdrop, content centered (`display: grid; place-items: center`).
- **Box:** `--panel` bg, 1px border, **8px radius**, `padding: 20px 24px`, shadow `0 12px 40px #0009`.
- **Sizing:** dynamic — `width: min(<ideal>px, calc(100vw - 40px))`, `max-height: calc(100vh - 40px)`; inner list scrolls, the dialog never overflows the window. Like a browser's own picker dialog.
- **Title:** 16px 600, 14px below.
- **Footer:** buttons right-aligned, 5px gap; or a single full-width grey **Close/Cancel** at the bottom.
- **Add row** at the top of list dialogs: a one-line grid of inputs + a blue Add button at the end.
- Esc and clicking the backdrop close the dialog.

---

## 9. Notifications

**Drop-down notifications** (primary feedback):
- Position: top center of the content/log area, `width: min(520px, 90%)`, stacked with 6px gap, newest on top.
- Look: solid color fill, white 600 text, `padding: 10px 34px 10px 14px`, **6px radius on all 4 corners**, shadow `0 4px 14px #0006`.
- Animation: drop in from above, 0.25s ease-out.
- White **✕** in the top-right corner (18px, no background) dismisses it.
- Auto-dismiss after **5 seconds**.
- Colors: green = success · orange `#d9822b` = warning · red = error · pink = system message.
- **When to notify:** system messages and errors (say what failed and a plain cause, e.g. "Save failed: file is read-only."). Confirm user actions with a short sentence ("Log cleared.", "Settings saved."). **Do not** notify routine events.
- History loaded on page open never triggers notifications; only live events do.

**Toasts** (optional, for secondary pages): bottom-right, `--panel-2` bg, 4px colored left border (blue / green / red), 6px radius.

---

## 10. Log / console views

- Font: Syne Mono 13–14px, `line-height: 1.6`.
- Fixed-width grid columns (time first, message last as `minmax(0,1fr)`), 10px gap, muted header row above. Example for a request log: `20ch time | 70px | 50px | 90px | 60px | 1fr`.
- **Never a horizontal scrollbar**: `overflow-x: hidden`, spans use `min-width: 0; overflow-wrap: anywhere` so long lines wrap.
- Colors: timestamp `--time` · keywords/actions `--blue` · success `--ok` · warnings `--warn` · errors `--lerr` · system `--pink` · notes `--text-2`.
- Highlighted full rows (white text, 4px radius, `margin: 0 -6px; padding: 0 6px`) for key events: start/success = green, stop/failure = red, warning = orange `#d9822b`.
- Timestamps: `YYYY-MM-DD HH:MM:SS`.
- A "Clear Log" button appears only when the log has entries.

---

## 11. Scrollbars

- Thin: 10px, transparent track, thumb `#3a3936` (hover `#55534e`), 5px radius, 2px inset.
- **Hidden until needed:** thumb is transparent unless the mouse is within **15px** of the scrollbar; a small mousemove handler toggles a `.sb-near` class on the scroll container.

```css
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: transparent; border-radius: 5px; border: 2px solid transparent; background-clip: padding-box; }
.sb-near::-webkit-scrollbar-thumb { background: #3a3936; background-clip: padding-box; }
.sb-near::-webkit-scrollbar-thumb:hover { background: #55534e; background-clip: padding-box; }
```

---

## 12. Charts

- Pure inline SVG, no chart libraries.
- Axis/label text: 11px Exo 2, `--text-2`. Gridlines: 1px `--border`.
- Bars: horizontal, 3px radius, label left / value right. Lines: 2px stroke with dot markers.
- Series colors follow the palette in section 3.
- Tooltip: inverted (`--text` bg, `--bg` text), 4px radius, 12px, follows the cursor.
- Large numbers abbreviate in charts (`1.25M`); KPIs show the exact value.
- Live graphs (e.g. a meter over time): line chart on `<canvas>` or SVG, newest on the right, fixed time window, dashed red line for a limit, labels only where they fit.

---

## 13. Naming and text conventions

- Buttons: short Title Case verbs ("Open Module", "Clear Log"). Notifications: sentence case ending with a period.
- Section headings are nouns in UPPERCASE via CSS (write them normally in HTML).
- On/off status words in caps: ONLINE / RUNNING (green), OFFLINE / STOPPED (red).
- People (when a project lists them): `Last, First M.`, middle initial with a period, an optional role/type suffix in caps. Keep the list in one shared JSON file.
- Empty values show `-`, never blank.

---

## 14. Checklist for a new project

- [ ] Copy `assets/fonts/` (Exo 2 400/600, Syne Mono) and the theme stylesheet.
- [ ] No `<link>`/`<script>` pointing to any external host.
- [ ] Link the theme on every page; tokens only, no stray hex colors.
- [ ] Header with 40px blue logo, 20px title, muted sub line.
- [ ] Buttons 25px, Title Case labels, blue/green/red/grey by meaning; hide what doesn't apply; groups sorted alphabetically.
- [ ] Long choice lists use the searchable picker (10 rows, alphabetical, search on top).
- [ ] Empty values in tables show `-`.
- [ ] Badges: 20px, 3px corners, colored border + bold caps text, 50% darker fill.
- [ ] Expanding rows: Edit (blue) left, Delete (red) right.
- [ ] Dialogs centered, dynamically sized, 8px radius.
- [ ] Drop-down notifications: top center, 6px radius, white ✕, 5s.
- [ ] Scrollbars hidden until within 15px; no horizontal scroll on logs.
