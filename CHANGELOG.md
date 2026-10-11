# Changelog

Newest first. Dates are commit dates.

## 2026-10-11: Parallel full sort

- ORDER BY over all rows sorts one piece per worker at the same time, then merges the pieces in pairs (each merge
  also split across the workers), with a comparer that reads the key arrays directly. 5M rows by a mostly-unique text
  key: 8.2 s -> 1.1 s (12 workers); same order as before (ties by row position). Uses every core the machine has
  (workers = logical cores, up to 64). The Benchmark's fast steps repeat and keep the median; engine times keep
  fractions of a millisecond.

## 2026-10-11: SQLite reads 3x faster

- SQLite text is read through one reused buffer per reader and repeated values are shared (TextIntern), instead of
  two new arrays per value: 5M rows into memory 384k -> 1.18M rows/s on 12 workers (1 worker 207k -> 511k); same answers.

## 2026-10-11: Purge Memory frees everything

- Idle worker threads kept a reference to the last work they ran (whose closure can reach whole tables), so after
  Purge Memory up to several hundred MB stayed in use until the workers ran something new. Workers now drop their
  work item as soon as it finishes: 5M rows loaded + copied + queried, then purged: 731 MB -> 178 MB (the server
  process itself; managed memory 586 MB -> 7 MB).

## 2026-10-11: SQLite export on all workers

- **SQLite export** (5M rows: 345k -> about 1M rows/s, same rows, same order): rows are cut into 64k-row slices; every
  worker writes the slices it takes into its own piece file in `temp\write` (one table per slice); SQLite then copies the
  slice tables into the final table in row order with its raw record transfer (ATTACH + INSERT ... SELECT *). Text is
  packed into one UTF-8 buffer per column per slice (no per-value arrays), binds skip .NET's security stack walk, and
  the file is written with no journal / syncs (it is built at a staging path and swapped in). SQLite import already
  reads rowid ranges on all workers.
- **Benchmark:** Generate Test Data shows its progress in the page's progress bar, cards and activity log (no popup).

## 2026-10-11: All temporary data stays in <root>\temp

- Nothing temporary is written outside the app folder: `temp\engine` (compiled engine cache, was %LOCALAPPDATA%),
  `temp\browser` (app-window browser profiles, was %LOCALAPPDATA%), `temp\sys` (compiler scratch and .NET temp
  files: the server sets TEMP/TMP), `temp\write` (datasets and exports are built here, then swapped in; was a
  `.tmp-` folder beside the target inside the project), `temp\spill`, `temp\bench`. Deleting `temp` never touches a
  project. Only a user-chosen export path on another drive still stages beside the file.
- Crash leftovers in `temp\write` / `temp\spill` older than a day are removed when the engine starts.

## 2026-10-11: Queries spill to disk instead of running out of memory

- **GROUP BY, sorts, window functions, joins** work in memory first. When one would go over the engine memory budget it
  runs again with its input cut into pieces on disk (`temp\spill\q-*`, deleted when the query ends):
  GROUP BY / window (one shared PARTITION BY) / INNER and LEFT joins split rows by a hash of their keys into 64
  partitions and do each partition in memory (a partition still too big splits again); a full sort writes sorted runs
  and merges them. Disk only holds rows; all work happens in memory. Same answers (`tests/spill.ps1`: 7 queries at a
  40 MB budget). Still in memory only: GROUP BY with no keys (e.g. one COUNT DISTINCT), RIGHT / FULL / CROSS joins,
  windows with different PARTITION BYs.
- `status` memory now reports `spills` (count since start).

## 2026-10-11: In-memory tables spill to disk; Purge Memory

- **Cached tables spill:** `cache/load` keeps a table in RAM while it fits (below 70% of the engine budget, free RAM
  above the floor); past that the table is written to an Arrow dataset under `temp\spill` and read from
  its parts, so a 25M-row memory test no longer runs out of memory. Spills are deleted when the table is dropped and at
  engine start.
- **`memory/purge`** route + **Purge Memory** button on the Benchmark page: drops cached tables and resident datasets,
  then a compacting GC.
- **Benchmark cards:** live times always in seconds with one decimal.

## 2026-10-11: Data Grid and LIKE speed

- **Data Grid, sorted:** rows are fetched 1,000 at a time and pages served from that, so scrolling a sorted grid runs
  one sort per 1,000 rows instead of one per 100 (24 pages: about 0.3 s on 2M rows).
- **Data Grid search:** only columns whose text could hold the search term are searched (numbers / dates / true-false
  skipped when they cannot match); same rows as before.
- **LIKE / ILIKE:** patterns of text and `%` (`'%abc%'`, `'abc%'`, ...) are matched without a regex (text searches on
  2M rows: 3.4 s -> 0.1 s); `_` patterns still use the regex, which now anchors at the true end (`LIKE 'abc'` no longer
  matches `'abc'` + newline).
- Removed the `tools/` folder (DuckDB test-data scripts, dev only) and `html/apex-test.html` (unlinked dev page).

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
  Mostly-distinct text is kept in memory as Arrow UTF-8 buffers and decoded per query (no millions of long-lived strings
  for the garbage collector); resident sources skip the columns a query does not read.
- **Dashboard** uses the engine's resident datasets instead of its own per-page in-memory tables; every module page
  starts loading its project's datasets when it opens.
- **Faster engine paths:** shared strings for repeated text (`TextIntern`: Arrow reads, CSV reads, memory);
  zero-copy CSV field parser with exact int / decimal / date fast paths; one correctly rounded decimal parser for CSV,
  casts and SQL literals (.NET Framework's `double.Parse` can be one bit off) and number text checked with it;
  `ORDER BY … LIMIT` finds each unit's top rows on the workers; CSV export formats batches on the workers; window
  functions group partitions by hash and compute them in parallel (casts / defaults once, not per partition).
- **Speed (10M rows, 12 cores):** 2.6× faster overall than the old engine; CSV import 5.4×, ORDER BY … LIMIT 6.8×,
  window functions 7.4×, CSV export 4.3×, joins 2.2–2.3×, scans 4.4–4.5×. Full table: `arrow after action report.md`.
- `EngineOptions.DatasetFormat` (`arrow` | `parquet`) and `ResidentFraction` (0 = off) for benchmarks.
- New tests: `tests/arrow-format.ps1` (Arrow = Parquet answers, memory = disk answers), `tests/csv-compare.ps1` +
  `csv-diff.ps1` (old vs new engine on tricky CSVs and window queries), `tests/bench-engine.ps1` + `bench-compare.ps1`
  (old vs new speed) + `bench-report.py` / `.html` (comparison page).
- Removed the unused vendored `js/vendor/apex-grid/` (the Data Grid is our own renderer since 3d0933a) and unused engine
  methods (`Parser.ParseExpr`, `ParseOrder`, `MemoryGuard.WaitForRoom`, `Job.SetBytes`, SQLite `Decl`).
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
