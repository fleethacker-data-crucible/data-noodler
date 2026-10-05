# Data Noodler — Project Plan

## Vision

Data Noodler is a fully local, self-contained data analytics app. It runs in the browser, is served by the project's own PowerShell server, and works on flat files kept inside the project folder.

- The entry point is the **Project Management** home page (`html/home.html`, the server's default page).
- Each analytics project lives in its own folder, and every project folder has the same layout.
- Work happens in modules, each opened in its own window: **Import Data → Pipeline → Dashboard → Publish → Update → Archives**.

## Hard constraints

- **Self-contained and local.** No CDNs, no package managers, no network calls to outside services at runtime. Every library (DuckDB-WASM and its extensions, sql.js, fonts) is vendored in the repo.
- **Stack:** HTML, CSS and JavaScript for the UI, served by `.server/server.ps1`. PowerShell only on the server side. No admin rights needed.
- **No executables.** No `.exe`, no Node.js, no native DLLs. The data engine runs in the browser (WASM/JS).
- **Paths are relative to the project root**, never absolute, so the folder can move between machines.
- **File access stays inside the project root.** The app uses `js/dn-fs.js` (`DNFS`) → `/api/fs/*`. Data gets into the project by upload or by copying it in manually.
- **Modular code.** Small single-purpose files and modules with a narrow API each, so errors stay contained. No massive files. See `CODE_INDEX.md`. Support docs may live in `.claude/`.
- **Windows.** Every module opens as its own 1400×1000 window, centered.

## Universal theme

- Dark theme, shared by every page through one stylesheet (`css/theme.css`), matching the server control panel (`.server/server.html`): DN logo header, uppercase section headings, flat panels with border lines.
- Fonts: Exo 2 for the UI, Syne Mono for logs and data/monospace text (both in `assets/fonts/`).
- Buttons: 25px tall, blue, 4px rounded corners, solid fill, everywhere. Grey = cancel/secondary, red = destructive, green = main action.
- Disabled (not built yet) buttons are greyed out and not clickable.

## Project structure on disk

```
projects/
  <project-folder>/
    project-config.json     settings, status, classification, owner, datasets, module last runs
    data/
      source/               original files as imported (csv, sqlite, parquet)
      staged/               converted Parquet: the working format (imports + pipeline outputs)
      cache/                dashboard widget result caches (disposable)
    pipeline/               pipeline.json (steps), runs.json (history)
    dashboard/              dashboard.json (widgets)
    publish/                published dashboards (self-contained HTML) and dataset exports
    archives/               snapshots: config + staged data + pipeline + dashboard
    logs/                   activity-YYYY-MM.log
  .trash/                   deleted projects (moved here by the server, recoverable from disk)
```

- **Phase:** `not-started`, `planning`, `development`, `testing`, `production`.
- **Status:** percent complete, `0`, `25`, `50`, `75`, `100`.
- **Classification:** `unclassified`, `unnpi`, `cui`.
- **Last Updated** = `modules.update.lastRun` (`-` if never). Older configs are migrated on read.
- `datasets[]` in the config: `{ name, path, rows, bytes, columns[{name,type}], imported, source{ kind, path, table, select, size, modified } }`.

## Data engine (findings)

- **DuckDB-WASM 1.33.1-dev57 (DuckDB v1.5.4), single-threaded build (`eh`)** is the engine, in `js/duckdb/`, loaded from the server.
  - Extensions are vendored in `js/duckdb/ext/v1.5.4/<platform>/` and loaded from the server only (`custom_extension_repository`): `httpfs` (HTTP range reads), `parquet`.
  - The **threaded build (`coi`) is not usable**: the official threaded extensions do not link with it ("mismatch in shared state of memory"), and Parquet support is an extension. Kept testable in `html/thread-bench.html`.
- **Parallelism = several engines** (`js/duckdb-pool.js`): each engine is its own worker with its own ~4 GB, work is split by row range (or by key hash for per-key work), each engine runs a "partial" query, and one engine combines them with a "final" query.
- **Optimal engine profile** (`js/duckdb/optimal-engine-profile.json`): measured by `html/engine-bench.html` (Profile) on the generated test datasets, best engine count per query kind (scan, group, distinct, sort, join, window) and row count. `js/core/data-engine.js` picks the engine count from the entry nearest the row count.
- **Server:** HTTP range requests (206), `Last-Modified`/`ETag`, COOP/COEP headers, and up to `fileThreads` (16) file requests served in parallel.
- **SQLite:** DuckDB's sqlite extension cannot open files in DuckDB-WASM, so Import reads SQLite with the vendored sql.js and hands tables to DuckDB as typed CSV (limited by browser memory).
- **GPU (WebGPU):** works on this machine and is 5–18× faster than DuckDB for numeric aggregates on data already on the GPU; exact only with integer cents (no 64-bit floats). Candidate for interactive dashboard filtering later (`js/gpu-compute.js`, `html/gpu-bench.html`).
- **Known limits:** ~4 GB per engine, little disk spilling; CSV is read whole at import; very large single-step outputs are built in memory before upload.

## Phases

### Phase 0: Foundation ✅
- [x] Local server, control panel, live log, session log files (`.server/`)
- [x] Project-root file API with security checks + `DNFS` client

### Phase 0.5: Engine validation ✅
- [x] Load DuckDB-WASM from served URLs; range reads over HTTP; write-back via `DNFS`
- [x] Threaded build tested (not usable, see findings); engine pool built and benchmarked instead
- [x] Test datasets: `html/generate-test-parquet-files.html` → 9 datasets, 0.5M–100M rows × 50 columns in `test-data/gen/`
- [x] Engine profile: `html/engine-bench.html` Profile / Profile all → `optimal-engine-profile.json`
- [ ] Full profile of all 9 datasets (running unattended; re-run any time to refine)

### Phase 1: Shared foundation + Project Management home page ✅ prototype
- [x] `css/theme.css`, `js/core/` (`ui.js`, `projects.js`, `project-log.js`, `windows.js`, `module-page.js`, `data-engine.js`)
- [x] `html/home.html`: projects table with search/filter/sort, create, edit, rename (folder follows), delete → `projects/.trash` (server endpoint `/api/project/trash`), expandable rows with module buttons and recent activity
- [x] Module windows open with `window.open` (centered 1400×1000, `?project=<folder>`) instead of a server endpoint

### Phase 2: Import Data ✅ prototype
- [x] Upload or pick files in `data/source/`; CSV, Parquet, SQLite (all tables)
- [x] Preview, schema detection, rename/retype/drop columns, check conversions before import
- [x] Convert to `data/staged/<dataset>.parquet` (ZSTD, 100k row groups), verify row count, register the dataset, log

### Phase 3: Pipeline ✅ prototype
- [x] Steps: filter, add columns, choose/rename, group & summarise, join, sort/limit, SQL; each step is a view
- [x] Preview any step; run writes output steps to `data/staged/` as datasets; run history

### Phase 4: Dashboard ✅ prototype
- [x] Widgets: KPI, bar, line, table; SVG charts; definitions in `dashboard/dashboard.json`
- [x] Aggregates run on the engine pool sized by the profile; results cached in `data/cache/`

### Phase 5: Publish ✅ prototype
- [x] Dashboard as one self-contained HTML file with the results built in; dataset export to CSV or Parquet

### Phase 6: Update ✅ prototype
- [x] Detect changed source files, re-import with the original column choices, re-run the pipeline, show row/column changes

### Phase 7: Archives ✅ prototype
- [x] Snapshots (server `copy` file API), compare with current, restore (auto-snapshot first), delete

### Next: debugging and hardening
- [ ] Run every module in real Chrome/Edge windows (the built-in test pane cannot open pop-ups)
- [ ] Large-file paths: chunked writes for outputs over ~1 GB, CSV imports of multi-GB files
- [ ] Use the engine profile in Pipeline runs (today: single engine)
- [ ] GPU path for dashboard filtering

## Working rules

- New code goes in new small files (`js/core/`, `js/<module>/`, `html/<module>.html`, `css/`).
- Keep `CODE_INDEX.md` and this plan updated at the end of each phase.
