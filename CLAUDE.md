# Data Noodler

- TOP PRIORITY (save tokens): never narrate steps. For tasks, do the work silently and reply only "Finished!". For questions, answer briefly.
- `.ps1` files must be ASCII only (no `…`, `—`, `✓`): Windows PowerShell 5.1 reads them as ANSI and garbles anything else.
- CHARTS only, no widgets (widgets come later; there is no `widget-studio/` and no `widgets/` folder). D3 Studio builds CHARTS: packages in `workspace/chart-builder/dev|live/<id>/` with a `chart.json` manifest. The Dashboard reads only `workspace/chart-builder/live`. The Data Grid is core app code (`ui/js/grid/`), not a widget.
- Chart edits: ONLY edit `workspace/chart-builder/dev/<id>/d3-code.js` (new unsaved chart: `workspace/chart-builder/dev/_new/d3-code.js`); D3 Studio mirrors it live. NEVER edit anything in `workspace/chart-builder/live/`: only the user's Publish button copies dev to live (and onto the Dashboard).
- Charts are self-contained: a chart's ONLY style is its package `style.css` (`.CHART` = its box; `--w-*` vars for chart colours). Never style a chart from pages, `ui/css/theme.css` or `ui/js/charts/*.js`. The Data Grid's only style is `ui/js/grid/data-grid.css` (`.GRID` = its box).
- Read `.claude/docs/ARCHITECTURE.md` (how the server, file API and native C# engine work) before server/engine work; `.claude/docs/CODE_INDEX.md` is the file map.
- Tests: write/run all test scripts ONLY in `.claude/tests/` (git-ignored); never elsewhere.
