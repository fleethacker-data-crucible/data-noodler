# Changelog

Newest first. Dates are commit dates.

## 2026-10-10: Arrow engine (branch `dev-engine-validation`)

- **Arrow IPC is the working format.** Import (Stage) and Transform (Build Output Dataset) write datasets as
  `part-NNNNNN.arrow` + `dataset.json` (`format: "arrow"`). Hand-written Arrow IPC file reader / writer
  (`engine/Arrow/ArrowIpc.cs`: FlatBuffers, all engine types, validity bitmaps, column pruning). Parquet, CSV and SQLite
  are produced only on export. Existing Parquet datasets are still read; `read_parquet()` / `read_dataset()` /
  `read_arrow()` read either format.
- **Resident datasets.** Project datasets (`data/source`, `data/staged`) are held in engine memory
  (`engine/Storage/ResidentDatasets.cs`): loaded in the background when a module opens a project or on first read,
  shared by every window, checked against the files on every query (never stale), least recently used dropped when the
  in-memory share (60% of the engine budget) is full. API: `GET /api/engine/memory`, `POST memory/load`, `memory/drop`;
  client `Engine.memory`.
- **Dashboard** uses the engine's resident datasets instead of its own per-page in-memory tables.
- **Speed:** see `ref-docs/arrow after action report.md` (old vs new engine, rows/s per step).
- `EngineOptions.DatasetFormat` (`arrow` | `parquet`) and `ResidentFraction` (0 = off) for benchmarks.
- New tests: `tests/arrow-format.ps1`, `tests/bench-engine.ps1`, `tests/bench-compare.ps1`.
- Removed the unused vendored `js/vendor/apex-grid/` (the Data Grid is our own renderer since 3d0933a).
- Docs: README, CHANGELOG added; ARCHITECTURE, CODE_INDEX, PROJECT_PLAN brought up to date.

## 2026-10-09

- `ff5b0b5` D3 Studio charts: dev/live publish, live code file, settings, global menus and icons.
- `3d0933a` Own Data Grid renderer, per-widget style sheets, project Update workflow.

## 2026-10-08

- `e03a324` Store app manifest as binary so git keeps it byte-exact.
- `35bf93f` Dashboard: Apex-only widgets, settings pop-out, Filter + Data Grid, in-memory datasets.

## 2026-10-06

- `e84bad6` Single-file text bundle (`__app-package.ps1`: pack / unpack the whole app as `__app.manifest`).
- `d41ee05` Native C# data engine (replaced DuckDB-WASM), SQL pipeline, module windows + global header, widget packages.

## 2026-10-05

- `1356081` Ignore all data files (csv, parquet, sqlite, ...).
- `9ee984e` Server panel, app shell, path import, split Parquet, grid dashboard.

## 2026-10-04

- `efa70ba` Initial commit.
