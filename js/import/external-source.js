// Source files OUTSIDE the project (local or network drives), through the server's import API.
// Global: ExternalSource. Needs dn-fs.js (window.DN_TOKEN).
//   const info = await ExternalSource.probe('\\\\server\\share\\orders.csv')   { size, modified }  (throws a plain-English error)
//   ExternalSource.url(src)                       URL DuckDB can read in place (range reads, token in the query)
//   await ExternalSource.copy(src, 'projects/x/temp/orders.csv', (done, total) => …)   copies into the project
//   ExternalSource.drive(src)                     'X:' or '\\server\share'
//   await ExternalSource.verify(E, aSql, bSql, { values })   compares two sources: columns, types, rows, values
// The server gives up on a drive after 30 s without progress; this side warns the user after 10 s (onWait).
const ExternalSource = (() => {
  const WARN_MS = 10000;
  const isPath = s => /^[A-Za-z]:\\/.test(s) || /^\\\\[^\\]+\\[^\\]+\\/.test(s);
  const drive = s => (s.match(/^\\\\[^\\]+\\[^\\]+/) || s.match(/^[A-Za-z]:/) || [s])[0];
  const name = s => s.split(/[\\/]/).pop();
  const qs = p => new URLSearchParams(p).toString();

  // Calls the import API; after WARN_MS without an answer, onWait(drive) is called once.
  async function call(op, params, { method = 'GET', onWait } = {}) {
    if (!window.DN_TOKEN) throw new Error('Page was not served by the Data Noodler server.');
    const t = onWait && setTimeout(() => onWait(drive(params.src)), WARN_MS);
    try {
      const r = await fetch(`/api/import/${op}?${qs(params)}`, { method, headers: { 'X-DN-Token': window.DN_TOKEN } });
      let j = {}; try { j = await r.json(); } catch {}
      if (!r.ok || j.ok === false) { const e = new Error(j.error || `${op} failed (HTTP ${r.status})`); e.status = r.status; e.drive = j.drive; throw e; }
      return j;
    } finally { clearTimeout(t); }
  }

  const probe = (src, opts) => call('probe', { src }, opts);
  const url = src => `${location.origin}/api/import/read?${qs({ src, t: window.DN_TOKEN })}`;

  // Copies src into the project at `to` (project-relative). onProgress(done, total) about twice a second.
  // onWait(drive) if no progress for 10 s.
  async function copy(src, to, onProgress = () => {}, { onWait, overwrite = true } = {}) {
    const id = 'imp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let last = -1, lastAt = Date.now(), warned = false;
    const poll = setInterval(async () => {
      try {
        const p = await call('progress', { id });
        if (p.done !== last) { last = p.done; lastAt = Date.now(); onProgress(p.done, p.total); }
        else if (!warned && onWait && Date.now() - lastAt > WARN_MS) { warned = true; onWait(drive(src)); }
      } catch {}
    }, 500);
    try { return await call('copy', { src, to, id, overwrite: overwrite ? 1 : 0 }, { method: 'POST', onWait }); }
    finally { clearInterval(poll); }
  }

  // Compares two SQL sources (e.g. read_parquet(...)). values = also compare every column's contents
  // (order-independent hash per column). Returns { ok, checks: [{ name, ok, detail }] }.
  async function verify(E, aSql, bSql, { values = true, types = true } = {}) {
    const desc = async s => (await E.query(`DESCRIBE SELECT * FROM ${s}`)).rows.map(r => ({ name: r[0], type: r[1] }));
    const [ca, cb] = await Promise.all([desc(aSql), desc(bSql)]);
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    add('Column count', ca.length === cb.length, `${ca.length} vs ${cb.length}`);
    const nameDiff = ca.findIndex((c, i) => c.name !== cb[i]?.name);
    add('Column names and order', nameDiff < 0 && ca.length === cb.length, nameDiff < 0 ? 'match' : `first difference at #${nameDiff + 1}: "${ca[nameDiff]?.name}" vs "${cb[nameDiff]?.name}"`);
    if (types) {
      const typeDiff = ca.findIndex((c, i) => c.type !== cb[i]?.type);
      add('Column types', typeDiff < 0, typeDiff < 0 ? 'match' : `"${ca[typeDiff].name}": ${ca[typeDiff].type} vs ${cb[typeDiff]?.type}`);
    }
    const count = async s => Number((await E.query(`SELECT count(*) FROM ${s}`)).rows[0][0]);
    const [na, nb] = [await count(aSql), await count(bSql)];
    add('Row count', na === nb, `${na.toLocaleString()} vs ${nb.toLocaleString()}`);
    if (values && nameDiff < 0 && na === nb) {
      // One streaming pass per file: XOR of row hashes per column (no rows kept in memory).
      const sums = async s => (await E.query(`SELECT bit_xor(hash(COLUMNS(*)))::VARCHAR FROM ${s}`)).rows[0];
      const [ha, hb] = [await sums(aSql), await sums(bSql)];
      const bad = ca.filter((c, i) => ha[i] !== hb[i]).map(c => c.name);
      add('Values', !bad.length, bad.length ? `differ in: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ''}` : 'match');
    }
    return { ok: checks.every(c => c.ok), checks, rows: na, columns: ca };
  }

  return { isPath, drive, name, probe, url, copy, verify };
})();
