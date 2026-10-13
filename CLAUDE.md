# Data Noodler

- TOP PRIORITY (save tokens): never narrate steps. For tasks, do the work silently and reply only "Finished!". For questions, answer briefly.
- `.ps1` files must be ASCII only (no `…`, `—`, `✓`): Windows PowerShell 5.1 reads them as ANSI and garbles anything else.
- WIDGETS, built in ONE studio: **Dashboard Studio** (`ui/html/dashboard-studio.html`, project module `dashboard`). No Chart Builder, D3 Studio or Dashboard Builder. Top bar: category placeholders + **Custom Widget** (adds an empty container) + project / global widgets; right-click a container > **Edit Widget** = Widget Editor (preview on the grid, Data / Settings windows, code window with tabs).
- Rendering: ONLY the official D3 7.9.0 (`ui/js/vendor/d3.v7.min.js`). No Apex anywhere, no other chart library.
- A widget package = `d3-code.js` (ES module: `export default function (data, { width, height, settings, inputs }) -> element`; builds its own root with d3, selects only inside it, fires CustomEvents for filters) + `d3-style.css` (`.WIDGET` = its container, scoped automatically; frame colours = app theme vars, data colours = settings) + `d3-settings.json` (`name`, `inputs`, `settings`, `values`). Nothing else.
- Where: global library `workspace/dashboard-studio/widgets/<id>/`; project copy `<project>/dashboard/widgets/<id>/` (projects are self-contained: a global widget is COPIED into the project). Save asks Project / Global / both. Containers + attached data: `<project>/dashboard/dashboard.json`.
- Widget data: ONLY the project's `CLEAN_` datasets. `SAMPLE_*` datasets (`workspace/sample-data/`, the user makes them) are preview-only in the editor: Save is greyed while one is attached. Never put sample data in code.
- Widgets are self-contained: never style a widget from pages, `ui/css/theme.css` or app JS. The Data Grid is core app code (`ui/js/grid/`, style `data-grid.css`, `.GRID` = its box), not a widget.
- Read `.claude/docs/ARCHITECTURE.md` (how the server, file API and native C# engine work) before server/engine work; `.claude/docs/CODE_INDEX.md` is the file map.
- Tests: write/run all test scripts ONLY in `.claude/tests/` (git-ignored); never elsewhere.
- Settings panels (widget Settings window and any settings list): every box, text box, drop-down, slider and button is at most 18px tall (text 12px), centred text on buttons; settings and sections always A-Z; numbers with a min / max are sliders, 1 - 50 unless told otherwise.
- Rounded corners: 4px on all studio / app UI (circles and square edges excepted); widgets keep their own.
