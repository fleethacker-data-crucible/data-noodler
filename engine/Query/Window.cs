// Window functions: row_number, rank, dense_rank, percent_rank, cume_dist, ntile, lag, lead, first_value,
// last_value, and sum/count/avg/min/max OVER (PARTITION BY ... ORDER BY ...). With ORDER BY the frame is the
// default running frame (all rows up to and including the current row's peers); without it, the whole partition.
using System;
using System.Collections.Generic;

namespace NativeDataEngine
{
    public sealed class WinSpec
    {
        public string Fn; public List<BExpr> Args = new List<BExpr>(); public bool Star;
        public List<BExpr> Partition = new List<BExpr>(); public List<SortKey> Order = new List<SortKey>(); public DataType Out;

        public static DataType OutType(string fn, List<BExpr> args)
        {
            switch (fn)
            {
                case "row_number": case "rank": case "dense_rank": case "ntile": case "count": return DataType.BigInt;
                case "percent_rank": case "cume_dist": case "avg": case "mean": return DataType.Double;
                case "sum": return args.Count > 0 && args[0].Type.Kind == Kind.Int ? DataType.BigInt : DataType.Double;
                case "lag": case "lead": case "first_value": case "last_value": case "min": case "max":
                    if (args.Count == 0) throw new EngineException("FUNCTION_ARGS", fn + "() needs an argument.");
                    return args[0].Type.Kind == Kind.Int ? DataType.BigInt : args[0].Type;
            }
            throw new EngineException("FUNCTION_UNKNOWN", fn + "() cannot be used as a window function.");
        }
    }

    public sealed class WindowOp : Op
    {
        readonly Op child; readonly List<WinSpec> specs;
        public Op Child { get { return child; } }
        public void SpecRefs(HashSet<int> n) { foreach (WinSpec w in specs) { BExpr.RefsOf(w.Args, n); BExpr.RefsOf(w.Partition, n); foreach (SortKey k in w.Order) k.E.Refs(n); } }
        public WindowOp(Op child, List<WinSpec> specs, Schema s) { this.child = child; this.specs = specs; Schema = s; }

        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            using (MemoryLease lease = new MemoryLease(ctx.Mem, "Window function"))
            {
                Batch all = Collect.All(child, ctx, lease);
                int n = all.Rows;
                Column[] outCols = new Column[all.Cols.Length + specs.Count];
                Array.Copy(all.Cols, outCols, all.Cols.Length);
                for (int w = 0; w < specs.Count; w++)
                {
                    outCols[all.Cols.Length + w] = Compute(specs[w], all);
                    lease.Add(outCols[all.Cols.Length + w].Bytes);
                }
                Batch r = new Batch(Schema, outCols, n);
                foreach (Batch piece in AggOp.Split(r, ctx)) yield return piece;
            }
        }

        static Column Compute(WinSpec s, Batch all)
        {
            int n = all.Rows;
            List<SortKey> keys = new List<SortKey>();
            foreach (BExpr p in s.Partition) { SortKey k = new SortKey(); k.E = p; keys.Add(k); }
            keys.AddRange(s.Order);
            int[] idx = keys.Count > 0 ? SortOp.Order(all, keys, -1) : Identity(n);
            Column[] pc = new Column[s.Partition.Count]; for (int k = 0; k < pc.Length; k++) pc[k] = s.Partition[k].Eval(all);
            Column[] oc = new Column[s.Order.Count]; for (int k = 0; k < oc.Length; k++) oc[k] = s.Order[k].E.Eval(all);
            Column arg = s.Args.Count > 0 ? s.Args[0].Eval(all) : null;
            Column res = new Column(s.Out, n);
            int start = 0;
            while (start < n)
            {
                int end = start + 1;
                while (end < n && Same(pc, idx[start], idx[end])) end++;
                Partition(s, idx, start, end, oc, arg, res, all);
                start = end;
            }
            return res;
        }
        static int[] Identity(int n) { int[] r = new int[n]; for (int i = 0; i < n; i++) r[i] = i; return r; }
        static bool Same(Column[] cs, int a, int b)
        {
            foreach (Column c in cs)
            {
                bool an = c.IsNull(a), bn = c.IsNull(b);
                if (an != bn) return false;
                if (!an && BCmp.Compare(c, a, c, b) != 0) return false;
            }
            return true;
        }

        static void Partition(WinSpec s, int[] idx, int st, int en, Column[] oc, Column arg, Column res, Batch all)
        {
            int cnt = en - st;
            bool ordered = oc.Length > 0;
            // peer group end for each position (rows with equal ORDER BY values)
            int[] peerEnd = new int[cnt];
            for (int i = cnt - 1; i >= 0; i--)
                peerEnd[i] = (i + 1 < cnt && ordered && Same(oc, idx[st + i], idx[st + i + 1])) ? peerEnd[i + 1] : (ordered ? i + 1 : cnt);
            switch (s.Fn)
            {
                case "row_number": for (int i = 0; i < cnt; i++) res.I[idx[st + i]] = i + 1; return;
                case "rank": case "dense_rank": case "percent_rank":
                    {
                        long rank = 1, dense = 1;
                        for (int i = 0; i < cnt; i++)
                        {
                            if (i > 0 && !(ordered && Same(oc, idx[st + i - 1], idx[st + i]))) { rank = i + 1; dense++; }
                            int r = idx[st + i];
                            if (s.Fn == "rank") res.I[r] = rank; else if (s.Fn == "dense_rank") res.I[r] = dense; else res.F[r] = cnt > 1 ? (rank - 1) / (double)(cnt - 1) : 0;
                        }
                        return;
                    }
                case "cume_dist": for (int i = 0; i < cnt; i++) res.F[idx[st + i]] = peerEnd[i] / (double)cnt; return;
                case "ntile":
                    {
                        long buckets = Math.Max(1, s.Args.Count > 0 ? (long)Convert.ToDouble(((BLit)s.Args[0]).Value) : 1);
                        for (int i = 0; i < cnt; i++) res.I[idx[st + i]] = 1 + (long)i * buckets / cnt;
                        return;
                    }
                case "lag": case "lead":
                    {
                        int off = s.Args.Count > 1 ? (int)Convert.ToInt64(((BLit)s.Args[1]).Value) : 1;
                        Column def = s.Args.Count > 2 ? Cast.To(s.Args[2].Eval(all), s.Out, true) : null;
                        Column a = arg.Type.SameAs(s.Out) || (arg.Type.UsesI && s.Out.UsesI) ? arg : Cast.To(arg, s.Out, true);
                        for (int i = 0; i < cnt; i++)
                        {
                            int j = s.Fn == "lag" ? i - off : i + off, r = idx[st + i];
                            if (j < 0 || j >= cnt) { if (def != null) BCase.Copy(def, r, res, r); else res.SetNull(r); }
                            else BCase.Copy(a, idx[st + j], res, r);
                        }
                        return;
                    }
                case "first_value": case "last_value":
                    {
                        Column a = arg.Type.SameAs(s.Out) || (arg.Type.UsesI && s.Out.UsesI) ? arg : Cast.To(arg, s.Out, true);
                        for (int i = 0; i < cnt; i++)
                        {
                            int r = idx[st + i];
                            int from = s.Fn == "first_value" ? idx[st] : idx[st + peerEnd[i] - 1];
                            BCase.Copy(a, from, res, r);
                        }
                        return;
                    }
            }
            // Aggregates: running over peers (ORDER BY) or whole partition.
            Column v = arg == null ? null : (arg.F != null || arg.I != null ? arg : Cast.To(arg, s.Out.Kind == Kind.String ? DataType.Varchar : DataType.Double, true));
            bool isMin = s.Fn == "min", isMax = s.Fn == "max";
            Column vv = (isMin || isMax) ? (v.Type.SameAs(s.Out) || (v.Type.UsesI && s.Out.UsesI) ? v : Cast.To(v, s.Out, true)) : null;
            double sum = 0; long lsum = 0, count = 0; int best = -1;
            int pos = 0;
            while (pos < cnt)
            {
                int pe = peerEnd[pos];
                for (int i = pos; i < pe; i++)
                {
                    int r = idx[st + i];
                    if (s.Star || s.Fn == "count" && v == null) { count++; continue; }
                    if (v.IsNull(r)) continue;
                    count++;
                    if (isMin || isMax) { if (best < 0) best = r; else { int c = BCmp.Compare(v, r, v, best); if (isMin ? c < 0 : c > 0) best = r; } }
                    else if (v.I != null) { lsum += v.I[r]; sum += v.I[r]; } else sum += v.F[r];
                }
                for (int i = pos; i < pe; i++)
                {
                    int r = idx[st + i];
                    switch (s.Fn)
                    {
                        case "count": res.I[r] = count; break;
                        case "sum": if (count == 0) res.SetNull(r); else if (res.I != null) res.I[r] = lsum; else res.F[r] = sum; break;
                        case "avg": case "mean": if (count == 0) res.SetNull(r); else res.F[r] = sum / count; break;
                        default: if (best < 0) res.SetNull(r); else BCase.Copy(vv, best, res, r); break;
                    }
                }
                pos = pe;
            }
        }
    }
}
