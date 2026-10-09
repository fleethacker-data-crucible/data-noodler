# Data Noodler

- TOP PRIORITY (save tokens): never narrate steps. For tasks, do the work silently and reply only "Finished!". For questions, answer briefly.
- `.ps1` files must be ASCII only (no `…`, `—`, `✓`): Windows PowerShell 5.1 reads them as ANSI and garbles anything else.
- CHARTS vs WIDGETS: D3 Studio builds CHARTS (never call them widgets); a widget = several things in one box (Widget Studio, later). No `widgets/` folder: charts live in `d3-studio/dev|live/<id>/`, widgets in `widget-studio/dev|live/<id>/`. The Dashboard reads only the `live` folders.
- Chart edits: ONLY edit `d3-studio/dev/<id>/d3-code.js` (new unsaved chart: `d3-studio/dev/_new/d3-code.js`); D3 Studio mirrors it live. NEVER edit anything in `d3-studio/live/`: only the user's Publish button copies dev to live (and onto the Dashboard).
- Packages are self-contained: a chart's / widget's ONLY style is its package `style.css` (`.WIDGET` = its box; a `/* ===== SHADOW ===== */` part for shadow roots; `--w-*` vars for chart colours). Never style a widget from pages, `css/theme.css` or `js/widgets/*.js`; any widget edit goes in its own folder. New widgets get their own `style.css`.
- Read `.claude/docs/ARCHITECTURE.md` (how the server, file API and native C# engine work) before server/engine work; `.claude/docs/CODE_INDEX.md` is the file map.
