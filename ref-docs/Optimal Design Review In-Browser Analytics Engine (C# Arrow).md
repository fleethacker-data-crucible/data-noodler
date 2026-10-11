# Optimal Design Review: In-Browser Analytics Engine (C# / Arrow)

Oct 10, 2026 · @Christopher Staggs

## How to use this document

Opus: this is your build plan. Work through the phases **in order**. For each phase: build what the phase specifies, then run its **Checkpoint** against the existing code and your new code, fix every red flag it names, and report the checkpoint results to Chris before starting the next phase. Do not skip ahead; each phase assumes the previous one passed.

Where code already exists for a phase, treat the phase as a review-and-conform step: diff the current implementation against the spec, list what differs with file and function names, and bring it into line before the checkpoint.

**Hard constraints:** no third-party DLLs, executables or NuGet packages. Everything is C# compiled in-process by PowerShell `Add-Type`, hosted as an `HttpListener` server, serving a browser frontend. Target workload: a CSV of \~100 million rows ingested, joined, aggregated and exported to Parquet on one machine with limited RAM.

**Phase 0 — confirm the runtime before anything else.** Report whether this is Windows PowerShell 5.1 (legacy C# 5 compiler, .NET Framework 4.x) or PowerShell 7 (Roslyn, .NET 6+), and whether `[Environment]::Is64BitProcess` is true. Several later instructions (`Span<T>`, `ArrayPool<T>`, `Utf8Parser`, `Vector<T>`) depend on this; where a feature is unavailable, use the fallback named in that phase.

## Phase 1 — Target architecture (read, do not build yet)

The optimal shape is a single-process columnar engine with Arrow as the only internal format, memory-mapped spill files, and Parquet produced only at the export boundary.

| Layer | Optimal choice | Why |
| --- | --- | --- |
| Host | PowerShell `Add-Type` compiles one C# assembly in memory; 64-bit process only | 32-bit caps the process at \~2–4 GB; `[Environment]::Is64BitProcess` must be true |
| Server | `HttpListener` on localhost, async handlers, streamed responses | Avoids blocking threads during long queries; keeps the UI responsive |
| Internal format | Arrow columnar buffers (validity bitmap + offsets + data) for every column, everywhere | One layout for memory, spill and IPC; zero conversion between stages |
| Ingestion | Parallel chunked CSV parser writing Arrow record batches of 64k–1M rows | Bounded memory per chunk; chunks are independently spillable |
| Memory | Pooled, pinned or memory-mapped buffers; no per-row objects; no `List<object[]>` | Keeps the GC and the Large Object Heap out of the hot path |
| Spill | Arrow IPC file per batch on SSD, memory-mapped on read | Reading a spilled batch costs a page map, not a copy |
| Execution | Vectorized operators over whole batches; hash join; hash aggregate; late materialization | Linear scaling; CPU cache-friendly; what DuckDB does |
| Export | Minimal Parquet writer: PLAIN encoding, optional Snappy, row groups of \~128 MB | Readable by pandas, DuckDB, Spark; a fraction of the spec |
| Frontend | Browser fetches Arrow IPC streams over HTTP; renders paged slices | Never JSON-serialize 100M rows |

## Phase 2 — Build the ingester: CSV to Arrow

Ingestion should run at close to disk read speed (300 MB/s to 2 GB/s on SSD) and never hold more than a few batches in memory at once.

1. **Read the file in large byte blocks** (16–64 MB) with `FileStream` and a big buffer, or memory-map the CSV. Never `File.ReadAllLines` or `StreamReader.ReadLine` per row.
2. **Split into chunks on newline boundaries** so each chunk can be parsed by a separate thread. Handle a quoted newline by scanning for the chunk boundary with quote-state tracking, or fall back to sequential parsing when quotes are detected in the header sample.
3. **Parse bytes, not strings.** Work on `byte[]` or `Span<byte>` directly: find delimiters with `IndexOf`, parse numbers with `Utf8Parser` (.NET Core) or a hand-rolled integer and double parser. Creating one `string` per cell for 100M rows × N columns is the single most common cause of a slow ingester.
4. **Infer types once** from a sample of the first \~10k rows, then parse every column with a fixed typed parser. Promote on failure (int64 → double → string) by re-parsing only that column's chunk.
5. **Build Arrow buffers directly** per column per chunk: a validity bitmap, a fixed-width data buffer for numerics, and offsets + data buffers for strings. Use dictionary encoding for low-cardinality string columns (cardinality under \~10% of rows).
6. **Emit record batches of 64k to 1M rows** and hand each to the spill manager immediately. Use a bounded producer-consumer queue (`BlockingCollection` with a capacity of 2–4 batches) so parsing cannot outrun writing.
7. **Parallelism**: one parser thread per core, one writer thread. Measure: a correct implementation parses 100M rows of \~10 columns in roughly 1–3 minutes on a laptop.

**Red flags to look for in the code:** `string.Split`, `StreamReader.ReadLine`, `List<string[]>`, `Convert.ToDouble(string)`, `DataTable`, boxing into `object`, or any per-row allocation in the parser.

**Checkpoint 2 — do not proceed until all pass:**

- [ ] Grep the ingester for every red flag above; zero hits.
- [ ] Ingest a generated 10M-row, 10-column CSV; record wall time and peak working set (`Get-Process` `WorkingSet64`). Peak must stay under 3 batches' worth of memory regardless of file size.
- [ ] Ingest the same file at 100M rows; wall time must scale roughly 10×, not worse.
- [ ] Read one spilled `.arrow` file back and confirm the schema and row count match.
- [ ] Report the numbers to Chris.

## Phase 3 — Build the memory manager and spill-to-disk

The engine should behave like a buffer pool: a fixed memory budget, batches pinned while in use, evicted to Arrow IPC files on SSD when the budget is exceeded, and re-read by memory mapping rather than copying.

**Memory budget.** Set a hard cap (for example 60–70% of physical RAM, read from `GC.GetGCMemoryInfo()` or WMI) and track bytes per resident batch. The GC does not know about memory-mapped pages, so the cap must be enforced by the engine, not by waiting for `OutOfMemoryException`.

**Buffer allocation.** Every Arrow buffer over 85 KB lands on the Large Object Heap, which is collected only in Gen 2 and is not compacted by default. Optimal handling, in order of preference:

- Allocate column buffers from `ArrayPool<byte>.Shared` or a custom pool and return them on eviction, so the LOH stops churning.
- Or allocate unmanaged memory (`Marshal.AllocHGlobal`, `NativeMemory` on .NET 6+) and wrap it in `Memory<T>` via a custom `MemoryManager<T>`; this keeps 100M rows of data entirely outside the GC heap.
- Set `GCSettings.LatencyMode = GCLatencyMode.SustainedLowLatency` and enable Server GC (`<gcServer enabled="true"/>` is not available through `Add-Type`, so set `GCSettings` and `GCLargeObjectHeapCompactionMode` in code where possible).

**Spill files.** One Arrow IPC file per record batch (or per column chunk for very wide tables), written with a sequential `FileStream` of 1 MB buffer size and `FileOptions.SequentialScan`. File name = `{table}/{batch_id}.arrow`. The IPC format is a schema message plus a record-batch message with 8-byte-aligned buffers, so a spilled batch is already the in-memory layout.

**Reading spilled batches.** `MemoryMappedFile.CreateFromFile` with `MemoryMappedFileAccess.Read`, then `CreateViewAccessor` or, on .NET Core, an `unsafe` pointer from `SafeMemoryMappedViewHandle.AcquirePointer` wrapped in a `Span<T>`. Operators then read column data directly from the mapped pages; the OS page cache does the caching. Never `ReadAllBytes` a spill file back into a managed array.

**Eviction policy.** LRU over batches, with a pin count so a batch currently being scanned or sitting in a hash table cannot be evicted. Intermediate results (join output, sorted runs) follow the same path as ingested data: they are batches, they count against the budget, they spill the same way.

**Red flags:** `byte[]` reads of spill files, `new double[100_000_000]`, `List<T>` growing by doubling over large data, `MemoryStream` holding a whole table, or no explicit memory accounting.

**Checkpoint 3 — do not proceed until all pass:**

- [ ] Grep for every red flag above; zero hits.
- [ ] Set the memory budget to 25% of RAM and ingest the 100M-row file; the process must spill and finish without `OutOfMemoryException`, and the working set must hover at the budget, not climb.
- [ ] Scan a spilled table end to end twice; the second scan should be faster (page cache) and allocate near zero managed memory (`GC.GetTotalAllocatedBytes` delta).
- [ ] Confirm a pinned batch is never evicted mid-scan (write a test that scans while forcing eviction).
- [ ] Report the numbers to Chris.

## Phase 4 — Build the query execution engine

Build a vectorized, batch-at-a-time engine: every operator takes an Arrow record batch in and produces one out, with no per-row virtual calls, no boxing, and no row objects. This is the phase where a hand-rolled engine most often goes wrong, so follow the operator specs exactly.

**Execution model.** A pull-based (Volcano-style) pipeline where `Next()` returns a batch of \~64k–1M rows, not a row. Operators are typed per column: generate or hand-write one tight loop per primitive type (`long`, `double`, `bool`, string offsets) rather than a generic loop over `object`. Where the runtime allows, use `Span<T>` over the Arrow buffers and `System.Numerics.Vector<T>` for arithmetic and comparisons; on .NET Framework, fall back to `unsafe` pointer loops over pinned arrays.

**Scan + filter.** Read only the columns the query references (projection pushdown). Evaluate predicates into a selection vector (an `int[]` of surviving row indices, or a bitmap) and pass the batch plus selection vector downstream; do not copy rows out of the batch to filter them. Use the Arrow validity bitmap for null checks with word-at-a-time operations.

**Hash join.** Build on the smaller input: hash the key column(s) into an open-addressing table keyed by a 64-bit hash with the row index as payload, sized to a power of two at \~50% load. Probe with the larger input one batch at a time, emitting matched row-index pairs, then gather output columns from both sides by index (late materialization). Handle multi-column keys by hashing the combined bytes. When the build side exceeds the memory budget, partition both sides by hash into N spill files and join partition by partition (Grace hash join). Never a nested loop; never `Dictionary<string, List<Row>>`.

**Hash aggregate (GROUP BY).** Same open-addressing table keyed by the group key; aggregate state (`sum`, `count`, `min`, `max`, and `sum`+`count` for `avg`) stored in parallel typed arrays indexed by group slot, updated in place per batch. Partition and spill groups when the table exceeds the budget. For low-cardinality keys (under \~1000 groups) a direct-indexed array beats hashing.

**Sort / ORDER BY.** Sort row indices by key, not rows; use `Array.Sort` on a key array with an index payload, or a radix sort for integer keys. For data exceeding memory, produce sorted runs of batch size and k-way merge them from spill files. Apply `LIMIT` with a bounded heap instead of a full sort.

**Expressions.** Compile expressions once per query into a tree of typed vector kernels (`AddDoubleDouble`, `CompareLongConst`, etc.), each operating on a whole column at once. Do not interpret the expression tree per row.

**Parallelism.** Partition the input batches across cores for scan, filter, and the probe side of joins; build the hash table in parallel with per-thread tables merged at the end, or a lock-free concurrent insert. Use `Parallel.For` over batch indices; keep the degree of parallelism at `Environment.ProcessorCount`.

**Red flags:** `foreach (var row in rows)`, `object[]` rows, `dynamic`, `IComparable` boxing, `LINQ` over row sequences on the hot path, `string` concatenation to build join keys, `Dictionary<object, …>`, a nested loop anywhere in a join, or any operator that materializes the whole table before emitting.

**Checkpoint 4 — do not proceed until all pass:**

- [ ] Grep for every red flag above; zero hits on the hot path.
- [ ] Join a 10M-row table to a 1M-row table on an integer key; then 100M to 1M. Wall time must scale linearly in the probe side.
- [ ] `GROUP BY` a 100M-row table on a 10k-cardinality key with `sum` and `count`; target under 10 seconds on 8 cores.
- [ ] Filter 100M rows on a numeric predicate; target over 500M rows/second per core.
- [ ] Run each benchmark with the memory budget at 25% of RAM; results must be identical and the engine must spill rather than fail.
- [ ] Report the numbers to Chris.

## Phase 5 — Build the Parquet exporter

Build the smallest Parquet writer that mainstream readers accept. Parquet is an export boundary only; never use it as the internal or spill format.

**Scope — implement exactly this and nothing more:**

- File layout: `PAR1` magic, row groups, a Thrift-compact-encoded `FileMetaData` footer, 4-byte footer length, `PAR1` magic. You must hand-write a minimal Thrift compact-protocol encoder (varints, zigzag, field headers, structs, lists); it is \~200 lines.
- Physical types: `INT32`, `INT64`, `DOUBLE`, `BOOLEAN`, `BYTE_ARRAY` (strings, with the `UTF8`/`STRING` logical type annotation). Map Arrow timestamps to `INT64` with the `TIMESTAMP` logical type.
- Encoding: `PLAIN` for all data pages; `RLE` for definition levels only (required for nullable columns; max definition level 1, no repetition levels since there are no nested types). Optionally add `RLE_DICTIONARY` for strings later; not in this phase.
- Compression: `UNCOMPRESSED` first, then `SNAPPY` (hand-rolled; the format is \~150 lines of C#). Do not attempt Zstd or GZIP via `System.IO.Compression` unless `GZIP` is specifically wanted, since it is supported by the spec and already available in the framework.
- Row groups of \~128 MB uncompressed or \~1M rows, whichever first; one column chunk per column per row group with min/max statistics in the column metadata.
- Data page V1 with page headers; one page per column chunk is acceptable for a first version, \~1 MB pages preferred.
- Stream directly from Arrow batches to the output `FileStream`; never build the whole file in memory.

**Out of scope:** nested types, `INT96`, bloom filters, column indexes, encryption, dictionary encoding, data page V2.

**Red flags:** building the file in a `MemoryStream`, writing one row at a time, converting Arrow columns to `object[]` before encoding, or a footer written before all row groups.

**Checkpoint 5 — do not proceed until all pass:**

- [ ] Export a 1M-row table with int, double, string and nullable columns; open it in at least two independent readers (e.g. Python `pyarrow` and DuckDB, or Pandas and Spark) on any machine where those exist; row counts, nulls and values must match exactly.
- [ ] Run `parquet-tools` / `pyarrow.parquet.read_metadata` on the file and confirm statistics and row-group boundaries look right.
- [ ] Export 100M rows; the process working set must not grow with file size.
- [ ] Report the numbers to Chris.

## Phase 6 — Build the HTTP server and browser frontend

The server exists to move Arrow batches to the browser and run queries without ever blocking; the browser renders slices and never asks for a whole table.

**Server.**

- `HttpListener` bound to `http://localhost:<port>/`, started on a dedicated thread; accept with `BeginGetContext`/`GetContextAsync` and dispatch each request to the thread pool. Never handle requests on the accept thread.
- Long-running queries run on a background task and return a job id immediately; the client polls `/jobs/{id}` or opens a Server-Sent Events stream for progress. A request that blocks for minutes will hit the listener's own timeouts.
- Result endpoints stream Arrow IPC (`application/vnd.apache.arrow.stream`) directly from result batches to `response.OutputStream` with `SendChunked = true`. Never serialize rows to JSON for anything over a few thousand rows.
- Paging: `/tables/{name}/rows?offset=&limit=` returns one small Arrow batch gathered from the resident or spilled batches by index; `limit` capped at \~10k.
- Upload: accept the CSV as a raw request body streamed to disk, or better, take a local file path and let the ingester memory-map it; do not buffer uploads in memory.
- Cancellation: carry a `CancellationToken` through the whole operator pipeline so a closed browser tab stops the query.

**Frontend.**

- Decode Arrow IPC in the browser with a small hand-written reader (the format is simple: Flatbuffer schema + message framing + aligned buffers) since the Apache Arrow JS library cannot be downloaded. Keep columns as typed arrays (`Float64Array`, `BigInt64Array`) and render from those.
- Virtualized grid: render only visible rows, fetch pages on scroll, never hold more than a few pages client-side.
- Charts aggregate server-side; the browser receives the aggregated result, never raw rows.

**Red flags:** `JsonConvert`/`JavaScriptSerializer` on result sets, `response.Close()` after building a `string` of the whole result, synchronous `GetContext()` loop that runs the query inline, or a frontend that `fetch`es a whole table.

**Checkpoint 6 — do not proceed until all pass:**

- [ ] Start a 100M-row ingest from the browser; the UI stays responsive and shows progress.
- [ ] Scroll a 100M-row table in the grid; each page request returns in under 100 ms and browser memory stays flat.
- [ ] Close the tab mid-query; the server's CPU drops within a few seconds.
- [ ] Report the numbers to Chris.

## Phase 7 — End-to-end verification and final report

Run the whole pipeline once on the real target machine and produce a single report for Chris; the project is done when every row below is filled and within target.

**Benchmark script.** Write a PowerShell script that generates a 100M-row, 10-column CSV (ints, doubles, a 10k-cardinality string key, a 1M-cardinality string, 5% nulls), then runs each step below in sequence and prints the table. Keep this script in the repo; it is the regression test for every future change.

| Step | Target on 8 cores / 16 GB RAM / SSD | Measured | Peak working set |
| --- | --- | --- | --- |
| Ingest 100M rows CSV → Arrow | ≤ 3 min |  |  |
| Filter 100M rows, numeric predicate | ≤ 2 s |  |  |
| GROUP BY 10k-cardinality key, sum + count | ≤ 10 s |  |  |
| Hash join 100M × 1M on int key | ≤ 20 s |  |  |
| ORDER BY double, LIMIT 100 | ≤ 5 s |  |  |
| Export 100M rows to Parquet (Snappy) | ≤ 3 min |  |  |
| Same suite with memory budget at 25% of RAM | ≤ 2× the above |  |  |

**Final report must include:**

1. The runtime confirmed in Phase 0.
2. The table above, filled.
3. Every red-flag grep result, per phase, with zero hits or a justification for each remaining hit.
4. A list of any spec items from this document that were deliberately not implemented, with the reason.
5. The three changes that produced the largest measured speedup, so Chris knows where the design was weakest.

If any target is missed by more than 2×, stop, profile that step (`dotnet-counters` is unavailable; use `Stopwatch` instrumentation per operator and `GC.CollectionCount` deltas), and report the hotspot before attempting a fix.
