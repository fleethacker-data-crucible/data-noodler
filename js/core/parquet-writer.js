// Writes a query to Parquet in the project, split into parts when it would not fit in browser memory.
// Global: ParquetWriter. Needs dn-fs.js and an engine (duckdb-engine.js).
//   const plan = await ParquetWriter.prescan(E, src, rows)              { parts, rowsPerPart, estBytes, ... }
//   const w = await ParquetWriter.write(E, { select, src, rows, dest, plan?, onProgress? })
//        -> { path, parts (null | [file paths]), bytes, plan }
//   ParquetWriter.sql(E, d)   SQL source for a dataset { path, parts? }: read_parquet('a') or read_parquet(['a', 'b'])
//
// Why: DuckDB-WASM cannot spill to disk, and a COPY result is held in memory (in the engine, then once more
// as a buffer) until it is saved. A big source is therefore written in batches of rows, one part file at a
// time, each saved and freed before the next. All rows end up in the output.
//   one part:   <dest>.parquet
//   split:      <dest>/part-0001.parquet ... + <dest>/manifest.json  { version, rows, parts: [{ file, rows, bytes }] }
// Part size target: js/duckdb/duckdb-config.json "partMB" (default 256 MB of Parquet).
const ParquetWriter = (() => {
  const OPTS = 'FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000';
  const SAMPLE = 100000, GROUP = 100000, MARGIN = 1.25;   // MARGIN: the sample can compress better than the rest
  let partBytes = null;
  async function target() {
    if (partBytes) return partBytes;
    let mb = 256;
    try { mb = (await (await fetch('/js/duckdb/duckdb-config.json', { cache: 'no-store' })).json()).partMB || mb; } catch {}
    return partBytes = mb * 1048576;
  }

  // Rows [a, b) of a SQL source. A single Parquet file is cut by row number (only those row groups are read);
  // anything else (CSV, SQLite, several files) is read in order with LIMIT/OFFSET (single-threaded engine keeps order).
  function range(src, a, b) {
    const m = /^read_parquet\('([^']+)'\)$/.exec(src.trim());
    if (m) return `(SELECT * EXCLUDE (file_row_number) FROM read_parquet('${m[1]}', file_row_number = true) WHERE file_row_number >= ${a} AND file_row_number < ${b})`;
    return `(SELECT * FROM ${src} LIMIT ${b - a} OFFSET ${a})`;
  }

  // Estimate the Parquet size from a sample of rows; decide how many parts.
  async function prescan(E, src, rows, select = '*') {
    const n = Math.min(rows, SAMPLE), max = await target();
    const sample = n ? await E.outputBytes(`SELECT ${select} FROM ${range(src, 0, n)}`, OPTS) : 0;
    const perRow = n ? sample / n : 0, estBytes = Math.round(perRow * rows * MARGIN);
    let parts = Math.max(1, Math.ceil(estBytes / max)), rowsPerPart = rows;
    if (parts > 1) { rowsPerPart = Math.ceil(Math.ceil(rows / parts) / GROUP) * GROUP; parts = Math.ceil(rows / rowsPerPart); }
    return { rows, sampleRows: n, perRow, estBytes, partBytes: max, parts, rowsPerPart };
  }

  // Remove an earlier output at dest (single file and/or part folder), so a re-import replaces it cleanly.
  async function clear(dest) {
    if (await DNFS.exists(`${dest}.parquet`)) await DNFS.remove(`${dest}.parquet`);
    if (await DNFS.exists(dest)) await DNFS.remove(dest, { recursive: true });
  }

  // dest = project path without extension. onProgress(done, total, msg).
  async function write(E, { select = '*', src, rows, dest, plan, onProgress = () => {} }) {
    plan ||= await prescan(E, src, rows, select);
    await clear(dest);
    if (plan.parts === 1) {
      onProgress(0, 1, 'Writing Parquet…');
      const w = await E.writeProjectFile(`SELECT ${select} FROM ${src}`, `${dest}.parquet`, OPTS);
      onProgress(1, 1, 'Written');
      return { path: `${dest}.parquet`, parts: null, bytes: w.bytes, plan };
    }
    const files = [], manifest = { version: 1, rows, created: new Date().toISOString(), parts: [] };
    let bytes = 0;
    for (let i = 0; i < plan.parts; i++) {
      const a = i * plan.rowsPerPart, b = Math.min(rows, a + plan.rowsPerPart);
      const file = `${dest}/part-${String(i + 1).padStart(4, '0')}.parquet`;
      onProgress(i, plan.parts, `Writing part ${i + 1} of ${plan.parts} (rows ${a + 1}–${b})…`);
      const w = await E.writeProjectFile(`SELECT ${select} FROM ${range(src, a, b)}`, file, OPTS);   // saved, then freed
      files.push(file); bytes += w.bytes;
      manifest.parts.push({ file: file.split('/').pop(), rows: b - a, bytes: w.bytes });
    }
    await DNFS.writeJSON(`${dest}/manifest.json`, manifest);
    onProgress(plan.parts, plan.parts, 'Written');
    return { path: dest, parts: files, bytes, plan };
  }

  const sql = (E, d) => d.parts?.length
    ? `read_parquet([${d.parts.map(p => `'${E.url(p)}'`).join(', ')}])`
    : `read_parquet('${E.url(d.path)}')`;

  return { prescan, write, sql, range, OPTS };
})();
