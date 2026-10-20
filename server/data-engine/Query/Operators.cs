// Physical operators. Batches stream through; splittable sources (Parquet row groups, in-memory tables) run their
// per-unit work (read + filter + project + join probe + partial aggregate) on the worker pool, in unit order.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace NativeDataEngine
{
    public sealed class ExecCtx
    {
        public DataEngine Engine;
        public WorkerPool Pool;
        public MemoryGuard Mem;
        public CancellationToken Ct;
        public int Parallel;          // max units in flight (bench "workers"); defaults to the pool size
        public Job Job;               // progress (optional)
        readonly List<IDisposable> cleanup = new List<IDisposable>();
        public void Rows(long n) { if (Job != null) Job.AddRows(n); }
        public void OnEnd(IDisposable d) { lock (cleanup) cleanup.Add(d); }
        public void End() { lock (cleanup) { foreach (IDisposable d in cleanup) { try { d.Dispose(); } catch { } } cleanup.Clear(); } }
    }

    public abstract class Op
    {
        public Schema Schema;
        public abstract IEnumerable<Batch> Run(ExecCtx ctx);
    }

    // A source that can be cut into independent units (row groups). Non-splittable ones have one unit.
    public abstract class Source : Op
    {
        public abstract int Units(ExecCtx ctx);
        public abstract IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit);
        public virtual long KnownRows(ExecCtx ctx) { return -1; }   // row count without reading data, or -1
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            int n = Units(ctx);
            for (int u = 0; u < n; u++) foreach (Batch b in RunUnit(ctx, u)) yield return b;
        }
    }

    // Any operator as a one-unit source.
    public sealed class OpSource : Source
    {
        public readonly Op Inner;
        public OpSource(Op inner) { Inner = inner; Schema = inner.Schema; }
        public override int Units(ExecCtx ctx) { return 1; }
        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit) { return Inner.Run(ctx); }
    }

    // In-memory batches (VALUES, cached / session tables, resident datasets).
    // Resident datasets (resident = true): columns the query never reads are left out (placeholders, like a file scan),
    // and text kept as Arrow bytes is handed over as a per-query copy so decoding never touches the shared batch.
    // Packed columns (Storage/Packing.cs) are unpacked into a plain per-query copy the same way.
    public sealed class MemSource : Source
    {
        readonly List<Batch> batches; readonly bool resident;
        HashSet<int> needed;
        public MemSource(Schema s, List<Batch> b) : this(s, b, false) { }
        public MemSource(Schema s, List<Batch> b, bool resident) { Schema = s; batches = b; this.resident = resident; }
        public void SetNeeded(HashSet<int> cols) { if (resident) needed = cols; }
        public override int Units(ExecCtx ctx) { return batches.Count; }
        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit)
        {
            Batch b = batches[unit];
            if (!resident) { yield return b; yield break; }
            Column[] cs = new Column[b.Cols.Length];
            for (int c = 0; c < cs.Length; c++)
            {
                Column x = b.Cols[c];
                if (needed != null && !needed.Contains(c)) { Column ph = new Column(DataType.Null, 0); ph.Type = x.Type; ph.Length = b.Rows; ph.Nulls = null; cs[c] = ph; }
                else cs[c] = x.IsPacked ? Packing.Unpack(x) : x.IsLazyText ? x.ShallowCopy() : x;
            }
            yield return new Batch(b.Schema, cs, b.Rows);
        }
        public override long KnownRows(ExecCtx ctx) { long n = 0; foreach (Batch b in batches) n += b.Rows; return n; }
    }

    // range(n) / range(a, b[, step]): generated in units of BatchRowCount.
    public sealed class RangeSource : Source
    {
        readonly long a, b, step; readonly int per;
        public RangeSource(string name, long a, long b, long step, int per)
        {
            this.a = a; this.b = b; this.step = step == 0 ? 1 : step; this.per = per;
            Schema = new Schema(new List<Field> { new Field(name, DataType.BigInt) });
        }
        long Count { get { long n = (b - a + step - Math.Sign(step)) / step; return Math.Max(0, n); } }
        public override int Units(ExecCtx ctx) { return (int)((Count + per - 1) / per); }
        public override long KnownRows(ExecCtx ctx) { return Count; }
        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit)
        {
            long from = (long)unit * per, n = Math.Min(per, Count - from);
            Column c = new Column(DataType.BigInt, (int)n);
            for (int i = 0; i < n; i++) c.I[i] = a + (from + i) * step;
            yield return new Batch(Schema, new[] { c }, (int)n);
        }
    }

    public interface ITransform
    {
        Schema Out { get; }
        Batch Apply(Batch b, ExecCtx ctx);
    }

    public sealed class FilterStep : ITransform
    {
        readonly BExpr cond; readonly Schema s;
        public FilterStep(BExpr cond, Schema s) { this.cond = BCast.To(cond, DataType.Bool); this.s = s; }
        public Schema Out { get { return s; } }
        public void Refs(HashSet<int> n) { cond.Refs(n); }
        public Batch Apply(Batch b, ExecCtx ctx)
        {
            Column c = cond.Eval(b);
            int[] idx = new int[b.Rows]; int n = 0;
            for (int i = 0; i < b.Rows; i++) if (!c.IsNull(i) && c.B[i]) idx[n++] = i;
            if (n == b.Rows) return b;
            return b.Take(idx, n);
        }
    }

    public sealed class ProjectStep : ITransform
    {
        readonly List<BExpr> exprs; readonly Schema s; HashSet<int> live;   // live: outputs anyone reads (null = all)
        public ProjectStep(List<BExpr> exprs, Schema s) { this.exprs = exprs; this.s = s; }
        public Schema Out { get { return s; } }
        public void Refs(HashSet<int> n, HashSet<int> need)
        {
            live = new HashSet<int>(need);
            for (int k = 0; k < exprs.Count; k++) if (need.Contains(k)) exprs[k].Refs(n);
        }
        public Batch Apply(Batch b, ExecCtx ctx)
        {
            Column[] cs = new Column[exprs.Count];
            for (int k = 0; k < cs.Length; k++)
            {
                if (live != null && !live.Contains(k)) { Column ph = new Column(DataType.Null, 0); ph.Type = s[k].Type; ph.Length = b.Rows; ph.Nulls = null; cs[k] = ph; continue; }
                Column c = exprs[k].Eval(b);
                if (!c.Type.SameAs(s[k].Type) && s[k].Type.Kind != Kind.Null && !(c.Type.UsesI && s[k].Type.UsesI && c.Type.Kind == s[k].Type.Kind)) c = Cast.To(c, s[k].Type, true);
                cs[k] = c;
            }
            return new Batch(s, cs, b.Rows);
        }
    }

    // Source + stateless steps. Parallel over units when there is more than one.
    public sealed class ChainOp : Op
    {
        public readonly Source Src; public readonly List<ITransform> Steps = new List<ITransform>();
        public ChainOp(Source src) { Src = src; Schema = src.Schema; }
        public void Add(ITransform t) { Steps.Add(t); Schema = t.Out; }

        // Blocking steps (join build sides) are prepared here, on the coordinator thread, before units fan out.
        void Prepare(ExecCtx ctx) { foreach (ITransform t in Steps) { JoinProbe j = t as JoinProbe; if (j != null) j.Build(ctx); } }

        List<Batch> Unit(ExecCtx ctx, int u)
        {
            List<Batch> r = new List<Batch>();
            foreach (Batch b0 in Src.RunUnit(ctx, u))
            {
                ctx.Ct.ThrowIfCancellationRequested();
                ctx.Rows(b0.Rows);
                Batch b = b0;
                foreach (ITransform t in Steps) { b = t.Apply(b, ctx); if (b == null || b.Rows == 0) break; }
                if (b != null && b.Rows > 0) r.Add(b);
            }
            return r;
        }
        // A join whose build side does not fit in memory (INNER / LEFT on keys) runs partitioned: both sides are split by
        // the join keys into pieces on disk, then each right piece is built in memory and its left piece probed against it.
        int spillAt = -1;   // the join step that did not fit (kept, so a second run does not try memory again)
        int PrepareOrSpill(ExecCtx ctx)
        {
            if (spillAt >= 0) return spillAt;
            for (int k = 0; k < Steps.Count; k++)
            {
                JoinProbe j = Steps[k] as JoinProbe; if (j == null) continue;
                try { j.Build(ctx); }
                catch (Exception e)
                {
                    if (!Spill.IsOom(e) || j.LeftKeys.Count == 0 || !(j.Kind == "INNER" || j.Kind == "LEFT")) throw;
                    return spillAt = k;
                }
            }
            return -1;
        }
        IEnumerable<Batch> Prefix(ExecCtx ctx, int stop)
        {
            int n = Src.Units(ctx);
            for (int u = 0; u < n; u++)
                foreach (Batch b0 in Src.RunUnit(ctx, u))
                {
                    ctx.Ct.ThrowIfCancellationRequested();
                    ctx.Rows(b0.Rows);
                    Batch b = b0;
                    for (int k = 0; k < stop && b != null && b.Rows > 0; k++) b = Steps[k].Apply(b, ctx);
                    if (b != null && b.Rows > 0) yield return b;
                }
        }
        IEnumerable<Batch> Partitioned(ExecCtx ctx, int at)
        {
            JoinProbe j = (JoinProbe)Steps[at]; HashJoin h = j.Hash;
            SpillDir dir = new SpillDir(ctx, "Join");
            Schema ls = at == 0 ? Src.Schema : Steps[at - 1].Out;
            SpillFile[] right = Spill.Partition(dir, h.RightOp.Schema, h.RightOp.Run(ctx), b => Spill.Eval(h.RightKeys, b), Spill.Partitions, 1, ctx);
            SpillFile[] left = null;
            try
            {
                left = Spill.Partition(dir, ls, Prefix(ctx, at), b => Spill.Eval(j.LeftKeys, b), Spill.Partitions, 1, ctx);
                for (int p = 0; p < Spill.Partitions; p++)
                {
                    if (left[p].Rows == 0) { right[p].Dispose(); continue; }
                    List<Batch> rb = new List<Batch>(); foreach (Batch b in right[p].Read()) rb.Add(b);
                    HashJoin sub = new HashJoin(new MemSource(h.RightOp.Schema, rb), h.RightKeys);
                    JoinProbe probe = j.With(sub);
                    try
                    {
                        foreach (Batch lb in left[p].Read())
                        {
                            Batch b = probe.Apply(lb, ctx);
                            for (int k = at + 1; k < Steps.Count && b != null && b.Rows > 0; k++) b = Steps[k].Apply(b, ctx);
                            if (b != null && b.Rows > 0) yield return b;
                        }
                    }
                    finally { sub.Release(); right[p].Dispose(); left[p].Dispose(); }
                }
            }
            finally
            {
                foreach (SpillFile f in right) f.Dispose();
                if (left != null) foreach (SpillFile f in left) f.Dispose();
                dir.Dispose();
            }
        }
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            int spill = PrepareOrSpill(ctx);
            if (spill >= 0) { foreach (Batch b in Partitioned(ctx, spill)) yield return b; yield break; }
            int n = Src.Units(ctx);
            if (n <= 1 || ctx.Parallel <= 1)
            {
                for (int u = 0; u < n; u++)
                    foreach (Batch b0 in Src.RunUnit(ctx, u))
                    {
                        ctx.Ct.ThrowIfCancellationRequested();
                        ctx.Rows(b0.Rows);
                        Batch b = b0;
                        foreach (ITransform t in Steps) { b = t.Apply(b, ctx); if (b == null || b.Rows == 0) break; }
                        if (b != null && b.Rows > 0) yield return b;
                    }
                yield break;
            }
            foreach (List<Batch> list in ctx.Pool.Ordered(n, Math.Min(n, ctx.Parallel), u => Unit(ctx, u), ctx.Ct, ctx.Mem))
                foreach (Batch b in list) yield return b;
        }
        // Per-unit fold on the workers, results handed back in unit order.
        public IEnumerable<T> Fold<T>(ExecCtx ctx, Func<T> init, Action<T, Batch> add)
        {
            if (PrepareOrSpill(ctx) >= 0)
            {
                // A join had to spill: fold the partitioned rows in one go.
                T acc = init();
                foreach (Batch b in Run(ctx)) add(acc, b);
                yield return acc;
                yield break;
            }
            int n = Src.Units(ctx);
            Func<int, T> one = u =>
            {
                T acc = init();
                foreach (Batch b0 in Src.RunUnit(ctx, u))
                {
                    ctx.Ct.ThrowIfCancellationRequested();
                    ctx.Rows(b0.Rows);
                    Batch b = b0;
                    foreach (ITransform t in Steps) { b = t.Apply(b, ctx); if (b == null || b.Rows == 0) break; }
                    if (b != null && b.Rows > 0) add(acc, b);
                }
                return acc;
            };
            if (n <= 1 || ctx.Parallel <= 1) { for (int u = 0; u < n; u++) yield return one(u); yield break; }
            foreach (T r in ctx.Pool.Ordered(n, Math.Min(n, ctx.Parallel), one, ctx.Ct, ctx.Mem)) yield return r;
        }
    }

    public sealed class AggOp : Op
    {
        readonly Op child; readonly List<BExpr> groups; readonly List<AggSpec> aggs;
        public Op Child { get { return child; } }
        public void ChildRefs(HashSet<int> n) { BExpr.RefsOf(groups, n); foreach (AggSpec a in aggs) { if (a.Arg != null) a.Arg.Refs(n); if (a.Arg2 != null) a.Arg2.Refs(n); if (a.Filter != null) a.Filter.Refs(n); if (a.Order != null) a.Order.Refs(n); } }
        public AggOp(Op child, List<BExpr> groups, List<AggSpec> aggs, Schema s) { this.child = child; this.groups = groups; this.aggs = aggs; Schema = s; }
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            ChainOp chain = child as ChainOp;
            // count(*) only, straight off a source that knows its row count (Parquet footers).
            if (groups.Count == 0 && chain != null && chain.Steps.Count == 0 && aggs.TrueForAll(a => a.Fn == "count" && a.Arg == null && a.Filter == null))
            {
                long known = chain.Src.KnownRows(ctx);
                if (known >= 0)
                {
                    Column[] cs = new Column[aggs.Count];
                    for (int k = 0; k < cs.Length; k++) { cs[k] = new Column(DataType.BigInt, 1); cs[k].I[0] = known; }
                    yield return new Batch(Schema, cs, 1);
                    yield break;
                }
            }
            // In memory first; a GROUP BY too big for the memory budget spills (hash partitions by the group keys).
            Batch r = null; bool spill = false;
            try { r = InMemory(ctx); }
            catch (Exception e) { if (groups.Count == 0 || !Spill.IsOom(e)) throw; spill = true; }
            if (spill)
            {
                SpillDir dir = new SpillDir(ctx, "GROUP BY");
                try { foreach (Batch b in Spilled(ctx, child.Run(ctx), dir, 1)) yield return b; }
                finally { dir.Dispose(); }
                yield break;
            }
            if (groups.Count > 0 && r.Rows == 0) yield break;
            foreach (Batch piece in Split(r, ctx)) yield return piece;
        }
        Batch InMemory(ExecCtx ctx)
        {
            ChainOp chain = child as ChainOp;
            List<AggTable> made = new List<AggTable>();   // every table made (also on workers), freed if this fails
            Func<AggTable> mk = () => { AggTable t = new AggTable(groups, aggs, ctx.Mem); lock (made) made.Add(t); return t; };
            try
            {
                AggTable total = mk();
                if (chain != null && chain.Src.Units(ctx) > 1 && ctx.Parallel > 1)
                {
                    foreach (AggTable part in chain.Fold(ctx, mk, (t, b) => t.Add(b)))
                        using (part) total.Merge(part);
                }
                else foreach (Batch b in child.Run(ctx)) total.Add(b);
                return total.Result(Schema);
            }
            finally { lock (made) foreach (AggTable t in made) t.Dispose(); }
        }
        // Rows split by group key into partitions on disk; each partition is grouped in memory (split again if too big).
        IEnumerable<Batch> Spilled(ExecCtx ctx, IEnumerable<Batch> input, SpillDir dir, int seed)
        {
            SpillFile[] parts = Spill.Partition(dir, child.Schema, input, b => Spill.Eval(groups, b), Spill.Partitions, seed, ctx);
            try
            {
                foreach (SpillFile f in parts)
                {
                    if (f.Rows == 0) continue;
                    Batch r = null; bool again = false;
                    try { using (AggTable t = new AggTable(groups, aggs, ctx.Mem)) { foreach (Batch b in f.Read()) t.Add(b); r = t.Result(Schema); } }
                    catch (Exception e) { if (!Spill.IsOom(e) || seed >= 3) throw; again = true; }
                    if (again) { foreach (Batch b in Spilled(ctx, f.Read(), dir, seed + 1)) yield return b; }
                    else foreach (Batch piece in Split(r, ctx)) yield return piece;
                    f.Dispose();
                }
            }
            finally { foreach (SpillFile f in parts) f.Dispose(); }
        }
        public static IEnumerable<Batch> Split(Batch r, ExecCtx ctx)
        {
            int per = ctx.Engine != null ? ctx.Engine.Options.BatchRowCount : 100000;
            if (r.Rows <= per) { yield return r; yield break; }
            for (int at = 0; at < r.Rows; at += per) yield return r.Slice(at, Math.Min(per, r.Rows - at));
        }
    }

    // Collects the whole input (memory-guarded).
    public static class Collect
    {
        public static Batch All(Op child, ExecCtx ctx, MemoryLease lease)
        {
            List<Batch> bs = new List<Batch>();
            foreach (Batch b in child.Run(ctx)) { lease.Add(b.Bytes); bs.Add(b); }
            if (bs.Count == 0) return Batch.Empty(child.Schema);
            return Batch.Concat(child.Schema, bs);
        }
    }

    public sealed class SortKey { public BExpr E; public bool Desc; public bool NullsFirst; }

    public sealed class SortOp : Op
    {
        readonly Op child; readonly List<SortKey> keys; readonly long topN;
        public Op Child { get { return child; } }
        public void KeyRefs(HashSet<int> n) { foreach (SortKey k in keys) k.E.Refs(n); }
        public SortOp(Op child, List<SortKey> keys, long topN) { this.child = child; this.keys = keys; this.topN = topN; Schema = child.Schema; }

        internal static int Cmp(Column[] kc, List<SortKey> keys, int a, int b)
        {
            for (int k = 0; k < kc.Length; k++)
            {
                Column c = kc[k]; bool an = c.IsNull(a) || c.Type.Kind == Kind.Null, bn = c.IsNull(b) || c.Type.Kind == Kind.Null;
                int r;
                if (an || bn) { if (an && bn) continue; r = an ? 1 : -1; if (keys[k].NullsFirst) r = -r; return r; }
                r = BCmp.Compare(c, a, c, b);
                if (r != 0) return keys[k].Desc ? -r : r;
            }
            return a.CompareTo(b);   // stable
        }
        // The best `limit` rows of keep (earlier rows) followed by b.
        static Batch Best(Batch keep, Batch b, List<SortKey> keys, long limit)
        {
            Batch cur = keep == null ? b : Batch.Concat(b.Schema, new List<Batch> { keep, b });
            int[] o = Order(cur, keys, limit);
            return cur.Take(o, o.Length);
        }
        public static int[] Order(Batch all, List<SortKey> keys, long limit) { return Order(all, keys, limit, 1); }
        // parallel > 1 and enough rows: the rows are cut into one piece per worker, the pieces are sorted at the same time,
        // then merged in pairs, round by round; every merge is itself split along its output (merge path) so all workers
        // stay busy to the end. Ties fall back to row position, so the order is exactly the one a single sort gives.
        public static int[] Order(Batch all, List<SortKey> keys, long limit, int parallel)
        {
            Column[] kc = new Column[keys.Count];
            for (int k = 0; k < kc.Length; k++) { kc[k] = keys[k].E.Eval(all); if (!kc[k].IsLazyText) { string[] warm = kc[k].S; } }   // strings decoded once before threads share them; bytes are compared as bytes
            int n = all.Rows;
            int[] idx = new int[n];
            for (int i = 0; i < n; i++) idx[i] = i;
            Comparison<int> cmp = new KeyCompare(kc, keys).Compare;
            int p = Math.Min(parallel, n / 50000);
            if (p < 2) Array.Sort(idx, cmp);
            else
            {
                int[] at = new int[p + 1];
                for (int k = 0; k <= p; k++) at[k] = (int)((long)n * k / p);
                ParallelOptions po = new ParallelOptions { MaxDegreeOfParallelism = p };
                IComparer<int> cmpr = Comparer<int>.Create(cmp);
                Parallel.For(0, p, po, k => Array.Sort(idx, at[k], at[k + 1] - at[k], cmpr));
                int[] tmp = new int[n];
                List<int> bounds = new List<int>(at);
                while (bounds.Count > 2)
                {
                    int pairs = (bounds.Count - 1) / 2, segs = Math.Max(1, p / pairs);
                    int[] src = idx, dst = tmp; List<int> b = bounds;
                    Parallel.For(0, pairs * segs, po, t =>
                    {
                        int k = t / segs, sg = t % segs, lo = b[2 * k], mid = b[2 * k + 1], hi = b[2 * k + 2], len = hi - lo;
                        MergePart(src, dst, lo, mid, hi, (int)((long)len * sg / segs), (int)((long)len * (sg + 1) / segs), cmp);
                    });
                    List<int> nb = new List<int>();
                    for (int k = 0; k < pairs; k++) nb.Add(bounds[2 * k]);
                    if ((bounds.Count - 1) % 2 == 1) { int b0 = bounds[bounds.Count - 2]; Array.Copy(src, b0, dst, b0, n - b0); nb.Add(b0); }   // odd piece out: copied as it is
                    nb.Add(n);
                    idx = dst; tmp = src; bounds = nb;
                }
            }
            if (limit >= 0 && limit < idx.Length) Array.Resize(ref idx, (int)limit);
            return idx;
        }
        // Output positions [d0, d1) of the merge of src[lo, mid) and src[mid, hi) into dst[lo + d0, lo + d1): the start in
        // each half is found by binary search on the diagonal (take the right side only when strictly smaller).
        static void MergePart(int[] src, int[] dst, int lo, int mid, int hi, int d0, int d1, Comparison<int> cmp)
        {
            int na = mid - lo, nb = hi - mid;
            Func<int, int> split = d =>
            {
                int l = Math.Max(0, d - nb), h = Math.Min(d, na);
                while (l < h) { int m = (l + h) >> 1; if (cmp(src[mid + d - m - 1], src[lo + m]) < 0) h = m; else l = m + 1; }
                return l;
            };
            int i = lo + split(d0), j = mid + (d0 - (i - lo)), o = lo + d0, end = lo + d1;
            while (o < end)
            {
                if (i < mid && (j >= hi || cmp(src[j], src[i]) >= 0)) dst[o++] = src[i++];
                else dst[o++] = src[j++];
            }
        }
        // The sort keys' arrays, read directly (no per-call type checks): same order as Cmp.
        internal sealed class KeyCompare
        {
            readonly long[][] li; readonly double[][] fl; readonly string[][] st; readonly byte[][] ub; readonly int[][] uo; readonly ulong[][] up; readonly bool[][] us; readonly bool[][] bo, nu; readonly bool[] allNull, desc, nf;
            readonly Column[] kc; readonly List<SortKey> keys;
            public KeyCompare(Column[] kc, List<SortKey> keys)
            {
                this.kc = kc; this.keys = keys; int n = kc.Length;
                li = new long[n][]; fl = new double[n][]; st = new string[n][]; ub = new byte[n][]; uo = new int[n][]; up = new ulong[n][]; us = new bool[n][]; bo = new bool[n][]; nu = new bool[n][]; allNull = new bool[n]; desc = new bool[n]; nf = new bool[n];
                for (int k = 0; k < n; k++)
                {
                    Column c = kc[k]; allNull[k] = c.Type.Kind == Kind.Null; nu[k] = c.Nulls; desc[k] = keys[k].Desc; nf[k] = keys[k].NullsFirst;
                    li[k] = c.I; fl[k] = c.F; bo[k] = c.B;
                    if (c.IsLazyText) { ub[k] = c.Utf8; uo[k] = c.Offs; Utf8Ops.Prefixes(c, out up[k], out us[k]); } else st[k] = c.S;
                }
            }
            public int Compare(int a, int b)
            {
                for (int k = 0; k < li.Length; k++)
                {
                    bool[] nn = nu[k];
                    bool an = allNull[k] || (nn != null && nn[a]), bn = allNull[k] || (nn != null && nn[b]);
                    if (an || bn) { if (an && bn) continue; int z = an ? 1 : -1; return nf[k] ? -z : z; }
                    int r;
                    if (li[k] != null) r = li[k][a].CompareTo(li[k][b]);
                    else if (fl[k] != null) r = fl[k][a].CompareTo(fl[k][b]);
                    else if (ub[k] != null)
                    {
                        ulong pa = up[k][a], pb = up[k][b]; bool[] sl = us[k];
                        if (pa != pb && !sl[a] && !sl[b]) r = pa < pb ? -1 : 1;   // the first 8 bytes decide
                        else { int[] o = uo[k]; r = Utf8Ops.Compare(ub[k], o[a], o[a + 1] - o[a], ub[k], o[b], o[b + 1] - o[b]); }
                    }
                    else if (st[k] != null) r = string.CompareOrdinal(st[k][a], st[k][b]);
                    else if (bo[k] != null) r = bo[k][a].CompareTo(bo[k][b]);
                    else r = BCmp.Compare(kc[k], a, kc[k], b);
                    if (r != 0) return desc[k] ? -r : r;
                }
                return a.CompareTo(b);
            }
        }
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            using (MemoryLease lease = new MemoryLease(ctx.Mem, "Sorting"))
            {
                Batch all;
                if (topN >= 0 && topN <= 100000)
                {
                    // Top-N: keep only the best rows seen so far. A splittable input finds each unit's best rows on the
                    // workers first; those come back in unit order and ties keep input order, so the answer is the same.
                    Batch keep = null;
                    ChainOp chain = child as ChainOp;
                    IEnumerable<Batch> input = child.Run(ctx);
                    if (chain != null && ctx.Parallel > 1 && chain.Src.Units(ctx) > 1)
                    {
                        List<Batch> best = new List<Batch>();
                        foreach (Batch[] acc in chain.Fold(ctx, () => new Batch[1], (a, b) => a[0] = Best(a[0], b, keys, topN))) if (acc[0] != null) best.Add(acc[0]);
                        input = best;
                    }
                    foreach (Batch b in input) keep = Best(keep, b, keys, topN);
                    all = keep ?? Batch.Empty(Schema);
                    yield return all;
                    yield break;
                }
            }
            // Full sort in memory first; too big for the memory budget -> sorted runs on disk, merged.
            MemoryLease full = new MemoryLease(ctx.Mem, "Sorting");
            Batch rows = null; int[] order = null;
            try { rows = Collect.All(child, ctx, full); order = Order(rows, keys, topN, ctx.Parallel); full.Add(order.Length * 4L); }
            catch (Exception e) { full.Dispose(); rows = null; order = null; if (!Spill.IsOom(e)) throw; }
            if (rows == null) { foreach (Batch b in External(ctx)) yield return b; yield break; }
            try
            {
                int per = ctx.Engine != null ? ctx.Engine.Options.BatchRowCount : 100000;
                for (int at = 0; at < order.Length; at += per)
                {
                    int n = Math.Min(per, order.Length - at);
                    int[] part = new int[n]; Array.Copy(order, at, part, 0, n);
                    yield return rows.Take(part, n);
                }
            }
            finally { full.Dispose(); }
        }

        // External merge sort: runs of about an eighth of the budget are sorted in memory and written out; then every
        // run is read back a batch at a time and merged (ties: earlier run first, so the sort stays stable).
        IEnumerable<Batch> External(ExecCtx ctx)
        {
            SpillDir dir = new SpillDir(ctx, "Sort");
            long runBytes = Math.Max(64L << 20, ctx.Mem.Budget / 8);
            int per = ctx.Engine != null ? ctx.Engine.Options.BatchRowCount : 100000;
            List<SpillFile> runs = new List<SpillFile>();
            List<Batch> cur = new List<Batch>(); long bytes = 0;
            Action flush = () =>
            {
                if (cur.Count == 0) return;
                Batch all = Batch.Concat(child.Schema, cur); cur.Clear(); bytes = 0;
                int[] o = Order(all, keys, -1, ctx.Parallel);
                SpillFile f = dir.File(child.Schema);
                for (int at = 0; at < o.Length; at += per) { int n = Math.Min(per, o.Length - at); int[] part = new int[n]; Array.Copy(o, at, part, 0, n); f.Append(all.Take(part, n)); }
                f.Finish(); runs.Add(f);
            };
            foreach (Batch b in child.Run(ctx)) { ctx.Ct.ThrowIfCancellationRequested(); cur.Add(b); bytes += b.Bytes; if (bytes >= runBytes) flush(); }
            flush();
            Cursor[] cs = new Cursor[runs.Count];
            try
            {
                List<int> heap = new List<int>();
                for (int r = 0; r < cs.Length; r++) { cs[r] = new Cursor(runs[r].Read().GetEnumerator(), keys, r); if (cs[r].Next()) Push(heap, cs, r); }
                long left = topN >= 0 ? topN : long.MaxValue;
                while (heap.Count > 0 && left > 0)
                {
                    int n = (int)Math.Min(per, left);
                    Column[] outC = null; ColumnBuilder[] bld = null; int got = 0;
                    while (got < n && heap.Count > 0)
                    {
                        Cursor c = cs[heap[0]];
                        if (bld == null)
                        {
                            outC = new Column[Schema.Count]; bld = new ColumnBuilder[Schema.Count];
                            for (int k = 0; k < bld.Length; k++) if (!Spill.IsPlaceholder(c.B.Cols[k])) bld[k] = new ColumnBuilder(Schema[k].Type, n);
                        }
                        for (int k = 0; k < bld.Length; k++) if (bld[k] != null) bld[k].Add(c.B.Cols[k], c.Pos);
                        got++;
                        if (++c.Pos >= c.B.Rows && !c.Next()) { Pop(heap, cs); continue; }
                        Down(heap, cs, 0);
                    }
                    if (got == 0) break;
                    for (int k = 0; k < outC.Length; k++)
                    {
                        if (bld[k] != null) { outC[k] = bld[k].ToColumn(); continue; }
                        Column ph = new Column(DataType.Null, 0); ph.Type = Schema[k].Type; ph.Length = got; ph.Nulls = null; outC[k] = ph;
                    }
                    left -= got;
                    yield return new Batch(Schema, outC, got);
                }
            }
            finally { foreach (Cursor c in cs) if (c != null) c.Close(); foreach (SpillFile f in runs) f.Dispose(); dir.Dispose(); }
        }
        sealed class Cursor
        {
            readonly IEnumerator<Batch> it; readonly List<SortKey> keys; public readonly int Run;
            public Batch B; public Column[] K; public int Pos;
            public Cursor(IEnumerator<Batch> it, List<SortKey> keys, int run) { this.it = it; this.keys = keys; Run = run; }
            public bool Next()
            {
                while (it.MoveNext())
                {
                    B = it.Current; if (B.Rows == 0) continue;
                    K = new Column[keys.Count]; for (int k = 0; k < K.Length; k++) K[k] = keys[k].E.Eval(B);
                    Pos = 0; return true;
                }
                B = null; it.Dispose(); return false;
            }
            public void Close() { it.Dispose(); }   // stopped early (LIMIT): close the run file
        }
        int CmpC(Cursor a, Cursor b)
        {
            for (int k = 0; k < keys.Count; k++)
            {
                Column x = a.K[k], y = b.K[k];
                bool an = x.IsNull(a.Pos) || x.Type.Kind == Kind.Null, bn = y.IsNull(b.Pos) || y.Type.Kind == Kind.Null;
                int r;
                if (an || bn) { if (an && bn) continue; r = an ? 1 : -1; if (keys[k].NullsFirst) r = -r; return r; }
                r = BCmp.Compare(x, a.Pos, y, b.Pos);
                if (r != 0) return keys[k].Desc ? -r : r;
            }
            return a.Run.CompareTo(b.Run);
        }
        void Push(List<int> h, Cursor[] cs, int r)
        {
            h.Add(r); int i = h.Count - 1;
            while (i > 0) { int p = (i - 1) / 2; if (CmpC(cs[h[i]], cs[h[p]]) >= 0) break; int t = h[i]; h[i] = h[p]; h[p] = t; i = p; }
        }
        void Pop(List<int> h, Cursor[] cs) { h[0] = h[h.Count - 1]; h.RemoveAt(h.Count - 1); if (h.Count > 0) Down(h, cs, 0); }
        void Down(List<int> h, Cursor[] cs, int i)
        {
            while (true)
            {
                int l = 2 * i + 1, r = l + 1, m = i;
                if (l < h.Count && CmpC(cs[h[l]], cs[h[m]]) < 0) m = l;
                if (r < h.Count && CmpC(cs[h[r]], cs[h[m]]) < 0) m = r;
                if (m == i) return;
                int t = h[i]; h[i] = h[m]; h[m] = t; i = m;
            }
        }
    }

    public sealed class LimitOp : Op
    {
        readonly Op child; readonly long limit, offset;
        public Op Child { get { return child; } }
        public LimitOp(Op child, long limit, long offset) { this.child = child; this.limit = limit; this.offset = offset; Schema = child.Schema; }
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            long skip = offset, left = limit < 0 ? long.MaxValue : limit;
            if (left == 0) yield break;
            foreach (Batch b in child.Run(ctx))
            {
                Batch x = b;
                if (skip > 0) { if (skip >= x.Rows) { skip -= x.Rows; continue; } x = x.Slice((int)skip, x.Rows - (int)skip); skip = 0; }
                if (x.Rows > left) x = x.Slice(0, (int)left);
                left -= x.Rows;
                yield return x;
                if (left <= 0) yield break;
            }
        }
    }

    public sealed class UnionOp : Op
    {
        readonly List<Op> parts;
        public List<Op> Parts { get { return parts; } }
        public UnionOp(List<Op> parts, Schema s) { this.parts = parts; Schema = s; }
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            foreach (Op p in parts)
                foreach (Batch b in p.Run(ctx))
                {
                    Column[] cs = new Column[Schema.Count];
                    for (int k = 0; k < cs.Length; k++) cs[k] = b.Cols[k].Type.SameAs(Schema[k].Type) ? b.Cols[k] : Cast.To(b.Cols[k], Schema[k].Type, false);
                    yield return new Batch(Schema, cs, b.Rows);
                }
        }
    }

    // Working table of a recursive CTE: the rows of the previous round.
    public sealed class WorkSource : Source
    {
        List<Batch> cur = new List<Batch>();
        public WorkSource(Schema s) { Schema = s; }
        public void Set(List<Batch> b) { cur = b; }
        public override int Units(ExecCtx ctx) { return cur.Count; }
        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit) { yield return cur[unit]; }
        public override long KnownRows(ExecCtx ctx) { long n = 0; foreach (Batch b in cur) n += b.Rows; return n; }
    }

    // WITH RECURSIVE: anchor rows, then the recursive part over the previous round's rows until a round adds none.
    // UNION (not ALL) drops rows already produced.
    public sealed class RecursiveOp : Op
    {
        readonly Op anchor, rec; readonly WorkSource work; readonly bool distinct;
        public Op Anchor { get { return anchor; } }
        public Op Rec { get { return rec; } }
        public const int MaxRounds = 100000;
        public RecursiveOp(Op anchor, Op rec, WorkSource work, bool distinct, Schema s) { this.anchor = anchor; this.rec = rec; this.work = work; this.distinct = distinct; Schema = s; }
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            using (MemoryLease lease = new MemoryLease(ctx.Mem, "Recursive query"))
            {
                KeyIndex seen = distinct ? new KeyIndex(Schema.Fields.Select(f => f.Type).ToArray()) : null;
                List<Batch> cur = Keep(anchor.Run(ctx), seen, lease);
                for (int round = 0; ; round++)
                {
                    long n = 0;
                    foreach (Batch b in cur) { n += b.Rows; yield return b; }
                    if (n == 0) yield break;
                    if (round >= MaxRounds) throw new EngineException("SQL_RECURSION_LIMIT", "A recursive query ran " + MaxRounds + " rounds without finishing; check its stop condition.");
                    work.Set(cur);
                    OpTree.ResetJoins(rec);
                    cur = Keep(rec.Run(ctx), seen, lease);
                }
            }
        }
        // seen: rows met so far (UNION without ALL): a row is kept when its key gets a new group id.
        List<Batch> Keep(IEnumerable<Batch> src, KeyIndex seen, MemoryLease lease)
        {
            List<Batch> r = new List<Batch>();
            foreach (Batch b0 in src)
            {
                Column[] cs = new Column[Schema.Count];
                for (int k = 0; k < cs.Length; k++) cs[k] = b0.Cols[k].Type.SameAs(Schema[k].Type) ? b0.Cols[k] : Cast.To(b0.Cols[k], Schema[k].Type, false);
                Batch b = new Batch(Schema, cs, b0.Rows);
                if (seen != null)
                {
                    int[] idx = new int[b.Rows]; int n = 0, before = seen.Count;
                    int[] g = seen.Assign(cs, b.Rows);
                    for (int i = 0; i < b.Rows; i++) if (g[i] == before + n) idx[n++] = i;   // ids are given in first-seen order
                    if (n < b.Rows) b = b.Take(idx, n);
                }
                if (b.Rows > 0) { lease.Add(b.Bytes); r.Add(b); }
            }
            return r;
        }
    }

    public static class OpTree
    {
        // Hash join build sides are cached per run; a recursive round must rebuild them (they may read the working table).
        public static void ResetJoins(Op op)
        {
            if (op == null) return;
            ChainOp ch = op as ChainOp;
            if (ch != null)
            {
                OpSource os = ch.Src as OpSource; if (os != null) ResetJoins(os.Inner);
                foreach (ITransform t in ch.Steps) { JoinProbe j = t as JoinProbe; if (j != null) { j.Hash.Reset(); ResetJoins(j.Hash.RightOp); } }
                return;
            }
            AggOp ag = op as AggOp; if (ag != null) { ResetJoins(ag.Child); return; }
            SortOp so = op as SortOp; if (so != null) { ResetJoins(so.Child); return; }
            LimitOp li = op as LimitOp; if (li != null) { ResetJoins(li.Child); return; }
            WindowOp wo = op as WindowOp; if (wo != null) { ResetJoins(wo.Child); return; }
            RenameOp rn = op as RenameOp; if (rn != null) { ResetJoins(rn.Child); return; }
            OuterJoinOp oj = op as OuterJoinOp; if (oj != null) { ResetJoins(oj.Probe); return; }
            UnionOp un = op as UnionOp; if (un != null) { foreach (Op p in un.Parts) ResetJoins(p); return; }
            RecursiveOp ro = op as RecursiveOp; if (ro != null) { ResetJoins(ro.Anchor); ResetJoins(ro.Rec); }
        }
    }

    // Renames/retypes the schema without touching data (subquery aliases).
    public sealed class RenameOp : Op
    {
        readonly Op child;
        public Op Child { get { return child; } }
        public RenameOp(Op child, Schema s) { this.child = child; Schema = s; }
        public override IEnumerable<Batch> Run(ExecCtx ctx) { foreach (Batch b in child.Run(ctx)) yield return new Batch(Schema, b.Cols, b.Rows); }
    }
}
