// DuckDB-WASM engine, loaded from the Data Noodler server.
// Globals: createDuckEngine() makes a new, independent engine (its own worker and memory);
//          DuckEngine is a ready-made default instance.
// Settings come from js/duckdb/duckdb-config.json:
//   threads        worker threads (threaded build only; capped at the CPU's logical cores)
//   memoryLimitGB  DuckDB memory_limit
//   build          "eh" (single-threaded), "coi" (threaded) or "auto" (threaded if the page is cross-origin isolated)
// Project files are read over HTTP with range requests, so DuckDB fetches only the parts it needs.
const createDuckEngine = (() => {
  const BASE = new URL('duckdb/', document.currentScript.src).href; // js/duckdb/, next to this file
  let duckdb, arrow, modules;

  // DECIMAL arrives as a raw scaled integer (128-bit, as 32-bit words, or a BigInt-like value): apply the scale.
  // Returned as a Number when it fits exactly, else as an exact string.
  const decimal = (v, scale) => {
    let big;
    if (typeof v === 'bigint') big = v;
    else if (v && v.length >= 2 && typeof v[0] === 'number') {
      big = 0n;
      for (let k = v.length - 1; k >= 0; k--) big = (big << 32n) | BigInt(v[k] >>> 0);
      const bits = BigInt(v.length * 32);
      if (big >> (bits - 1n)) big -= 1n << bits; // two's complement sign
    } else big = BigInt(String(v));
    const neg = big < 0n, abs = (neg ? -big : big).toString().padStart(scale + 1, '0');
    const s = (neg ? '-' : '') + (scale ? abs.slice(0, -scale) + '.' + abs.slice(-scale) : abs);
    return (neg ? -big : big) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(s) : s;
  };
  // Arrow returns dates/timestamps as epoch ms and BIGINT as BigInt; make cells plain JS values.
  const cell = (v, t, f) => {
    if (v == null) return null;
    if (t === 7) return decimal(v, f?.type?.scale || 0);
    if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    if (t === 8) return new Date(Number(v)).toISOString().slice(0, 10);
    if (t === 10) return new Date(Number(v)).toISOString().replace('T', ' ').replace('Z', '');
    return typeof v === 'object' ? String(v) : v;
  };
  const text = async name => { const r = await fetch(BASE + name); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.text(); };
  const blobUrl = src => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const strip = sql => sql.replace(/;\s*$/, '');

  // duckdb-browser.mjs imports the bare name "apache-arrow"; point it at our local Arrow bundle.
  // Loaded once and shared by every engine.
  const loadModules = () => modules ||= (async () => {
    const src = await text('apache-arrow.js'), A = {};
    new Function('exports', 'module', src)(A, { exports: A });
    const arrowUrl = blobUrl(`const module={exports:{}},exports=module.exports;${src}\n` +
      Object.keys(A).map(k => `export const ${k}=exports.${k};`).join(''));
    arrow = await import(arrowUrl); // same URL = same module instance DuckDB uses
    duckdb = await import(blobUrl((await text('duckdb-browser.mjs')).replaceAll('"apache-arrow"', JSON.stringify(arrowUrl))));
  })();

  return function createDuckEngine() {
    let db, conn, info = {};
    const buffered = new Set(); // files loaded into memory by source()

    // Start one build ("coi" threaded or "eh" single-threaded), with a timeout.
    async function start(build) {
      const worker = new Worker(BASE + `duckdb-browser-${build}.worker.js`);
      db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
      const go = (async () => {
        await db.instantiate(BASE + `duckdb-${build}.wasm`, build === 'coi' ? BASE + 'duckdb-browser-coi.pthread.worker.js' : null);
        await db.open({ filesystem: { allowFullHTTPReads: false } });
        conn = await db.connect();
        // Extensions come from js/duckdb/ext/<version>/<platform>/, served locally.
        await conn.query(`SET custom_extension_repository='${BASE}ext'`);
        await conn.query('SET autoinstall_known_extensions=true');
        await conn.query('LOAD parquet');
        // httpfs = HTTP range reads. Single-threaded build only: the threaded httpfs won't link with this DuckDB-WASM.
        if (build === 'eh') await conn.query('LOAD httpfs');
      })();
      try { await Promise.race([go, new Promise((_, r) => setTimeout(() => r(new Error('start timed out after 20 s')), 20000))]); }
      catch (e) { await conn?.close().catch(() => {}); conn = null; throw e; }
    }

    const E = {
      // Start the engine. opts overrides duckdb-config.json. Returns info { version, build, threads, maxThreads, isolated, memoryLimit }.
      async init(opts = {}) {
        if (conn) return info;
        let cfg = {};
        try { cfg = JSON.parse(await text('duckdb-config.json')); } catch (e) { console.warn('duckdb-config.json:', e.message); }
        cfg = { threads: 1, memoryLimitGB: 3, build: 'eh', ...cfg, ...opts };
        const isolated = !!self.crossOriginIsolated;
        const build = cfg.build === 'auto' ? (isolated ? 'coi' : 'eh') : cfg.build;
        if (build === 'coi' && !isolated) throw new Error('Threaded build needs cross-origin isolation (COOP/COEP headers from the server).');
        await loadModules();
        let used = build, note = '';
        try { await start(build); }
        catch (e) {
          if (build !== 'coi' || cfg.build === 'coi') throw e;
          note = `Threaded build failed (${e.message}); using single-threaded.`;
          console.warn(note);
          await db?.terminate().catch(() => {});
          await start(used = 'eh');
        }
        await conn.query(`SET memory_limit='${+cfg.memoryLimitGB}GB'`);
        info = { version: await db.getVersion(), build: used, isolated, note, maxThreads: used === 'coi' ? navigator.hardwareConcurrency || 1 : 1 };
        await E.setThreads(cfg.threads);
        info.memoryLimit = await E.setting('memory_limit');
        return info;
      },
      get ready() { return !!conn; },
      get info() { return info; },
      get arrow() { return arrow; },

      // Set worker threads (clamped to what the build allows). Returns the value DuckDB reports.
      async setThreads(n) {
        n = Math.max(1, Math.min(Math.floor(+n) || 1, info.maxThreads));
        await conn.query(`SET threads=${n}`);
        return info.threads = Number(await E.setting('threads'));
      },
      async setting(name) { return String((await conn.query(`SELECT current_setting('${name}') v`)).toArray()[0].v); },

      // URL to use in SQL for a project file, e.g. read_parquet('${DuckEngine.url('test-data/sales.parquet')}').
      // httpfs reads it with range requests: only the needed parts are fetched.
      url(path) { return new URL('/' + path.replace(/^\/+/, ''), location.origin).href; },
      // Name to use in SQL for a project file, whichever build is running:
      // single-threaded = its URL (lazy range reads); threaded = the whole file loaded into memory once.
      async source(path) {
        if (info.build === 'eh') return E.url(path);
        const name = path.replace(/[\/\\]/g, '_');
        if (!buffered.has(name)) { await db.registerFileBuffer(name, new Uint8Array(await DNFS.readBuffer(path))); buffered.add(name); }
        return name;
      },
      // Register in-memory bytes (Uint8Array) as a file.
      async registerBuffer(name, bytes) { await db.dropFile(name).catch(() => {}); await db.registerFileBuffer(name, bytes); return name; },
      async unregister(name) { buffered.delete(name); await db.dropFile(name).catch(() => {}); },

      // Run SQL -> { cols, rows (arrays of plain values), ms }
      async query(sql) {
        const t0 = performance.now();
        const res = await conn.query(sql);
        const fields = res.schema.fields;
        const rows = res.toArray().map(r => fields.map(f => cell(r[f.name], f.type.typeId, f)));
        return { cols: fields.map(f => f.name), rows, ms: performance.now() - t0 };
      },
      async exec(sql) { await conn.query(sql); },
      // Run SQL -> Arrow table (no conversion; can be handed to another engine with insertArrow)
      queryArrow(sql) { return conn.query(sql); },
      // Create or append to a table from an Arrow table
      async insertArrow(table, name, create = true) { await conn.insertArrowTable(table, { name, create }); },
      // Time a query without converting rows to JS: { rows, ms }
      async time(sql) {
        const t0 = performance.now();
        const res = await conn.query(sql);
        return { rows: res.numRows, ms: performance.now() - t0 };
      },
      // Stream a query as batches of plain-value rows: yields { n, rows }
      async *batches(sql) {
        for await (const b of await conn.send(sql)) {
          const f = b.schema.fields, cols = f.map((_, j) => b.getChildAt(j)), rows = [];
          for (let i = 0; i < b.numRows; i++) rows.push(cols.map((c, j) => cell(c.get(i), f[j].type.typeId, f[j])));
          yield { n: b.numRows, rows };
        }
      },
      page(sql, offset, limit) { return E.query(`SELECT * FROM (${strip(sql)}) LIMIT ${limit} OFFSET ${offset}`); },

      // Write a query result into the project (via DNFS). options = COPY options.
      // Returns { path, bytes, ms }.
      async writeProjectFile(sql, path, options = 'FORMAT PARQUET, COMPRESSION ZSTD') {
        const t0 = performance.now(), tmp = 'out-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + (path.split('.').pop() || 'bin');
        await conn.query(`COPY (${strip(sql)}) TO '${tmp}' (${options})`);
        const buf = await db.copyFileToBuffer(tmp);
        await db.dropFile(tmp);
        await DNFS.write(path, buf);
        return { path, bytes: buf.length, ms: performance.now() - t0 };
      },

      // Size in bytes of a query result written with these COPY options (written in memory, then dropped).
      // Used by ParquetWriter's prescan on a sample of rows.
      async outputBytes(sql, options = 'FORMAT PARQUET, COMPRESSION ZSTD') {
        const tmp = 'probe-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.bin';
        await conn.query(`COPY (${strip(sql)}) TO '${tmp}' (${options})`);
        try { return (await db.copyFileToBuffer(tmp)).length; } finally { await db.dropFile(tmp).catch(() => {}); }
      },

      // DuckDB buffer memory: { used, limit } in bytes
      async mem() {
        const u = (await conn.query('SELECT sum(memory_usage_bytes)::DOUBLE u FROM duckdb_memory()')).toArray()[0].u;
        const m = /([\d.]+)\s*([KMGT]?)i?B/i.exec(await E.setting('memory_limit')), x = { '': 1, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 };
        return { used: Number(u) || 0, limit: m ? +m[1] * x[m[2].toUpperCase()] : 0 };
      },
      async drop(table) { await conn.query(`DROP TABLE IF EXISTS "${table}"`); },
      async tables() { return (await E.query('SHOW TABLES')).rows.map(r => r[0]); },
      async close() { await conn?.close(); await db?.terminate(); conn = db = null; },
    };
    return E;
  };
})();

const DuckEngine = createDuckEngine();
