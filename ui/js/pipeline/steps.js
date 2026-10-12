// Pipeline step types: each turns its form settings into SQL. Global: PipelineSteps.
// Every step becomes a view named after the step, so later steps (and the SQL step) can use it by name.
// Imported datasets are views too, under their dataset names.
const PipelineSteps = (() => {
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const lines = s => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
  // "name = expression" lines -> [[name, expression]]
  const pairs = s => lines(s).map(l => { const i = l.indexOf('='); if (i < 1) throw new Error(`Expected "name = expression": ${l}`); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; });
  const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

  const TYPES = {
    filter: {
      label: 'Filter rows', fields: [['input', 'Input', 'source'], ['where', 'Keep rows where (SQL condition)', 'text', "e.g. status = 'Delivered' AND total > 100"]],
      sql: c => `SELECT * FROM ${q(c.input)} WHERE ${c.where || 'true'}`,
    },
    derive: {
      label: 'Add columns', fields: [['input', 'Input', 'source'], ['exprs', 'New columns, one per line: name = expression', 'area', 'margin_pct = margin / total\norder_year = year(order_date)']],
      sql: c => `SELECT *, ${pairs(c.exprs).map(([n, e]) => `${e} AS ${q(n)}`).join(', ') || 'NULL AS empty'} FROM ${q(c.input)}`,
    },
    select: {
      label: 'Choose / rename columns', fields: [['input', 'Input', 'source'], ['cols', 'Columns, one per line: new_name = expression (or just a column name)', 'area', 'id\ncustomer = customer_id\ntotal']],
      sql: c => `SELECT ${lines(c.cols).map(l => { const i = l.indexOf('='); return i > 0 ? `${l.slice(i + 1).trim()} AS ${q(l.slice(0, i).trim())}` : l; }).join(', ')} FROM ${q(c.input)}`,
    },
    aggregate: {
      label: 'Group and summarise', fields: [['input', 'Input', 'source'], ['group', 'Group by (comma separated)', 'text', 'region, category'], ['aggs', 'Measures, one per line: name = aggregate', 'area', 'orders = count(*)\nrevenue = sum(total)\navg_price = avg(unit_price)']],
      sql: c => { const g = list(c.group); return `SELECT ${[...g, ...pairs(c.aggs).map(([n, e]) => `${e} AS ${q(n)}`)].join(', ')} FROM ${q(c.input)}${g.length ? ` GROUP BY ${g.join(', ')}` : ''}`; },
    },
    join: {
      label: 'Join two inputs', fields: [['left', 'Left input', 'source'], ['right', 'Right input', 'source'], ['how', 'Join type', 'select', '', ['INNER', 'LEFT', 'RIGHT', 'FULL']], ['on', 'Match on: shared column names (comma separated) or a condition using l. and r.', 'text', 'customer_id']],
      sql: c => {
        const on = (c.on || '').trim();
        const cond = /[=<>]/.test(on) ? `ON ${on}` : `USING (${list(on).join(', ')})`;
        return `SELECT * FROM ${q(c.left)} l ${c.how || 'INNER'} JOIN ${q(c.right)} r ${cond}`;
      },
    },
    sort: {
      label: 'Sort / limit', fields: [['input', 'Input', 'source'], ['order', 'Order by', 'text', 'total DESC'], ['limit', 'Limit (blank = all rows)', 'text', '']],
      sql: c => `SELECT * FROM ${q(c.input)}${c.order ? ` ORDER BY ${c.order}` : ''}${+c.limit > 0 ? ` LIMIT ${+c.limit}` : ''}`,
    },
    sql: {
      label: 'SQL', fields: [['query', 'SQL (use dataset and step names as tables)', 'area', 'SELECT * FROM my_dataset']],
      sql: c => String(c.query || '').trim().replace(/;\s*$/, ''),
    },
  };
  // Names other steps can read from.
  const inputsOf = step => (TYPES[step.type]?.fields || []).filter(f => f[2] === 'source').map(f => step.config?.[f[0]]).filter(Boolean);
  return { TYPES, q, inputsOf, sqlOf: step => TYPES[step.type].sql(step.config || {}) };
})();
