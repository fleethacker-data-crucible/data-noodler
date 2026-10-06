# Data Noodler: How It Works

What actually happens from launch to query. Updated 2026-10-05 for the native C# engine (replaced DuckDB-WASM).
`CODE_INDEX.md` is the file map; this is the runtime story. Re-check line refs after edits.

## Ground rules

- **No DuckDB, no WebAssembly, no third-party DLLs.** The data engine is our own C# source (`engine/`), compiled at
  server start by PowerShell 5.1 `Add-Type` (C# 5 syntax only), using .NET Framework assemblies and Windows' `winsqlite3.dll`.
- **No installs, no admin.** Server is plain PowerShell + .NET `HttpListener`; browsers are the installed Edge/Chrome.
- **Project-relative paths only.** The folder can move to any machine.
- **`.trash/` is off-limits** unless explicitly asked (see `CLAUDE.md`). Retired DuckDB/sql.js files are in `.trash/duckdb-wasm-20261005/`.

## 1. Launch

```
start-server.cmd
  └─ powershell -WindowStyle Hidden -File .server/server.ps1
```

`server.ps1` startup, top to bottom:
1. `$root` = project folder (one up from `.server`), `$uiPort = 8079`, log file `.server/logs/Data_Noodler_Server_Logs_<time>.log`.
2. Loads `.server/settings.json` (`port`, `page`, `fileThreads`, `engineWorkers`, `engineMemory`).
3. Kills a stale instance via `.server/.pid`, writes its own PID.
4. Clears leftover `temp/upload-*.tmp`.
5. One `HttpListener` listens on **two ports**: **8079** = control panel, **site port** = the app (started/stopped from the panel).
6. **Engine:** `.server/engine-loader.ps1` hashes `engine/**/*.cs`; a cached DLL `%LOCALAPPDATA%\data-noodler\engine\NativeDataEngine-<hash>.dll`
   is loaded if present, else the sources are compiled with `Add-Type -CompilerParameters` (`/optimize+`, ~0.5 s) into that DLL.
   Then `New-DataEngine` creates the one `NativeDataEngine.DataEngine` (workers, memory guard). A compile error is logged and
   the site still runs (engine calls answer 503).
7. Opens the panel (`Open-App`: Edge, else Chrome, `--app` window, own profile in `%LOCALAPPDATA%\data-noodler\.profile`).
8. Main loop: one request at a time on the main thread, except plain static files (runspace pool) and engine calls (engine threads).
   Each loop pass also moves engine log lines into the server log (`Read-EngineLog`).

**Shutdown:** panel closes → `/api/bye` → exits after 4 s (a reload cancels it); or no heartbeat for 120 s; or the panel never
connects within 60 s. The engine is disposed (jobs cancelled, workers stopped).

## 2. Control panel (port 8079, `.server/server.html`)

- Polls `GET /api/log?since=` every 1 s. That poll **is the heartbeat**.
- `GET /api/state`: status, port, page, hits, uptime, list of `html/*.html` modules.
- **Engine check:** `GET /api/engine` runs `SELECT sum(range) FROM range(1000000)` in the engine and returns its status
  (version, workers, cores, memory budget). Shown as `READY <version> (<n> workers, <ms>)`; click to re-run.
- Buttons → `/api/site`, `/api/clear`, `/api/users`, Modules dialog, Settings dialog (port, browser, theme).
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
- The **engine reads the file in place** (read only): `read_csv('X:\…')`, `read_parquet('\\server\share\…')`. `PathGuard.Source`
  allows full paths only for data files (csv/tsv/txt/parquet/pq/sqlite/sqlite3/db). Writes stay inside the project.
- `/api/import/read` and `copy` still exist but the app no longer uses them.

## 5. Native engine (`engine/`, namespace `NativeDataEngine`)

```
EngineApi (HTTP, own thread) ─► DataEngine ─► Parser (SQL) ─► Planner ─► Optimizer.Prune ─► operators ─► WorkerPool
                                   │                                                          │
                                   ├─ Jobs (write / export / pipeline: id + progress + cancel) │
                                   ├─ MemoryGuard (budget, reservations, free-RAM floor)       │
                                   └─ sources: ParquetSource (row groups), CsvSource, SqliteSource, RangeSource, MemSource
```

- **Columnar batches** (`engine/Arrow`): `Column` = typed array (`long[]` ints/dates/timestamps, `double[]` doubles/decimals,
  `string[]`, `bool[]`) + null flags; `Batch` = columns + schema. Dates = days since 1970, timestamps = microseconds.
- **SQL** (`Query/SqlParser.cs`): DuckDB-style subset: `WITH`, `SELECT [DISTINCT]`, `* EXCLUDE (…)`, joins (INNER/LEFT/RIGHT/FULL/CROSS,
  `ON` / `USING`), `WHERE`, `GROUP BY [ALL]`, `HAVING`, `ORDER BY [ALL]`, `LIMIT/OFFSET`, `UNION [ALL]`, window functions,
  `CAST/TRY_CAST/::`, `CASE`, `IN`, `BETWEEN`, `LIKE/ILIKE`, `FILTER (WHERE …)`, lateral aliases, `DESCRIBE`.
  Table functions: `read_parquet(file | folder | [list])`, `read_csv(file, delim=, header=, …)`, `read_sqlite(file, table)`, `range(…)`.
  Functions: `Query/Functions.cs` (+ `choose`, `add_seconds`). Aggregates: `Query/Aggregates.cs`. Windows: `Query/Window.cs`.
- **Views:** every request may pass `views: { name: sql }`; the pages pass the project's datasets
  (`name → SELECT * FROM read_parquet('<dataset folder>')`) and pipeline steps.
- **Declarative queries** (`Query/QuerySpec.cs`): dashboard widgets send `{ dataset, groupBy, aggregate, where, sort, limit }`.
- **Parallelism:** one engine, `min(engineWorkers ≤ 64, logical cores)` worker threads. A scan + its filters/projections/join probes
  runs per Parquet row group on the workers; aggregates are built per row group and merged **in row-group order**, so
  answers are identical for any worker count. Join build sides are built on the coordinator thread; nested parallel work
  started from a worker runs inline (no pool deadlock). A query may limit its workers (`workers`, used by the benches).
- **Column pruning** (`Query/Optimizer.cs`): only the Parquet columns a query reads are decoded.
- **Memory guard** (`Core/MemoryGuard.cs`): budget = `engineMemory` (default 50%) of physical RAM. Sort, hash join build, hash
  aggregate, window and cached tables reserve what they hold; over budget → `QUERY_OUT_OF_MEMORY` (HTTP 507) instead of
  paging the machine. Parallel readers stop starting new row groups while free RAM is below max(512 MB, 10%).
  No disk spilling yet: a sort/join/window must fit the budget.

### API (`/api/engine/*`, client `js/core/engine-client.js` = `Engine`)

| Call | Body → result |
|---|---|
| `GET status` | engine, version, workers, cores, memory, jobs |
| `POST query` | `{ sql \| query, views, limit, workers }` → `{ cols, types, rows, rowCount, truncated, ms }` (≤ 200k rows) |
| `POST describe` | `{ sql, views }` → `{ columns: [{ name, type }] }` |
| `POST open` | `{ src, table }` → `{ kind, tables, columns, rows, size, modified }` |
| `POST write` | `{ sql, views, dest, meta, codec }` → job → dataset manifest |
| `POST export` | `{ sql, views, to, format: csv\|parquet\|sqlite, table }` → job → `{ path, rows, bytes }` |
| `POST pipeline` | `{ datasets: {name: path}, nodes: [{ id, name, sql, output, dest }], changed, version }` → job |
| `GET job?id=` / `POST job/cancel?id=` / `GET jobs` | job state, stage, progress, rows, result or error `{ code, message }` |
| `POST cache/load` / `cache/drop` | in-memory tables (engine bench) |

Errors: `{ ok: false, error, code }` with codes like `CSV_INVALID_QUOTE`, `PARQUET_CORRUPT`, `PARQUET_UNSUPPORTED_CODEC`,
`SQL_SYNTAX`, `COLUMN_NOT_FOUND`, `PIPELINE_CYCLE`, `QUERY_OUT_OF_MEMORY`, `PATH_FORBIDDEN`. Details go to the server log.

## 6. Storage: datasets

```
data/staged/<name>/  or  data/source/<name>/
  part-000000.parquet   Snappy, 100k-row row groups, new part every 2M rows (EngineOptions.PartRows)
  dataset.json          { name, version, rowCount, bytes, columns, partitions: [{ file, rows, bytes }], codec,
                          createdUtc, updatedUtc, lineage?: { pipelineStep, pipelineVersion, upstream: [{ dataset, version }] } }
```

- **Atomic writes** (`Storage/Datasets.cs` `DatasetWriter`): written into `<name>.tmp-xxxx/`, then the old folder is moved aside,
  the new one moved in, the old one deleted. A failed or cancelled write leaves the previous version untouched; `version` + 1.
- **Parquet** (`engine/Parquet`): own Thrift compact codec, writer (PLAIN, dictionary for repeated text, RLE definition levels,
  min/max stats) and reader (data pages v1/v2, PLAIN, dictionary, RLE, DELTA_*, BYTE_STREAM_SPLIT; Snappy, GZIP, none; flat
  schemas, nested columns skipped). **ZSTD/LZ4/Brotli files are rejected** (`PARQUET_UNSUPPORTED_CODEC`): re-import the source.
- **CSV** (`Providers/CsvProvider.cs`): streaming state machine (quotes, embedded delimiters/newlines, BOM), delimiter + header
  detection, types from a 20k-row sample; a later value that does not fit widens that column and the query re-runs.
- **SQLite** (`Providers/SqliteProvider.cs`): P/Invoke to `winsqlite3.dll`; import streams rows; export = one transaction + prepared INSERT.

**Data flow (only Import reads CSV/SQLite; every dataset is Parquet):**

```
data/raw/ or X:\… / \\server\share\…   (read in place)
   │  Import: Engine.write({ sql: SELECT <columns> FROM read_csv/read_sqlite/read_parquet(...) })
   └─ Stage            column choices applied → data/staged/<name>/  (always; input for Pipeline)
data/staged ──Pipeline (ordered SQL queries, each with an output name)──→ data/source/<name>/
data/source ──Dashboard / Publish
```

## 7. App modules (`html/*.html`)

- **Windows + global header:** every module opens in its own window (85% of the screen, centred; `Windows.open`); the server
  panel and site windows use 85% too (`Open-App`). No app shell, no Back buttons. `js/core/embed.js` adds the same header to
  every page: logo initials, Data Noodler, module · project, Server status (`/api/status`, 5 s), Engine status (test query).
- **Import:** `Engine.open` (kind, tables, columns) → preview/count/type checks via `Engine.query` → `Engine.write` (job with
  progress) → checks columns/order/row count from the manifest → dataset record `{ path: folder, parts, version, … }`.
- **Pipeline:** an ordered list of SQL queries typed in `SqlEditor` (left: staged datasets, then queries); each query needs an
  output dataset name and may read staged datasets and earlier outputs by name. Preview = `Engine.query` over views; Run = `Engine.pipeline`:
  the engine parses each step, finds its inputs, rejects cycles, orders the DAG, validates every step, then writes the output
  steps (up to 3 at once) with lineage. Run history in `pipeline/runs.json`.
- **Dashboard:** each widget = declarative query (`Widgets.query`); cache key = query + dataset version, so a new dataset version
  makes cached results stale.
- **Publish:** self-contained HTML (results embedded); dataset export to CSV / Parquet (single file) / SQLite via `Engine.exportTo`.
- **Update:** compares source size/modified, re-imports changed sources, then re-runs **only** the pipeline outputs downstream of them.
- **Archives:** folder copies (datasets are folders).
- **Benches:** `engine-bench.html` (worker counts, Auto, profile → `config/engine-profile.json`), `thread-bench.html` (worker sweep),
  `engine-test.html` (SQL console), `generate-test-parquet-files.html` (test datasets via the engine).

**Light/dark mode:** one global setting, `settings.json` `theme`, chosen in the server panel; pages follow via `js/core/theme.js`.
Project layout: `projects/<folder>/` with `data/raw`, `data/staged`, `data/source`, `pipeline/`, `dashboard/`, `publish/`, `archives/`.

## 7b. Widget packages

- `widgets/<id>/` = one package: `widget.json` manifest (+ `spec.json` for Vega / Vega-Lite). Valid manifests are listed by `WidgetRegistry` and appear in Dashboard > Add widget. `chart` / `table` are `kind: builtin` (rendered by `js/dashboard/widgets.js`).
- The manifest drives the settings popout (`WidgetSettings`) in both the Widget Builder and the Dashboard: `inputs` (each `field` in the spec; dimension = group by, measure = aggregate) and `options` (spec paths: colour, number, switch, choice, text; `show` hides one from the dashboard).
- Dashboard widget `{ type: "widget", pkg, dataset, inputs: { key: { col, agg } }, opts: { path: value }, limit }`. The engine runs `VegaWidget.query` (group by dims, aggregate measures as `v_<key>`); rows are inlined into the spec, field paths are pointed at the result columns.
- Theme: `VegaWidget.theme()` builds a Vega config from css/theme.css variables (fonts, axis/legend colours, `--c1..c8` category range). Colour options left at "Theme" (null) follow it.
- Published dashboards skip Vega widgets for now.

## 8. Tests

`powershell -NoProfile -ExecutionPolicy Bypass -File tests\engine-tests.ps1 [-Big]` (85 checks incl. `-Big` 4M-row CSV run):
CSV parsing and widening, expressions, aggregates, joins, windows, Parquet round trips (all types, nulls, 3 codecs), Snappy,
determinism at 1/2/4/N workers, CSV/SQLite/Parquet round trips, failed/cancelled writes keep the last dataset, corrupt and ZSTD
Parquet, path guard, pipeline DAG (order, lineage, incremental update, cycles), memory guard.
