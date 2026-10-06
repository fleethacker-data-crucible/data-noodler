// Column pruning: works out which source columns an operator tree really reads, so Parquet scans skip the rest.
using System;
using System.Collections.Generic;
using System.Reflection;

namespace NativeDataEngine
{
    public static class Optimizer
    {
        public static void Prune(Op root)
        {
            HashSet<int> all = new HashSet<int>();
            for (int i = 0; i < root.Schema.Count; i++) all.Add(i);
            Need(root, all);
        }

        static HashSet<int> All(Op op) { HashSet<int> s = new HashSet<int>(); for (int i = 0; i < op.Schema.Count; i++) s.Add(i); return s; }

        // need = output columns of op that its parent reads.
        static void Need(Op op, HashSet<int> need)
        {
            ChainOp ch = op as ChainOp;
            if (ch != null)
            {
                HashSet<int> n = new HashSet<int>(need);
                for (int k = ch.Steps.Count - 1; k >= 0; k--) n = StepNeed(ch.Steps[k], n);
                SourceNeed(ch.Src, n);
                return;
            }
            AggOp ag = op as AggOp;
            if (ag != null) { HashSet<int> n = new HashSet<int>(); ag.ChildRefs(n); Need(ag.Child, n); return; }
            SortOp so = op as SortOp;
            if (so != null) { HashSet<int> n = new HashSet<int>(need); so.KeyRefs(n); Need(so.Child, n); return; }
            LimitOp li = op as LimitOp;
            if (li != null) { Need(li.Child, need); return; }
            WindowOp wo = op as WindowOp;
            if (wo != null) { HashSet<int> n = new HashSet<int>(); foreach (int i in need) if (i < wo.Child.Schema.Count) n.Add(i); wo.SpecRefs(n); Need(wo.Child, n); return; }
            OuterJoinOp oj = op as OuterJoinOp;
            if (oj != null) { Need(oj.Probe, need); return; }
            UnionOp un = op as UnionOp;
            if (un != null) { foreach (Op p in un.Parts) Need(p, All(p)); return; }
            RenameOp rn = op as RenameOp;
            if (rn != null) { Need(rn.Child, need); return; }
        }

        static HashSet<int> StepNeed(ITransform t, HashSet<int> need)
        {
            HashSet<int> n = new HashSet<int>();
            ProjectStep p = t as ProjectStep;
            if (p != null) { p.Refs(n, need); return n; }
            FilterStep f = t as FilterStep;
            if (f != null) { n.UnionWith(need); f.Refs(n); return n; }
            JoinProbe j = t as JoinProbe;
            if (j != null) return j.Prune(need);
            return n;
        }

        static void SourceNeed(Source s, HashSet<int> need)
        {
            ParquetSource ps = s as ParquetSource;
            if (ps != null) { ps.SetNeeded(need); return; }
            OpSource os = s as OpSource;
            if (os != null) { Need(os.Inner, need); return; }
        }

        // Join probe: split needs between left (passed back) and right (pruned now).
        internal static void NeedRight(Op right, HashSet<int> need) { Need(right, need); }
    }
}
