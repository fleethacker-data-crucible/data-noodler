// Reads source files for Import. Global: SourceReader.
//   SourceReader.kind('data/source/a.csv')        'csv' | 'parquet' | 'sqlite' | null
//   const s = await SourceReader.open(engine, path) { kind, tables, sql(table) }  sql() = a SQL source for the table
//   await SourceReader.schema(engine, sourceSql)   [{ name, type }]
// CSV and Parquet are read over HTTP (range requests).
// SQLite: DuckDB-WASM's sqlite extension cannot open files in this build, so the vendored sql.js reads the
// database and each table is handed to DuckDB as an in-memory CSV with the column types SQLite declares.
// The whole file is loaded into the page, so very large SQLite files are limited by browser memory.
// sql(table) may return a promise (SQLite tables are converted on first use).
const SourceReader = (() => {
  const KINDS = { csv: 'csv', tsv: 'csv', txt: 'csv', parquet: 'parquet', pq: 'parquet', sqlite: 'sqlite', sqlite3: 'sqlite', db: 'sqlite' };
  const kind = path => KINDS[(path.split('.').pop() || '').toLowerCase()] || null;
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  let opened = 0, sqljs;

  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(`Could not load ${src}`)); document.head.append(s); });
  async function getSqlJs() {
    if (sqljs) return sqljs;
    if (!window.initSqlJs) await loadScript('/js/vendor/sql-wasm.js');
    if (!window.__sqlWasmBase64) await loadScript('/js/vendor/sql-wasm-binary.js');
    return sqljs = await initSqlJs({ wasmBinary: Uint8Array.from(atob(window.__sqlWasmBase64), c => c.charCodeAt(0)) });
  }
  // SQLite declared type -> DuckDB type (SQLite type affinity rules).
  const duckType = t => { t = (t || '').toUpperCase(); return /INT/.test(t) ? 'BIGINT' : /CHAR|CLOB|TEXT/.test(t) ? 'VARCHAR' : /REAL|FLOA|DOUB/.test(t) ? 'DOUBLE' : /DEC|NUM/.test(t) ? 'DOUBLE' : /BOOL/.test(t) ? 'BOOLEAN' : /DATE|TIME/.test(t) ? 'VARCHAR' : 'VARCHAR'; };
  const csvCell = v => v == null ? '\\N' : typeof v === 'number' ? String(v) : v instanceof Uint8Array ? '"' + btoa(String.fromCharCode(...v)) + '"' : '"' + String(v).replace(/"/g, '""') + '"';

  async function openSqlite(e, path) {
    const SQL = await getSqlJs(), id = ++opened;
    const db = new SQL.Database(new Uint8Array(await DNFS.readBuffer(path)));
    const tables = (db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY 1")[0]?.values || []).map(r => r[0]);
    const done = new Map();
    async function sql(t) {
      if (done.has(t)) return done.get(t);
      const cols = db.exec(`PRAGMA table_info(${q(t)})`)[0].values.map(r => ({ name: r[1], type: duckType(r[2]) }));
      const parts = [cols.map(c => q(c.name)).join(',') + '\n'], st = db.prepare(`SELECT * FROM ${q(t)}`);
      while (st.step()) parts.push(st.get().map(csvCell).join(',') + '\n');
      st.free();
      const name = `sqlite_${id}_${t.replace(/[^A-Za-z0-9_]/g, '_')}.csv`;
      await e.registerBuffer(name, new TextEncoder().encode(parts.join('')));
      const src = `read_csv('${name}', header = true, auto_detect = false, nullstr = '\\N', quote = '"', escape = '"', columns = {${cols.map(c => `'${c.name.replace(/'/g, "''")}': '${c.type}'`).join(', ')}})`;
      done.set(t, src);
      return src;
    }
    return { kind: 'sqlite', tables, sql };
  }

  async function open(e, path) {
    const k = kind(path); if (!k) throw new Error(`Unsupported file type: ${path}`);
    const url = e.url(path);
    if (k === 'csv') return { kind: k, tables: [''], sql: () => `read_csv('${url}', auto_detect = true, sample_size = 100000)` };
    if (k === 'parquet') return { kind: k, tables: [''], sql: () => `read_parquet('${url}')` };
    return openSqlite(e, path);
  }
  const schema = async (e, src) => (await e.query(`DESCRIBE SELECT * FROM ${src}`)).rows.map(r => ({ name: r[0], type: r[1] }));
  return { kind, open, schema, quote: q };
})();
