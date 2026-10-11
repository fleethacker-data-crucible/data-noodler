# Arrow After Action Report

Branch `dev-engine-validation` · 2026-10-10 · baseline = commit `7594849` (your work in progress from `d3-studio-charts`)

Comparison page (old vs new, every step): https://claude.ai/artifact/VZHCJgkEFnjWKG86deTG9c

## 1. Summary

You asked for:

1. A check of the engine against the two design docs in `ref-docs/`.
2. A rework so Arrow is used for everything internal: raw files convert to Arrow on disk, datasets load into memory for
   Transform / Dashboard / D3 Studio, and Parquet / CSV / SQLite only appear on export.
3. A review of D3 Studio against its doc.
4. A cleanup of unused code, and the README / changelog / architecture / code index made accurate.
5. Old vs new numbers, with the winning setup made the default.
6. Nothing broken.

What happened:

- **Arrow is now the working format.** Import writes `data/staged/<NAME>/part-NNNNNN.arrow` and Transform writes
  `data/source/CLEAN_<NAME>/part-NNNNNN.arrow`. These are real Arrow IPC files, which pyarrow, DuckDB and Polars can open.
  Parquet, CSV and SQLite are written only by Publish / export. Your existing Parquet datasets still open and query; each
  one becomes Arrow the next time it is staged or built.
- **Datasets live in engine memory while you work.** Opening any module for a project starts loading its datasets
  into RAM in the background. Every window shares them. A dataset that changes on disk is reloaded, and is never served
  stale. If the in-memory share (60% of the engine budget) runs out, the least recently used dataset is dropped first.
- **Four setups were measured:**
  1. Old engine.
  2. New engine reading Parquet from disk.
  3. New engine reading Arrow from disk.
  4. New engine with Arrow held in memory.

  **Arrow + memory wins and is now the default.** It is **2.6× faster overall** (geometric mean of 15 steps) and **2.9×
  on the query steps**, on 10 million rows.
- **Nothing broke.** Every check passes:
  - 158 SQL dialect checks.
  - 34 Arrow / memory checks.
  - A 180,114-value old-vs-new comparison of CSV reading and window functions: 0 differences, apart from 3 decimals
    where the old engine was off by one bit (section 6).
  - A click-through of Import, Transform, Dashboard, D3 Studio and Publish in the real app.
- **Biggest wins:** CSV import 5.4×, window functions 7.4×, `ORDER BY … LIMIT` 6.8×, CSV export 4.3×, scans 4.5×,
  joins 2.2–2.3×, GROUP BY 2.0–2.9×.
- **Not faster:**
  - COUNT DISTINCT on a 1M-value text column: 0.8×.
  - Transform write: 0.9×.
  - Parquet export: 0.9×.

  Repeat runs vary by about ±10%, and the old engine happened to run on the fast side in the final round. Section 5
  explains each.

## 2. What the docs asked for vs what the engine had

The engine doc (*Optimal Design Review: In-Browser Analytics Engine*) describes 7 phases. Before this work the engine
had:

| Doc phase | Before | Now |
|---|---|---|
| 0. Runtime | PowerShell 5.1, .NET Framework 4.8 (CLR 4.0.30319.42000), C# 5 compiler, **64-bit: yes**, 12 cores, 16 GB | same (constraint) |
| 1. Arrow as the only internal format | Columnar batches "Arrow-style" in memory, but **Parquet on disk** for every dataset | **Arrow IPC on disk + in memory**; Parquet only on export |
| 2. CSV → Arrow ingester | Parallel byte-range parser, but **one string per field**, `StreamReader` decode, `long.TryParse` per value | Same parallel ranges + **one record buffer, no string per field**, exact fast parsers for ints / decimals / dates, shared strings for repeated text; writes Arrow |
| 3. Memory manager + spill | Memory budget + reservations, **no spill** | Budget kept; **resident datasets** (LRU within 60% of budget); **spill not built** (see 7) |
| 4. Vectorized execution | Batch-at-a-time, parallel per row group, hash join / hash aggregate | Same + parallel top-N, parallel window partitions, column pruning for in-memory sources |
| 5. Parquet exporter | Full Parquet writer (Snappy, dictionary, stats) | Unchanged; now the export path only |
| 6. Server + browser | JSON results (≤200k rows), job polling, Data Grid pages through the engine | Unchanged (Arrow IPC to the browser not built, see 7) |
| 7. Benchmark + report | Benches by worker count | `tests/bench-compare.ps1` (old vs new, 4 setups) + this report |

The D3 Studio doc (*Build Plan: D3 Studio*) is short in your copy. It stops after the intro, so its phases are not in
the file. Its one principle is **"generate a spec, not per-chart D3 code"**. Section 8 covers how that fits.

## 3. What changed

### Engine (`engine/`)

| File | Change |
|---|---|
| `Arrow/ArrowIpc.cs` (new) | Arrow IPC file format, hand-written. FlatBuffers writer + reader. Types: Int8–64, Float64, Decimal128, Utf8, Bool, Date32, Timestamp(µs), validity bitmaps. Reads more: unsigned ints, Float16/32, Date64, other timestamp units, LargeUtf8, Binary, Null. Column pruning reads only the byte ranges a query needs. `ArrowSource` = one parallel unit per record batch. |
| `Storage/ResidentDatasets.cs` (new) | In-memory datasets: background load on all workers, signature check (file sizes + write times) on every query, LRU, memory accounting. Mostly-distinct text is kept as Arrow bytes. |
| `Arrow/TextIntern.cs` (new) | Shared strings for repeated text (CSV fields, Arrow buffers, memory). A 10M-row column with 10k distinct values holds 10k strings, not 10M. |
| `Storage/Datasets.cs` | `DatasetWriter` writes Arrow parts (or Parquet when `EngineOptions.DatasetFormat = "parquet"`). |
| `Core/DataEngine.cs` | `read_dataset` / `read_parquet` / `read_arrow` read either format and use memory when the dataset is resident. Dataset writes are Arrow. CSV export formats batches on the workers. |
| `Core/EngineApi.cs` | `GET memory`, `POST memory/load {paths, wait}`, `POST memory/drop {path}`. |
| `Providers/CsvProvider.cs` | Zero-copy record parser; fast exact parsing; shared text; pre-sized column builders handed over without a copy. |
| `Arrow/DataSchema.cs` | Exact decimal parser (`FastDouble`, `FastLong`, `FastDate`). Number text checked with it. A column can hold text as Arrow bytes and decode on first use. |
| `Query/Operators.cs` | Parallel top-N for `ORDER BY … LIMIT`. In-memory sources prune unread columns and give each query its own copy of byte-text columns. |
| `Query/Window.cs` | Partitions grouped by hash and computed in parallel. Casts / defaults worked out once, not once per partition. |
| `Query/SqlParser.cs`, `Optimizer.cs`, `Aggregates.cs` | SQL literals use the exact parser; pruning knows Arrow / memory sources; one `ref` fix. |

### App (`js/`, `html/`, `.server/`)

- `js/core/engine-client.js`: `Engine.memory.load / preload / info / drop`. Datasets are referenced as `read_dataset(...)`.
- `js/core/module-page.js`: every module page preloads its project's datasets.
- `html/dashboard.html`: the Dashboard's own per-page memory tables are replaced by the engine's resident datasets.
  This is simpler, and other windows share them.
- `html/import.html`, `html/transform.html`: wording says Arrow; `.arrow` / `.feather` files can be imported.
- `js/pipeline/runner.js`, `html/import.html`: delete logic also knows legacy single `.arrow` files.
- `.server/import-api.ps1`, `.server/server.ps1`: `.arrow` accepted / served.

### Cleanup

- Removed `js/vendor/apex-grid/` (441 KB, 41 files): nothing loads it since the Data Grid became your own renderer.
- Removed unused engine methods: `Parser.ParseExpr`, `Parser.ParseOrder`, `MemoryGuard.WaitForRoom`, `Job.SetBytes`,
  SQLite `Decl` + its import.
- A full scan (every function in `js/`, `html/`, `engine/`, `.server/`) found no other unreferenced code.

### Docs

- `README.md` and `CHANGELOG.md` added (there were none).
- `.claude/docs/ARCHITECTURE.md`, `CODE_INDEX.md` (rewritten) and `PROJECT_PLAN.md` updated. Stale facts fixed:
  - the launcher is `Data Noodler.lnk`;
  - `start-server.cmd` and the root `.trash/` do not exist;
  - the Vega files and `apex-grid` are gone;
  - `pdf.js`, `pptx.js`, `syntax-library.html`, `apex-test.html`, the `rebuild-shortcut.ps1` / `__app-package` tools and
    `tools/` were missing from the index.

### Tests (all in `tests/`)

| Script | What it proves | Result |
|---|---|---|
| `sql-cheatsheet.ps1` | Every command in both SQL cheatsheets + edge cases | 158 / 158 |
| `arrow-format.ps1` (new) | Arrow dataset = Parquet dataset for every type, NULLs, Unicode, decimals, multi-part, pruning, empty data. Exports. Memory = disk for joins, windows, scripts with UPDATE, DISTINCT, LIKE, string_agg. Stale-data check. | 34 / 34 |
| `csv-compare.ps1` + `csv-diff.ps1` (new) | Runs the **old engine** (git worktree of `7594849`) and the new one on tricky CSVs (quotes, embedded newlines, CRLF, BOM, blank lines, whitespace numbers, leading zeros, exponents, type widening past the 20k-row sample, semicolons, no header, booleans, an 800k-row parallel file) and 5 window queries over 30k rows, comparing every value | 180,111 identical, 3 last-bit decimal fixes, 0 different |
| `bench-engine.ps1` / `bench-compare.ps1` / `bench-report.py` (new) | Old vs new speed, one fresh process per setup | Section 4 |

## 4. Benchmark

**Machine:** 12 logical cores, 15.9 GB RAM, Windows PowerShell 5.1.26100.9444, .NET 4.0.30319.42000, 64-bit.

**Data:** generated 10,000,000-row, 11-column CSV (631 MB). Columns:
- `order_id`, `store_id`;
- a 10k-value text key and a 1M-value text column;
- region (8 values), category (25 values);
- quantity, price, a 5%-NULL discount;
- a date and a 5%-NULL note.

There's also a 10,000-row dimension table. Each setup ran in its own fresh process on the same data. Query steps ran 3
times and the median is shown. Every step's answer matched across all four setups.

Setups:
1. **Old engine**: the app before this work, with Parquet datasets read from disk every query.
2. **New · Parquet**: new engine, Parquet datasets, no memory.
3. **New · Arrow disk**: Arrow datasets read from disk every query.
4. **New · Arrow + memory**: Arrow datasets resident in memory. **This is the app's default now.**

| Step | Rows | Old engine | New · Parquet | New · Arrow disk | New · Arrow + memory | Speed-up (old → Arrow + memory) |
|---|---:|---:|---:|---:|---:|---:|
| Import CSV -> dataset (write) | 10,000,000 | 22,055 ms · 453,404 rows/s | 4,672 ms · 2,140,568 rows/s | 4,042 ms · 2,473,787 rows/s | 4,092 ms · 2,444,113 rows/s | **5.4×** |
| Full scan count(*) WHERE | 10,000,000 | 61.4 ms · 162,924,030 rows/s | 70.7 ms · 141,359,939 rows/s | 74.3 ms · 134,643,323 rows/s | 13.6 ms · 733,864,162 rows/s | **4.5×** |
| Filter numeric + 2 columns | 10,000,000 | 131 ms · 76,298,660 rows/s | 158 ms · 63,132,349 rows/s | 194 ms · 51,506,992 rows/s | 29.7 ms · 336,781,981 rows/s | **4.4×** |
| Calculations (6 expressions) | 10,000,000 | 1,126 ms · 8,879,768 rows/s | 1,144 ms · 8,743,197 rows/s | 1,649 ms · 6,065,590 rows/s | 1,021 ms · 9,795,506 rows/s | **1.1×** |
| GROUP BY 10k key, sum+count | 10,000,000 | 203 ms · 49,254,411 rows/s | 187 ms · 53,562,495 rows/s | 427 ms · 23,416,676 rows/s | 70.3 ms · 142,195,123 rows/s | **2.9×** |
| GROUP BY 2 cols, 5 aggregates | 10,000,000 | 426 ms · 23,499,714 rows/s | 422 ms · 23,671,777 rows/s | 531 ms · 18,846,067 rows/s | 217 ms · 46,079,148 rows/s | **2.0×** |
| COUNT DISTINCT high-card text | 10,000,000 | 1,564 ms · 6,394,387 rows/s | 1,524 ms · 6,562,634 rows/s | 1,900 ms · 5,262,269 rows/s | 1,882 ms · 5,313,725 rows/s | **0.8×** |
| Hash join fact x dim + group | 10,000,000 | 310 ms · 32,284,236 rows/s | 285 ms · 35,137,874 rows/s | 319 ms · 31,348,120 rows/s | 142 ms · 70,651,705 rows/s | **2.2×** |
| Join + filter both sides | 10,000,000 | 276 ms · 36,226,227 rows/s | 257 ms · 38,894,766 rows/s | 282 ms · 35,526,642 rows/s | 120 ms · 83,148,605 rows/s | **2.3×** |
| ORDER BY double LIMIT 100 | 10,000,000 | 3,968 ms · 2,520,423 rows/s | 783 ms · 12,767,790 rows/s | 1,000 ms · 9,995,914 rows/s | 587 ms · 17,047,124 rows/s | **6.8×** |
| Window: rank per key (1/10 rows) | 1,000,000 | 943 ms · 1,060,690 rows/s | 370 ms · 2,698,944 rows/s | 514 ms · 1,947,582 rows/s | 127 ms · 7,879,829 rows/s | **7.4×** |
| Preview top 100 + count | 10,000,000 | 182 ms · 55,003,171 rows/s | 141 ms · 71,078,560 rows/s | 181 ms · 55,231,500 rows/s | 40.1 ms · 249,069,104 rows/s | **4.5×** |
| Transform write (filter+calc) | 10,000,000 | 1,286 ms · 7,775,428 rows/s | 1,249 ms · 8,004,012 rows/s | 1,722 ms · 5,805,620 rows/s | 1,490 ms · 6,708,979 rows/s | **0.9×** |
| Export Parquet (Snappy) | 10,000,000 | 3,004 ms · 3,328,966 rows/s | 3,147 ms · 3,177,249 rows/s | 3,202 ms · 3,123,439 rows/s | 3,242 ms · 3,084,579 rows/s | **0.9×** |
| Export CSV | 10,000,000 | 24,066 ms · 415,516 rows/s | 6,403 ms · 1,561,864 rows/s | 6,862 ms · 1,457,207 rows/s | 5,545 ms · 1,803,511 rows/s | **4.3×** |

Other figures:

| | Old engine | New · Parquet | New · Arrow disk | New · Arrow + memory |
|---|---:|---:|---:|---:|
| Dataset on disk | 209 MB | 209 MB | 832 MB | 832 MB |
| Peak process memory | 1.2 GB | 1.6 GB | 1.7 GB | 3.4 GB |
| Load 10M rows into memory | – | – | – | 2.3 s (886 MB resident) |

**Geometric-mean speed-up vs the old engine:**

| Setup | All steps | Query steps only |
|---|---:|---:|
| New · Parquet | 1.45× | 1.28× |
| New · Arrow disk | 1.17× | 0.98× |
| New · Arrow + memory | **2.65×** | **2.89×** |

### How the work moved the numbers (Arrow + memory, first build → final)

| Step | First build | Final | Change |
|---|---:|---:|---:|
| Import CSV → dataset | 18,270 ms | 4,092 ms | 4.5× |
| Load into memory | 5,298 ms (2.5 GB) | 2,251 ms (0.9 GB) | 2.4× |
| Hash join + group | 912 ms | 142 ms | 6.4× |
| Join + filter | 1,000 ms | 120 ms | 8.3× |
| ORDER BY … LIMIT | 4,044 ms | 587 ms | 6.9× |
| Window | 1,145 ms | 127 ms | 9.0× |
| Export CSV | 22,148 ms | 5,545 ms | 4.0× |
| COUNT DISTINCT high-card text | 1,223 ms | 1,882 ms | 0.65× (trade-off, see 5) |

## 5. Why the winner won, and the trade-offs

- **Arrow + memory** wins because queries skip disk and decoding entirely. Numbers and dates are already typed arrays in
  RAM, repeated text is already shared strings, and every query runs on all 12 workers over in-memory batches.
- **Arrow on disk alone is not faster than Parquet on disk** for analytics (0.98× on queries).
  - Arrow files are uncompressed: 832 MB vs 209 MB here.
  - Parquet's dictionary pages give repeated text for free.

  That is why memory is the default, and why the doc's "Arrow everywhere" only pays off with the in-memory layer. If a
  dataset is bigger than the in-memory share, it is read from its Arrow files, about Parquet speed or a little below.
- **Memory use is higher by design:** 3.4 GB peak at 10M rows, against a 5.1 GB in-memory cap on your 16 GB machine.
  The engine budget and the LRU keep it bounded.
- **Not faster:**
  - **COUNT DISTINCT on a 1M-value text column (0.8×).** To keep memory low and joins fast, mostly-distinct text is kept
    as Arrow bytes and turned back into strings for queries that read it. Keeping it as strings (the first build) was
    1.2 s, but cost 2.5 GB and made every join 3–6× slower, because .NET's garbage collector had to walk 10 million
    strings. The bytes approach is the better overall deal.
  - **Transform write (0.9×) and Parquet export (0.9×).** Writing 4× larger uncompressed Arrow files (308 MB vs 124 MB)
    costs a little disk time. Parquet export does the same Parquet encoding as before. Both are within the ±10% run-to-run
    noise.

## 6. Correctness notes

- **Decimal parsing is now exactly right.** .NET Framework's `double.Parse` is sometimes one bit off: `0.39266239`
  becomes the next double up. The new engine parses decimals exactly (correctly rounded) everywhere: CSV, `CAST`, and
  number literals in SQL. A value in a file therefore always equals the same number typed in a query. Only 3 of 180,114
  compared values changed, all by that one bit.
- **Number display is cleaner.** .NET Framework's round-trip formatting depended on that same parser, so some values
  showed with 17 digits. The old engine showed `65766.406207` from a CSV as `65766.406206999993`; the new engine shows
  `65766.406207`.
- **Stale data is impossible by construction.** Every query checks the dataset's file sizes and write times before
  using memory, and every dataset write drops its memory copy.

## 7. Doc items deliberately not built (and why)

| Item | Why not |
|---|---|
| Spill to disk (Arrow IPC spill files) for sorts / joins / windows bigger than the budget | Large, risky change to every blocking operator. Today they fail cleanly with `QUERY_OUT_OF_MEMORY` (as before). Next step in `PROJECT_PLAN.md`. |
| Memory-mapped reads, `ArrayPool`, unmanaged buffers, `Span<T>`, `Vector<T>` | Not available or not practical on .NET Framework 4.8 with the C# 5 compiler and no NuGet / third-party DLLs. Memory-mapping would also keep dataset files locked, which breaks the atomic swap, archives and deletes. Reads use short-lived shared file streams instead. |
| Arrow IPC to the browser (typed arrays, no JSON) | Would touch every page that shows rows. The Data Grid already pages through the engine 100 rows at a time and charts aggregate in the engine, so JSON volumes stay small. Listed as next. |
| Server GC | Tested: .NET Framework ignores the environment switch, and turning it on needs an admin-owned config file next to `powershell.exe`. The text-sharing / bytes changes removed most of the GC pressure instead. |
| Arrow compression (LZ4 / ZSTD) | No built-in codec in .NET Framework. Files stay uncompressed (the format's fastest option). |
| 100M-row run | Ran 10M rows (631 MB CSV) for every setup to keep runs comparable and inside disk / time limits. `bench-compare.ps1 -Rows 100000000` runs it. |
| Per-chart code → spec-only D3 Studio | Conflicts with your CLAUDE.md design (see 8); not changed without your decision. |

**Red-flag code scans (doc phases 2–6)** on the engine:

- **No hits:** `List<string[]>`, `DataTable`, `dynamic`, `ReadAllBytes`, `JsonConvert`, a synchronous `GetContext()`
  loop.
- **Off the hot path (fine):**
  - `string.Split`: type names and path segments.
  - `StreamReader.ReadLine`: 30 lines for delimiter detection.
  - `Convert.ToDouble`: constants and scalars.
  - `MemoryStream`: one Parquet page at a time.
  - `JavaScriptSerializer`: small request bodies; results use our own writer.
- **One real one left:** joins and GROUP BY on **several** key columns build boxed `object[]` keys per row in some cases
  (`Join.cs` composite keys; `Aggregates.cs` above 6 columns). Single-column keys and up to 6 GROUP BY columns are already
  typed. Good next optimization.

## 8. D3 Studio review

**What exists:** per-chart D3 code (`d3-studio/dev/<id>/d3-code.js`), inputs bound to `TABLE.FIELD`, a declarative
engine query per chart (`ApexWidget.query`), and Save / Publish dev → live.

**The doc's principle** is a chart spec plus one renderer, with no per-chart code.

**How they compare:**
- **Already in line with the doc:**
  - Data enters only through named inputs (the doc's "slots").
  - Bindings are `TABLE.FIELD`.
  - Aggregation runs in the engine, so the browser never gets raw rows.

  With this work those queries run on in-memory Arrow data. D3 Studio's preview of CLEAN_SUMMARY ran in 0 ms of engine
  time in the click-through.
- **Different:** each chart carries its own D3 code. Your `CLAUDE.md` makes that the design ("ONLY edit
  `d3-studio/dev/<id>/d3-code.js`"), so I did not replace it.

**Recommendation if you want the doc's model:** keep the code path, and add a "spec" chart kind next to it. A chart
would then be `chart.json` slots + marks / axes / scales, drawn by one shared renderer in `js/charts/`. Common charts (bar,
line, area, scatter, pie) become specs anyone can make without code, and custom charts keep their D3 code. That is a
D3 Studio feature project, not an engine change.

**No D3 Studio code changed in this work** apart from the shared engine client.

## 9. Things I found that need your eye

- `projects/staggs-test`'s `project-config.json` lists two datasets, `CLEAN_` and `CLEAN_TEST`, whose folders no longer
  exist. They were already broken before this work. The Dashboard ignores them (it reads `data/source` from disk), but
  you may want to remove the records.
- `tools/make-sales-parquet.ps1` downloads and uses the DuckDB CLI. It's a dev-only tool, not part of the app, but it
  goes against the "no DuckDB" rule if anyone runs it.
- `html/apex-test.html` is a dev page nothing links to. I kept it (it is in the Modules list).

## 10. How to re-run everything

```
powershell -NoProfile -ExecutionPolicy Bypass -File tests\sql-cheatsheet.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\arrow-format.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\csv-compare.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\bench-compare.ps1 -Rows 10000000 -Tag final
python tests\bench-report.py final        # rebuilds the comparison page in temp\bench\
```

## 11. Commits on `dev-engine-validation`

1. `7594849` Baseline: your WIP from `d3-studio-charts`, committed so every change after it can be reviewed on its own.
2. `a87f345` Engine: Arrow IPC working format, resident in-memory datasets.
3. `0d7e8f1` App: Arrow datasets end to end, engine memory API, Dashboard uses resident datasets.
4. `f0b9d72` Engine speed: shared text, zero-copy CSV, exact number parsing, parallel top-N and CSV export, cleanup.
5. `c6fb44a` Engine: text kept as Arrow bytes in memory, parallel window partitions.
6. The final commit: last speed fix, docs, report, test tools, repacked `__app.manifest`.

Nothing was pushed. To merge, review the branch and merge it into `master` when you're ready.
