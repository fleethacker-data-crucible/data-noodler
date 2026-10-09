# Data Noodler

- TOP PRIORITY (save tokens): never narrate steps. For tasks, do the work silently and reply only "Finished!". For questions, answer briefly.
- `.ps1` files must be ASCII only (no `…`, `—`, `✓`): Windows PowerShell 5.1 reads them as ANSI and garbles anything else.
- Widgets are self-contained: a widget's ONLY style is `widgets/<id>/style.css` (`.WIDGET` = its box; a `/* ===== SHADOW ===== */` part for shadow roots; `--w-*` vars for chart colours). Never style a widget from pages, `css/theme.css` or `js/widgets/*.js`; any widget edit goes in its own folder. New widgets get their own `style.css`.
- Read `.claude/docs/ARCHITECTURE.md` (how the server, file API and native C# engine work) before server/engine work; `.claude/docs/CODE_INDEX.md` is the file map.
