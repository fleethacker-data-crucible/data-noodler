# Data Noodler: How It Works

What actually happens from launch to query. Updated 2026-10-10 for the Arrow engine (Arrow IPC datasets, resident in-memory datasets).
`CODE_INDEX.md` is the file map; this is the runtime story. Re-check line refs after edits.

## Ground rules

- **No DuckDB, no WebAssembly, no third-party DLLs.** The data engine is our own C# source (`engine/`), compiled at
  server start by PowerShell 5.1 `Add-Type` (C# 5 syntax only), using .NET Framework assemblies and Windows' `winsqlite3.dll`.
- **No installs, no admin.** Server is plain PowerShell + .NET `HttpListener`; browsers are the installed Edge/Chrome.
- **Project-relative paths only.** The folder can move to any machine.
- **Arrow is the working format.** Datasets are Arrow IPC files on disk and are held in engine memory while in use;
  Parquet / CSV / SQLite are written only on export (older Parquet datasets are still read).
- **`projects/.trash/`** holds deleted projects (moved there by the server); it is closed to the file API.

## 1. Launch

```
Data Noodler.lnk
  └─ conhost --headless powershell -WindowStyle Hidden -File .server/server.ps1
```
`Data Noodler.lnk` holds absolute paths: run `rebuild-shortcut.ps1` if the folder moves. No VBS launchers.

`server.ps1` startup, top to bottom:
1. `$root` = project folder (one up from `.server`), `$uiPort = 8079`, log file `.server/logs/Data_Noodler_Server_Logs_<time>.log`.
2. Loads `.server/settings.json` (`port`, `portMode`, `browser`, `theme`, `fileThreads`, `engineWorkers`, `engineMemory`).
   App entry point is hard-coded: `$entryPage = 'html/project_manager.html'` (site `/` redirects there).
3. Kills a stale instance via `.server/.pid`, writes its own PID.
4. Clears leftover `temp/upload-*.tmp`.
5. One `HttpListener` listens on **two ports**: **8079** = control panel, **site port** = the app (started/stopped from the panel).
6. **Engine:** `.server/engine-loader.ps1` hashes `engine/**/*.cs`; a cached DLL `%LOCALAPPDATA%\data-noodler\engine\NativeDataEngine-<hash>.dll`
   is loaded if present, else the sources are compiled with `Add-Type -CompilerParameters` (`/optimize+`, ~0.5 s) into that DLL.
   Then `New-DataEngine` creates the one `NativeDataEngine.DataEngine` (workers, memory guard). A compile error is logged and
   the site still runs (engine calls answer 503).
7. Starts the site and opens `$entryPage` (Project Manager). The panel is NOT opened at startup: the red **Server Control**
   button in the Project Manager calls `POST /api/panel` (`Open-Panel`: opens it, or raises it if already open; `--app` window,
   own profile in `%LOCALAPPDATA%\data-noodler\.profile`).
8. Main loop: one request at a time on the main thread, except plain static files (runspace pool) and engine calls (engine threads).
   Each loop pass also moves engine log lines into the server log (`Read-EngineLog`).

**Shutdown:** the Project Manager window closes → `/api/bye` → exits after 4 s (a reload sends `/api/hello` and cancels it); or no heartbeat (panel log poll or any app window's `/api/status`) for 120 s, i.e. all windows closed; or nothing
connects within 60 s. Closing the panel alone does not stop the server. The engine is disposed (jobs cancelled, workers stopped).

## 2. Control panel (port 8079, `.server/server.html`)

- Polls `GET /api/log?since=` every 1 s. Heartbeats = this poll + each app window's `/api/status` (5 s); the server exits
  120 s after the last one (60 s if none ever connects). Closing the panel does not stop the server.
- Window: 1200×800, centred (`Open-App -Width/-Height` + `resizeTo` in the page; the profile's saved app-window placement is cleared on launch).
- `GET /api/state`: status, port, page, user (`$env:USERNAME`), uptime, list of `html/*.html` modules.
- Side panel: Current User; Uptime, Port; Web Server (PowerShell), Data Engine (C#) — each `ONLINE` (green) or `OFFLINE` (red), details in the tooltip.
- **Engine check:** `GET /api/engine` runs `SELECT sum(range) FROM range(1000000)` in the engine and returns its status
  (version, workers, cores, memory budget); click to re-run.
- Server Actions (blue): `/api/site`, `/api/clear`, `/api/users`, Settings (port, browser, theme). Dev Actions (orange): Modules dialog (module list + Open Module, for testing; no default module).
- Favicons: `/favicon.ico` → `assets/server_favicon.ico` (panel, red) and `assets/client_favicon.ico` (site, blue).
- Log kinds and colors: `req`, `sys` (pink), `err` (red), `engine` (teal), `start`/`stop`. `sys`/`err` and 4xx/5xx pop a notification.

## 3. Site (site port) — `Handle-Site`

| Request | Handling |
|---|---|
| `/` | 302 → shell (`html/app.html?m=<page>`). |
| `*.html` | `Send-File -Token`: injects `window.DN_TOKEN` before `</head>`, `no-store`. |
| other static | Runspace pool (`fileThreads`, default 16) → `Send-Stream`, in parallel. Range requests supported. |
| `/api/engine/<op>` | Same-site check (`Test-FsRequest`), then `[NativeDataEngine.EngineApi]::Handle($engine, $ctx, $op)`: answered on an engine thread. |
| `/api/fs/<op>` | File API (below). |
| `/api/import/<op>` | Outside-file probe (below). |
| `/api/status`, `/api/mem`, `/api/theme`, `/api/project/trash` | Shell status, memory graph (browser + engine process + system), theme, project trash. |

## 4. File API (`/api/fs/*`) and `DNFS` (`js/dn-fs.js`)

Pages never touch disk directly. `DNFS` sends `X-DN-Token` + same-origin; server checks:
- `Test-FsRequest`: correct Host (anti DNS-rebinding), no foreign Origin, valid token.
- `Resolve-ProjectPath`: rejects absolute paths, `..`, `:`, any dot-segment (`.server`, `.git`, `.trash`), and links.

Ops: `list`, `stat`, `read`, `write`, `mkdir`, `delete`, `move`, `copy`.

## 4b. Files outside the project

- `/api/import/probe?src=` (`.server/import-api.ps1`, `ExternalSource.probe`): exists/size/modified on a background
  runspace, 10 s warn / 30 s timeout, so a dead network drive can't freeze the server. Used by Import and Update.
- The **engine reads the file in place** (read only): `read_csv('X:\…')`, `read_dataset('\\server\share\…')`. `PathGuard.Source`
  allows full paths only for data files (csv/tsv/txt/parquet/pq/arrow/feather/sqlite/sqlite3/db). Writes stay inside the project.
- `/api/import/read` and `copy` still exist but the app no longer uses them.

## 5. Native engine (`engine/`, namespace `NativeDataEngine`)

```
EngineApi (HTTP, own thread) ─► DataEngine ─► Parser (SQL) ─► Planner ─► Optimizer.Prune ─► operators ─► WorkerPool
                                   │                                                          │
                                   ├─ Jobs (write / export / pipeline: id + progress + cancel) │
                                   ├─ MemoryGuard (budget, reservations, free-RAM floor)       │
                                   ├─ ResidentDatasets (project datasets in RAM)                │
                                   └─ sources: MemSource (resident), ArrowSource (record batches), ParquetSource (row groups),
                                      CsvSource, SqliteSource, RangeSource
```

- **Columnar batches** (`engine/Arrow/DataSchema.cs`): `Column` = typed array (`long[]` ints/dates/timestamps, `double[]` doubles/decimals,
  `string[]`, `bool[]`) + null flags; `Batch` = columns + schema. Dates = days since 1970, timestamps = microseconds.
- **SQL** (`Query/SqlParser.cs`): DuckDB-style subset: `WITH [RECURSIVE]` (+ `name(cols)`), `SELECT [DISTINCT]`, `VALUES`, `* EXCLUDE (…)`,
  joins (INNER/LEFT/RIGHT/FULL/CROSS, `ON` / `USING`), `WHERE`, `GROUP BY [ALL | ROLLUP | CUBE | GROUPING SETS]` (+ `GROUPING()`),
  `HAVING`, `ORDER BY [ALL]`, `LIMIT/OFFSET`, `UNION [ALL]`, `PIVOT (agg FOR col IN (…))`, window functions, `CAST/TRY_CAST/::`, `CASE`,
  `IN`, `BETWEEN`, `LIKE/ILIKE`, `FILTER (WHERE …)`, lateral aliases, `[bracket]` names, `DESCRIBE`.
  **Subqueries** (scalar, `EXISTS`, `IN (SELECT)`, `ANY/SOME/ALL`; correlated on equality conditions) are rewritten by
  `Planner.Unnest` into hidden helper joins (CROSS JOIN when uncorrelated, LEFT JOIN on the correlation keys), so they run
  in parallel like any join. Recursive CTEs run round by round (`RecursiveOp`, working table `WorkSource`).
- **Scripts** (`Core/Script.cs`): several statements separated by `;` run against a per-request session (in-memory tables,
  views, indexes): `CREATE TABLE` (constraints: PRIMARY KEY / UNIQUE / NOT NULL / DEFAULT / CHECK / AUTO_INCREMENT, or `AS query`),
  `CREATE [OR REPLACE] VIEW`, `DROP TABLE/VIEW/INDEX`, `ALTER TABLE`, `INSERT` (VALUES / query / DEFAULT VALUES, `ON DUPLICATE KEY
  UPDATE`, `ON CONFLICT`, `OR REPLACE/IGNORE`), `UPDATE`, `DELETE`, `TRUNCATE`, `MERGE`, `SELECT … INTO`, `BEGIN/COMMIT/ROLLBACK`,
  `BEGIN TRY … END TRY BEGIN CATCH … END CATCH` (`ERROR_MESSAGE()`), `THROW/RAISERROR`, `CREATE [UNIQUE] [CLUSTERED] INDEX`.
  Datasets are read only: changing one works on a session copy. The result is the final `SELECT` (planned with the session
  catalog, streamed in parallel), else the last table created/changed. Tests: `tests/sql-cheatsheet.ps1` (every command in
  `ref-docs/*-sql-cheatsheet.md` + edge cases + Parquet row groups).
  Table functions: `read_dataset` = `read_arrow` = `read_parquet(file | folder | [list])` (Arrow or Parquet files), `read_csv(file, delim=, header=, …)`, `read_sqlite(file, table)`, `range(…)`.
  Functions: `Query/Functions.cs` (+ `choose`, `add_seconds`). Aggregates: `Query/Aggregates.cs`. Windows: `Query/Window.cs`.
- **Views:** every request may pass `views: { name: sql }`; the pages pass the project's datasets
  (`name → SELECT * FROM read_dataset('<dataset folder>')`) and pipeline steps.
- **Declarative queries** (`Query/QuerySpec.cs`): dashboard widgets send `{ dataset, groupBy, aggregate, where, sort, limit }`.
- **Parallelism:** one engine, `min(engineWorkers ≤ 64, logical cores)` worker threads. A scan + its filters/projections/join probes
  runs per unit (resident batch / Arrow record batch / Parquet row group) on the workers; aggregates are built per unit and merged **in unit order**, so
  answers are identical for any worker count. Join build sides are built on the coordinator thread; nested parallel work
  started from a worker runs inline (no pool deadlock). A query may limit its workers (`workers`, used by the benches).
- **Column pruning** (`Query/Optimizer.cs`): only the columns a query reads are read from Arrow / Parquet / CSV files.
- **Shared text** (`Arrow/TextIntern.cs`): repeated values read from Arrow, CSV or into memory are one string each, so a
  column of 10k distinct values in 10M rows holds 10k strings (less memory, far less garbage-collector work).
- **Top-N** (`ORDER BY … LIMIT n`, n ≤ 100k): each unit's best rows are found on the workers, then merged in unit order.
- **Memory guard** (`Core/MemoryGuard.cs`): budget = `engineMemory` (default 50%) of physical RAM. Sort, hash join build, hash
  aggregate, window and cached tables reserve what they hold; over budget → `QUERY_OUT_OF_MEMORY` (HTTP 507) instead of
  paging the machine. Parallel readers stop starting new row groups while free RAM is below max(512 MB, 10%).
  No disk spilling yet: a sort/join/window must fit the budget.
- **Resident datasets** (`Storage/ResidentDatasets.cs`): project datasets (`projects/<p>/data/source|staged/<name>/`) are
  loaded into memory on all workers (in the background: when a module page opens a project, on the first read, or on
  `memory/load`). A query reads the in-memory batches when the dataset's files (sizes + write times) still match, else
  it reads the files and reloads in the background. They share `ResidentFraction` (60%) of the budget; the least
  recently used is dropped to make room; a dataset larger than that stays on disk. A dataset write drops its entry.

### API (`/api/engine/*`, client `js/core/engine-client.js` = `Engine`)

| Call | Body → result |
|---|---|
| `GET status` | engine, version, workers, cores, memory, jobs |
| `POST query` | `{ sql \| query, views, limit, workers }` → `{ cols, types, rows, rowCount, truncated, ms }` (≤ 200k rows) |
| `POST describe` | `{ sql, views }` → `{ columns: [{ name, type }] }` |
| `POST preview` | `{ sql, views, limit }` → query result + `count` (script statements run once; rows and count in parallel) |
| `POST open` | `{ src, table }` → `{ kind, tables, columns, rows, size, modified }` |
| `POST write` | `{ sql, views, dest, meta, codec }` → job → dataset manifest |
| `POST export` | `{ sql, views, to, format: csv\|parquet\|sqlite, table }` → job → `{ path, rows, bytes }` |
| `POST pipeline` | `{ datasets: {name: path}, nodes: [{ id, name, sql, output, dest }], changed, version }` → job |
| `GET job?id=` / `POST job/cancel?id=` / `GET jobs` | job state, stage, progress, rows, result or error `{ code, message }` |
| `POST cache/load` / `cache/drop` | in-memory tables (engine bench) |
| `GET memory` / `POST memory/load` / `POST memory/drop` | resident datasets: list / `{ paths, wait }` load / `{ path }` drop |

Errors: `{ ok: false, error, code }` with codes like `CSV_INVALID_QUOTE`, `PARQUET_CORRUPT`, `PARQUET_UNSUPPORTED_CODEC`,
`SQL_SYNTAX`, `COLUMN_NOT_FOUND`, `PIPELINE_CYCLE`, `QUERY_OUT_OF_MEMORY`, `PATH_FORBIDDEN`. Details go to the server log.

## 6. Storage: datasets

```
data/staged/<name>/  or  data/source/<name>/
  part-000000.arrow     Arrow IPC file: one record batch per 100k rows, new part every 2M rows (EngineOptions.PartRows)
  dataset.json          { name, version, format: "arrow", rowCount, bytes, columns, partitions: [{ file, rows, bytes }], codec,
                          createdUtc, updatedUtc, lineage?: { pipelineStep, pipelineVersion, upstream: [{ dataset, version }] } }
```

- **Atomic writes** (`Storage/Datasets.cs` `DatasetWriter`): written into `<name>.tmp-xxxx/`, then the old folder is moved aside,
  the new one moved in, the old one deleted. A failed or cancelled write leaves the previous version untouched; `version` + 1.
- **Arrow IPC** (`engine/Arrow/ArrowIpc.cs`): own FlatBuffers writer/reader; `ARROW1` file = schema message + record batch
  messages + footer. Types: Int8/16/32/64, Float64, Decimal128, Utf8, Bool, Date32, Timestamp(us), all nullable (validity
  bitmaps); also reads unsigned ints, Float16/32, Date64, other timestamp units, LargeUtf8, Binary, Null. Uncompressed,
  8-byte aligned: a batch reads back with block copies. Files are read with short-lived shared FileStreams (never kept
  open or memory-mapped), so dataset folders can be swapped, archived or deleted at any time. pyarrow / DuckDB / Polars
  can open them. `EngineOptions.DatasetFormat = "parquet"` writes Parquet parts instead (benchmarks).
- **Parquet** (`engine/Parquet`, export and older datasets): own Thrift compact codec, writer (PLAIN, dictionary for repeated text, RLE definition levels,
  min/max stats) and reader (data pages v1/v2, PLAIN, dictionary, RLE, DELTA_*, BYTE_STREAM_SPLIT; Snappy, GZIP, none; flat
  schemas, nested columns skipped). **ZSTD/LZ4/Brotli files are rejected** (`PARQUET_UNSUPPORTED_CODEC`): re-import the source.
- **CSV** (`Providers/CsvProvider.cs`): the parser fills one record buffer (no string per field); ints, decimals and
  yyyy-MM-dd dates are parsed straight from it (exact: decimals are correctly rounded, the same parser as casts and SQL
  literals). Files over 16 MB are cut into byte ranges on record boundaries (one quote-aware byte
  scan, cached per file version), parsed in parallel, in file order; unread columns are not converted (count is fast).
  Streaming state machine (quotes, embedded delimiters/newlines, BOM), delimiter + header
  detection, types from a 20k-row sample; a later value that does not fit widens that column and the query re-runs.
- **SQLite** (`Providers/SqliteProvider.cs`): P/Invoke to `winsqlite3.dll`; import streams rows; export = one transaction + prepared INSERT.

**Data flow (only Import reads raw CSV / SQLite / Parquet / Arrow files; every dataset is Arrow):**

```
data/raw/ or X:\… / \\server\share\…   (read in place)
   │  Import: Engine.write({ sql: SELECT <columns> FROM read_csv/read_sqlite/read_dataset(...) })
   └─ Stage            column choices applied → data/staged/<name>/  (always; input for Pipeline)
data/staged ──Transform (active SQL query / script)──→ data/source/CLEAN_<name>/
data/source ──Dashboard / D3 Studio / Publish (export: Parquet / CSV / SQLite)
```

## 7. App modules (`html/*.html`)

- **Every module page** (`ModulePage.init`) starts loading the project's datasets into engine memory (`Engine.memory.preload`).

- **Windows + global header:** every module opens in its own window (95% of screen height, 16:10 width, centred; `Windows.open`); site windows
  use the same size (`Open-App`), the server panel 1200×800. No app shell, no Back buttons. `js/core/embed.js` adds the same header to
  every page: logo initials, Data Noodler, module · project, Web Server (PowerShell) status (`/api/status`, 5 s), Data Engine (C#) status (test query); `ONLINE`/`OFFLINE` only.
- **Import:** `Engine.open` (kind, tables, columns) → preview/count/type checks via `Engine.query` → `Engine.write` (job with
  progress) → checks columns/order/row count from the manifest → dataset record `{ path: folder, parts, version, … }`.
- **Transform** (`html/transform.html`, module id `pipeline`): a list of named SQL queries (each one SELECT or a script) in
  `SqlEditor`; one is **active**. Preview Output / Preview Source = `Engine.preview` (top 100 + count). Build Output Dataset =
  `PipelineRunner.run`: `Engine.write` of the active query → `data/source/<CLEAN_name>/` (Arrow parts, atomic). Saved in
  `pipeline/pipeline.json` `{ version: 2, queries: [{ id, name, sql }], active, output }`; run history in `pipeline/runs.json`.
  (`Engine.pipeline` / `RunPipeline`, the old step DAG, is no longer used by the app.)
- **Dashboard:** each widget = a chart package + declarative query (`ApexWidget.query`); before its first query a dataset is
  loaded into engine memory (`Engine.memory.load`, waits); result cache key = query + dataset version, so a new dataset
  version makes cached results stale.
- **Publish:** self-contained HTML (results embedded); dataset export to CSV / Parquet (single file) / SQLite via `Engine.exportTo`.
- **Update:** compares source size/modified, re-imports changed sources, then re-runs **only** the pipeline outputs downstream of them.
- **Archives:** folder copies (datasets are folders).
- **Benchmark** (`html/benchmark.html`, Project Manager > Utilities): imports, exports, reads / writes (memory, CSV, Parquet,
  Arrow, SQLite) and heavy queries for 100k-25M rows, any rows per batch (`POST /api/engine/options {batchRows}`) and 1 .. max
  workers; live cards, results table, results saved in `test-data/bench/benchmark.json`, reports in `test-data/bench/reports/`.
  `engine-test.html` = SQL console.

**Light/dark mode:** one global setting, `settings.json` `theme`, chosen in the server panel; pages follow via `js/core/theme.js`.
Project layout: `projects/<folder>/` with `data/raw`, `data/staged`, `data/source`, `pipeline/`, `dashboard/`, `publish/`, `archives/`.

## 7b. Chart packages (no widgets)

- No widgets for now (no `widget-studio/`, no `widgets/` folder). Charts are built in D3 Studio: `d3-studio/dev/<id>/` (Save) and `d3-studio/live/<id>/` (Publish copies dev to live). The Dashboard reads ONLY `d3-studio/live` (Dashboard > Charts; registry id `chart-<id>`).
- One package = `chart.json` manifest (+ `spec.json` = `{ $kind: 'd3', data: inputs, query: { sort, top } }`, `d3-code.js`, `sample.json`, `thumb.svg`, `style.css`). `ChartRegistry.list` = the live charts (`m.chart`) + the built-in Data Grid; `ChartRegistry.scan(<folder>)` lists any folder (D3 Studio uses it for dev).
- The Data Grid is core app code, not a package folder: `js/grid/data-grid-pkg.js` (`DataGrid.pkg()`: manifest + spec + style), renderer `js/grid/data-grid.js` (`DNGrid`), style `js/grid/data-grid.css` (`.GRID`), `grid-remote.js` (engine paging), `preview-grid.js` (Import / Transform previews). Grids already on a dashboard keep drawing; new ones are not added from the Dashboard.
- `style.css` (manifest `"style"`) is the chart's ONLY style, the same wherever it is drawn. `ApexWidget.useStyle(m, box)` puts it in the page with `.CHART` (or `.GRID`) -> `.dn-w-<id>` and tags the box; `--w-*` variables reach the code as `theme` (`ApexWidget.theme(box)`).
- The manifest drives Chart Settings (`ChartSettings`, `js/charts/chart-settings.js`, in `html/dashboard-settings.html`): `inputs` (each linked to `TABLE.FIELD`; dimension = group by, measure = aggregate) and `options` (`opts.<path>`; `show` hides one).
- Dashboard item `{ type: "widget" (stored name, kept for old files), pkg, dataset, inputs: { key: { col, agg } }, opts: { path: value }, sort, top }`. The engine runs `ApexWidget.query`; rows are re-keyed by input key and handed to `D3Render` (`js/charts/d3-render.js`, vendored d3 v7.9.0: `d3, data, el, W, H, colors, opts, theme, inputs` + capital accessors). Not linked yet: drawn with no data (axes / grid).
- **Axes + plug and play** (`ApexWidget.axisOf` / `labelOf` / `autoBind`): every input is named by its axis (X = bottom, left to right; Y = vertical value; Series = colour; manifest `horizontal` flips X/Y names; D3 Studio sets `input.axis` and detects `const y = d3.scaleBand`). Picking a dataset (or adding a widget when the project has one dataset) connects the inputs at once: same name, else X = text (date if the input looks like one), Y = first non-id number, Series only by name, Fields = all columns.
- Dashboard **Add widget** = popup listing packages by `category` (collapsible, open state in localStorage), 8 tiles per row (100 x 80 `thumb` or placeholder + name). Toolbar: Add widget, Options (Size Window, Refresh All), D3 Studio (`Windows.open('d3studio')`).
- Publish draws each widget (Apex) to SVG in the browser and embeds the static SVGs at their grid positions: the published page has no JavaScript.

