// Hash aggregation: group-key index + per-group aggregate states. Partial tables (one per row group, built on
// workers) merge into one in row-group order, so results are the same for any worker count.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace NativeDataEngine
{
    // Composite key for multi-column grouping / joins.
    public struct RowKey : IEquatable<RowKey>
    {
        public readonly object[] V; readonly int h;
        public RowKey(object[] v)
        {
            V = v; ulong x = 1469598103934665603UL;
            foreach (object o in v) x = Functions.Mix(x, o == null ? 7UL : (ulong)o.GetHashCode());
            h = (int)(x ^ (x >> 32));
        }
        public override int GetHashCode() { return h; }
        public bool Equals(RowKey o)
        {
            if (o.h != h || o.V.Length != V.Length) return false;
            for (int k = 0; k < V.Length; k++) { if (V[k] == null) { if (o.V[k] != null) return false; } else if (!V[k].Equals(o.V[k])) return false; }
            return true;
        }
        public override bool Equals(object obj) { return obj is RowKey && Equals((RowKey)obj); }
    }

    // Maps key rows to dense group ids (first-seen order) and keeps each group's key values.
    public sealed class KeyIndex
    {
        readonly DataType[] types; readonly ColumnBuilder[] keys;
        Dictionary<long, int> lmap; TextKeys smap; List<int> sgroup; Dictionary<RowKey, int> gmap; int nullGroup = -1;   // smap: text keys as bytes (TextKeys.cs)
        int count;
        public int Count { get { return count; } }
        public KeyIndex(DataType[] types)
        {
            this.types = types; keys = new ColumnBuilder[types.Length];
            for (int k = 0; k < types.Length; k++) keys[k] = new ColumnBuilder(types[k], 16);
            if (types.Length == 1 && types[0].UsesI) lmap = new Dictionary<long, int>();
            else if (types.Length == 1 && types[0].Kind == Kind.String) { smap = new TextKeys(); sgroup = new List<int>(); }
            else if (types.Length >= 2 && types.Length <= 6)
            {
                // Several key columns: each value gets a small per-column code; the codes pack into one long.
                bits = 62 / types.Length; maxCode = (1L << bits) - 1;
                cmap = new Dictionary<long, int>();
                colL = new Dictionary<long, int>[types.Length]; colS = new TextKeys[types.Length]; colD = new Dictionary<double, int>[types.Length];
                for (int k = 0; k < types.Length; k++)
                {
                    if (types[k].UsesI || types[k].Kind == Kind.Bool) colL[k] = new Dictionary<long, int>();
                    else if (types[k].UsesF) colD[k] = new Dictionary<double, int>();
                    else colS[k] = new TextKeys();
                }
            }
            else if (types.Length > 0) gmap = new Dictionary<RowKey, int>();
        }
        Dictionary<long, int> cmap; Dictionary<long, int>[] colL; TextKeys[] colS; Dictionary<double, int>[] colD; int bits; long maxCode;
        // Code of one key value (0 = NULL), or -1 when the column has more distinct values than its bits allow.
        long Code(int k, Column c, int i)
        {
            if (c.IsNull(i) || c.Type.Kind == Kind.Null) return 0;
            int code;
            if (colL[k] != null)
            {
                long v = c.I != null ? c.I[i] : c.B != null ? (c.B[i] ? 1 : 0) : (long)c.F[i];
                if (!colL[k].TryGetValue(v, out code)) { code = colL[k].Count + 1; colL[k][v] = code; }
            }
            else if (colD[k] != null)
            {
                double v = c.F != null ? c.F[i] : c.I[i]; if (v == 0) v = 0.0;
                if (!colD[k].TryGetValue(v, out code)) { code = colD[k].Count + 1; colD[k][v] = code; }
            }
            else
            {
                code = (c.IsLazyText || c.Type.Kind == Kind.String ? colS[k].Get(c, i) : colS[k].Get(Values.Text(c, i))) + 1;
            }
            return code > maxCode ? -1 : code;
        }
        // Too many distinct values for packed codes: move every group to the general (boxed) map.
        void ToGeneral()
        {
            gmap = new Dictionary<RowKey, int>();
            Column[] kc = KeyColumns();
            for (int gI = 0; gI < count; gI++)
            {
                object[] v = new object[kc.Length];
                for (int k = 0; k < kc.Length; k++) v[k] = KeyOf(kc[k], gI);
                gmap[new RowKey(v)] = gI;
            }
            cmap = null; colL = null; colS = null; colD = null;
        }
        public static object KeyOf(Column c, int i)
        {
            if (c.IsNull(i) || c.Type.Kind == Kind.Null) return null;
            if (c.I != null) return c.I[i];
            if (c.F != null) { double d = c.F[i]; return d == 0 ? 0.0 : d; }   // -0 == 0
            if (c.IsLazyText) return Encoding.UTF8.GetString(c.Utf8, c.Offs[i], c.Offs[i + 1] - c.Offs[i]);   // one value, not the column
            if (c.S != null) return c.S[i];
            return c.B[i];
        }
        int New(Column[] cols, int i)
        {
            for (int k = 0; k < cols.Length; k++) keys[k].Add(cols[k], i);
            return count++;
        }
        public int[] Assign(Column[] cols, int n)
        {
            int[] g = new int[n];
            if (types.Length == 0) { if (count == 0) count = 1; return g; }
            if (lmap != null)
            {
                Column c = cols[0];
                for (int i = 0; i < n; i++)
                {
                    if (c.IsNull(i) || c.I == null) { if (nullGroup < 0) nullGroup = New(cols, i); g[i] = nullGroup; continue; }
                    int id; long v = c.I[i];
                    if (!lmap.TryGetValue(v, out id)) { id = New(cols, i); lmap[v] = id; }
                    g[i] = id;
                }
                return g;
            }
            if (smap != null)
            {
                Column c = cols[0];
                for (int i = 0; i < n; i++)
                {
                    if (c.IsNull(i) || c.Type.Kind != Kind.String) { if (nullGroup < 0) nullGroup = New(cols, i); g[i] = nullGroup; continue; }
                    bool added; int t = smap.Get(c, i, out added);
                    if (added) sgroup.Add(New(cols, i));
                    g[i] = sgroup[t];
                }
                return g;
            }
            if (cmap != null)
            {
                for (int i = 0; i < n; i++)
                {
                    long key = 0; bool overflow = false;
                    for (int k = 0; k < cols.Length; k++)
                    {
                        long code = Code(k, cols[k], i);
                        if (code < 0) { overflow = true; break; }
                        key |= code << (bits * k);
                    }
                    if (overflow) { ToGeneral(); return AssignGeneral(cols, n, g, i); }
                    int id;
                    if (!cmap.TryGetValue(key, out id)) { id = New(cols, i); cmap[key] = id; }
                    g[i] = id;
                }
                return g;
            }
            return AssignGeneral(cols, n, g, 0);
        }
        int[] AssignGeneral(Column[] cols, int n, int[] g, int from)
        {
            for (int i = from; i < n; i++)
            {
                object[] v = new object[cols.Length];
                for (int k = 0; k < cols.Length; k++) v[k] = KeyOf(cols[k], i);
                RowKey rk = new RowKey(v); int id;
                if (!gmap.TryGetValue(rk, out id)) { id = New(cols, i); gmap[rk] = id; }
                g[i] = id;
            }
            return g;
        }
        public Column[] KeyColumns()
        {
            Column[] r = new Column[keys.Length];
            for (int k = 0; k < keys.Length; k++) r[k] = keys[k].ToColumn();
            return r;
        }
    }

    public sealed class AggSpec
    {
        public string Fn; public BExpr Arg, Arg2; public bool Distinct; public BExpr Filter; public DataType Out; public double Param;
        public static DataType OutType(string fn, DataType arg)
        {
            switch (fn)
            {
                case "count": case "count_if": case "countif": case "approx_count_distinct": return DataType.BigInt;
                case "avg": case "mean": case "stddev": case "stddev_samp": case "stddev_pop": case "variance": case "var_samp": case "var_pop":
                case "quantile_cont": case "median": case "product": case "fsum": case "sumkahan": case "kahan_sum": return DataType.Double;
                case "sum":
                    if (arg.Kind == Kind.Int || arg.Kind == Kind.Bool) return DataType.BigInt;
                    if (arg.Kind == Kind.Decimal) return DataType.Decimal(38, arg.Scale);
                    return DataType.Double;
                case "string_agg": case "group_concat": case "listagg": return DataType.Varchar;
                case "bool_and": case "bool_or": return DataType.Bool;
                default: return arg.Kind == Kind.Int ? DataType.BigInt : arg;   // min/max/any_value/first/last/mode/quantile_disc
            }
        }
    }

    public abstract class AggState
    {
        public abstract void Update(int[] g, int n, Column a, Column a2, bool[] mask);
        public abstract void Merge(AggState other, int[] map, int otherGroups);
        public abstract Column Result(int groups);
        public static AggState Create(AggSpec s)
        {
            if (s.Distinct && s.Fn != "min" && s.Fn != "max") return new DistinctState(s);
            switch (s.Fn)
            {
                case "count": return new CountState(s.Arg == null);
                case "count_if": case "countif": return new CountIfState();
                case "sum": case "fsum": case "sumkahan": case "kahan_sum": return new SumState(s.Out);
                case "avg": case "mean": return new AvgState();
                case "min": return new MinMaxState(s.Out, true);
                case "max": return new MinMaxState(s.Out, false);
                case "any_value": case "first": case "arbitrary": return new AnyState(s.Out, false);
                case "last": return new AnyState(s.Out, true);
                case "stddev": case "stddev_samp": case "stddev_pop": case "variance": case "var_samp": case "var_pop": return new VarState(s.Fn);
                case "string_agg": case "group_concat": case "listagg": return new ListState(s, ListState.Mode.Concat);
                case "median": case "quantile_cont": case "quantile": return new ListState(s, ListState.Mode.QuantCont);
                case "quantile_disc": return new ListState(s, ListState.Mode.QuantDisc);
                case "mode": return new ListState(s, ListState.Mode.Mode);
                case "approx_count_distinct": { AggSpec d = new AggSpec(); d.Fn = "count"; d.Arg = s.Arg; d.Distinct = true; d.Out = DataType.BigInt; return new DistinctState(d); }
                case "bool_and": return new BoolState(true);
                case "bool_or": return new BoolState(false);
                case "product": return new ProductState();
            }
            throw new EngineException("FUNCTION_UNKNOWN", "Unknown aggregate " + s.Fn + "().");
        }
        protected static bool Skip(Column a, bool[] mask, int i) { return (mask != null && !mask[i]) || (a != null && (a.IsNull(i) || a.Type.Kind == Kind.Null)); }
        protected static void Fit<T>(ref T[] arr, int groups) { if (arr.Length < groups) Array.Resize(ref arr, Math.Max(groups, arr.Length * 2)); }
    }

    sealed class CountState : AggState
    {
        long[] c = new long[16]; readonly bool star;
        public CountState(bool star) { this.star = star; }
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i]; Fit(ref c, max + 1);
            for (int i = 0; i < n; i++) if (!Skip(star ? null : a, mask, i)) c[g[i]]++;
        }
        public override void Merge(AggState o, int[] map, int og) { CountState x = (CountState)o; for (int k = 0; k < og; k++) { Fit(ref c, map[k] + 1); c[map[k]] += k < x.c.Length ? x.c[k] : 0; } }
        public override Column Result(int groups) { Fit(ref c, groups); Column r = new Column(DataType.BigInt, groups); Array.Copy(c, r.I, groups); return r; }
    }

    sealed class CountIfState : AggState
    {
        long[] c = new long[16];
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i]; Fit(ref c, max + 1);
            Column b = Cast.To(a, DataType.Bool, true);
            for (int i = 0; i < n; i++) if (!Skip(b, mask, i) && b.B[i]) c[g[i]]++;
        }
        public override void Merge(AggState o, int[] map, int og) { CountIfState x = (CountIfState)o; for (int k = 0; k < og; k++) { Fit(ref c, map[k] + 1); c[map[k]] += k < x.c.Length ? x.c[k] : 0; } }
        public override Column Result(int groups) { Fit(ref c, groups); Column r = new Column(DataType.BigInt, groups); Array.Copy(c, r.I, groups); return r; }
    }

    sealed class SumState : AggState
    {
        readonly DataType t; long[] l = new long[16]; double[] d = new double[16]; bool[] has = new bool[16];
        public SumState(DataType t) { this.t = t; }
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i];
            Fit(ref l, max + 1); Fit(ref d, max + 1); Fit(ref has, max + 1);
            if (a.Type.Kind == Kind.Bool) a = Cast.To(a, DataType.BigInt, false);
            if (t.UsesI && a.I != null) { for (int i = 0; i < n; i++) if (!Skip(a, mask, i)) { l[g[i]] += a.I[i]; has[g[i]] = true; } }
            else if (a.F != null) { for (int i = 0; i < n; i++) if (!Skip(a, mask, i)) { d[g[i]] += a.F[i]; has[g[i]] = true; } }
            else if (a.I != null) { for (int i = 0; i < n; i++) if (!Skip(a, mask, i)) { d[g[i]] += a.I[i]; has[g[i]] = true; } }
            else if (a.Type.Kind != Kind.Null) throw new EngineException("TYPE_MISMATCH", "sum() needs a number column, not " + a.Type.Name + ".");
        }
        public override void Merge(AggState o, int[] map, int og)
        {
            SumState x = (SumState)o;
            for (int k = 0; k < og; k++)
            {
                int m = map[k]; Fit(ref l, m + 1); Fit(ref d, m + 1); Fit(ref has, m + 1);
                if (k < x.has.Length && x.has[k]) { l[m] += x.l[k]; d[m] += x.d[k]; has[m] = true; }
            }
        }
        public override Column Result(int groups)
        {
            Fit(ref l, groups); Fit(ref d, groups); Fit(ref has, groups);
            Column r = new Column(t, groups);
            for (int k = 0; k < groups; k++) { if (!has[k]) r.SetNull(k); else if (r.I != null) r.I[k] = l[k]; else r.F[k] = d[k]; }
            return r;
        }
    }

    sealed class AvgState : AggState
    {
        double[] s = new double[16]; long[] c = new long[16];
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i]; Fit(ref s, max + 1); Fit(ref c, max + 1);
            if (a.Type.Kind == Kind.Null) return;
            if (a.I == null && a.F == null) a = Cast.To(a, DataType.Double, true);
            for (int i = 0; i < n; i++) if (!Skip(a, mask, i)) { s[g[i]] += a.F != null ? a.F[i] : a.I[i]; c[g[i]]++; }
        }
        public override void Merge(AggState o, int[] map, int og)
        {
            AvgState x = (AvgState)o;
            for (int k = 0; k < og; k++) { int m = map[k]; Fit(ref s, m + 1); Fit(ref c, m + 1); if (k < x.c.Length) { s[m] += x.s[k]; c[m] += x.c[k]; } }
        }
        public override Column Result(int groups)
        {
            Fit(ref s, groups); Fit(ref c, groups); Column r = new Column(DataType.Double, groups);
            for (int k = 0; k < groups; k++) { if (c[k] == 0) r.SetNull(k); else r.F[k] = s[k] / c[k]; }
            return r;
        }
    }

    sealed class MinMaxState : AggState
    {
        readonly DataType t; readonly bool min; Column best; bool[] has = new bool[16];
        public MinMaxState(DataType t, bool min) { this.t = t; this.min = min; best = new Column(t, 16); }
        void Fit(int groups)
        {
            if (has.Length >= groups) return;
            int cap = Math.Max(groups, has.Length * 2);
            Array.Resize(ref has, cap);
            if (best.I != null) Array.Resize(ref best.I, cap); if (best.F != null) Array.Resize(ref best.F, cap);
            if (best.S != null) { string[] s = best.S; Array.Resize(ref s, cap); best.S = s; } if (best.B != null) Array.Resize(ref best.B, cap);
            best.Length = cap;
        }
        void Offer(int gi, Column a, int i)
        {
            if (!has[gi]) { BCase.Copy(a, i, best, gi); has[gi] = true; return; }
            int c = BCmp.Compare(a, i, best, gi);
            if (min ? c < 0 : c > 0) BCase.Copy(a, i, best, gi);
        }
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i]; Fit(max + 1);
            if (a.Type.Kind == Kind.Null) return;
            if (a.IsLazyText && t.Kind == Kind.String) { Bytes(g, n, a, mask); return; }
            if (!(a.Type.UsesI == t.UsesI && a.Type.UsesF == t.UsesF)) a = Cast.To(a, t, true);
            for (int i = 0; i < n; i++) if (!Skip(a, mask, i)) Offer(g[i], a, i);
        }
        // Text as bytes: each group's best row of this batch is found on the bytes, and only those rows are decoded.
        void Bytes(int[] g, int n, Column a, bool[] mask)
        {
            byte[] u = a.Utf8; int[] f = a.Offs;
            System.Collections.Generic.Dictionary<int, int> win = new System.Collections.Generic.Dictionary<int, int>();
            for (int i = 0; i < n; i++)
            {
                if (a.IsNull(i) || (mask != null && !mask[i])) continue;
                int w;
                if (!win.TryGetValue(g[i], out w)) { win[g[i]] = i; continue; }
                int c = Utf8Ops.Compare(u, f[i], f[i + 1] - f[i], u, f[w], f[w + 1] - f[w]);
                if (min ? c < 0 : c > 0) win[g[i]] = i;
            }
            Column one = new Column(t, win.Count); int k = 0;
            foreach (System.Collections.Generic.KeyValuePair<int, int> p in win)
            {
                int i = p.Value; one.S[k] = Encoding.UTF8.GetString(u, f[i], f[i + 1] - f[i]);
                Offer(p.Key, one, k); k++;
            }
        }
        public override void Merge(AggState o, int[] map, int og)
        {
            MinMaxState x = (MinMaxState)o;
            for (int k = 0; k < og; k++) { Fit(map[k] + 1); if (k < x.has.Length && x.has[k]) Offer(map[k], x.best, k); }
        }
        public override Column Result(int groups)
        {
            Fit(groups); Column r = best.Slice(0, groups); r.Nulls = null;
            for (int k = 0; k < groups; k++) if (!has[k]) r.SetNull(k);
            return r;
        }
    }

    sealed class AnyState : AggState
    {
        readonly DataType t; readonly bool last; object[] v = new object[16]; bool[] has = new bool[16];
        public AnyState(DataType t, bool last) { this.t = t; this.last = last; }
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i]; Fit(ref v, max + 1); Fit(ref has, max + 1);
            for (int i = 0; i < n; i++) if (!Skip(a, mask, i) && (last || !has[g[i]])) { v[g[i]] = a.Get(i); has[g[i]] = true; }
        }
        public override void Merge(AggState o, int[] map, int og)
        {
            AnyState x = (AnyState)o;
            for (int k = 0; k < og; k++) { int m = map[k]; Fit(ref v, m + 1); Fit(ref has, m + 1); if (k < x.has.Length && x.has[k] && (last || !has[m])) { v[m] = x.v[k]; has[m] = true; } }
        }
        public override Column Result(int groups)
        {
            Fit(ref v, groups); ColumnBuilder b = new ColumnBuilder(t, groups);
            for (int k = 0; k < groups; k++) b.AddObj(v[k]);
            return b.ToColumn();
        }
    }

    sealed class VarState : AggState
    {
        readonly string fn; long[] c = new long[16]; double[] mean = new double[16], m2 = new double[16];
        public VarState(string fn) { this.fn = fn; }
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i]; Fit(ref c, max + 1); Fit(ref mean, max + 1); Fit(ref m2, max + 1);
            if (a.Type.Kind == Kind.Null) return;
            if (a.F == null) a = Cast.To(a, DataType.Double, true);
            for (int i = 0; i < n; i++)
            {
                if (Skip(a, mask, i)) continue;
                int k = g[i]; double x = a.F[i]; c[k]++; double d = x - mean[k]; mean[k] += d / c[k]; m2[k] += d * (x - mean[k]);
            }
        }
        public override void Merge(AggState o, int[] map, int og)
        {
            VarState x = (VarState)o;
            for (int k = 0; k < og && k < x.c.Length; k++)
            {
                int m = map[k]; Fit(ref c, m + 1); Fit(ref mean, m + 1); Fit(ref m2, m + 1);
                if (x.c[k] == 0) continue;
                if (c[m] == 0) { c[m] = x.c[k]; mean[m] = x.mean[k]; m2[m] = x.m2[k]; continue; }
                long nn = c[m] + x.c[k]; double d = x.mean[k] - mean[m];
                m2[m] += x.m2[k] + d * d * c[m] * x.c[k] / nn; mean[m] += d * x.c[k] / nn; c[m] = nn;
            }
        }
        public override Column Result(int groups)
        {
            Fit(ref c, groups); Fit(ref m2, groups); Column r = new Column(DataType.Double, groups);
            bool pop = fn.EndsWith("_pop"), sd = fn.StartsWith("stddev");
            for (int k = 0; k < groups; k++)
            {
                long nn = c[k]; if (nn == 0 || (!pop && nn < 2)) { r.SetNull(k); continue; }
                double v = m2[k] / (pop ? nn : nn - 1); r.F[k] = sd ? Math.Sqrt(v) : v;
            }
            return r;
        }
    }

    sealed class ProductState : AggState
    {
        double[] p = new double[16]; bool[] has = new bool[16];
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i]; Fit(ref p, max + 1); Fit(ref has, max + 1);
            if (a.F == null) a = Cast.To(a, DataType.Double, true);
            for (int i = 0; i < n; i++) if (!Skip(a, mask, i)) { int k = g[i]; p[k] = has[k] ? p[k] * a.F[i] : a.F[i]; has[k] = true; }
        }
        public override void Merge(AggState o, int[] map, int og)
        {
            ProductState x = (ProductState)o;
            for (int k = 0; k < og && k < x.has.Length; k++) { int m = map[k]; Fit(ref p, m + 1); Fit(ref has, m + 1); if (x.has[k]) { p[m] = has[m] ? p[m] * x.p[k] : x.p[k]; has[m] = true; } }
        }
        public override Column Result(int groups) { Fit(ref p, groups); Fit(ref has, groups); Column r = new Column(DataType.Double, groups); for (int k = 0; k < groups; k++) { if (!has[k]) r.SetNull(k); else r.F[k] = p[k]; } return r; }
    }

    sealed class BoolState : AggState
    {
        readonly bool and; bool[] v = new bool[16], has = new bool[16];
        public BoolState(bool and) { this.and = and; }
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i]; Fit(ref v, max + 1); Fit(ref has, max + 1);
            Column b = Cast.To(a, DataType.Bool, true);
            for (int i = 0; i < n; i++) if (!Skip(b, mask, i)) { int k = g[i]; v[k] = has[k] ? (and ? v[k] && b.B[i] : v[k] || b.B[i]) : b.B[i]; has[k] = true; }
        }
        public override void Merge(AggState o, int[] map, int og)
        {
            BoolState x = (BoolState)o;
            for (int k = 0; k < og && k < x.has.Length; k++) { int m = map[k]; Fit(ref v, m + 1); Fit(ref has, m + 1); if (x.has[k]) { v[m] = has[m] ? (and ? v[m] && x.v[k] : v[m] || x.v[k]) : x.v[k]; has[m] = true; } }
        }
        public override Column Result(int groups) { Fit(ref v, groups); Fit(ref has, groups); Column r = new Column(DataType.Bool, groups); for (int k = 0; k < groups; k++) { if (!has[k]) r.SetNull(k); else r.B[k] = v[k]; } return r; }
    }

    // Keeps every value per group: string_agg, median / quantiles, mode.
    sealed class ListState : AggState
    {
        public enum Mode { Concat, QuantCont, QuantDisc, Mode }
        readonly AggSpec s; readonly Mode mode; List<object>[] vals = new List<object>[16]; string sep = ",";
        public ListState(AggSpec s, Mode m) { this.s = s; mode = m; }
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i]; Fit(ref vals, max + 1);
            if (mode == Mode.Concat && a2 != null && n > 0 && !a2.IsNull(0)) sep = Values.Text(a2, 0);
            if (mode == Mode.QuantCont && a.F == null && a.I == null) a = Cast.To(a, DataType.Double, true);
            for (int i = 0; i < n; i++)
            {
                if (Skip(a, mask, i)) continue;
                List<object> l = vals[g[i]] ?? (vals[g[i]] = new List<object>());
                l.Add(mode == Mode.Concat ? (object)Values.Text(a, i) : a.Get(i));
            }
        }
        public override void Merge(AggState o, int[] map, int og)
        {
            ListState x = (ListState)o; sep = x.sep;
            for (int k = 0; k < og && k < x.vals.Length; k++)
            {
                if (x.vals[k] == null) continue;
                int m = map[k]; Fit(ref vals, m + 1);
                if (vals[m] == null) vals[m] = new List<object>();
                vals[m].AddRange(x.vals[k]);
            }
        }
        public override Column Result(int groups)
        {
            Fit(ref vals, groups);
            ColumnBuilder b = new ColumnBuilder(s.Out, groups);
            double q = s.Param > 0 ? s.Param : 0.5;
            for (int k = 0; k < groups; k++)
            {
                List<object> l = vals[k];
                if (l == null || l.Count == 0) { b.AddNull(); continue; }
                if (mode == Mode.Concat) { string[] parts = new string[l.Count]; for (int j = 0; j < l.Count; j++) parts[j] = (string)l[j]; b.AddString(string.Join(sep, parts)); continue; }
                if (mode == Mode.Mode)
                {
                    Dictionary<object, int> cnt = new Dictionary<object, int>(); object best = null; int bc = 0;
                    foreach (object v in l) { int c; cnt.TryGetValue(v, out c); cnt[v] = ++c; if (c > bc) { bc = c; best = v; } }
                    b.AddObj(best); continue;
                }
                List<object> sorted = new List<object>(l);
                sorted.Sort((x, y) => Comparer<object>.Default.Compare(x, y));
                if (mode == Mode.QuantDisc) { b.AddObj(sorted[(int)Math.Max(0, Math.Ceiling(q * sorted.Count) - 1)]); continue; }
                double pos = q * (sorted.Count - 1); int lo = (int)Math.Floor(pos), hi = (int)Math.Ceiling(pos);
                double vlo = Convert.ToDouble(sorted[lo], CultureInfo.InvariantCulture), vhi = Convert.ToDouble(sorted[hi], CultureInfo.InvariantCulture);
                b.AddDouble(vlo + (vhi - vlo) * (pos - lo));
            }
            return b.ToColumn();
        }
    }

    // DISTINCT aggregates: collect distinct values per group, then apply the function.
    sealed class DistinctState : AggState
    {
        readonly AggSpec s; HashSet<object>[] sets = new HashSet<object>[16];
        HashSet<long>[] lsets = new HashSet<long>[16]; TextKeys[] ssets = new TextKeys[16];   // text: kept as bytes (TextKeys.cs)
        public DistinctState(AggSpec s) { this.s = s; }
        public override void Update(int[] g, int n, Column a, Column a2, bool[] mask)
        {
            int max = 0; for (int i = 0; i < n; i++) if (g[i] > max) max = g[i];
            Fit(ref sets, max + 1); Fit(ref lsets, max + 1); Fit(ref ssets, max + 1);
            if (a.I != null && a.Type.UsesI)
            {
                for (int i = 0; i < n; i++) { if (Skip(a, mask, i)) continue; HashSet<long> h = lsets[g[i]] ?? (lsets[g[i]] = new HashSet<long>()); h.Add(a.I[i]); }
                return;
            }
            if (a.Type.Kind == Kind.String && (a.IsLazyText || a.S != null))
            {
                for (int i = 0; i < n; i++) { if (Skip(a, mask, i)) continue; TextKeys h = ssets[g[i]] ?? (ssets[g[i]] = new TextKeys()); h.Get(a, i); }
                return;
            }
            for (int i = 0; i < n; i++)
            {
                if (Skip(a, mask, i)) continue;
                HashSet<object> h = sets[g[i]] ?? (sets[g[i]] = new HashSet<object>());
                h.Add(KeyIndex.KeyOf(a, i));
            }
        }
        // Typed sets folded into the boxed ones (only for Result / non-count functions).
        void Unify(int gI)
        {
            if (gI < lsets.Length && lsets[gI] != null) { HashSet<object> h = sets[gI] ?? (sets[gI] = new HashSet<object>()); foreach (long v in lsets[gI]) h.Add(v); lsets[gI] = null; }
            if (gI < ssets.Length && ssets[gI] != null) { HashSet<object> h = sets[gI] ?? (sets[gI] = new HashSet<object>()); TextKeys t = ssets[gI]; for (int k = 0; k < t.Count; k++) h.Add(t.Key(k)); ssets[gI] = null; }
        }
        public override void Merge(AggState o, int[] map, int og)
        {
            DistinctState x = (DistinctState)o;
            for (int k = 0; k < og; k++)
            {
                int m = map[k]; Fit(ref sets, m + 1); Fit(ref lsets, m + 1); Fit(ref ssets, m + 1);
                if (k < x.lsets.Length && x.lsets[k] != null) { if (lsets[m] == null) lsets[m] = x.lsets[k]; else lsets[m].UnionWith(x.lsets[k]); }
                if (k < x.ssets.Length && x.ssets[k] != null) { if (ssets[m] == null) ssets[m] = x.ssets[k]; else { TextKeys t = x.ssets[k]; for (int q = 0; q < t.Count; q++) ssets[m].Get(t.Bytes, t.Start(q), t.Length(q)); } }
            }
            for (int k = 0; k < og && k < x.sets.Length; k++)
            {
                if (x.sets[k] == null) continue;
                int m = map[k]; Fit(ref sets, m + 1);
                if (sets[m] == null) sets[m] = x.sets[k]; else sets[m].UnionWith(x.sets[k]);
            }
        }
        public override Column Result(int groups)
        {
            Fit(ref sets, groups); Fit(ref lsets, groups); Fit(ref ssets, groups);
            if (s.Fn == "count")
            {
                Column rc = new Column(DataType.BigInt, groups);
                for (int k = 0; k < groups; k++)
                    rc.I[k] = (sets[k] == null ? 0 : sets[k].Count) + (lsets[k] == null ? 0 : lsets[k].Count) + (ssets[k] == null ? 0 : ssets[k].Count);
                return rc;
            }
            for (int k = 0; k < groups; k++) Unify(k);
            if (s.Fn == "count")
            {
                Column r = new Column(DataType.BigInt, groups);
                for (int k = 0; k < groups; k++) r.I[k] = sets[k] == null ? 0 : sets[k].Count;
                return r;
            }
            // Feed the distinct values to a plain state of the same function.
            AggSpec plain = new AggSpec(); plain.Fn = s.Fn; plain.Arg = s.Arg; plain.Arg2 = s.Arg2; plain.Out = s.Out; plain.Param = s.Param;
            AggState st = Create(plain);
            DataType at = s.Arg.Type;
            for (int k = 0; k < groups; k++)
            {
                if (sets[k] == null) continue;
                ColumnBuilder cb = new ColumnBuilder(at, sets[k].Count);
                foreach (object v in sets[k]) cb.AddObj(v);
                Column c = cb.ToColumn(); int[] g = new int[c.Length];
                for (int j = 0; j < g.Length; j++) g[j] = k;
                st.Update(g, c.Length, c, null, null);
            }
            return st.Result(groups);
        }
    }

    // One aggregation table: key index + states. Reserves memory as it grows.
    public sealed class AggTable : IDisposable
    {
        readonly List<BExpr> groups; readonly List<AggSpec> aggs; readonly KeyIndex index; readonly AggState[] states;
        readonly MemoryLease lease; int reservedFor;
        public AggTable(List<BExpr> groups, List<AggSpec> aggs, MemoryGuard mem)
        {
            this.groups = groups; this.aggs = aggs;
            DataType[] kt = new DataType[groups.Count];
            for (int k = 0; k < kt.Length; k++) kt[k] = groups[k].Type;
            index = new KeyIndex(kt);
            states = new AggState[aggs.Count];
            for (int k = 0; k < states.Length; k++) states[k] = AggState.Create(aggs[k]);
            lease = new MemoryLease(mem, "Grouping");
        }
        public int Groups { get { return groups.Count == 0 ? 1 : index.Count; } }
        void Account()
        {
            int g = index.Count;
            if (g < reservedFor + 65536) return;
            lease.Add((long)(g - reservedFor) * (96 + 24 * aggs.Count + 32 * groups.Count));
            reservedFor = g;
        }
        public void Add(Batch b)
        {
            if (b.Rows == 0) return;
            Column[] keys = new Column[groups.Count];
            for (int k = 0; k < keys.Length; k++) keys[k] = groups[k].Eval(b);
            int[] g = index.Assign(keys, b.Rows);
            for (int k = 0; k < aggs.Count; k++)
            {
                AggSpec s = aggs[k];
                Column a = s.Arg != null ? s.Arg.Eval(b) : null, a2 = s.Arg2 != null ? s.Arg2.Eval(b) : null;
                bool[] mask = null;
                if (s.Filter != null)
                {
                    Column f = s.Filter.Eval(b); mask = new bool[b.Rows];
                    for (int i = 0; i < b.Rows; i++) mask[i] = !f.IsNull(i) && f.B[i];
                }
                states[k].Update(g, b.Rows, a, a2, mask);
            }
            Account();
        }
        // Merge another (partial) table into this one, in its group order.
        public void Merge(AggTable o)
        {
            int og = o.Groups;
            int[] map;
            if (groups.Count == 0) { map = new int[og]; index.Assign(new Column[0], 0); }
            else map = index.Assign(o.index.KeyColumns(), og);
            for (int k = 0; k < states.Length; k++) states[k].Merge(o.states[k], map, og);
            Account();
        }
        public Batch Result(Schema s)
        {
            int n = Groups;
            Column[] cols = new Column[groups.Count + aggs.Count];
            Column[] keys = index.KeyColumns();
            for (int k = 0; k < keys.Length; k++) cols[k] = keys[k];
            for (int k = 0; k < aggs.Count; k++)
            {
                Column c = states[k].Result(n);
                if (!c.Type.SameAs(aggs[k].Out) && aggs[k].Out.Kind != Kind.Null) c = Cast.To(c, aggs[k].Out, true);
                cols[groups.Count + k] = c;
            }
            return new Batch(s, cols, n);
        }
        public void Dispose() { lease.Dispose(); }
    }
}
