// What the Import module does with a raw source, shared with Data Studio's input nodes. Global: ImportCore.
// Needs engine-client.js (Engine) and grid/data-table.js (DataTable).
//   ImportCore.TYPES / typeLabel(t)          the Change Type list ('DOUBLE - number with decimals')
//   ImportCore.TYPE_NEED[t]                  what a value must look like to convert to t
//   ImportCore.defName(sourceName)           a source field's default new name (UPPER_CASE, A-Z 0-9 _)
//   ImportCore.unquote(text)                 a pasted path without the quotes Explorer's "Copy as path" adds
//   ImportCore.tryCast(col, type)            CAST(... DEFAULT NULL ON CONVERSION ERROR): a bad value becomes null
//   ImportCore.selectList(cols)              the SELECT list for cols [{ name, type, newName, newType, keep }]
//   await ImportCore.reader(src)             { kind, tables, sql(table) } for a project path or a full path
//   await ImportCore.preview(el, src, title) the first 100 rows of src in a DataTable (more as it scrolls)
const ImportCore = (() => {
  // Plain-English hint shown next to each type in the Change Type list.
  const TYPE_HINT = { VARCHAR: 'text', BIGINT: 'whole number, very large', INTEGER: 'whole number', SMALLINT: 'small whole number (±32,767)',
    DOUBLE: 'number with decimals', 'DECIMAL(18,2)': 'money, 2 decimal places', 'DECIMAL(38,6)': 'exact number, 6 decimal places',
    DATE: 'calendar date', TIMESTAMP: 'date and time', BOOLEAN: 'true / false' };
  // What a value must look like to convert (used to explain failed type checks).
  const TYPE_NEED = { BIGINT: 'Needs whole numbers only (no decimals, letters or symbols).', INTEGER: 'Needs whole numbers between ±2,147,483,647.',
    SMALLINT: 'Needs whole numbers between ±32,767.', DOUBLE: 'Needs numbers (no letters, currency signs or thousands commas).',
    'DECIMAL(18,2)': 'Needs numbers (no letters, currency signs or thousands commas).', 'DECIMAL(38,6)': 'Needs numbers (no letters, currency signs or thousands commas).',
    DATE: 'Needs dates like 2024-01-31.', TIMESTAMP: 'Needs date-times like 2024-01-31 13:45:00.', BOOLEAN: 'Needs true/false, yes/no or 1/0.' };
  const typeLabel = t => TYPE_HINT[t.toUpperCase()] ? `${t} - ${TYPE_HINT[t.toUpperCase()]}` : t;
  const TYPES = ['VARCHAR', 'BIGINT', 'INTEGER', 'SMALLINT', 'DOUBLE', 'DECIMAL(18,2)', 'DECIMAL(38,6)', 'DATE', 'TIMESTAMP', 'BOOLEAN'];
  const defName = name => name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || name;
  // Strips spaces and straight or curly quotes at either end; a path without quotes is left as it is.
  const unquote = s => String(s).replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '');
  // Engine type name (the Change Type list) -> the Oracle type written in a CAST.
  const oraType = t => ({ VARCHAR: 'VARCHAR2(4000)', BIGINT: 'NUMBER(19)', DOUBLE: 'BINARY_DOUBLE' })[t] || String(t).replace(/^DECIMAL\b/, 'NUMBER');
  // CAST(x AS type DEFAULT NULL ON CONVERSION ERROR): a value that cannot convert becomes null instead of stopping the query.
  const tryCast = (c, t) => `CAST(${Engine.q(c)} AS ${oraType(t)} DEFAULT NULL ON CONVERSION ERROR)`;
  // SELECT list with renames and conversions (kept columns only; keep missing = kept).
  const selectList = cols => cols.filter(c => c.keep !== false).map(c =>
    `${c.newType === c.type ? Engine.q(c.name) : tryCast(c.name, c.newType)} AS ${Engine.q(c.newName)}`).join(', ');
  // A source the engine reads in place (project path, or a full local/network path): { kind, tables, sql(table) }.
  async function reader(src) {
    const o = await Engine.open(src);
    return { kind: o.kind, tables: o.tables?.length ? o.tables : [''], sql: t => Engine.src(src, t) };
  }
  // The preview: one worker, FETCH FIRST 100 ROWS ONLY (stops after the first rows); the grid asks for the next 100 as
  // the reader nears the end.
  async function preview(el, src, title) {
    const p = await Engine.query(`SELECT * FROM ${src} FETCH FIRST 100 ROWS ONLY`, { workers: 1 });
    DataTable.show(el, p.cols, p.rows, { title, more: async at => (await Engine.query(`SELECT * FROM ${src} OFFSET ${at} ROWS FETCH NEXT 100 ROWS ONLY`, { workers: 1 })).rows });
    return p;
  }
  return { TYPES, TYPE_NEED, typeLabel, defName, unquote, oraType, tryCast, selectList, reader, preview };
})();
