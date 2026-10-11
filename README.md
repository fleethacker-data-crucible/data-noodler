# Data Noodler

A fully local, self-contained data analytics app for Windows. It runs in Edge or Chrome, is served by the project's
own PowerShell server, and does all of its data work in its own C# engine (no DuckDB, no WebAssembly, no third-party
DLLs, no installs, no admin rights).

## Start

- Double-click **`Data Noodler.lnk`** (rebuild it with `rebuild-shortcut.ps1` if the folder moved).
- Or run `powershell -NoProfile -ExecutionPolicy Bypass -File .server\server.ps1`.

The server compiles the engine (`engine/**/*.cs`, cached as a DLL in `temp\engine\`) and opens the
**Project Manager**. The red **Server Control** button opens the control panel (port 8079: status, engine check, live log).

## How data flows

```
raw file (CSV / Parquet / Arrow / SQLite, in data/raw or read in place from X:\ or \\server\share)
   │ Import ── Stage: column choices applied
   ▼
data/staged/<NAME>/        part-NNNNNN.arrow + dataset.json      ← Arrow IPC: the working format
   │ Transform ── SQL query / script
   ▼
data/source/CLEAN_<NAME>/  part-NNNNNN.arrow + dataset.json
   │ Dashboard · D3 Studio · Publish
   ▼
Export only: Parquet (Snappy) · CSV · SQLite        (Publish, Data Grid export, archives for distribution)
```

- **Arrow on disk, Arrow in memory.** Every dataset is a folder of Arrow IPC files (standard `.arrow`; pyarrow / DuckDB /
  Polars can read them). When a project is opened in a module, its datasets are loaded into engine memory in the
  background and every query (Transform previews, Dashboard widgets, Data Grids, D3 Studio) reads RAM. A dataset that
  changes on disk is reloaded; one too large for the engine's in-memory share is read from its parts instead.
- **Parquet is an export format.** Older projects whose datasets are Parquet keep working; a dataset becomes Arrow the
  next time it is staged or built.

## Modules

| Module | Page | What it does |
|---|---|---|
| Project Manager | `html/project_manager.html` | Projects (create, edit, rename, trash), module buttons, Update workflow. Entry point. |
| Import | `html/import.html` | Pick or link a raw file, set column names / types, Stage it as an Arrow dataset. |
| Transform | `html/transform.html` | Named SQL queries (SELECT or scripts); the active one builds `data/source/CLEAN_*`. |
| Dashboard | `html/dashboard.html` | Charts from D3 Studio + Data Grids on a grid layout; queries run in the engine. |
| D3 Studio | `html/d3-studio.html` | Build D3 charts (code + inputs linked to TABLE.FIELD); Publish to the Dashboard. |
| Publish | `html/publish.html` | Web app / PDF / PowerPoint / images of a dashboard; dataset export (CSV / Parquet / SQLite). |
| Archives | `html/archives.html` | Snapshots of a project, compare, restore. |
| Benchmark | `html/benchmark.html` (Utilities menu) | Engine speed: imports, exports, reads / writes, heavy queries by rows, batch size and workers. |
| SQL console | `html/engine-test.html` | Run SQL against the engine. |

## Tests and benchmarks

```
powershell -NoProfile -ExecutionPolicy Bypass -File tests\sql-cheatsheet.ps1    # SQL dialect: 158 checks
powershell -NoProfile -ExecutionPolicy Bypass -File tests\arrow-format.ps1      # Arrow = Parquet answers, memory, exports
powershell -NoProfile -ExecutionPolicy Bypass -File tests\spill.ps1             # GROUP BY / sort / window / join spill to disk
powershell -NoProfile -ExecutionPolicy Bypass -File tests\bench-compare.ps1     # old vs new engine, rows/s per step
```

## Rules for working on it

See `CLAUDE.md` (project rules) and `.claude/docs/`: `ARCHITECTURE.md` (how the server, file API and engine work),
`CODE_INDEX.md` (file map), `PROJECT_PLAN.md`, `THEME_GUIDE.md`. Changes are listed in `CHANGELOG.md`.

- Windows PowerShell 5.1 only on the server; engine code is C# 5 (compiled by `Add-Type`).
- `.ps1` files are ASCII only.
- Paths are relative to the project root; the site only reads and writes inside it.
- Data files (`*.csv`, `*.parquet`, `*.arrow`, `*.sqlite`, ...) are never committed.
