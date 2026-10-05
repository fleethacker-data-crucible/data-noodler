# Data Noodler: How It Works

What actually happens from launch to query. Written 2026-10-04 from the code (no changes made).
`CODE_INDEX.md` is the file map; this is the runtime story. Re-check line refs after edits.

## Ground rules

- **DuckDB-WASM only.** No native `duckdb.exe` / `.dll`, ever.
- **No installs, no admin.** Server is plain PowerShell + .NET `HttpListener`; browsers are the installed Edge/Chrome.
- **Project-relative paths only.** The folder can move to any machine.
- **`.trash/` is off-limits** unless explicitly asked (see `CLAUDE.md`).

## 1. Launch

```
start-server.cmd
  └─ powershell -WindowStyle Hidden -File .server/server.ps1
```

`server.ps1` startup, top to bottom:
1. `$root` = project folder (one up from `.server`), `$uiPort = 8079`, log file `.server/logs/Data_Noodler_Server_Logs_<time>.log`.
2. Loads `.server/settings.json` (`port`, `page`, `fileThreads`).
3. Kills a stale instance via `.server/.pid`, writes its own PID.
4. Clears leftover `temp/upload-*.tmp`.
5. One `HttpListener` listens on **two ports**:
   - **8079** = control panel (serves `.server/` folder).
   - **site port** (settings, e.g. 54611) = the app (serves project root). Started/stopped from the panel.
6. Opens the panel: `Open-App` launches Edge (else Chrome) as an `--app` window with its own profile in
   `%LOCALAPPDATA%\data-noodler\.profile` and slimming flags (no component updates, cache, sync, extensions).
7. Main loop: one request at a time on the main thread, except plain static files (see 3).

**Shutdown:** panel closes → `/api/bye` → exits after 4 s (a reload cancels it). Also exits if no heartbeat
for 120 s, or if the panel never connects within 60 s.

## 2. Control panel (port 8079, `.server/server.html`)

- Polls `GET /api/log?since=` every 1 s. That poll **is the heartbeat**.
- `GET /api/state`: status, port, page, hits, uptime, list of `html/*.html` modules.
- Buttons → `/api/site` (start/stop), `/api/clear`, `/api/users` (Manage Users → `config/users.json`).
- **Modules** (orange = developer shortcut, removed in production): dialog to pick the served module (`/api/settings {page}`)
  and Open Module (`/api/open` in the default browser, profile `.profile-site-<browser>`).
- **Settings** dialog → `/api/settings {portMode, port, browser}`:
  - Port: `manual` (1024-65535 or 80; not 8079) or `random` (new free 5-digit port at every launch; Randomize = `/api/random`, applies now).
  - Default browser: Edge (recommended, lighter) or Chrome.
  - Saved in `.server/settings.json` (`port`, `portMode`, `browser`, `page`, `fileThreads`).
- `clientLog()` → `/api/clientlog` writes panel messages into the server log. Levels: `err`, `duck`, else `client`.
- Log kinds and colors: `req`, `sys` (pink), `err` (red), `duck` (teal), `start`/`stop` (banners). `sys`/`err`/`duck`
  and 4xx/5xx requests also pop a notification.
- **DuckDB check:** the panel loads `js/duckdb-engine.js` (server maps `js/duckdb-engine.js` and `js/duckdb/*`
  on port 8079 to the project's `js/`), starts an engine, runs `sum(range(1e6))`, shows READY/FAILED.

## 3. Site (site port) — `Handle-Site`

| Request | Handling |
|---|---|
| `/` | 302 → `/<page>` from settings (default `html/home.html`); shell pages go straight to `html/app.html?m=<name>` (`Get-ShellUrl`). |
| `*.html` | `Send-File -Token`: injects `window.DN_TOKEN` before `</head>`, `no-store`. |
| other static (js, wasm, css, parquet, csv…) | Runspace pool (`fileThreads`, default 16) → `Send-Stream`, in parallel, off the main thread. |
| `/api/fs/<op>` | File API (below). |
| `/api/project/trash` | Moves `projects/<folder>` → `projects/.trash/<folder>-<time>`. |
| `/api/mem` | Browser process memory for the memory graph (not logged). |

Every site response carries **COOP/COEP/CORP same-origin** (cross-origin isolated → SharedArrayBuffer available).

Static requests the browser cancels (page navigated away) log as `---` "(cancelled by browser)", not 500.

**Range requests:** `Send-Stream` honours `Range: bytes=a-b` → `206 Partial Content` with `Accept-Ranges`.
This is what lets DuckDB read only the bytes it needs from big files.

## 4. File API (`/api/fs/*`) and `DNFS` (`js/dn-fs.js`)

Pages never touch disk directly. `DNFS` sends `X-DN-Token` + same-origin; server checks:
- `Test-FsRequest`: correct Host (anti DNS-rebinding), no foreign Origin, valid token.
- `Resolve-ProjectPath`: rejects absolute paths, `..`, `:`, any dot-segment (`.server`, `.git`, `.trash`), and links.

Ops: `list`, `stat`, `read`, `write` (PUT body → `temp/upload-<id>.tmp` → move into place), `mkdir`, `delete`,
`move`, `copy`. Writes from one page are queued one at a time.

## 4b. Import API (`/api/import/*`, `.server/import-api.ps1`) — files OUTSIDE the project

Read-only access to local/network source files for Import. Writes still only go inside the project.
- `probe?src=` (exists, readable, size, modified) · `read?src=&t=<token>` (Range/HEAD; DuckDB reads in place) ·
  `copy?src=&to=<project path>&id=` (4 MB chunks → `.part` → size check → move) · `progress?id=`.
- `src` must be a full path (`X:\…` or `\\server\share\…`) with a data extension (csv/tsv/txt/parquet/pq/sqlite/sqlite3/db).
- Every call runs on a background runspace pool (8), so a dead drive can't freeze the server. `Watch-ImportJobs`
  (main loop): no progress for **10 s** → orange `warn` log + notification naming the drive; **30 s** → 504, gives up.
- Errors → `ConvertTo-FsError` (server.ps1): permission denied (403), file/folder not found (404), drive not
  available (503, names `X:` / `\\server\share`), file in use (423), disk full (507), else read/write error (500).
  Messages say where to check, or to copy the file into the project's temp/source folder by hand.
- Browser side: `js/import/external-source.js` (`ExternalSource`: probe, url; copy/verify kept but unused by Import).

**Data flow (only Import reads CSV/SQLite; every dataset is Parquet, all other modules read Parquet only):**

```
data/raw/        uploads, drag/drop, or files copied in by hand (Import re-lists the folder every 3 s)
outside path     X:\... or \\server\share\...: streamed through /api/import/read, never copied in
   │  Import: prescan → one Parquet or split parts (ParquetWriter)
   ├─ Stage            column choices applied   → data/staged/   (input for Pipeline)
   └─ Import Directly  whole source as is       → data/source/   (ready for Dashboard)
data/staged ──Pipeline (output steps)──────────→ data/source/
data/source ──Dashboard / Publish (picker shows only data/source datasets)
```

- **Prescan** (`js/core/parquet-writer.js`, `ParquetWriter`): writes the first 100k rows to Parquet in memory
  (`E.outputBytes`) → bytes/row × rows × 1.25 = estimated size. Over the part limit (`partMB` in
  `js/duckdb/duckdb-config.json`, default 256) → **split**: rows written in batches, one part file at a time,
  each saved and freed before the next (`<name>/part-0001.parquet` … + `manifest.json`). Otherwise `<name>.parquet`.
  Row batches: single Parquet source = `file_row_number` ranges; CSV/SQLite/several files = `LIMIT/OFFSET` in order.
- After writing: column count, names/order, row count checked against the source; a failed output is removed.
- Dataset record: `path` (file, or part folder), `parts` (part files or null), `stage` (`staged`/`source`;
  `Projects.stageOf(d)` for older records), `source` (raw path or `origin`, `select`, size/modified for Update).
- Readers: `ParquetWriter.sql(E, d)` → `read_parquet('a')` or `read_parquet([parts])`. `DataEngine.parallel({ parts })`
  gives each engine whole parts (else row ranges of one file).
- Pipeline runs an output step into a temp table, then writes it with `ParquetWriter` to `data/source`.
  Update re-reads the source where it is and rewrites with the same `select`.
- Not in Import any more: copying outside files into the project, the read/copy prompt, temp copies.

## 5. DuckDB engine (browser) — `js/duckdb-engine.js`

`createDuckEngine()` → independent engine (own Web Worker + own WASM memory). `DuckEngine` = default instance.

- Loads `js/duckdb/duckdb-browser.mjs` + local Arrow, worker `duckdb-browser-<build>.worker.js`, `duckdb-<build>.wasm`.
- Config `js/duckdb/duckdb-config.json`: `threads: 1`, `memoryLimitGB: 3`, `build: "eh"`.
  - `eh` = single-threaded. Loads `parquet` + `httpfs`. **Used everywhere.**
  - `coi` = threaded; needs cross-origin isolation; can't load httpfs in this DuckDB-WASM, falls back to `eh`.
- Extensions come from `js/duckdb/ext/v1.5.4/...` (served locally, no internet).
- `memory_limit` = `memoryLimitGB` (3 GB → shows as 2.7 GiB). Per engine.

**How files reach DuckDB:**

| Way | Memory use | Used by |
|---|---|---|
| `E.url(path)` → `read_parquet('http://localhost:<port>/…')` / `read_csv(...)` via **httpfs range reads** | Only the needed byte ranges / row groups are fetched | Import (CSV, Parquet), Pipeline views, DataEngine, Dashboard |
| `E.source(path)` on `coi` build / `registerBuffer` | **Whole file in browser memory** | threaded build only; SQLite import |
| SQLite (`js/import/source-reader.js`) | sql.js loads **whole DB** into page memory, each table converted to an in-memory CSV for DuckDB | Import of `.sqlite/.db` |

**Writing results:** `writeProjectFile(sql, path)` → `COPY ... TO` an in-WASM temp file → `copyFileToBuffer`
→ `DNFS.write`. The **whole output file is held in memory** before it is saved.

## 6. Parallelism — `DuckPool` + `DataEngine`

- `js/duckdb-pool.js` `DuckPool.create(n)`: n single-threaded `eh` engines = n CPU cores.
  `run(partial, final)`: each engine runs `partial` on its share → Arrow results copied into engine 0's
  `__parts` table → `final` combines.
- `js/core/data-engine.js` `DataEngine.parallel({ path, rows, kind, partial, final })`:
  - Engine count from `js/duckdb/optimal-engine-profile.json` (made by `html/engine-bench.html` → Profile),
    nearest row count for that query kind; else ~1 engine per 2M rows (1 below 1M). Max = min(16, cores).
  - Each engine reads **its own row range** of the same Parquet via `file_row_number` over HTTP range reads.
  - Pool memory per engine: `min(3, max(0.5, 10/n))` GB → ~10 GB total budget across the pool.

## 7. Memory: where the limits actually are

- WASM is 32-bit → each engine tops out around **4 GB**, and DuckDB-WASM **cannot spill to disk** (no temp dir).
  Over `memory_limit` = out-of-memory error.
- What already keeps memory low: Parquet/CSV range reads, row-range splitting across engines, ZSTD Parquet with
  100k-row groups for staged outputs.
- Big outputs are split into parts (`ParquetWriter`, see 4b), so one `writeProjectFile` holds at most one part.
- What still loads whole things into memory: SQLite import, a Pipeline output step (temp table), `__parts` combine on
  engine 0, and query results converted to JS rows (`query()`; `batches()` streams instead).

## 8. App modules (`html/*.html`)

**Light/dark mode:** one global setting, `settings.json` `theme` (default dark), chosen only in the server panel:
Settings > Appearance (no toggle in the app, to keep modules clean). App pages: `js/core/theme.js` in every
page's `<head>` applies it; the shell follows the server via `/api/status` (5 s), other windows via the `storage`
event. Panel follows `/api/state` (1 s). `POST /api/theme` also exists (unused). Light palette:
`:root[data-theme="light"]` in `css/theme.css` and `server.html`.

**App shell (`html/app.html`):** one window, one global header; Projects (home) and the six modules load in a
frame under it (`Shell.go`). Header: logo = module initials (PR, IM, PL, DA, PU, UP, AR), "Data Noodler",
module · project; Server status (`/api/status`, every 5 s, not logged) and DuckDB status (starts an engine, runs a
test query, closes it; click to re-test). `js/core/embed.js` in each page's `<head>` redirects a page opened
alone into the shell, hides its own logo/title, and puts Back (→ Projects, same project expanded) at the left of
the page's toolbar row. Browser Back/refresh work (URL `app.html?m=<id>&project=<folder>`).

Home (projects) → Import (source → staged Parquet) → Pipeline (steps → views → `data/staged/*.parquet`) →
Dashboard (widgets via `DataEngine.parallel`) → Publish (self-contained HTML, CSV/Parquet exports) →
Update (re-import changed sources, re-run pipeline) → Archives (snapshots).
Shared code in `js/core/` (`ModulePage`, `Projects`, `UI`, `Windows`, `ProjectLog`, `UserPicker`).
Bench/test pages: `engine-bench`, `thread-bench`, `duckdb-test`, `generate-test-parquet-files`, `index`.

Project layout: `projects/<folder>/` with `data/raw`, `data/staged`, `data/source`, `pipeline/pipeline.json` + `runs.json`,
`archives/<time>/`.
