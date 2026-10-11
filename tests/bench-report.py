# Builds the benchmark comparison page (HTML) and the Markdown tables from temp/bench/results-<tag>.json.
# Dev tool only (Python 3, standard library). Run: python tests/bench-report.py final
import json, sys, os, html, math

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tag = sys.argv[1] if len(sys.argv) > 1 else 'final'
bench = os.path.join(root, 'temp', 'bench')
d = json.load(open(os.path.join(bench, f'results-{tag}.json'), encoding='utf-8-sig'))
r1p = os.path.join(bench, 'results-round1.json')
r1 = json.load(open(r1p, encoding='utf-8-sig')) if os.path.exists(r1p) else None

KEYS = ['old', 'pq', 'ar', 'mem']
NAMES = {'old': 'Old engine · Parquet', 'pq': 'New engine · Parquet', 'ar': 'New engine · Arrow on disk', 'mem': 'New engine · Arrow + memory'}
cfg = dict(zip(KEYS, d['configs']))
steps = [s['step'] for s in cfg['old']['steps']]
def step(k, name):
    for s in cfg[k]['steps']:
        if s['step'] == name: return s
    return None
def r1step(i, name):
    if not r1: return None
    for s in r1['configs'][i]['steps']:
        if s['step'] == name: return s
    return None

GROUP = {
    'Import CSV -> dataset (write)': 'Write', 'Transform write (filter+calc)': 'Write', 'Export Parquet (Snappy)': 'Export', 'Export CSV': 'Export',
    'Full scan count(*) WHERE': 'Scan', 'Filter numeric + 2 columns': 'Scan', 'Preview top 100 + count': 'Scan',
    'Calculations (6 expressions)': 'Calculate', 'GROUP BY 10k key, sum+count': 'Aggregate', 'GROUP BY 2 cols, 5 aggregates': 'Aggregate',
    'COUNT DISTINCT high-card text': 'Aggregate', 'Hash join fact x dim + group': 'Join', 'Join + filter both sides': 'Join',
    'ORDER BY double LIMIT 100': 'Sort', 'Window: rank per key (1/10 rows)': 'Window',
}
rows = []
for name in steps:
    o = step('old', name)
    row = {'step': name, 'group': GROUP.get(name, ''), 'rows': o['rows']}
    for k in KEYS:
        s = step(k, name)
        row[k] = {'ms': s['ms'], 'rps': s['rowsPerSec']} if s else None
    r = r1step(3, name)
    row['r1mem'] = {'ms': r['ms'], 'rps': r['rowsPerSec']} if r else None
    rows.append(row)
load = step('mem', 'Load into engine memory')

def speed(row, k): return row['old']['ms'] / row[k]['ms'] if row.get(k) and row[k]['ms'] > 0 else None
def gmean(xs): xs = [x for x in xs if x]; return math.exp(sum(math.log(x) for x in xs) / len(xs)) if xs else 0
query_rows = [r for r in rows if r['group'] not in ('Write', 'Export')]
summary = {k: {'all': gmean([speed(r, k) for r in rows]), 'query': gmean([speed(r, k) for r in query_rows])} for k in KEYS[1:]}
best = max(KEYS[1:], key=lambda k: summary[k]['all'])
data = {'machine': d['machine'], 'rows': d['rows'], 'csvMB': round(d['csvBytes'] / 1048576), 'when': d['when'], 'oldRef': d['oldRef'],
        'names': NAMES, 'steps': rows, 'summary': summary, 'best': best,
        'load': {'ms': load['ms'], 'mb': round(int(load['check'].split()[-1]) / 1048576)} if load else None,
        'disk': {k: round(cfg[k]['factBytesOnDisk'] / 1048576) for k in KEYS}, 'peak': {k: cfg[k]['peakMB'] for k in KEYS}}

# ---- Markdown tables ----
def ms(x): return f"{x:,.0f}" if x >= 100 else f"{x:,.1f}"
md = []
md.append('| Step | Rows | Old engine | New · Parquet | New · Arrow disk | New · Arrow + memory | Speed-up (old → Arrow + memory) |')
md.append('|---|---:|---:|---:|---:|---:|---:|')
for r in rows:
    cells = [f"{ms(r[k]['ms'])} ms<br>{r[k]['rps']:,} rows/s" for k in KEYS]
    md.append(f"| {r['step']} | {r['rows']:,} | " + ' | '.join(cells) + f" | **{speed(r, 'mem'):.1f}×** |")
md_text = '\n'.join(md)
open(os.path.join(bench, f'table-{tag}.md'), 'w', encoding='utf-8').write(md_text)
json.dump(data, open(os.path.join(bench, f'data-{tag}.json'), 'w'), indent=1)

# ---- HTML page ----
page = open(os.path.join(root, 'tests', 'bench-report.html'), encoding='utf-8').read()
page = page.replace('/*DATA*/null', json.dumps(data))
out = os.path.join(root, 'temp', 'bench', f'arrow-engine-benchmark.html')
open(out, 'w', encoding='utf-8').write(page)
print(out)
print('best:', best, {k: {kk: round(vv, 2) for kk, vv in v.items()} for k, v in summary.items()})
