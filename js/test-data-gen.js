// Synthetic test data: 50 columns of realistic, reproducible values. Global: TestDataGen.
// Each row is computed from its id with hash(id, k), so any range of ids can be generated
// on its own (in parallel, or resumed later) and always gives the same values.
// A dataset is a folder of Parquet part files plus manifest.json:
//   test-data/gen/<name>/part-0000.parquet ...   ids are 0..rows-1, in order across the parts
//   test-data/gen/<name>/manifest.json           { name, rows, columns, parts: [{ path, rows, first }] }
const TestDataGen = (() => {
  const DIR = 'test-data/gen';
  const L = a => '[' + a.map(s => `'${s}'`).join(', ') + ']';
  const h = k => `hash(i, ${k})`;
  const pick = (a, k) => `${L(a)}[1 + (${h(k)} % ${a.length})::INT]`;
  const LISTS = {
    region: ['North', 'South', 'East', 'West', 'Central', 'International'],
    country: ['US', 'CA', 'MX', 'BR', 'GB', 'FR', 'DE', 'ES', 'IT', 'NL', 'SE', 'PL', 'IN', 'CN', 'JP', 'KR', 'AU', 'NZ', 'ZA', 'AE'],
    category: ['Hardware', 'Software', 'Services', 'Support', 'Training', 'Licensing', 'Cloud', 'Consulting'],
    channel: ['Online', 'Retail', 'Partner', 'Direct'],
    status: ['Open', 'Shipped', 'Delivered', 'Returned', 'Cancelled'],
    payment: ['Card', 'Invoice', 'PayPal', 'Wire', 'Cash'],
    segment: ['Consumer', 'SMB', 'Enterprise', 'Government', 'Education'],
    priority: ['Low', 'Medium', 'High', 'Critical'],
    warehouse: Array.from({ length: 12 }, (_, k) => `WH-${String(k + 1).padStart(2, '0')}`),
    currency: ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'],
    notes: ['', 'Leave at door', 'Gift wrap', 'Call on arrival', 'Fragile', 'Expedite', 'Back order', 'Customer pickup'],
  };
  // Column name -> SQL expression over i (the row id). Later columns may use earlier ones by name.
  const COLUMNS = [
    ['id', 'i'],
    ['order_date', `DATE '2020-01-01' + (${h(1)} % 2192)::INT`],
    ['ship_date', `order_date + (1 + ${h(2)} % 14)::INT`],
    ['order_ts', `order_date + to_seconds((${h(3)} % 86400)::BIGINT)`],
    ['customer_id', `(${h(4)} % 50000)::INT`],
    ['product_id', `(${h(5)} % 5000)::INT`],
    ['store_id', `(${h(6)} % 300)::SMALLINT`],
    ['employee_id', `(${h(7)} % 2000)::SMALLINT`],
    ['region', pick(LISTS.region, 8)],
    ['country', pick(LISTS.country, 9)],
    ['category', pick(LISTS.category, 10)],
    ['subcategory', `category || '-' || (${h(11)} % 5)::VARCHAR`],
    ['channel', pick(LISTS.channel, 12)],
    ['status', pick(LISTS.status, 13)],
    ['payment', pick(LISTS.payment, 14)],
    ['segment', pick(LISTS.segment, 15)],
    ['priority', pick(LISTS.priority, 16)],
    ['warehouse', pick(LISTS.warehouse, 17)],
    ['currency', pick(LISTS.currency, 18)],
    ['quantity', `(1 + ${h(19)} % 50)::INT`],
    ['unit_price', `((100 + ${h(20)} % 99900) / 100)::DECIMAL(10,2)`],
    ['discount', `((${h(21)} % 7) * 5)::INT`],
    ['total', `round(quantity * unit_price * (100 - discount) / 100, 2)::DECIMAL(14,2)`],
    ['cost', `round(total * (40 + ${h(22)} % 40) / 100, 2)::DECIMAL(14,2)`],
    ['tax', `round(total * 0.08, 2)::DECIMAL(14,2)`],
    ['shipping', `((${h(23)} % 5000) / 100)::DECIMAL(8,2)`],
    ['margin', `(total - cost)::DECIMAL(14,2)`],
    ['weight_kg', `(${h(24)} % 10000) / 100.0`],
    ['rating', `(1 + ${h(25)} % 5)::TINYINT`],
    ['score', `(${h(26)} % 1000000) / 10000.0`],
    ['latitude', `-90 + (${h(27)} % 18000000) / 100000.0`],
    ['longitude', `-180 + (${h(28)} % 36000000) / 100000.0`],
    ['is_member', `${h(29)} % 2 = 0`],
    ['is_returned', `${h(30)} % 20 = 0`],
    ['is_gift', `${h(31)} % 10 = 0`],
    ['has_coupon', `${h(32)} % 4 = 0`],
    ['session_seconds', `(${h(33)} % 7200)::INT`],
    ['page_views', `(${h(34)} % 200)::SMALLINT`],
    ['age', `(18 + ${h(35)} % 70)::TINYINT`],
    ['income', `(20000 + ${h(36)} % 180000)::INT`],
    ['zip_code', `lpad((${h(37)} % 100000)::VARCHAR, 5, '0')`],
    ['sku', `'SKU-' || lpad(product_id::VARCHAR, 5, '0')`],
    ['email', `'user' || customer_id::VARCHAR || '@example.com'`],
    ['notes', pick(LISTS.notes, 38)],
    ['created_at', `order_ts - to_seconds((${h(39)} % 604800)::BIGINT)`],
    ['updated_at', `order_ts + to_seconds((${h(40)} % 2592000)::BIGINT)`],
    ['fiscal_quarter', `'FY' || year(order_date)::VARCHAR || '-Q' || quarter(order_date)::VARCHAR`],
    ['batch_no', `(i // 10000)::INT`],
    ['ref_code', `'R' || lpad((${h(41)} % 1000)::VARCHAR, 3, '0')`],
    ['checksum', `(${h(42)} % 1000000000000)::BIGINT`],
  ];
  const SIZES = [
    ['gen_0.5m', 500000], ['gen_1m', 1000000], ['gen_1.5m', 1500000], ['gen_2m', 2000000], ['gen_5m', 5000000],
    ['gen_10m', 10000000], ['gen_20m', 20000000], ['gen_50m', 50000000], ['gen_100m', 100000000],
  ];
  // Up to 10M rows: at least 16 parts (so every engine count up to 16 has work), at most 1M rows each.
  // Above 10M: 250k-row parts (~22 MB), so generating and uploading many parts at once stays within page memory.
  const partCount = rows => rows <= 1e7 ? Math.max(16, Math.ceil(rows / 1e6)) : Math.ceil(rows / 250000);

  return {
    DIR, COLUMNS, SIZES,
    // SELECT that generates rows with ids [a, b).
    sql: (a, b) => `SELECT ${COLUMNS.map(([n, e]) => `${e} AS ${n}`).join(',\n  ')}\nFROM range(${a}, ${b}) r(i)`,
    // The parts of a dataset: [{ path, rows, first }]
    plan(name, rows) {
      const n = partCount(rows), parts = [];
      for (let k = 0; k < n; k++) {
        const first = Math.floor(rows * k / n), next = Math.floor(rows * (k + 1) / n);
        parts.push({ path: `${DIR}/${name}/part-${String(k).padStart(4, '0')}.parquet`, rows: next - first, first });
      }
      return parts;
    },
    // All finished datasets: [manifest...] sorted by rows.
    async list() {
      let dirs = [];
      try { dirs = (await DNFS.list(DIR)).filter(e => e.dir); } catch { return []; }
      const out = [];
      for (const d of dirs) { try { out.push(await DNFS.readJSON(`${d.path}/manifest.json`)); } catch {} }
      return out.sort((a, b) => a.rows - b.rows);
    },
  };
})();
