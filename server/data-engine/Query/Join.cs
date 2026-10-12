// Hash join: the right input is collected once (memory-guarded) and indexed by its key; left batches probe it
// as a stateless step, so probing runs in parallel across the left side's row groups.
// INNER / LEFT / RIGHT / FULL / CROSS, equality keys plus an optional extra (residual) condition.
using System;
using System.Collections.Generic;
using System.Threading;

namespace NativeDataEngine
{
    public sealed class HashJoin
    {
        readonly Op right; readonly List<BExpr> rkeys; readonly object gate = new object();
        volatile bool built; Batch rb; MemoryLease lease;
        Dictionary<long, int> lmap; Dictionary<string, int> smap; Dictionary<RowKey, int> gmap; int[] next;
        public bool[] Matched;
        public HashJoin(Op right, List<BExpr> rkeys) { this.right = right; this.rkeys = rkeys; }
        public Op RightOp { get { return right; } }
        public List<BExpr> RightKeys { get { return rkeys; } }
        public Batch Right { get { return rb; } }

        public void Build(ExecCtx ctx)
        {
            if (built) return;
            lock (gate)
            {
                if (built) return;
                lease = new MemoryLease(ctx.Mem, "Join");
                ctx.OnEnd(lease);
                try { rb = Collect.All(right, ctx, lease); }
                catch { lease.Dispose(); lease = null; rb = null; throw; }   // too big: the chain falls back to a partitioned join
                int n = rb.Rows;
                Matched = new bool[n];
                next = new int[n];
                lease.Add(n * 40L);
                if (rkeys.Count > 0)
                {
                    Column[] kc = new Column[rkeys.Count];
                    for (int k = 0; k < kc.Length; k++) kc[k] = rkeys[k].Eval(rb);
                    if (kc.Length == 1 && kc[0].I != null) lmap = new Dictionary<long, int>();
                    else if (kc.Length == 1 && kc[0].S != null) smap = new Dictionary<string, int>(StringComparer.Ordinal);
                    else gmap = new Dictionary<RowKey, int>();
                    for (int i = n - 1; i >= 0; i--)   // reverse, so each chain lists rows in ascending order
                    {
                        bool anyNull = false;
                        foreach (Column c in kc) if (c.IsNull(i) || c.Type.Kind == Kind.Null) { anyNull = true; break; }
                        if (anyNull) { next[i] = -2; continue; }
                        int head;
                        if (lmap != null) { if (!lmap.TryGetValue(kc[0].I[i], out head)) head = -1; next[i] = head; lmap[kc[0].I[i]] = i; }
                        else if (smap != null) { if (!smap.TryGetValue(kc[0].S[i], out head)) head = -1; next[i] = head; smap[kc[0].S[i]] = i; }
                        else { RowKey rk = Key(kc, i); if (!gmap.TryGetValue(rk, out head)) head = -1; next[i] = head; gmap[rk] = i; }
                    }
                }
                built = true;
            }
        }
        static RowKey Key(Column[] kc, int i) { object[] v = new object[kc.Length]; for (int k = 0; k < kc.Length; k++) v[k] = KeyIndex.KeyOf(kc[k], i); return new RowKey(v); }

        // First matching right row for left row i of the key columns, or -1.
        public int First(Column[] kc, int i)
        {
            if (rkeys.Count == 0) return rb.Rows > 0 ? 0 : -1;
            foreach (Column c in kc) if (c.IsNull(i) || c.Type.Kind == Kind.Null) return -1;
            int h;
            if (lmap != null) return kc[0].I != null && lmap.TryGetValue(kc[0].I[i], out h) ? h : -1;
            if (smap != null) return kc[0].S != null && smap.TryGetValue(kc[0].S[i], out h) ? h : -1;
            return gmap.TryGetValue(Key(kc, i), out h) ? h : -1;
        }
        public int Next(int j) { return rkeys.Count == 0 ? (j + 1 < rb.Rows ? j + 1 : -1) : next[j]; }
        public void Release() { if (lease != null) lease.Dispose(); }
        // Forget the build side so the next run collects it again (recursive CTE rounds).
        public void Reset()
        {
            lock (gate)
            {
                if (lease != null) { lease.Dispose(); lease = null; }
                rb = null; lmap = null; smap = null; gmap = null; next = null; Matched = null; built = false;
            }
        }
    }

    public sealed class JoinProbe : ITransform
    {
        readonly HashJoin h; readonly List<BExpr> lkeys; readonly BExpr residual; readonly string kind; readonly Schema outS;
        public JoinProbe(HashJoin h, List<BExpr> lkeys, BExpr residual, string kind, Schema outS)
        { this.h = h; this.lkeys = lkeys; this.residual = residual != null ? BCast.To(residual, DataType.Bool) : null; this.kind = kind; this.outS = outS; }
        public Schema Out { get { return outS; } }
        public HashJoin Hash { get { return h; } }
        public List<BExpr> LeftKeys { get { return lkeys; } }
        public string Kind { get { return kind; } }
        public JoinProbe With(HashJoin other) { return new JoinProbe(other, lkeys, residual, kind, outS); }
        public void Build(ExecCtx ctx) { h.Build(ctx); }

        // Column pruning: returns the left columns needed, and prunes the right input.
        public HashSet<int> Prune(HashSet<int> need)
        {
            int lc = outS.Count - h.RightOp.Schema.Count;
            HashSet<int> all = new HashSet<int>(need);
            if (residual != null) residual.Refs(all);
            HashSet<int> left = new HashSet<int>(), right = new HashSet<int>();
            foreach (int i in all) { if (i < lc) left.Add(i); else right.Add(i - lc); }
            BExpr.RefsOf(lkeys, left);
            BExpr.RefsOf(h.RightKeys, right);
            Optimizer.NeedRight(h.RightOp, right);
            return left;
        }

        public Batch Apply(Batch b, ExecCtx ctx)
        {
            h.Build(ctx);
            Batch r = h.Right;
            Column[] kc = new Column[lkeys.Count];
            for (int k = 0; k < kc.Length; k++) kc[k] = lkeys[k].Eval(b);
            List<int> li = new List<int>(b.Rows), ri = new List<int>(b.Rows);
            bool keepLeft = kind == "LEFT" || kind == "FULL";
            long budget = 0;
            for (int i = 0; i < b.Rows; i++)
            {
                for (int j = h.First(kc, i); j >= 0; j = h.Next(j))
                {
                    li.Add(i); ri.Add(j);
                    if (++budget % 1000000 == 0) { ctx.Ct.ThrowIfCancellationRequested(); ctx.Mem.Reserve(0, "Join"); if (li.Count > 50000000) throw new EngineException("QUERY_OUT_OF_MEMORY", "The join makes too many rows; check the join keys.", 507); }
                }
            }
            int[] la = li.ToArray(), ra = ri.ToArray(); int n = la.Length;
            if (residual != null && n > 0)
            {
                Batch cand = Combine(b, la, r, ra, n);
                Column c = residual.Eval(cand);
                int m = 0;
                for (int k = 0; k < n; k++) if (!c.IsNull(k) && c.B[k]) { la[m] = la[k]; ra[m] = ra[k]; m++; }
                n = m;
            }
            if (h.Matched != null && (kind == "RIGHT" || kind == "FULL")) for (int k = 0; k < n; k++) h.Matched[ra[k]] = true;
            if (keepLeft)
            {
                bool[] hit = new bool[b.Rows];
                for (int k = 0; k < n; k++) hit[la[k]] = true;
                List<int> l2 = new List<int>(n + 16), r2 = new List<int>(n + 16);
                int p = 0;
                for (int i = 0; i < b.Rows; i++)   // keep left order: matches, or one row with nulls
                {
                    if (!hit[i]) { l2.Add(i); r2.Add(-1); continue; }
                    while (p < n && la[p] < i) p++;
                    while (p < n && la[p] == i) { l2.Add(i); r2.Add(ra[p]); p++; }
                }
                la = l2.ToArray(); ra = r2.ToArray(); n = la.Length;
            }
            return Combine(b, la, r, ra, n);
        }

        Batch Combine(Batch l, int[] la, Batch r, int[] ra, int n)
        {
            Column[] cs = new Column[l.Cols.Length + r.Cols.Length];
            for (int k = 0; k < l.Cols.Length; k++) cs[k] = l.Cols[k].Take(la, n);
            for (int k = 0; k < r.Cols.Length; k++) cs[l.Cols.Length + k] = r.Cols[k].TakeOrNull(ra, n);
            return new Batch(outS, cs, n);
        }
    }

    // RIGHT / FULL: after the probe side is done, add right rows that never matched.
    public sealed class OuterJoinOp : Op
    {
        readonly Op probe; readonly HashJoin h; readonly int leftCols;
        public Op Probe { get { return probe; } }
        public OuterJoinOp(Op probe, HashJoin h, int leftCols) { this.probe = probe; this.h = h; this.leftCols = leftCols; Schema = probe.Schema; }
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            try
            {
                foreach (Batch b in probe.Run(ctx)) yield return b;
                h.Build(ctx);
                Batch r = h.Right;
                List<int> miss = new List<int>();
                for (int j = 0; j < r.Rows; j++) if (!h.Matched[j]) miss.Add(j);
                if (miss.Count == 0) yield break;
                int[] ra = miss.ToArray(); int n = ra.Length;
                int[] none = new int[n]; for (int k = 0; k < n; k++) none[k] = -1;
                Column[] cs = new Column[Schema.Count];
                for (int k = 0; k < leftCols; k++) cs[k] = new Column(Schema[k].Type, 0).TakeOrNull(none, n);
                for (int k = 0; k < r.Cols.Length; k++) cs[leftCols + k] = r.Cols[k].Take(ra, n);
                yield return new Batch(Schema, cs, n);
            }
            finally { h.Release(); }
        }
    }
}
