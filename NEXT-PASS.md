# Next pass: data-noodler

Findings from a review on 2026-10-24. Work top to bottom; tick items off as you go. Line numbers are as of commit `4a3fc59` and may have shifted.

## 1. Sanitize (do first)

This branch already removed the items below from the current tree. They are **still in git history**, in this repo and in every fork of it.

- [ ] **Back up `config/users.json` before pulling.** It is now ignored and no longer tracked, so pulling deletes your local copy. Put it back afterwards; git will leave it alone from then on. Fictional sample: `config/users.example.json`.
- [ ] **Rewrite history** to drop the user list and the real names that were in old code comments.
  1. Build `names.txt` *outside the repo* from your backed-up `users.json`. Add one line per person in each form that appears: `Last, First==>Doe, Jane`, `First Last==>Jane Doe`, `first_last==>jane_doe` (the Windows login form).
  2. Run:
     ```bash
     git clone --mirror <repo-url> data-noodler.git && cd data-noodler.git
     git filter-repo --invert-paths --path config/users.json --replace-text ../names.txt
     git remote add origin <repo-url>
     git push --force --mirror
     ```
  3. Delete `names.txt`. Re-clone everywhere, and delete old branches, tags and PRs that point at pre-rewrite commits. Rewrite every fork in the network the same way.
- [x] **Regenerate `Data Noodler.lnk`.** It embedded a user SID, the hostname and an absolute `D:\Dev_Project_Repository\...` icon path. *(2026-10-25, branch `standards/untrack-lnk`: no longer tracked; `*.lnk` is ignored; `Data_Noodler.bat` and every server start create or repair it from `Get-NoodlerShortcutSpec`. The git-checkout skip from PR #5 is gone because the file is no longer tracked.)*
- [ ] **Old `Data Noodler.lnk` copies in history.** The SID, hostname and `D:\...` path are still in every commit before `standards/untrack-lnk`. Removing them is part of Jeremy's pending history / fork decision; if the rewrite above goes ahead, add `--path 'Data Noodler.lnk'`.
- [ ] **Stop tracking runtime files the app rewrites.** `server/settings.json` gets a new random port on each start (`server.ps1:223,246`). `workspace/workspaces.json` holds a machine-specific workspace UUID. Ship `*.example.json` templates instead.
- [ ] **Ignore new workspaces.** `.gitignore` excludes only `workspace/smpg/` and `workspace/projects/*`, so user projects in any other workspace get committed. Add `workspace/*/` with the needed exceptions (`sample-data`, `dashboard-studio` widgets, `workspaces.example.json`).

## 2. Security

- [ ] **HIGH: the control-panel port (8079) has no Host, Origin or token check.** `server/server.ps1:1436-1438` sends every request straight to `Handle-Ui` (338-473). Any website open in the browser can POST `text/plain` to:
  - `api/purge`, which permanently deletes `workspace\.trash`
  - `api/users`, which overwrites the user list
  - `api/site`, `api/settings`, `api/open` and `api/clear`

  `Read-Json` (line 97) ignores the content type. With a fixed port, DNS rebinding can also read `api/state` (root path, Windows username) and `api/log`. Apply the same Host + Origin + token checks the site port uses.
- [ ] **HIGH: stored XSS in the control panel.** `server/server.html:681` puts `data-id="${u.id}"` into `innerHTML` without escaping it, and the id can be set through the unguarded `api/users`. Escape it, and validate ids on save.
- [ ] **MEDIUM: static files need no token and no Host check.** `Get-StaticPath` (`server.ps1:713-718`) and `Handle-Site` (1076) serve every non-.html file under the root, including `workspace/**/*.arrow`, `config/users.json` and `temp/`. HTML pages are also served without a Host check (1297). Add the Host check to every route; require the token for anything under `workspace/`, `config/` and `temp/`.
- [ ] **MEDIUM: the control-panel port serves logs and settings unauthenticated.** `Send-File $res $here $rel` (`server.ps1:469`) exposes `server/logs/*.log` (username, machine name, paths) and `server/settings.json`.
- [ ] **MEDIUM: startup kills other processes.** `server.ps1:171-176` force-kills any process whose command line matches `*server.ps1*`, which can hit another tool's server. Match this app's own PID file instead.
- [ ] **LOW: the installer can write outside its folder.** `Data_Noodler_Install.ps1:99-103` writes `Join-Path $Root $f.Path` with no `..` or rooted-path check. Reject both.
- [ ] **LOW: import paths allow outbound SMB.** `server/import-api.ps1:20-37` and `PathGuard.Source` (`server/data-engine/Storage/Datasets.cs:38-46`) accept `\\host\share\...`, which can leak NTLM credentials. `DataEngine.cs:203-204` also skips the extension check for external folders. Refuse UNC paths unless deliberately allowed.
- [ ] **LOW: widgets run with full page access.** User widget `code.js` (`ui/js/widgets/widgets.js:86-89`) runs with `DN_TOKEN`. That seems to be by design; document that imported widgets get full read/write/delete.

## 3. Conformance with TechStack / edge-ops

- [ ] **Listener:** `HttpListener` with `http://localhost:PORT/` (`server.ps1:185-186,201,243`) is used instead of `TcpListener` on `127.0.0.1`. Confirm with `netstat -ano` that it binds to loopback only, and that it needs no admin URL reservation.
- [ ] **Ports:** the site defaults to 47823, or a random port in 10000-65535 (`server.ps1:47,211-223`). Neither is in edge-ops `PORTS.md`. Port 8079 has no fallback and exits if busy (line 188). Register the ports, or follow the fallback convention.
- [ ] **Launcher and installer:** the tool ships a `.lnk` (`conhost --headless ... -ExecutionPolicy Bypass`) and an installer. The conventions call for one `.bat` → `powershell.exe -File` and no installers. *(2026-10-25: `Data_Noodler.bat` -> `Start-DataNoodler.ps1` added, and the `.lnk` is now made locally; the installer is still open.)*
- [ ] **UI stack:** the UI is hand-written JS with vendored billboard.js and d3, and has no build step. TechStack calls for React or Svelte, Tailwind and ECharts. Either migrate or record this as an approved exception.
- [ ] Add `LICENSE` and `VERSION` per edge-ops `CONVENTIONS.md`.

## 4. Cleanup

- [ ] `Data_Noodler_Package.ps1:43` force-includes `workspace/projects/demo-project-for-development`, which moved to `workspace/smpg/`.
- [ ] `README.md` lists `ui/html/dashboard.html` and `d3-studio.html`, which don't exist (the real page is `dashboard-studio.html`). It also points at gitignored `.claude/` and `CLAUDE.md` content and describes an old `data/raw` and `data/source` layout.
- [ ] `server/import-api.ps1:5,39` still mentions DuckDB.
- [ ] `server/fonts/*.ttf` duplicate `assets/fonts/*.ttf` (about 360 KB).
- [ ] `Get-ShellUrl` (`server.ps1:258-262`) computes `$file` and never uses it.
