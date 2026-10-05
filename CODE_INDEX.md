# Data Noodler — Code Index

Quick map for future edits. Line numbers are as of 2026-09-30; re-check them after edits.

## Where we are

- **Data Noodler** is a browser-based flat-file analytics app: projects, Import, Pipeline, Dashboard, Publish, Update, Archives, on DuckDB-WASM engine pools sized by a measured profile.
- It is hosted by a local PowerShell server (`.server/server.ps1`) that needs no admin rights and no installs.
- A control panel (`.server/server.html`) opens as a 1400×1000 Edge/Chrome app window. It sets the port and page, starts/stops the site, opens the site in Chrome or Edge, and shows a live log.
- The site can read and write files **only inside the project root**, through the file API (`/api/fs/*`) and the client helper `js/dn-fs.js`. Data gets into the project by upload (`DNFS.upload`) or by copying it in manually.
- All paths are relative to the project root, never absolute, so the folder can move to any machine.

## Design rule: keep it modular

Build the app as small single-purpose files, not one massive file:
- each module owns one job and exposes a small API (for example `DNFS`, `DuckEngine`)
- a bug stays contained to its module and is easier to find, test and replace
- new features go in new files under `js/` and load into pages with `<script src="../js/...">`

Known exceptions:
- `.server/server.html` keeps its CSS/JS inline on purpose, since it is small and self-contained.
- `.server/server.ps1` (~480 lines) is the largest file. If it grows further, split it into dot-sourced parts (for example `.server/lib/fs-api.ps1`, `browser.ps1`).

## Files

| Path | Purpose |
|---|---|
| `start-server.cmd` | Entry point. Runs `.server/server.ps1` with a hidden PowerShell window. |
| `.server/server.ps1` | HTTP server: site (range requests, COOP/COEP, parallel static files), control panel API, file API (incl. copy), project trash, logging, browser launch. |
| `.server/server.html` | Control panel UI (inline CSS + JS). |
| `config/users.json` | Shared user list (`first, middle, last, type, display`), edited in the panel's User Access dialog (`/api/users`); pages read `/config/users.json` for user drop-downs. |
| `.server/settings.json` | Saved `port`, `page`, `fileThreads`. Written by the server. |
| `.server/fonts/` | Exo 2 + Syne Mono for the panel. |
| `.server/logs/` | `Data_Noodler_Server_Logs_YYYY_MM_DD_HHMMSS.log`, one per session. |
| `.server/.pid` | PID of the running server, used to stop a stale instance on relaunch. |
| `%LOCALAPPDATA%\data-noodler\.profile*` | Browser profiles (outside the project): panel (`.profile`), site (`.profile-site-edge` / `-chrome`). |
| `html/index.html` | Window size/position test page. |
| `html/thread-bench.html` | Threaded (coi) DuckDB build vs thread count. Threaded build can't load extensions in this DuckDB-WASM, so it falls back to single-threaded. |
| `html/engine-bench.html` | Engine pool benchmark: 1–16 engines, splits, tests, Auto, Profile (saves `js/duckdb/optimal-engine-profile.json`). |
| `html/generate-test-parquet-files.html` | Builds the 50-column test datasets in `test-data/gen/` (parallel, resumable, Verify button). |
| `html/gpu-bench.html` | WebGPU vs DuckDB on sums, group-by and filters, with accuracy checks. |
| `html/duckdb-test.html` | Minimal DuckEngine query test. |
| `js/dn-fs.js` | `DNFS`: client for the project file API. |
| `js/duckdb-engine.js` | `createDuckEngine()` / `DuckEngine`: DuckDB-WASM engine loaded from the server; reads project files over HTTP (httpfs, range requests). |
| `js/duckdb-pool.js` | `DuckPool`: N independent engines; `run(partial, final, n)` runs on each engine's share, then combines. |
| `js/gpu-compute.js` | `GpuCompute`: WebGPU column maths (exact integer sums, group-by, filter count). |
| `js/mem-monitor.js` | `MemMonitor`: live memory graph (tab / browser / system vs limit), polls `/api/mem` (server reads browser process memory). |
| `js/test-data-gen.js` | `TestDataGen`: 50-column synthetic data SQL, dataset sizes, part plans, manifests. |
| `js/duckdb/` | DuckDB-WASM builds (`eh` single-threaded, `coi` threaded), `duckdb-config.json`, `ext/v1.5.4/<platform>/` extensions (httpfs, parquet, sqlite_scanner), `optimal-engine-profile.json`. |
| `test-data/gen/<name>/` | Generated datasets: `part-NNNN.parquet` (ids 0..rows-1 in order) + `manifest.json`. |
| `js/vendor/` | sql.js (`sql-wasm.js` + embedded binary), used by Import for SQLite files. |
| `css/theme.css` | Universal dark theme for all app pages (matches the server panel). |
| `html/home.html` | Project Management home page (default page). |
| `html/import.html` | Import Data: upload, preview, schema edit, convert to staged Parquet. |
| `html/pipeline.html` | Pipeline: steps editor, preview, run. |
| `html/dashboard.html` | Dashboard: KPI/bar/line/table widgets on the engine pool, cached. |
| `html/publish.html` | Publish: self-contained dashboard HTML, CSV/Parquet exports. |
| `html/update.html` | Update: detect changed sources, re-import, re-run pipeline, show changes. |
| `html/archives.html` | Archives: snapshot, compare, restore, delete. |
| `js/core/ui.js` | `UI`: toasts, dialogs (confirm/form), formatting, data tables, `guard`. |
| `js/core/user-picker.js` | `UserPicker`: owner/developer drop-downs with search, fed by `config/users.json`. |
| `js/core/projects.js` | `Projects`: project CRUD, layout, datasets, trash. |
| `js/core/project-log.js` | `ProjectLog`: per-project monthly activity log. |
| `js/core/windows.js` | `Windows`: module list and centered 1400×1000 module windows. |
| `js/core/module-page.js` | `ModulePage.init()`: shared start-up for module pages (project, header, log). |
| `js/core/data-engine.js` | `DataEngine`: shared engine, engine count from the profile, `parallel()` row-range jobs. |
| `js/import/source-reader.js` | `SourceReader`: CSV/Parquet over HTTP, SQLite via sql.js. |
| `js/pipeline/steps.js` | `PipelineSteps`: step types → SQL. |
| `js/pipeline/runner.js` | `PipelineRunner`: views, run outputs, run history (used by Pipeline and Update). |
| `js/dashboard/widgets.js` | `Widgets`: partial/final SQL per widget, SVG renderers. |
| `assets/fonts/` | Exo 2 + Syne Mono for site pages. |
| `projects/` | Analytics projects (see PROJECT_PLAN.md for the layout); `projects/.trash/` holds deleted ones. |
| `test-data/` | Sample CSVs + `make-test-data.ps1` generator. |
| `temp/` | Upload temp files (created on demand, cleaned on start). |

## Data flow

```
start-server.cmd
  └─ .server/server.ps1
       ├─ load settings.json ............................ :19
       ├─ stop stale instance via .pid .................. :92
       ├─ HttpListener on UI port 8079 .................. :110
       ├─ open panel: Find-Browser :379 → Open-App :383 → (line :443)
       └─ main loop :445 ─ request ─┬─ port 8079 → Handle-Ui   :156  (line :462)
                                    └─ site port → Handle-Site :351  (line :464)
       exit when: panel sends /api/bye (:474) or no heartbeat for 120s (:475)
```

### Control panel ⇄ server (port 8079)

| Panel (`server.html`) | Calls | Server (`server.ps1`) |
|---|---|---|
| `center()` :194 | — | sizes/centers its own window |
| `poll()` :262 every 1s (heartbeat) | `GET /api/log?since=` | `'api/log'` :164 → reads `$log` from `Add-Log` :38 |
| `loadState()` :226 | `GET /api/state` | `'api/state'` :158 → `Get-Pages` :50 |
| `#apply` :281 | `POST /api/settings` | `'api/settings'` :168 → `Set-SitePort` :117, `Save-Settings` :28 |
| `#random` :299 | `POST /api/random` | `'api/random'` :184 → `Test-PortFree` :112 |
| `#toggle` :304 | `POST /api/site` | `'api/site'` :201 → `Start-Site` :133 / `Stop-Site` :142 |
| picker :289 | `POST /api/open {browser}` | `'api/open'` :215 → `Open-App` :383 → `Raise-Window` :426 |
| `#clear` :298 | `POST /api/clear` | `'api/clear'` :226 |
| `clientLog()` :210 | `POST /api/clientlog` | `'api/clientlog'` :210 → `Add-Log` |
| `pagehide` :311 | `POST /api/bye` | `'api/bye'` :227 → shutdown in 4s unless the next poll cancels it |
| `addLines()` :242 | — | renders log rows (req / sys / err / start / stop) |

### Site pages ⇄ server (site port, default 47823)

```
browser GET /            → Handle-Site :351 → 302 to /html/<page>
browser GET /html/x.html → Send-File :76 (-Token injects window.DN_TOKEN before </head>) → Send-Stream :66
browser GET /js/...      → Send-File :76 → Send-Stream :66
every request            → Add-Log :38 → live log + session log file
```

### App file access (project root only)

```
page JS → DNFS.<op>()  (js/dn-fs.js, call() :9 adds X-DN-Token header)
        → /api/fs/<op> → Handle-Site :351 → Handle-Fs :282
             ├─ Test-FsRequest :268   Host + Origin + token check (blocks other sites / DNS rebinding)
             ├─ Resolve-ProjectPath :244   rejects .., absolute paths, ':', dot-folders, links
             └─ op:  list :286 · stat :293 · read :299 · write :304 · mkdir :322 · delete :327 · move :337
                     write/upload: stream → temp/upload-<id>.tmp → move into place
             errors: FsError :241 → JSON {ok:false,error} + light-red log line
```

| `DNFS` method (js/dn-fs.js) | Line | API op |
|---|---|---|
| `list(path, {recursive})` | 24 | `list` |
| `stat` / `exists` | 26–27 | `stat` |
| `read` / `readText` / `readJSON` / `readBuffer` | 29–32 | `read` |
| `write` / `writeText` / `writeJSON` | 35–38 | `write` |
| `upload(file, folder)` | 41 | `write` |
| `mkdir` / `remove` / `move` | 43–45 | `mkdir` / `delete` / `move` |

### Analytics engine (browser only)

`html/thread-bench.html`, `html/duckdb-test.html` → `js/duckdb-engine.js` `DuckEngine` (:3)
- `load()` :29 starts the DuckDB worker + wasm from a user-picked folder (`pickFolder` :58 / `restoreFolder` :64)
- `register` :76 / `openFiles` :84 → `query` :89 / `exec` :98 / `page` :136
- `exportTo` :119, `exportArrow` :140, `loadArrow` :148 write and read through File System Access handles

Next step: route DuckEngine file I/O through `DNFS` so the engine reads and writes project files directly, without folder pickers.
