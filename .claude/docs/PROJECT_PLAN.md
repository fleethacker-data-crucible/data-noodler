# Data Noodler — Project Plan

## Vision

Data Noodler is a fully local, self-contained data analytics app. It runs in the browser, is served by the project's own PowerShell server, and works on flat files kept inside the project folder.

- The entry point is the **Project Manager** page (`html/project_manager.html`, hard-coded entry point).
- Each analytics project lives in its own folder, and every project folder has the same layout.
- Work happens in modules, each opened in its own window: **Import Data → Transform → Dashboard (+ D3 Studio) → Publish → Update → Archives**.

## Hard constraints

- **Self-contained and local.** No CDNs, no package managers, no network calls to outside services at runtime. Fonts are vendored; the data engine is C# source in `engine/`.
- **Stack:** HTML, CSS and JavaScript for the UI, served by `.server/server.ps1`. PowerShell only on the server side. No admin rights needed.
- **No executables, no WebAssembly, no third-party DLLs.** No `.exe`, no Node.js, no DuckDB. The data engine is plain C# (C# 5) compiled at server start by PowerShell 5.1 `Add-Type` (our own DLL, cached in `%LOCALAPPDATA%`), using only .NET Framework assemblies and Windows' `winsqlite3.dll`.
- **Paths are relative to the project root**, never absolute, so the folder can move between machines.
- **File access stays inside the project root.** The app uses `js/dn-fs.js` (`DNFS`) → `/api/fs/*`. Data gets into the project by upload or by copying it in manually.
- **Modular code.** Small single-purpose files and modules with a narrow API each, so errors stay contained. No massive files. See `CODE_INDEX.md`. Support docs live in `.claude/docs/`.
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
      raw/                  raw files copied in for Import (csv, sqlite, parquet, arrow)
      staged/               Import output: Arrow datasets (part-NNNNNN.arrow + dataset.json), the working format
      source/               Transform output: CLEAN_* Arrow datasets (Dashboard, D3 Studio, Publish read these)
      cache/                dashboard widget result caches (disposable)
    pipeline/               pipeline.json (queries), runs.json (history)
    dashboard/              dashboard.json (widgets)
    publish/                published dashboards (self-contained HTML) and dataset exports
    archives/               snapshots: config + datasets + pipeline + dashboard
    logs/                   activity-YYYY-MM.log
  .trash/                   deleted projects (moved here by the server, recoverable from disk)
```

- **Phase:** `not-started`, `planning`, `development`, `testing`, `production`.
- **Status:** percent complete, `0`, `25`, `50`, `75`, `100`.
- **Classification:** `unclassified`, `unnpi`, `cui`.
- **Last Updated** = `modules.update.lastRun` (`-` if never). Older configs are migrated on read.
- `datasets[]` in the config: `{ name, path, rows, bytes, columns[{name,type}], imported, source{ kind, path, table, select, size, modified } }`.

## Data engine (native C#, replaced DuckDB-WASM on 2026-10-05)

- **Why:** the target PCs may not run DuckDB or WebAssembly. Plans: `01-native-windows-data-engine-plan.md`, `02-dashboard-project-module-plan.md`, `03-starter-code-map.md`.
- **Where:** `engine/**/*.cs`, compiled by `.server/engine-loader.ps1`, one `DataEngine` per server, `/api/engine/*` (see ARCHITECTURE.md 5).
- **Storage:** every dataset is a folder of `part-NNNNNN.arrow` (Arrow IPC, 100k-row record batches, 2M-row parts) + `dataset.json` (version, format, columns, partitions, lineage); writes go to a temp folder and are swapped in atomically. Parquet / CSV / SQLite are export formats; older Parquet datasets are still read.
- **Memory:** a project's datasets are held resident in engine memory while it is open (up to 60% of the engine budget, least recently used dropped first); queries read RAM, and a dataset changed on disk is reloaded.
- **Reads:** CSV (zero-copy field parser, type inference, widening), Arrow IPC, Parquet (Snappy/GZIP/none; ZSTD rejected: re-import), SQLite (`winsqlite3.dll`). Sources outside the project are read in place, read-only.
- **Queries:** DuckDB-style SQL subset (joins, GROUP BY ALL, windows, CTEs, UNION) and declarative widget queries; parallel by row group on min(64, cores) workers; results are the same for any worker count.
- **Memory guard:** budget = 50% of RAM (`engineMemory`); sort/join/group/window state is reserved against it and fails with `QUERY_OUT_OF_MEMORY` instead of filling RAM; readers pause when free RAM is low.
- **Known limits:** no disk spilling yet (big sorts/joins must fit the budget), results reach the browser as JSON (capped rows; Arrow IPC to the browser not built), no Excel. Speed per step: `arrow after action report.md` (`tests/bench-compare.ps1`).

## Phases

### Phase 0: Foundation ✅
- [x] Local server, control panel, live log, session log files (`.server/`)
- [x] Project-root file API with security checks + `DNFS` client

### Phase 0.5: Engine validation ✅
- [x] Load DuckDB-WASM from served URLs; range reads over HTTP; write-back via `DNFS` (superseded by the native engine)
- [x] Threaded build tested (not usable, see findings); engine pool built and benchmarked instead
- [x] Test datasets: `html/generate-test-parquet-files.html` → 9 datasets, 0.5M–100M rows × 50 columns in `test-data/gen/`
- [x] Engine profile: `html/engine-bench.html` Profile / Profile all → `optimal-engine-profile.json`
- [ ] Full profile of all 9 datasets (running unattended; re-run any time to refine)

### Phase 1: Shared foundation + Project Manager page ✅ prototype
- [x] `css/theme.css`, `js/core/` (`ui.js`, `projects.js`, `project-log.js`, `windows.js`, `module-page.js`, `engine-client.js`)
- [x] `html/project_manager.html`: projects table with search/filter/sort, create, edit, rename (folder follows), delete → `projects/.trash` (server endpoint `/api/project/trash`), expandable rows with module buttons and recent activity
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

### Phase 8: Arrow engine ✅ (2026-10-10)
- [x] Arrow IPC dataset format (own FlatBuffers reader / writer); Parquet only on export
- [x] Resident datasets in engine memory, shared by every window, never stale
- [x] Shared text values, zero-copy CSV parsing, exact number parsing, parallel top-N and CSV export
- [x] Old vs new benchmark (`tests/bench-compare.ps1`) and CSV reader comparison (`tests/csv-compare.ps1`)
- [ ] Spill to disk (Arrow IPC) for sorts / joins / windows larger than the budget
- [ ] Arrow IPC results to the browser (Data Grid paging, big previews)

### Next: debugging and hardening
- [ ] Run every module in real Chrome/Edge windows (the built-in test pane cannot open pop-ups)
- [ ] Large-file paths: chunked writes for outputs over ~1 GB, CSV imports of multi-GB files
- [ ] Use the engine profile in Pipeline runs (today: single engine)

## Working rules

- New code goes in new small files (`js/core/`, `js/<module>/`, `html/<module>.html`, `css/`).
- Keep `CODE_INDEX.md` and this plan updated at the end of each phase.
