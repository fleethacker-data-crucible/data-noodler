// Physical operators. Batches stream through; splittable sources (Parquet row groups, in-memory tables) run their
// per-unit work (read + filter + project + join probe + partial aggregate) on the worker pool, in unit order.
using System;
using System.Collections.Generic;
using System.Threading;

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

    // In-memory batches (VALUES, cached tables, range()).
    public sealed class MemSource : Source
    {
        readonly List<Batch> batches;
        public MemSource(Schema s, List<Batch> b) { Schema = s; batches = b; }
        public override int Units(ExecCtx ctx) { return batches.Count; }
        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit) { yield return batches[unit]; }
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
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            Prepare(ctx);
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
            Prepare(ctx);
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
        public void ChildRefs(HashSet<int> n) { BExpr.RefsOf(groups, n); foreach (AggSpec a in aggs) { if (a.Arg != null) a.Arg.Refs(n); if (a.Arg2 != null) a.Arg2.Refs(n); if (a.Filter != null) a.Filter.Refs(n); } }
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
            using (AggTable total = new AggTable(groups, aggs, ctx.Mem))
            {
                if (chain != null && chain.Src.Units(ctx) > 1 && ctx.Parallel > 1)
                {
                    foreach (AggTable part in chain.Fold(ctx, () => new AggTable(groups, aggs, ctx.Mem), (t, b) => t.Add(b)))
                        using (part) total.Merge(part);
                }
                else foreach (Batch b in child.Run(ctx)) total.Add(b);
                Batch r = total.Result(Schema);
                if (groups.Count > 0 && r.Rows == 0) yield break;
                foreach (Batch piece in Split(r, ctx)) yield return piece;
            }
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

        static int Cmp(Column[] kc, List<SortKey> keys, int a, int b)
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
        public static int[] Order(Batch all, List<SortKey> keys, long limit)
        {
            Column[] kc = new Column[keys.Count];
            for (int k = 0; k < kc.Length; k++) kc[k] = keys[k].E.Eval(all);
            int[] idx = new int[all.Rows];
            for (int i = 0; i < idx.Length; i++) idx[i] = i;
            Array.Sort(idx, (x, y) => Cmp(kc, keys, x, y));
            if (limit >= 0 && limit < idx.Length) Array.Resize(ref idx, (int)limit);
            return idx;
        }
        public override IEnumerable<Batch> Run(ExecCtx ctx)
        {
            using (MemoryLease lease = new MemoryLease(ctx.Mem, "Sorting"))
            {
                Batch all;
                if (topN >= 0 && topN <= 100000)
                {
                    // Top-N: keep only the best rows seen so far.
                    Batch keep = null;
                    foreach (Batch b in child.Run(ctx))
                    {
                        Batch cur = keep == null ? b : Batch.Concat(Schema, new List<Batch> { keep, b });
                        int[] o = Order(cur, keys, topN);
                        keep = cur.Take(o, o.Length);
                    }
                    all = keep ?? Batch.Empty(Schema);
                    yield return all;
                    yield break;
                }
                all = Collect.All(child, ctx, lease);
                int[] idx = Order(all, keys, topN);
                lease.Add(idx.Length * 4L);
                int per = ctx.Engine != null ? ctx.Engine.Options.BatchRowCount : 100000;
                for (int at = 0; at < idx.Length; at += per)
                {
                    int n = Math.Min(per, idx.Length - at);
                    int[] part = new int[n]; Array.Copy(idx, at, part, 0, n);
                    yield return all.Take(part, n);
                }
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
                HashSet<string> seen = distinct ? new HashSet<string>(StringComparer.Ordinal) : null;
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
        List<Batch> Keep(IEnumerable<Batch> src, HashSet<string> seen, MemoryLease lease)
        {
            List<Batch> r = new List<Batch>();
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            foreach (Batch b0 in src)
            {
                Column[] cs = new Column[Schema.Count];
                for (int k = 0; k < cs.Length; k++) cs[k] = b0.Cols[k].Type.SameAs(Schema[k].Type) ? b0.Cols[k] : Cast.To(b0.Cols[k], Schema[k].Type, false);
                Batch b = new Batch(Schema, cs, b0.Rows);
                if (seen != null)
                {
                    int[] idx = new int[b.Rows]; int n = 0;
                    for (int i = 0; i < b.Rows; i++)
                    {
                        sb.Length = 0;
                        foreach (Column c in cs) { string v = Values.Text(c, i); sb.Append(v == null ? "\u0002" : v).Append('\u0001'); }
                        if (seen.Add(sb.ToString())) idx[n++] = i;
                    }
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
