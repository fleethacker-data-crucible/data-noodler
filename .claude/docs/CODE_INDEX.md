# Data Noodler — Code Index

Quick map for future edits. Updated 2026-10-10 (Arrow engine). Runtime story: `ARCHITECTURE.md`. Changes: `CHANGELOG.md`.

## Where we are

- **Data Noodler** is a browser-based flat-file analytics app: projects, Import, Transform, Dashboard, D3 Studio, Publish,
  Update, Archives.
- All data work runs in the **native C# engine** (`server/data-engine/`, ~11k lines, C# 5) inside the local PowerShell server
  (`server/server.ps1`), compiled at start by `Add-Type` into a cached DLL. No DuckDB, no WebAssembly, no third-party DLLs,
  no admin rights, no installs.
- **Datasets are Arrow IPC** (`part-NNNNNN.arrow` + `dataset.json`) on disk and are held **resident in engine memory**
  while a project is open; Parquet / CSV / SQLite are export formats (older Parquet datasets are still read).
- The browser only renders: it sends SQL / declarative queries to `/api/data-engine/*` (`ui/js/core/engine-client.js`) and gets
  compact JSON.
- A control panel (`server/server.html`) opens as an Edge/Chrome app window: port, page, start/stop, engine check, live log.
- The site reads/writes files **only inside the project root** (`/api/fs/*`, `ui/js/dn-fs.js`); the engine reads outside data
  files in place, read-only. All paths are relative to the project root.

## Design rule: keep it modular

Small single-purpose files, each owning one job behind a small API (`DNFS`, `Engine`, `ChartRegistry`, ...). New features
go in new files (`ui/js/...` for pages, `server/data-engine/<Area>/...cs` for the engine). Exceptions: `server/server.html` (inline
CSS/JS) and `server/server.ps1` (split into dot-sourced parts if it grows, like `import-api.ps1` / `engine-loader.ps1`).

## Files

### Launch, server, packaging

| Path | Purpose |
|---|---|
| `Data Noodler.lnk` | Entry point, no console flash: `conhost --headless powershell ... server/server.ps1` (absolute paths). |
| `server/server.ps1` | HTTP server: site, panel API, file API, engine routing, project trash, logging, browser launch. |
| `server/engine-loader.ps1` | `Load-DataEngine` (hash `server/data-engine/**/*.cs` → cached DLL in `temp\data-engine\`, else `Add-Type` compile), `New-DataEngine`. |
| `server/server.html` | Control panel UI (inline CSS + JS), 1200×800; status cards, Server/Dev Actions; engine check via `/api/data-engine`. |
| `server/import-api.ps1` | Files outside the project: `/api/import/probe` (dead-drive timeouts), `read`, `copy` (Import "Copy into project"). |
| `server/settings.json` | `port`, `portMode`, `browser`, `theme`, `fileThreads`, `engineWorkers` (≤64), `engineMemory` (share of RAM). |

### Engine (`server/data-engine/`, namespace `NativeDataEngine`)

| Path | Purpose |
|---|---|
| `Core/DataEngine.cs` | `DataEngine`: catalog (session tables, views, table functions; resident datasets first), `Query`, `Preview`, `Describe`, `Write` (Arrow dataset), `Export` (csv / parquet / sqlite), `OpenSource`, `CacheLoad`, `RunPipeline` (DAG), `Status`. |
| `Core/Script.cs` | SQL scripts: statement parser (CREATE/ALTER/DROP, INSERT/UPDATE/DELETE/MERGE, transactions, TRY/CATCH, indexes) and the session that runs them. |
| `Core/EngineApi.cs` | `/api/data-engine/*` routes (answered on engine threads), result JSON. |
| `Core/Jobs.cs` | `Job` (state, stage, progress, rows, cancel), `JobManager`. |
| `Core/MemoryGuard.cs` | RAM budget, reservations (`MemoryLease`), free-RAM floor. |
| `Core/EngineOptions.cs` | Options (`DatasetFormat` arrow\|parquet, `ResidentFraction`, batch / part sizes) + `EngineLog`. |
| `Core/EngineError.cs` | `EngineException` (code + message + HTTP status), `EngineError`, `Json` helpers. |
| `Arrow/DataSchema.cs` | `DataType`, `Field`, `Schema`, `Column` (typed arrays + null flags), `Batch`, `Values` (dates, text, number parsing, JSON cells). |
| `Arrow/ColumnBuilder.cs` | Growable column. |
| `Arrow/ArrowIpc.cs` | Arrow IPC file format: FlatBuffers writer/reader (`FbOut`, `Fb`), `ArrowFileWriter` (encode on workers, append in order), `ArrowMeta` (footer, batches), `ArrowSource` (one unit per record batch, column pruning), `DataFiles` (.arrow vs .parquet → source). |
| `Query/SqlParser.cs` | Lexer, syntax tree, `Parser` (queries; statements in Script.cs). |
| `Query/Planner.cs` | Name resolution, typing, joins, GROUP BY / aggregates, windows, ORDER BY / LIMIT, lateral aliases → operators. |
| `Query/Optimizer.cs` | Column pruning (Arrow / Parquet / CSV scans read only the columns a query needs). |
| `Query/Operators.cs` | `ExecCtx`, `Source`, `MemSource`, `ChainOp` (parallel per unit), `FilterStep`, `ProjectStep`, `AggOp`, `SortOp` (parallel top-N), `LimitOp`, `UnionOp`, `RecursiveOp`. |
| `Query/Expressions.cs` | Bound expressions (vectorised per batch). |
| `Query/Functions.cs` | Scalar functions. |
| `Query/Aggregates.cs` | `KeyIndex` (group keys), aggregate states, `AggTable` (partial + merge). |
| `Query/Join.cs` | `HashJoin`, `JoinProbe`, `OuterJoinOp`. |
| `Query/Window.cs` | Window functions. |
| `Query/Spill.cs` | Spill to disk: hash partitions and sorted runs for GROUP BY, sort, window and join when memory runs out. |
| `Query/Cast.cs` | Type conversion, common types. |
| `Query/QuerySpec.cs` | Declarative widget query → SQL. |
| `Parquet/*.cs` | `Thrift` (compact protocol), `Compression` (Snappy, GZIP), `Encoding` (RLE, DELTA_*), `ParquetWriter` (export), `ParquetReader` (Parquet sources / older datasets). |
| `Providers/CsvProvider.cs` | CSV: zero-copy field parser, detection, inference, widening, parallel byte ranges. |
| `Providers/SqliteProvider.cs` | `winsqlite3.dll` P/Invoke, SQLite source + export. |
| `Storage/Datasets.cs` | `PathGuard`, dataset file lists, `DatasetWriter` (Arrow or Parquet parts, atomic swap, `dataset.json`). |
| `Storage/ParquetSource.cs` | Parquet files as a splittable source (one unit per row group). |
| `Storage/ResidentDatasets.cs` | Project datasets held in engine memory: background load, signature check, LRU within `ResidentFraction` of the budget. |
| `Workers/WorkerPool.cs` | Worker threads, `Submit`, ordered bounded `Ordered(...)`. |

### Browser: shared code

| Path | Purpose |
|---|---|
| `ui/js/core/engine-client.js` | `Engine`: `query`, `describe`, `count`, `preview`, `check`, `open`, `write`, `exportTo`, `pipeline`, `job`, `cancel`, `status`, `cache`, `memory` (`load` / `preload` / `info` / `drop`), `src`, `dataset`, `views`. |
| `ui/js/dn-fs.js` | `DNFS`: client for the project file API. |
| `ui/js/core/module-page.js` | `ModulePage.init`: page header, `?project=`, project log; starts loading the project's datasets into engine memory. |
| `ui/js/core/projects.js` | `Projects`: project folders and `project-config.json` (datasets, modules, phase), `sourceDatasets`. |
| `ui/js/core/ui.js`, `user-picker.js`, `project-log.js`, `windows.js` (module windows), `theme.js`, `no-autofill.js` | Shared page code. |
| `ui/js/core/embed.js` | Global header on every page (logo initials, module · project, Web Server + Data Engine status); `GlobalHeader.setInfo`. |
| `ui/js/core/icons.js` | `Icons`: every inline SVG icon (`Icons.svg(name)`, `Icons.caret(open)`, CSS `.dn-caret` in theme.css). |
| `ui/js/core/menus.js` | `Menus`: drop-down menus (`.dd-wrap` / `.dd-menu`): `bind`, `sort`, Shift = item tips. |
| `ui/js/core/pdf.js`, `ui/js/core/pptx.js` | `Pdf.imagePage`, `Pptx.imageSlide`: one-picture PDF / PowerPoint writers (Publish). |
| `ui/js/import/external-source.js` | `ExternalSource`: probe / copy files outside the project. |
| `ui/js/pipeline/sql-editor.js` | `SqlEditor`: SQL / JSON / JS code editor (find / replace, comments, completion, error marks). CSS in theme.css. |
| `ui/js/pipeline/steps.js` | `PipelineSteps`: older form steps → SQL (pipelines saved before v2 are converted on load). |
| `ui/js/pipeline/runner.js` | `PipelineRunner`: `load` (pipeline.json v2), `run` = `Engine.write` of the active query → `data/source/<CLEAN_name>/`. |
| `ui/js/publish/publisher.js` | `Publisher`: dashboard publishing (Web App, PDF, PowerPoint, images) and dataset exports; shared by Publish and Update. |
| `ui/js/update/project-update.js` | `ProjectUpdate.run(folder)`: Import (changed sources), Transform, Dashboard caches, Publish, Archive. |
| `ui/js/bench/bench-tests.js`, `ui/js/bench/benchmark.js` | Benchmark page: test data (`temp/bench/data/<rows>/`), the tests (`BenchTests.run`), and the page (check-box pickers, live cards, results table, saved results, Markdown report, Create / Wipe Test Data). |
| `ui/css/theme.css`, `assets/fonts/` | Universal theme (see `THEME_GUIDE.md`). |

### Charts, Data Grid, D3 Studio

| Path | Purpose |
|---|---|
| `workspace/chart-builder/dev/<id>/`, `workspace/chart-builder/published/<id>/` | Chart packages: `chart.json` (+ `spec.json`, `d3-code.js`, `sample.json`, `style.css`, `thumb.svg`). dev = Save, published = Publish (the Dashboard Builder reads only published). Edit only `dev/<id>/d3-code.js`. |
| `ui/js/charts/apex-widget.js` | `ApexWidget` (inputs, query, row shaping, theme, style per chart) and `ChartRegistry` (live charts + the built-in Data Grid). |
| `ui/js/charts/d3-render.js` | `D3Render`: compile / draw a chart's code in its `<div>` (`d3, data, el, W, H, colors, opts, theme, inputs` + accessors), fit, rounded bars, redraw animation. |
| `ui/js/charts/apex-render.js`, `apex-options.js` | ApexCharts / ApexTree drawing for dashboards made before D3 charts (kept so they still draw); option catalog. |
| `ui/js/charts/chart-panel.js` (+ `ui/css/chart-studio.css`), `color-picker.js` | `ChartPanel`: the settings panel shared by Chart Builder and the Dashboard Builder (field chips, X / Y slots, Colors, Settings), built from the chart's inputs / options; colour swatch. |
| `ui/js/grid/data-grid.js` (+ `data-grid.css`, `data-grid-pkg.js`, `grid-remote.js`) | `DNGrid`: Dashboard Data Grid (sort / filter / search, export, pop-out); engine paging (`GridRemote`). |
| `ui/js/grid/data-table.js` (+ `ui/html/table-pop.html`) | `DataTable`: Import / Transform preview tables (schema-table look; Search, Pop-out, Export). |
| `ui/js/d3studio/studio.js`, `d3-api.js`, `d3-assist.js`, `observable.js` | D3 Studio: editor, inputs, data from a CLEAN_ dataset via the engine, live code file, Save / Publish; D3 API list, suggestions / checks, Observable import. |
| `ui/html/chart-builder.html`, `ui/js/chartbuilder/builder.js`, `templates.js` | Chart Builder: the simple chart maker (chart types, drag fields onto slots, colours, settings, optional code drawer). Saves the same chart packages as D3 Studio, plus chart.json `builder`. |
| `ui/js/vendor/apexcharts.min.js`, `apextree.min.js`, `d3.min.js` (v7.9.0) | Vendored libraries (offline; no CDN at runtime). |

### Pages (`ui/html/`)

| Path | Purpose |
|---|---|
| `project_manager.html` | App entry point (hard-coded `$entryPage` in server.ps1); red Server Control button → `/api/panel`. |
| `import.html`, `transform.html`, `dashboard.html` (Dashboard Builder: places published charts; Chart Builder's look), `d3-studio.html`, `publish.html` | Modules. |
| `dashboard-grid.html`, `grid-pop.html` | Dashboard Builder pop-outs: Data Grid drill-down, any grid's Pop-out. |
| `syntax-library.html` | SQL syntax / function reference (Transform's Syntax Library button). |
| `benchmark.html` | Benchmark (Project Manager > Utilities): engine speed by rows, rows per batch and workers. |
| `app.html` | Redirect only (old shell links → the module page). |

### Tests, tools, config, data

| Path | Purpose |
|---|---|
| `.claude/tests/sql-cheatsheet.ps1` (+ `-cases.ps1`) | Engine SQL tests: every cheatsheet command in `ref-docs/`, edge cases, Parquet row groups. |
| `.claude/tests/arrow-format.ps1` | Arrow datasets give the same answers as Parquet (all types, NULLs, Unicode, parts, pruning), exports, resident datasets. |
| `.claude/tests/bench-engine.ps1`, `.claude/tests/bench-compare.ps1` | Speed per step (import, filter, calculations, group by, joins, sort, window, write, export) for the old engine vs the new one; results in `temp/bench/`. |
| `config/users.json` | Shared users. |
| `workspace/projects/<folder>/` | Projects (`data/raw`, `data/imported/<ds>/`, `data/source/<ds>/`, `pipeline/`, `dashboard/`, `publish/`, `archives/`, `logs/`). |
| `ref-docs/` | SQL cheatsheets (test source), engine / D3 Studio design reviews. |
| `arrow after action report.md` | Report of the Arrow engine work: what changed, old vs new speed, what is left. |

## Request flow

```
Data Noodler.lnk → server/server.ps1
  ├─ engine-loader.ps1: Load-DataEngine → New-DataEngine
  ├─ main loop → Handle-Ui (panel; 'api/data-engine') | Handle-Site
  │                 └─ Read-EngineLog each pass (engine log → server log)
  └─ Handle-Site
       ├─ api/data-engine/<op> → Test-FsRequest → EngineApi.Handle (engine thread closes the response)
       ├─ api/fs/<op> → Handle-Fs → Resolve-ProjectPath
       ├─ api/import/<op> → import-api.ps1
       └─ static → Start-StaticJob (runspace pool) | *.html → Send-File (+ token)
```

### Engine call path

```
Engine.query(sql, { views })  (ui/js/core/engine-client.js call())
  → POST /api/data-engine/query → EngineApi.Route → DataEngine.Query
      → Parser.ParseQuery → Planner.Plan (read_dataset: ResidentDatasets.TryGet → MemSource, else ArrowSource / ParquetSource)
      → Optimizer.Prune → op.Run(ExecCtx)
      → ChainOp: WorkerPool.Ordered(units) → batch → steps → AggTable / SortOp / ...
  ← { cols, types, rows, rowCount, truncated, ms }
Engine.write / exportTo / pipeline → job id → Engine.job() polls GET /api/data-engine/job?id=
Engine.memory.load(paths) → POST /api/data-engine/memory/load → ResidentDatasets.Preload (waits for the loads)
```
