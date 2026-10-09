# Data Noodler — Code Index

Quick map for future edits. Line numbers are as of 2026-10-05; re-check them after edits. Runtime story: `ARCHITECTURE.md`.

## Where we are

- **Data Noodler** is a browser-based flat-file analytics app: projects, Import, Pipeline, Dashboard, Publish, Update, Archives.
- All data work runs in the **native C# engine** (`engine/`, ~7.7k lines, C# 5) inside the local PowerShell server (`.server/server.ps1`),
  compiled at start by `Add-Type` into a cached DLL. No DuckDB, no WebAssembly, no third-party DLLs, no admin rights, no installs.
- The browser only renders: it sends SQL / declarative queries to `/api/engine/*` (`js/core/engine-client.js`) and gets compact JSON.
- A control panel (`.server/server.html`) opens as an Edge/Chrome app window: port, page, start/stop, engine check, live log.
- The site reads/writes files **only inside the project root** (`/api/fs/*`, `js/dn-fs.js`); the engine reads outside data files in place, read-only.
- All paths are relative to the project root, never absolute.

## Design rule: keep it modular

Small single-purpose files, each owning one job behind a small API (`DNFS`, `Engine`, `Widgets`, ...). New features go in new
files (`js/...` for pages, `engine/<Area>/...cs` for the engine). Exceptions: `.server/server.html` (inline CSS/JS) and
`.server/server.ps1` (~860 lines; split into dot-sourced parts if it grows, like `import-api.ps1` / `engine-loader.ps1`).

## Files

| Path | Purpose |
|---|---|
| `Start Data Noodler.lnk` | Entry point, no console flash: `conhost --headless powershell ... .server/server.ps1` (absolute paths). |
| `start-server.cmd` | Same via `conhost --headless`; its own console flashes once. |
| `.server/server.ps1` | HTTP server: site, panel API, file API, engine routing, project trash, logging, browser launch. |
| `.server/engine-loader.ps1` | `Load-DataEngine` (hash `engine/**/*.cs` → cached DLL in `%LOCALAPPDATA%\data-noodler\engine\`, else `Add-Type` compile), `New-DataEngine`. |
| `.server/server.html` | Control panel UI (inline CSS + JS), 1200×800; status cards, Server/Dev Actions; Engine status via `/api/engine`. |
| `.server/import-api.ps1` | Outside-file probe (`/api/import/probe`, dead-drive timeouts). `read`/`copy` kept, unused. |
| `.server/settings.json` | `port`, `portMode`, `browser`, `theme`, `fileThreads`, `engineWorkers` (≤64), `engineMemory` (share of RAM). |
| `engine/Core/DataEngine.cs` | `DataEngine`: catalog (session tables, views, table functions), `Query`, `Preview`, `Describe`, `Write` (dataset), `Export`, `OpenSource`, `CacheLoad`, `RunPipeline` (DAG), `Status`. |
| `engine/Core/Script.cs` | SQL scripts: statement parser (CREATE/ALTER/DROP, INSERT/UPDATE/DELETE/MERGE, transactions, TRY/CATCH, indexes) and the session that runs them. |
| `engine/Core/EngineApi.cs` | `/api/engine/*` routes (answered on engine threads), result JSON. |
| `engine/Core/Jobs.cs` | `Job` (state, stage, progress, rows, cancel), `JobManager`. |
| `engine/Core/MemoryGuard.cs` | RAM budget, reservations (`MemoryLease`), free-RAM floor. |
| `engine/Core/EngineOptions.cs` | Options + `EngineLog` (lines drained into the server log). |
| `engine/Core/EngineError.cs` | `EngineException` (code + message + HTTP status), `EngineError`, `Json` helpers. |
| `engine/Arrow/DataSchema.cs` | `DataType`, `Field`, `Schema`, `Column`, `Batch`, `Values` (dates, text, JSON cells). |
| `engine/Arrow/ColumnBuilder.cs` | Growable column. |
| `engine/Query/SqlParser.cs` | Lexer, syntax tree, `Parser` (queries; statements in Script.cs). |
| `engine/Query/Planner.cs` | Name resolution, typing, joins, GROUP BY / aggregates, windows, ORDER BY / LIMIT, lateral aliases → operators. |
| `engine/Query/Optimizer.cs` | Column pruning (Parquet reads only needed columns). |
| `engine/Query/Operators.cs` | `ExecCtx`, `Source`, `ChainOp` (parallel per row group), `FilterStep`, `ProjectStep`, `AggOp`, `SortOp`, `LimitOp`, `UnionOp`. |
| `engine/Query/Expressions.cs` | Bound expressions (vectorised per batch). |
| `engine/Query/Functions.cs` | Scalar functions. |
| `engine/Query/Aggregates.cs` | `KeyIndex` (group keys), aggregate states, `AggTable` (partial + merge). |
| `engine/Query/Join.cs` | `HashJoin`, `JoinProbe`, `OuterJoinOp`. |
| `engine/Query/Window.cs` | Window functions. |
| `engine/Query/Cast.cs` | Type conversion, common types. |
| `engine/Query/QuerySpec.cs` | Declarative widget query → SQL. |
| `engine/Parquet/*.cs` | `Thrift` (compact protocol), `Compression` (Snappy, GZIP), `Encoding` (RLE, DELTA_*), `ParquetWriter`, `ParquetReader`. |
| `engine/Providers/CsvProvider.cs` | Streaming CSV parser, detection, inference, widening. |
| `engine/Providers/SqliteProvider.cs` | `winsqlite3.dll` P/Invoke, SQLite source + export. |
| `engine/Storage/Datasets.cs` | `PathGuard`, dataset file lists, `DatasetWriter` (atomic swap, `dataset.json`). |
| `engine/Storage/ParquetSource.cs` | Dataset as a splittable source (one unit per row group). |
| `engine/Workers/WorkerPool.cs` | Worker threads, `Submit`, ordered bounded `Ordered(...)`. |
| `js/core/engine-client.js` | `Engine`: `query`, `describe`, `count`, `preview` (rows + count, scripts), `open`, `write`, `exportTo`, `pipeline`, `job`, `cancel`, `status`, `cache`, `src`, `views`. |
| `js/dn-fs.js` | `DNFS`: client for the project file API. |
| `js/import/external-source.js` | `ExternalSource`: probe for files outside the project. |
| `js/pipeline/steps.js` | `PipelineSteps`: step → SQL (pipelines are now `sql` steps; older form steps are converted on load). |
| `js/pipeline/sql-editor.js` | `SqlEditor`: SQL / JSON (`lang`) code editor (line numbers, colours, Tab/Shift+Tab, auto-indent, SQL completion). CSS in theme.css. |
| `js/pipeline/runner.js` | `PipelineRunner`: `load` (pipeline.json v2: queries + active + output; v1 steps converted), `run` = `Engine.write` of the active query to `data/source/<CLEAN_name>/`. |
| `js/publish/publisher.js` | `Publisher`: dashboard publishing (Web App, PDF, PowerPoint, per-chart images) and dataset exports; shared by Publish and Update. Saved choices: `cfg.publish` (`targets`, `image`, `name`, `data: { names, fmt }`). |
| `js/update/project-update.js` | `ProjectUpdate.run(folder)` (Project Manager: Update button + workflow in each expanded project): Import (changed sources, same columns), Transform (active query), Dashboard (clears widget caches), Publish (saved choices), Archive (snapshot); result in `cfg.modules.update` (`ok`, `steps`). |
| `widgets/<id>/widget.json` (+ `spec.json`, `style.css`) | Global widget packages. `spec.$kind` = apexcharts / apexgrid / apextree. `style.css` (widget.json "style") is the widget's ONLY style: PAGE part scoped by `.WIDGET` (= class dn-w-<id>), `/* ===== SHADOW ===== */` part for shadow roots, `--w-*` vars feed chart colours (ApexWidget.useStyle / theme(el)). |
| `js/widgets/apex-widget.js` | `ApexWidget` (all widget kinds: inputs from spec.data or defaults per Apex chart type, option detection, query, row shaping, theme, render via ApexRender, sample data) and `WidgetRegistry` (widgets/ folder). |
| `js/widgets/apex-render.js` | `ApexRender`: ApexCharts (rows -> series / labels / categories by chart type), ApexTree (dimensions = levels), ApexGrid (picked fields); theme defaults merged under the spec. |
| `js/widgets/apex-options.js` | `ApexOptions`: catalog of ApexCharts options in groups (per chart type) `groupOf(path)` groups widget options in the Dashboard settings. |
| `widgets/data-grid/grid.js` | `DNGrid`: the Data Grid renderer (our own table, no ApexGrid): one native scroller, rows on screen only, sort / filter / search / resize / autosize, right-click column menu, Export, Pop-out; engine paging via `GridRemote` (grid.provider). Loaded by ApexRender from widget.json "renderer". |
| `js/vendor/apexcharts.min.js`, `apextree.min.js`, `apex-grid/` | Vendored libraries (offline; no CDN at runtime). |
| `js/widgets/widget-settings.js` | `WidgetSettings.render` / `tree`: widget settings built from a manifest (Dashboard side panel + Pop-out Settings). |
| `js/widgets/color-picker.js` | `ColorPicker.swatch`: SV square, hue strip, hex, theme palette, recent colours. |
| `js/vendor/vega.min.js`, `vega-lite.min.js` | Vendored Vega 5.30 / Vega-Lite 5.21 (offline). |
| `html/dashboard-settings.html` | Dashboard Pop-out Settings window: 300px tree (Widget, Inputs, option groups) + the picked group's settings; talks to the Dashboard via `window.opener.DashBridge`. Widgets are authored by hand / AI as packages in `widgets/`. |
| `js/mem-monitor.js` | `MemMonitor`: live graph of engine (server process), browser, system memory (`/api/mem`). |
| `js/test-data-gen.js` | `TestDataGen`: 50-column synthetic data SQL (engine dialect), sizes, part plans. |
| `js/core/ui.js`, `user-picker.js`, `projects.js`, `project-log.js`, `windows.js`, `module-page.js`, `embed.js`, `theme.js` | Shared page code (unchanged by the engine switch). |
| `css/theme.css`, `assets/fonts/` | Universal theme (see `THEME_GUIDE.md`). |
| `html/app.html` | Redirect only (old shell links → the module page). |
| `js/core/embed.js` | Global header on every page (logo initials, Data Noodler, module · project, Web Server (PowerShell) + Data Engine (C#) status, ONLINE/OFFLINE); `GlobalHeader.setInfo`. |
| `tests/sql-cheatsheet.ps1` (+ `-cases.ps1`) | Engine SQL tests: every cheatsheet command in `ref-docs/`, edge cases, Parquet row groups. |
| `html/project_manager.html` (app entry point, hard-coded `$entryPage` in server.ps1; red Server Control button → `/api/panel`), `import.html`, `transform.html`, `dashboard.html`, `publish.html`, `dashboard-grid.html` (Dashboard right-click > Data Grid drill-down window), `grid-pop.html` (any Data Grid's Pop-out button), `archives.html` | Modules. |
| `html/engine-bench.html` | Worker-count benchmark, Auto, profile → `config/engine-profile.json`. |
| `html/thread-bench.html` | Worker sweep per query (Parquet or engine in-memory table). |
| `html/engine-test.html` | SQL console. |
| `html/generate-test-parquet-files.html` | Test datasets → `test-data/gen/<name>/` (parts + `manifest.json`). |
| `config/users.json`, `config/engine-profile.json` | Shared users; saved engine profile. |
| `projects/<folder>/` | Projects (`data/raw`, `data/staged/<ds>/`, `data/source/<ds>/`, `pipeline/`, `dashboard/`, `publish/`, `archives/`). |
| `.trash/duckdb-wasm-20261005/` | Retired DuckDB-WASM, sql.js and their JS wrappers (do not use). |

## Request flow

```
Start Data Noodler.lnk / start-server.cmd → .server/server.ps1
  ├─ engine-loader.ps1: Load-DataEngine :22 → New-DataEngine :55        (server.ps1 :584-596)
  ├─ main loop :818 → Handle-Ui :260 (panel; 'api/engine' :340) | Handle-Site :638
  │                   └─ Read-EngineLog :598 each pass (engine log → server log)
  └─ Handle-Site :638
       ├─ api/engine/<op> :647 → Test-FsRequest :425 → EngineApi.Handle (engine thread closes the response)
       ├─ api/fs/<op> → Handle-Fs :439 → Resolve-ProjectPath :401
       ├─ api/import/<op> → import-api.ps1
       └─ static → Start-StaticJob :559 (runspace pool) | *.html → Send-File :145 (+ token)
```

### Engine call path

```
Engine.query(sql, { views })  (js/core/engine-client.js call() :20)
  → POST /api/engine/query → EngineApi.Route → DataEngine.Query
      → Parser.ParseQuery → Planner.Plan → Optimizer.Prune → op.Run(ExecCtx)
      → ChainOp: WorkerPool.Ordered(row groups) → ParquetReader.ReadRowGroup → steps → AggTable / SortOp / ...
  ← { cols, types, rows, rowCount, truncated, ms }
Engine.write / exportTo / pipeline → job id → Engine.job() polls GET /api/engine/job?id=
```
