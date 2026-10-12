// Turns a parsed query into physical operators: name resolution, typing, aggregation, windows, joins, sorting.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace NativeDataEngine
{
    public sealed class ScopeCol
    {
        public string Table, Name; public int Index; public DataType Type;
        public bool NoStar;          // hidden from * (USING duplicate on the right side)
        public bool NoUnqualified;   // only reachable as table.name
        public BExpr Override;       // FULL/RIGHT JOIN USING column: coalesce(left, right)
    }

    public sealed class Scope
    {
        public readonly List<ScopeCol> Cols = new List<ScopeCol>();
        public static Scope Of(Schema s, string table)
        {
            Scope sc = new Scope();
            for (int i = 0; i < s.Count; i++) { ScopeCol c = new ScopeCol(); c.Table = table; c.Name = s[i].Name; c.Index = i; c.Type = s[i].Type; sc.Cols.Add(c); }
            return sc;
        }
        public ScopeCol Find(string table, string name, bool throwIfMissing)
        {
            ScopeCol found = null; int hits = 0;
            foreach (ScopeCol c in Cols)
            {
                if (table != null && !string.Equals(c.Table, table, StringComparison.OrdinalIgnoreCase)) continue;
                if (table == null && c.NoUnqualified) continue;
                if (!string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
                if (found == null || c.Name == name && found.Name != name) found = c;
                hits++;
            }
            if (hits > 1)
            {
                int exact = Cols.Count(c => (table == null ? !c.NoUnqualified : string.Equals(c.Table, table, StringComparison.OrdinalIgnoreCase)) && c.Name == name);
                if (exact != 1) throw new EngineException("COLUMN_AMBIGUOUS", "Column \"" + name + "\" is ambiguous; qualify it with a table name (e.g. l." + name + ").");
            }
            if (found == null && throwIfMissing)
            {
                List<string> names = Cols.Where(c => !c.NoStar).Select(c => c.Name).Distinct().Take(30).ToList();
                throw new EngineException("COLUMN_NOT_FOUND", "Column \"" + (table != null ? table + "." : "") + name + "\" not found. Columns: " + string.Join(", ", names) + ".");
            }
            return found;
        }
    }

    public sealed class Planned { public Op Op; public Scope Scope; }

    // How expressions bind in one phase of a SELECT.
    sealed class Phase
    {
        public Scope Scope;
        public Dictionary<string, int> Exact = new Dictionary<string, int>();   // expression key -> column (group keys, aggregates, windows)
        public bool PostAgg;
        public bool AllowAgg;
    }

    public interface ICatalog
    {
        string ViewSql(string name);                                  // session view / dataset, or null
        Source TableFunction(FuncTable f, Planner p);                 // read_parquet / read_csv / read_sqlite / range
        Source MemTable(string name);                                 // cached in-memory table, or null
    }

    public sealed class Planner
    {
        readonly ICatalog cat; readonly int batchRows;
        readonly List<Dictionary<string, QueryStmt>> ctes = new List<Dictionary<string, QueryStmt>>();
        readonly HashSet<string> expanding = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, WorkSource> recWork = new Dictionary<string, WorkSource>(StringComparer.OrdinalIgnoreCase);   // recursive CTE -> its working table
        static int sqSeq;
        int depth;

        public Planner(ICatalog cat, int batchRows) { this.cat = cat; this.batchRows = batchRows; }

        public Planned Plan(QueryStmt q)
        {
            if (++depth > 64) throw new EngineException("SQL_TOO_DEEP", "Query nesting is too deep (views referring to each other?).");
            try
            {
                Dictionary<string, QueryStmt> local = new Dictionary<string, QueryStmt>(StringComparer.OrdinalIgnoreCase);
                foreach (KeyValuePair<string, QueryStmt> w in q.With) local[w.Key] = w.Value;
                ctes.Add(local);
                try
                {
                    SelectStmt sel = q.Body as SelectStmt;
                    if (sel != null) return PlanSelect(sel, q);
                    Planned body = PlanSet(q.Body);
                    return OrderLimit(body, q, null);
                }
                finally { ctes.RemoveAt(ctes.Count - 1); }
            }
            finally { depth--; }
        }

        Planned PlanSet(object body)
        {
            SelectStmt s = body as SelectStmt;
            if (s != null) { QueryStmt q = new QueryStmt(); q.Body = s; return PlanSelect(s, q); }
            QueryStmt qs = body as QueryStmt;
            if (qs != null) return Plan(qs);
            ValuesBody vb = body as ValuesBody;
            if (vb != null) return PlanValues(vb);
            SetOp so = (SetOp)body;
            if (so.Op != "UNION") throw new EngineException("SQL_UNSUPPORTED", so.Op + " is not supported; use UNION or a JOIN.");
            Planned l = PlanSet(so.Left), r = PlanSet(so.Right);
            if (l.Op.Schema.Count != r.Op.Schema.Count) throw new EngineException("SQL_UNION", "UNION inputs have different column counts (" + l.Op.Schema.Count + " vs " + r.Op.Schema.Count + ").");
            List<Field> fs = new List<Field>();
            for (int i = 0; i < l.Op.Schema.Count; i++) { DataType t = Cast.Common(l.Op.Schema[i].Type, r.Op.Schema[i].Type); if (t.Kind == Kind.Int) t = DataType.BigInt; fs.Add(new Field(l.Op.Schema[i].Name, t)); }
            Schema sch = new Schema(fs);
            Op u = new UnionOp(new List<Op> { l.Op, r.Op }, sch);
            if (!so.All) u = Distinct(u);
            Planned p = new Planned(); p.Op = u; p.Scope = Scope.Of(sch, null);
            return p;
        }

        // VALUES rows: each value is evaluated once (constants / functions), columns column1..columnN.
        Planned PlanValues(ValuesBody v)
        {
            int nc = v.Rows[0].Count, n = v.Rows.Count;
            Phase ph = Ph(new Scope());
            Schema empty = new Schema(new List<Field>());
            Batch one = new Batch(empty, new Column[0], 1);
            Column[][] cells = new Column[n][];
            DataType[] types = new DataType[nc];
            for (int k = 0; k < nc; k++) types[k] = DataType.Null;
            for (int i = 0; i < n; i++)
            {
                cells[i] = new Column[nc];
                for (int k = 0; k < nc; k++)
                {
                    if (HasSub(v.Rows[i][k])) throw new EngineException("SQL_UNSUPPORTED", "Subqueries are not supported inside VALUES; use INSERT ... SELECT.");
                    BExpr b = Bind(v.Rows[i][k], ph);
                    cells[i][k] = b.Eval(one);
                    types[k] = Cast.Common(types[k], b.Type);
                }
            }
            List<Field> fs = new List<Field>(); Column[] cols = new Column[nc];
            for (int k = 0; k < nc; k++)
            {
                DataType t = types[k].Kind == Kind.Null ? DataType.Varchar : types[k];
                fs.Add(new Field("column" + (k + 1), t));
                Column c = new Column(t, n);
                for (int i = 0; i < n; i++) BCase.Copy(cells[i][k].Type.SameAs(t) ? cells[i][k] : Cast.To(cells[i][k], t, false), 0, c, i);
                cols[k] = c;
            }
            Schema s = new Schema(fs);
            Planned p = new Planned(); p.Op = new ChainOp(new MemSource(s, new List<Batch> { new Batch(s, cols, n) })); p.Scope = Scope.Of(s, null);
            return p;
        }

        Op Distinct(Op child)
        {
            List<BExpr> keys = new List<BExpr>();
            for (int i = 0; i < child.Schema.Count; i++) keys.Add(new BCol(i, child.Schema[i].Type));
            return new AggOp(child, keys, new List<AggSpec>(), child.Schema);
        }

        // ---------- FROM ----------
        public Planned PlanFrom(TableRef t)
        {
            Planned r = PlanFrom1(t);
            if (t.Hidden) foreach (ScopeCol c in r.Scope.Cols) c.NoStar = true;   // helper join (subqueries): not part of *
            return r;
        }
        Planned PlanFrom1(TableRef t)
        {
            Planned r = PlanFrom0(t);
            if (t.ColAliases == null || t.ColAliases.Count == 0) return r;
            List<Field> fs = new List<Field>();
            for (int i = 0; i < r.Op.Schema.Count; i++) fs.Add(new Field(i < t.ColAliases.Count ? t.ColAliases[i] : r.Op.Schema[i].Name, r.Op.Schema[i].Type));
            Schema s = new Schema(fs);
            List<BExpr> ids = new List<BExpr>();
            for (int i = 0; i < fs.Count; i++) ids.Add(new BCol(i, fs[i].Type));
            ChainOp ch = AsChain(r.Op); ch.Add(new ProjectStep(ids, s));   // stays a parallel chain
            Planned p = new Planned(); p.Op = ch; p.Scope = Scope.Of(s, t.Alias);
            return p;
        }
        Planned PlanFrom0(TableRef t)
        {
            Planned p;
            NamedTable nt = t as NamedTable;
            if (nt != null)
            {
                string alias = t.Alias ?? nt.Name;
                WorkSource ws;
                if (recWork.TryGetValue(nt.Name, out ws)) { p = new Planned(); p.Op = new ChainOp(ws); p.Scope = Scope.Of(ws.Schema, alias); return p; }
                for (int i = ctes.Count - 1; i >= 0; i--)
                {
                    QueryStmt cq;
                    if (ctes[i].TryGetValue(nt.Name, out cq))
                    {
                        if (IsRecursive(nt.Name, cq)) return Rescope(PlanRecursive(nt.Name, cq), alias);
                        if (!expanding.Add("cte:" + nt.Name)) throw new EngineException("SQL_RECURSIVE", "CTE \"" + nt.Name + "\" refers to itself; a recursive CTE must be anchor UNION [ALL] recursive part.");
                        try { p = Plan(cq); } finally { expanding.Remove("cte:" + nt.Name); }
                        return Rescope(Renamed(p, cq.Cols, nt.Name), alias);
                    }
                }
                string sql = cat.ViewSql(nt.Name);
                if (sql != null)
                {
                    if (!expanding.Add(nt.Name)) throw new EngineException("SQL_RECURSIVE", "\"" + nt.Name + "\" refers to itself.");
                    try
                    {
                        QueryStmt vq;
                        try { vq = Parser.ParseQuery(sql); }
                        catch (EngineException e) { throw new EngineException(e.Code, "In \"" + nt.Name + "\": " + e.Message); }
                        p = Plan(vq);
                    }
                    finally { expanding.Remove(nt.Name); }
                    return Rescope(p, alias);
                }
                Source m = cat.MemTable(nt.Name);
                if (m != null) { p = new Planned(); p.Op = new ChainOp(m); p.Scope = Scope.Of(m.Schema, alias); return p; }
                throw new EngineException("TABLE_NOT_FOUND", "Table or dataset \"" + nt.Name + "\" not found.");
            }
            SubqueryTable sq = t as SubqueryTable;
            if (sq != null) return Rescope(Plan(sq.Query), sq.Alias);
            PivotRef pv = t as PivotRef;
            if (pv != null) return PlanPivot(pv);
            FuncTable ft = t as FuncTable;
            if (ft != null)
            {
                Source src = cat.TableFunction(ft, this);
                p = new Planned(); p.Op = new ChainOp(src); p.Scope = Scope.Of(src.Schema, ft.Alias ?? ft.Name);
                return p;
            }
            return PlanJoin((JoinRef)t);
        }

        // ---------- recursive CTE: anchor UNION [ALL] part that reads the CTE itself ----------
        static bool IsRecursive(string name, QueryStmt cq)
        {
            SetOp so = cq.Body as SetOp;
            if (so == null || so.Op != "UNION") return false;
            QueryStmt right = new QueryStmt(); right.Body = so.Right;
            HashSet<string> refs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Refs.Collect(right, refs);
            return refs.Contains(name);
        }
        Planned PlanRecursive(string name, QueryStmt cq)
        {
            SetOp so = (SetOp)cq.Body;
            if (!expanding.Add("cte:" + name)) throw new EngineException("SQL_RECURSIVE", "Recursive CTE \"" + name + "\" is used inside itself in an unsupported way.");
            try
            {
                Planned anchor = PlanSet(so.Left);
                List<Field> fs = new List<Field>();
                if (cq.Cols != null && cq.Cols.Count != anchor.Op.Schema.Count) throw new EngineException("SQL_CTE", "CTE \"" + name + "\" names " + cq.Cols.Count + " column(s) but returns " + anchor.Op.Schema.Count + ".");
                for (int i = 0; i < anchor.Op.Schema.Count; i++)
                {
                    Field f = anchor.Op.Schema[i];
                    DataType t = f.Type.Kind == Kind.Null ? DataType.Varchar : f.Type.Kind == Kind.Int ? DataType.BigInt : f.Type;
                    fs.Add(new Field(cq.Cols != null ? cq.Cols[i] : f.Name, t));
                }
                Schema sch = new Schema(fs);
                WorkSource ws = new WorkSource(sch);
                recWork[name] = ws;
                Planned rec;
                try { rec = PlanSet(so.Right); } finally { recWork.Remove(name); }
                if (rec.Op.Schema.Count != sch.Count) throw new EngineException("SQL_UNION", "The two parts of recursive CTE \"" + name + "\" have different column counts (" + sch.Count + " vs " + rec.Op.Schema.Count + ").");
                Planned p = new Planned(); p.Op = new RecursiveOp(anchor.Op, rec.Op, ws, !so.All, sch); p.Scope = Scope.Of(sch, null);
                return OrderLimit(p, cq, null);
            }
            finally { expanding.Remove("cte:" + name); }
        }

        // ---------- PIVOT (agg(x) FOR col IN (v1, v2, ...)): group by the other columns, one aggregate per value ----------
        Planned PlanPivot(PivotRef pr)
        {
            Planned src = PlanFrom(pr.Source);
            ColName forC = pr.For as ColName;
            if (forC == null) throw new EngineException("SQL_SYNTAX", "PIVOT ... FOR needs a column name.");
            HashSet<string> used = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { forC.Name };
            foreach (Expr a in pr.Agg.Args) Walk(a, x => { ColName cn = x as ColName; if (cn != null) used.Add(cn.Name); }, false);
            SelectStmt sel = new SelectStmt(); sel.From = pr.Source;
            foreach (ScopeCol c in src.Scope.Cols)
            {
                if (c.NoStar || used.Contains(c.Name)) continue;
                ColName cn = Col(c.Table, c.Name);
                sel.Items.Add(Item(cn, c.Name)); sel.GroupBy.Add(cn);
            }
            for (int i = 0; i < pr.Values.Count; i++)
            {
                Expr v = pr.Values[i], cond; string name = pr.ValueAliases[i];
                ColName vc = v as ColName;
                if (vc != null && vc.Table == null)
                {
                    // [2023] / "2023": a name standing for that value
                    CastE ce = new CastE(); ce.X = forC; ce.T = DataType.Varchar;
                    cond = Bin("=", ce, LitOf(vc.Name, DataType.Varchar)); if (name == null) name = vc.Name;
                }
                else
                {
                    cond = Bin("=", forC, v);
                    if (name == null) { Lit lv = v as Lit; name = lv != null ? (lv.Value == null ? "NULL" : Values.ToText(lv.Value, lv.Type)) : NameOf(v); }
                }
                Call a = new Call(); a.Name = pr.Agg.Name; a.Distinct = pr.Agg.Distinct;
                Expr arg = pr.Agg.Star || pr.Agg.Args.Count == 0 ? (Expr)LitOf(1L, DataType.BigInt) : pr.Agg.Args[0];
                a.Args.Add(CaseOf(new List<Expr> { cond }, new List<Expr> { arg }, null));
                for (int k = 1; k < pr.Agg.Args.Count; k++) a.Args.Add(pr.Agg.Args[k]);
                sel.Items.Add(Item(a, name));
            }
            QueryStmt q = new QueryStmt(); q.Body = sel;
            return Rescope(Plan(q), pr.Alias);
        }

        // WITH name(a, b): the CTE's columns renamed.
        static Planned Renamed(Planned p, List<string> cols, string name)
        {
            if (cols == null) return p;
            if (cols.Count != p.Op.Schema.Count) throw new EngineException("SQL_CTE", "CTE \"" + name + "\" names " + cols.Count + " column(s) but returns " + p.Op.Schema.Count + ".");
            List<Field> fs = new List<Field>();
            for (int i = 0; i < cols.Count; i++) fs.Add(new Field(cols[i], p.Op.Schema[i].Type));
            Planned r = new Planned(); r.Op = new RenameOp(p.Op, new Schema(fs)); r.Scope = Scope.Of(r.Op.Schema, null);
            return r;
        }

        static Planned Rescope(Planned p, string alias)
        {
            Planned r = new Planned(); r.Op = p.Op; r.Scope = Scope.Of(p.Op.Schema, alias);
            return r;
        }

        static ChainOp AsChain(Op op) { ChainOp c = op as ChainOp; return c ?? new ChainOp(new OpSource(op)); }

        Planned PlanJoin(JoinRef j)
        {
            Planned l = PlanFrom(j.Left), r = PlanFrom(j.Right);
            int lc = l.Op.Schema.Count;
            Scope sc = new Scope();
            foreach (ScopeCol c in l.Scope.Cols) sc.Cols.Add(Copy(c, c.Index));
            foreach (ScopeCol c in r.Scope.Cols) sc.Cols.Add(Copy(c, c.Index + lc));
            List<Field> fs = new List<Field>(l.Op.Schema.Fields);
            fs.AddRange(r.Op.Schema.Fields);
            Schema outS = new Schema(fs);

            List<BExpr> lk = new List<BExpr>(), rk = new List<BExpr>();
            BExpr residual = null;
            Phase lp = Ph(l.Scope), rp = Ph(r.Scope), bp = Ph(sc);
            if (j.Using != null)
            {
                foreach (string u in j.Using)
                {
                    ScopeCol a = l.Scope.Find(null, u, true), b = r.Scope.Find(null, u, true);
                    AddKey(lk, rk, new BCol(a.Index, a.Type), new BCol(b.Index, b.Type));
                    ScopeCol rc = sc.Cols[lc + b.Index]; rc.NoStar = true; rc.NoUnqualified = true;
                    if (j.Kind == "RIGHT" || j.Kind == "FULL")
                        sc.Cols[a.Index].Override = Functions.Bind("coalesce", new List<BExpr> { new BCol(a.Index, a.Type), new BCol(lc + b.Index, b.Type) });
                }
            }
            else if (j.On != null)
            {
                foreach (Expr conj in Conjuncts(j.On))
                {
                    BinOp eq = conj as BinOp;
                    if (eq != null && eq.Op == "=")
                    {
                        BExpr a, b;
                        if (TryBind(eq.L, lp, out a) && TryBind(eq.R, rp, out b)) { AddKey(lk, rk, a, b); continue; }
                        if (TryBind(eq.R, lp, out a) && TryBind(eq.L, rp, out b)) { AddKey(lk, rk, a, b); continue; }
                    }
                    BExpr x = Bind(conj, bp);
                    residual = residual == null ? x : new BLogic(true, residual, x);
                }
            }
            if (lk.Count == 0 && j.Kind != "CROSS" && j.Kind != "INNER" && residual == null)
                throw new EngineException("SQL_JOIN", "A " + j.Kind + " JOIN needs a condition.");
            HashJoin h = new HashJoin(r.Op, rk);
            ChainOp chain = AsChain(l.Op);
            chain.Add(new JoinProbe(h, lk, residual, j.Kind, outS));
            Planned p = new Planned(); p.Scope = sc;
            p.Op = (j.Kind == "RIGHT" || j.Kind == "FULL") ? (Op)new OuterJoinOp(chain, h, lc) : chain;
            return p;
        }
        static ScopeCol Copy(ScopeCol c, int index)
        {
            ScopeCol n = new ScopeCol(); n.Table = c.Table; n.Name = c.Name; n.Index = index; n.Type = c.Type; n.NoStar = c.NoStar; n.NoUnqualified = c.NoUnqualified;
            return n;
        }
        static void AddKey(List<BExpr> lk, List<BExpr> rk, BExpr a, BExpr b)
        {
            DataType t = Cast.Common(a.Type, b.Type);
            if (t.Kind == Kind.Int) t = DataType.BigInt;
            if (t.Kind == Kind.Decimal || (t.Kind == Kind.Double)) t = DataType.Double;
            lk.Add(a.Type.SameAs(t) || (a.Type.UsesI && t.UsesI && a.Type.Kind == t.Kind) ? a : new BCast(a, t, true));
            rk.Add(b.Type.SameAs(t) || (b.Type.UsesI && t.UsesI && b.Type.Kind == t.Kind) ? b : new BCast(b, t, true));
        }
        static IEnumerable<Expr> Conjuncts(Expr e)
        {
            BinOp b = e as BinOp;
            if (b != null && b.Op == "AND") { foreach (Expr x in Conjuncts(b.L)) yield return x; foreach (Expr x in Conjuncts(b.R)) yield return x; }
            else yield return e;
        }
        bool TryBind(Expr e, Phase ph, out BExpr r)
        {
            try { r = Bind(e, ph); return true; }
            catch (EngineException) { r = null; return false; }
        }
        static Phase Ph(Scope s) { Phase p = new Phase(); p.Scope = s; return p; }

        // ---------- SELECT ----------
        static bool HasAgg(Expr e)
        {
            bool found = false;
            Walk(e, x => { Call c = x as Call; if (c != null && c.Over == null && Functions.Aggregates.Contains(c.Name)) found = true; }, true);
            return found;
        }
        // Visits e and sub-expressions; stopAtAgg: do not look inside aggregate / window calls.
        static void Walk(Expr e, Action<Expr> f, bool stopAtAgg)
        {
            if (e == null) return;
            f(e);
            Call c = e as Call;
            if (c != null)
            {
                if (stopAtAgg && (c.Over != null || Functions.Aggregates.Contains(c.Name))) return;
                foreach (Expr a in c.Args) Walk(a, f, stopAtAgg);
                return;
            }
            BinOp b = e as BinOp; if (b != null) { Walk(b.L, f, stopAtAgg); Walk(b.R, f, stopAtAgg); return; }
            UnOp u = e as UnOp; if (u != null) { Walk(u.X, f, stopAtAgg); return; }
            IsNullE n = e as IsNullE; if (n != null) { Walk(n.X, f, stopAtAgg); return; }
            InE i = e as InE; if (i != null) { Walk(i.X, f, stopAtAgg); foreach (Expr x in i.List) Walk(x, f, stopAtAgg); return; }
            BetweenE bt = e as BetweenE; if (bt != null) { Walk(bt.X, f, stopAtAgg); Walk(bt.Lo, f, stopAtAgg); Walk(bt.Hi, f, stopAtAgg); return; }
            LikeE lk = e as LikeE; if (lk != null) { Walk(lk.X, f, stopAtAgg); Walk(lk.Pat, f, stopAtAgg); return; }
            CaseE ce = e as CaseE;
            if (ce != null) { Walk(ce.Operand, f, stopAtAgg); foreach (Expr x in ce.Whens) Walk(x, f, stopAtAgg); foreach (Expr x in ce.Thens) Walk(x, f, stopAtAgg); Walk(ce.Else, f, stopAtAgg); return; }
            CastE ca = e as CastE; if (ca != null) { Walk(ca.X, f, stopAtAgg); return; }
            RowE r = e as RowE; if (r != null) { foreach (Expr x in r.Items) Walk(x, f, stopAtAgg); return; }
            InSubE ins = e as InSubE; if (ins != null) { Walk(ins.X, f, stopAtAgg); return; }
            QuantE qe = e as QuantE; if (qe != null) { Walk(qe.X, f, stopAtAgg); return; }
        }
        static void CollectCalls(Expr e, List<Call> aggs, List<Call> wins)
        {
            Walk(e, x =>
            {
                Call c = x as Call; if (c == null) return;
                if (c.Over != null) { if (!wins.Any(w => w.Key() == c.Key())) wins.Add(c); }
                else if (Functions.Aggregates.Contains(c.Name)) { if (!aggs.Any(a => a.Key() == c.Key())) aggs.Add(c); }
            }, true);
            // aggregates inside window arguments (e.g. sum(sum(x)) OVER ()) are found by walking window args too
            Walk(e, x =>
            {
                Call c = x as Call; if (c == null || c.Over == null) return;
                foreach (Expr a in c.Args) Walk(a, y => { Call d = y as Call; if (d != null && d.Over == null && Functions.Aggregates.Contains(d.Name) && !aggs.Any(z => z.Key() == d.Key())) aggs.Add(d); }, true);
            }, false);
        }

        public static string NameOf(Expr e)
        {
            ColName c = e as ColName; if (c != null) return c.Name;
            Call f = e as Call;
            if (f != null)
            {
                if (f.Star && f.Name == "count") return "count_star()";
                return f.Name + "(" + (f.Distinct ? "DISTINCT " : "") + string.Join(", ", f.Args.Select(NameOf)) + ")";
            }
            if (e is SubE) return "subquery";
            Lit l = e as Lit; if (l != null) return l.Value == null ? "NULL" : l.Type.Kind == Kind.String ? "'" + l.Value + "'" : Values.ToText(l.Value, l.Type);
            CastE ca = e as CastE; if (ca != null) return (ca.Try ? "TRY_CAST(" : "CAST(") + NameOf(ca.X) + " AS " + ca.T.Name + ")";
            BinOp b = e as BinOp; if (b != null) return "(" + NameOf(b.L) + " " + b.Op + " " + NameOf(b.R) + ")";
            return e.Key();
        }

        Planned PlanSelect(SelectStmt s, QueryStmt q)
        {
            if (s.GroupBy.Any(IsGroupingElem)) return PlanGroupingSets(s, q);
            if (HasSub(s.Where) || HasSub(s.Having) || s.Items.Any(i => HasSub(i.E)) || s.GroupBy.Any(HasSub)) return PlanSelect(Unnest(s), q);
            Planned src;
            if (s.From != null) src = PlanFrom(s.From);
            else
            {
                Schema empty = new Schema(new List<Field>());
                src = new Planned(); src.Op = new ChainOp(new MemSource(empty, new List<Batch> { new Batch(empty, new Column[0], 1) })); src.Scope = new Scope();
            }
            Op op = src.Op; Scope scope = src.Scope;
            Phase ph = Ph(scope);
            if (s.Where != null)
            {
                if (HasAgg(s.Where)) throw new EngineException("SQL_AGG_WHERE", "Aggregates are not allowed in WHERE; use HAVING.");
                ChainOp ch = AsChain(op); ch.Add(new FilterStep(Bind(s.Where, ph), op.Schema)); op = ch;
            }

            // Expand * and name the select list.
            List<Expr> items = new List<Expr>(); List<string> names = new List<string>();
            foreach (SelectItem it in s.Items)
            {
                StarE st = it.E as StarE;
                if (st != null)
                {
                    bool any = false;
                    foreach (ScopeCol c in scope.Cols)
                    {
                        if (c.NoStar) continue;
                        if (st.Table != null && !string.Equals(c.Table, st.Table, StringComparison.OrdinalIgnoreCase)) continue;
                        if (st.Exclude.Any(x => string.Equals(x, c.Name, StringComparison.OrdinalIgnoreCase))) continue;
                        ColName cn = new ColName(); cn.Table = st.Table ?? (c.Override != null ? null : c.Table); cn.Name = c.Name;
                        if (cn.Table == null && c.Override == null && scope.Cols.Count(x => !x.NoUnqualified && string.Equals(x.Name, c.Name, StringComparison.OrdinalIgnoreCase)) > 1) cn.Table = c.Table;
                        items.Add(cn); names.Add(c.Name); any = true;
                    }
                    if (!any && st.Table != null) throw new EngineException("TABLE_NOT_FOUND", "No table \"" + st.Table + "\" in FROM.");
                    continue;
                }
                items.Add(it.E); names.Add(it.Alias ?? NameOf(it.E));
            }

            // Lateral aliases: a select item may use an earlier item's alias (SELECT a * 2 AS b, b + 1 AS c).
            for (int i = 1; i < items.Count; i++)
            {
                int upto = i;
                items[i] = Rewrite(items[i], cn =>
                {
                    if (cn.Table != null || scope.Find(null, cn.Name, false) != null) return null;
                    for (int k = upto - 1; k >= 0; k--) if (string.Equals(names[k], cn.Name, StringComparison.OrdinalIgnoreCase)) return items[k];
                    return null;
                });
            }

            List<Call> aggs = new List<Call>(), wins = new List<Call>();
            foreach (Expr e in items) CollectCalls(e, aggs, wins);
            if (s.Having != null) CollectCalls(s.Having, aggs, wins);
            foreach (OrderItem o in q.Order) CollectCalls(o.E, aggs, wins);

            List<Expr> groupBy = new List<Expr>();
            if (s.GroupAll) { for (int i = 0; i < items.Count; i++) if (!HasAgg(items[i]) && !HasWin(items[i])) groupBy.Add(items[i]); }
            else foreach (Expr g in s.GroupBy) groupBy.Add(ResolveGroupItem(g, items, names, scope));

            bool aggregating = aggs.Count > 0 || groupBy.Count > 0 || s.Having != null;
            if (aggregating)
            {
                List<BExpr> gb = new List<BExpr>(); List<AggSpec> specs = new List<AggSpec>(); List<Field> fs = new List<Field>();
                Phase post = new Phase(); post.Scope = new Scope(); post.PostAgg = true;
                foreach (Expr g in groupBy)
                {
                    if (post.Exact.ContainsKey(g.Key())) continue;
                    BExpr b = Bind(g, ph);
                    ColName gc = g as ColName;
                    string nm = gc != null ? gc.Name : NameOf(g);
                    ScopeCol sc = new ScopeCol(); sc.Name = nm; sc.Index = gb.Count; sc.Type = b.Type;
                    sc.Table = gc != null ? (gc.Table ?? (scope.Find(null, gc.Name, false) ?? new ScopeCol()).Table) : null;
                    post.Scope.Cols.Add(sc); post.Exact[g.Key()] = gb.Count;
                    fs.Add(new Field(nm, b.Type)); gb.Add(b);
                }
                foreach (Call c in aggs)
                {
                    AggSpec a = new AggSpec(); a.Fn = c.Name.ToLowerInvariant(); a.Distinct = c.Distinct;
                    if (a.Fn == "count" && (c.Star || c.Args.Count == 0)) a.Arg = null;
                    else
                    {
                        if (c.Args.Count == 0) throw new EngineException("FUNCTION_ARGS", c.Name + "() needs an argument.");
                        a.Arg = Bind(c.Args[0], ph);
                        if (c.Args.Count > 1)
                        {
                            BExpr second = Bind(c.Args[1], ph);
                            if (a.Fn.StartsWith("quantile")) { BLit pl = second as BLit; a.Param = pl != null ? Convert.ToDouble(pl.Value, CultureInfo.InvariantCulture) : 0.5; }
                            else a.Arg2 = second;
                        }
                    }
                    if (c.Filter != null) a.Filter = BCast.To(Bind(c.Filter, ph), DataType.Bool);
                    a.Out = AggSpec.OutType(a.Fn, a.Arg != null ? a.Arg.Type : DataType.BigInt);
                    int idx = gb.Count + specs.Count;
                    post.Exact[c.Key()] = idx;
                    specs.Add(a);
                }
                for (int k = 0; k < specs.Count; k++)
                {
                    fs.Add(new Field("__agg" + k, specs[k].Out));
                    ScopeCol sc = new ScopeCol(); sc.Name = "__agg" + k; sc.Index = gb.Count + k; sc.Type = specs[k].Out; sc.NoStar = true; sc.NoUnqualified = true;
                    post.Scope.Cols.Add(sc);
                }
                Schema aggS = new Schema(fs);
                op = new AggOp(op, gb, specs, aggS);
                scope = post.Scope; ph = post;
                if (s.Having != null) { ChainOp ch = AsChain(op); ch.Add(new FilterStep(Bind(s.Having, ph), op.Schema)); op = ch; }
            }

            if (wins.Count > 0)
            {
                List<WinSpec> ws = new List<WinSpec>(); List<Field> fs = new List<Field>(op.Schema.Fields);
                Phase wp = new Phase(); wp.Scope = new Scope(); wp.PostAgg = ph.PostAgg;
                foreach (ScopeCol c in scope.Cols) wp.Scope.Cols.Add(c);
                foreach (KeyValuePair<string, int> kv in ph.Exact) wp.Exact[kv.Key] = kv.Value;
                foreach (Call c in wins)
                {
                    WinSpec w = new WinSpec(); w.Fn = c.Name.ToLowerInvariant(); w.Star = c.Star;
                    foreach (Expr a in c.Args) w.Args.Add(Bind(a, ph));
                    foreach (Expr p in c.Over.Partition) w.Partition.Add(Bind(p, ph));
                    foreach (OrderItem o in c.Over.Order) { SortKey k = new SortKey(); k.E = Bind(o.E, ph); k.Desc = o.Desc; k.NullsFirst = o.Nulls == 1; w.Order.Add(k); }
                    w.Out = WinSpec.OutType(w.Fn, w.Args);
                    wp.Exact[c.Key()] = fs.Count;
                    ScopeCol sc = new ScopeCol(); sc.Name = "__win" + ws.Count; sc.Index = fs.Count; sc.Type = w.Out; sc.NoStar = true; sc.NoUnqualified = true;
                    wp.Scope.Cols.Add(sc);
                    fs.Add(new Field("__win" + ws.Count, w.Out));
                    ws.Add(w);
                }
                op = new WindowOp(op, ws, new Schema(fs));
                scope = wp.Scope; ph = wp;
            }

            // Projection (+ hidden ORDER BY columns), DISTINCT, ORDER BY, LIMIT.
            List<BExpr> proj = new List<BExpr>(); List<Field> pf = new List<Field>();
            for (int i = 0; i < items.Count; i++) { BExpr b = Bind(items[i], ph); proj.Add(b); pf.Add(new Field(names[i], b.Type.Kind == Kind.Null ? DataType.Null : b.Type)); }
            int visible = proj.Count;
            List<SortKey> sortKeys = new List<SortKey>();
            if (q.OrderAll)
                for (int i = 0; i < visible; i++) { SortKey k = new SortKey(); k.E = new BCol(i, pf[i].Type); k.Desc = q.OrderAllDesc; sortKeys.Add(k); }
            foreach (OrderItem o in q.Order)
            {
                int col = OutputColumn(o.E, items, names);
                if (col < 0)
                {
                    if (s.Distinct) throw new EngineException("SQL_ORDER", "With SELECT DISTINCT, ORDER BY must use selected columns.");
                    BExpr b = Bind(o.E, ph); col = proj.Count; proj.Add(b); pf.Add(new Field("__order" + col, b.Type));
                }
                SortKey k = new SortKey(); k.E = new BCol(col, pf[col].Type); k.Desc = o.Desc; k.NullsFirst = o.Nulls == 1; sortKeys.Add(k);
            }
            Schema projS = new Schema(pf);
            ChainOp pc = AsChain(op); pc.Add(new ProjectStep(proj, projS)); op = pc;
            if (s.Distinct) op = Distinct(op);
            if (sortKeys.Count > 0) op = new SortOp(op, sortKeys, q.Limit >= 0 ? q.Limit + q.Offset : -1);
            if (q.Limit >= 0 || q.Offset > 0) op = new LimitOp(op, q.Limit, q.Offset);
            if (proj.Count > visible)
            {
                List<BExpr> keep = new List<BExpr>(); List<Field> kf = new List<Field>();
                for (int i = 0; i < visible; i++) { keep.Add(new BCol(i, pf[i].Type)); kf.Add(pf[i]); }
                ChainOp fc = AsChain(op); fc.Add(new ProjectStep(keep, new Schema(kf))); op = fc;
            }
            Planned r = new Planned(); r.Op = op; r.Scope = Scope.Of(op.Schema, null);
            return r;
        }
        // Copy of e with column references replaced where f returns a non-null expression.
        static Expr Rewrite(Expr e, Func<ColName, Expr> f)
        {
            if (e == null) return null;
            ColName cn = e as ColName; if (cn != null) return f(cn) ?? cn;
            Call c = e as Call;
            if (c != null)
            {
                Call n = new Call(); n.Name = c.Name; n.Distinct = c.Distinct; n.Star = c.Star; n.Over = c.Over; n.Filter = Rewrite(c.Filter, f);
                foreach (Expr a in c.Args) n.Args.Add(Rewrite(a, f));
                return n;
            }
            BinOp b = e as BinOp; if (b != null) { BinOp n = new BinOp(); n.Op = b.Op; n.L = Rewrite(b.L, f); n.R = Rewrite(b.R, f); return n; }
            UnOp u = e as UnOp; if (u != null) { UnOp n = new UnOp(); n.Op = u.Op; n.X = Rewrite(u.X, f); return n; }
            IsNullE isn = e as IsNullE; if (isn != null) { IsNullE n = new IsNullE(); n.Not = isn.Not; n.X = Rewrite(isn.X, f); return n; }
            InE ine = e as InE; if (ine != null) { InE n = new InE(); n.Not = ine.Not; n.X = Rewrite(ine.X, f); foreach (Expr x in ine.List) n.List.Add(Rewrite(x, f)); return n; }
            BetweenE bt = e as BetweenE; if (bt != null) { BetweenE n = new BetweenE(); n.Not = bt.Not; n.X = Rewrite(bt.X, f); n.Lo = Rewrite(bt.Lo, f); n.Hi = Rewrite(bt.Hi, f); return n; }
            LikeE lk = e as LikeE; if (lk != null) { LikeE n = new LikeE(); n.Not = lk.Not; n.Insensitive = lk.Insensitive; n.X = Rewrite(lk.X, f); n.Pat = Rewrite(lk.Pat, f); return n; }
            CaseE ce = e as CaseE;
            if (ce != null)
            {
                CaseE n = new CaseE(); n.Operand = Rewrite(ce.Operand, f); n.Else = Rewrite(ce.Else, f);
                foreach (Expr x in ce.Whens) n.Whens.Add(Rewrite(x, f)); foreach (Expr x in ce.Thens) n.Thens.Add(Rewrite(x, f));
                return n;
            }
            CastE ca = e as CastE; if (ca != null) { CastE n = new CastE(); n.T = ca.T; n.Try = ca.Try; n.X = Rewrite(ca.X, f); return n; }
            RowE r = e as RowE; if (r != null) { RowE n = new RowE(); foreach (Expr x in r.Items) n.Items.Add(Rewrite(x, f)); return n; }
            InSubE ins = e as InSubE; if (ins != null) { InSubE n = new InSubE(); n.Q = ins.Q; n.Not = ins.Not; n.X = Rewrite(ins.X, f); return n; }
            QuantE qe = e as QuantE; if (qe != null) { QuantE n = new QuantE(); n.Q = qe.Q; n.Op = qe.Op; n.All = qe.All; n.X = Rewrite(qe.X, f); return n; }
            return e;
        }
        static bool HasWin(Expr e) { bool f = false; Walk(e, x => { Call c = x as Call; if (c != null && c.Over != null) f = true; }, false); return f; }

        // ORDER BY over a set operation / already projected result: output names and ordinals only.
        Planned OrderLimit(Planned p, QueryStmt q, object unused)
        {
            Op op = p.Op;
            List<SortKey> keys = new List<SortKey>();
            if (q.OrderAll) for (int i = 0; i < op.Schema.Count; i++) { SortKey k = new SortKey(); k.E = new BCol(i, op.Schema[i].Type); k.Desc = q.OrderAllDesc; keys.Add(k); }
            Phase ph = Ph(p.Scope);
            foreach (OrderItem o in q.Order)
            {
                Lit l = o.E as Lit; BExpr b;
                if (l != null && l.Value is long) { int i = (int)(long)l.Value - 1; if (i < 0 || i >= op.Schema.Count) throw new EngineException("SQL_ORDER", "ORDER BY position " + (i + 1) + " is out of range."); b = new BCol(i, op.Schema[i].Type); }
                else b = Bind(o.E, ph);
                SortKey k = new SortKey(); k.E = b; k.Desc = o.Desc; k.NullsFirst = o.Nulls == 1; keys.Add(k);
            }
            if (keys.Count > 0) op = new SortOp(op, keys, q.Limit >= 0 ? q.Limit + q.Offset : -1);
            if (q.Limit >= 0 || q.Offset > 0) op = new LimitOp(op, q.Limit, q.Offset);
            Planned r = new Planned(); r.Op = op; r.Scope = p.Scope;
            return r;
        }

        static int OutputColumn(Expr e, List<Expr> items, List<string> names)
        {
            Lit l = e as Lit;
            if (l != null && l.Value is long)
            {
                int i = (int)(long)l.Value - 1;
                if (i < 0 || i >= items.Count) throw new EngineException("SQL_ORDER", "ORDER BY position " + (i + 1) + " is out of range.");
                return i;
            }
            ColName c = e as ColName;
            if (c != null && c.Table == null)
            {
                for (int i = 0; i < names.Count; i++) if (names[i] == c.Name) return i;
                for (int i = 0; i < names.Count; i++) if (string.Equals(names[i], c.Name, StringComparison.OrdinalIgnoreCase)) return i;
            }
            string key = e.Key();
            for (int i = 0; i < items.Count; i++) if (items[i].Key() == key) return i;
            return -1;
        }
        Expr ResolveGroupItem(Expr g, List<Expr> items, List<string> names, Scope scope)
        {
            Lit l = g as Lit;
            if (l != null && l.Value is long)
            {
                int i = (int)(long)l.Value - 1;
                if (i < 0 || i >= items.Count) throw new EngineException("SQL_GROUP", "GROUP BY position " + (i + 1) + " is out of range.");
                return items[i];
            }
            ColName c = g as ColName;
            if (c != null && c.Table == null && scope.Find(null, c.Name, false) == null)
                for (int i = 0; i < names.Count; i++) if (string.Equals(names[i], c.Name, StringComparison.OrdinalIgnoreCase)) return items[i];
            return g;
        }

        // ---------- expressions ----------
        BExpr Bind(Expr e, Phase ph)
        {
            int ex;
            if (ph.Exact.Count > 0 && ph.Exact.TryGetValue(e.Key(), out ex))
                return new BCol(ex, ph.Scope.Cols.First(c => c.Index == ex).Type);
            ColName cn = e as ColName;
            if (cn != null)
            {
                ScopeCol c = ph.Scope.Find(cn.Table, cn.Name, !ph.PostAgg);
                if (c == null && ph.PostAgg)
                {
                    // A column that is not grouped: allowed if it equals a grouped column by name.
                    throw new EngineException("SQL_GROUP", "Column \"" + cn.Name + "\" must be in GROUP BY or inside an aggregate (e.g. any_value(" + cn.Name + ")).");
                }
                if (c.Override != null) return c.Override;
                return new BCol(c.Index, c.Type);
            }
            Lit l = e as Lit; if (l != null) return new BLit(l.Value, l.Type);
            Call f = e as Call;
            if (f != null)
            {
                if (f.Over != null) throw new EngineException("SQL_WINDOW", "Window function " + f.Name + "() is not allowed here.");
                if (Functions.Aggregates.Contains(f.Name)) throw new EngineException("SQL_AGG", "Aggregate " + f.Name + "() is not allowed here.");
                if (Functions.WindowOnly.Contains(f.Name)) throw new EngineException("SQL_WINDOW", f.Name + "() needs an OVER (...) clause.");
                List<BExpr> args = new List<BExpr>();
                foreach (Expr a in f.Args) args.Add(Bind(a, ph));
                return Functions.Bind(f.Name, args);
            }
            BinOp b = e as BinOp;
            if (b != null)
            {
                BExpr x = Bind(b.L, ph), y = Bind(b.R, ph);
                switch (b.Op)
                {
                    case "AND": return new BLogic(true, x, y);
                    case "OR": return new BLogic(false, x, y);
                    case "=": case "<>": case "<": case ">": case "<=": case ">=": case "IS DISTINCT FROM": case "IS NOT DISTINCT FROM": return new BCmp(b.Op, x, y);
                    default: return new BArith(b.Op, x, y);
                }
            }
            UnOp u = e as UnOp;
            if (u != null) { BExpr x = Bind(u.X, ph); return u.Op == "NOT" ? (BExpr)new BNot(x) : new BNeg(x); }
            IsNullE isn = e as IsNullE; if (isn != null) return new BIsNull(Bind(isn.X, ph), isn.Not);
            InE ine = e as InE;
            if (ine != null) { List<BExpr> list = new List<BExpr>(); foreach (Expr x in ine.List) list.Add(Bind(x, ph)); return new BIn(Bind(ine.X, ph), list, ine.Not); }
            BetweenE bt = e as BetweenE;
            if (bt != null)
            {
                BExpr x = Bind(bt.X, ph);
                BExpr r = new BLogic(true, new BCmp(">=", x, Bind(bt.Lo, ph)), new BCmp("<=", x, Bind(bt.Hi, ph)));
                return bt.Not ? new BNot(r) : r;
            }
            LikeE lk = e as LikeE; if (lk != null) return new BLike(Bind(lk.X, ph), Bind(lk.Pat, ph), lk.Not, lk.Insensitive);
            CaseE ce = e as CaseE;
            if (ce != null)
            {
                List<BExpr> ws = new List<BExpr>(), ts = new List<BExpr>();
                foreach (Expr x in ce.Whens) ws.Add(Bind(x, ph));
                foreach (Expr x in ce.Thens) ts.Add(Bind(x, ph));
                return new BCase(ce.Operand != null ? Bind(ce.Operand, ph) : null, ws, ts, ce.Else != null ? Bind(ce.Else, ph) : null);
            }
            CastE ca = e as CastE;
            if (ca != null)
            {
                BExpr x = Bind(ca.X, ph);
                if (x.Type.SameAs(ca.T)) return x;
                BLit lit = x as BLit;
                if (lit != null && !ca.Try) return BCast.To(lit, ca.T);
                return new BCast(x, ca.T, ca.Try);
            }
            RowE row = e as RowE;
            if (row != null) { List<BExpr> list = new List<BExpr>(); foreach (Expr x in row.Items) list.Add(Bind(x, ph)); return new BRow(list); }
            if (e is StarE) throw new EngineException("SQL_SYNTAX", "* is only allowed in the select list or count(*).");
            if (e is SubE) throw new EngineException("SQL_UNSUPPORTED", "Subqueries are supported in WHERE, HAVING and the select list.");
            if (e is GroupingSetsE) throw new EngineException("SQL_SYNTAX", "GROUPING SETS is only allowed in GROUP BY.");
            throw new EngineException("SQL_UNSUPPORTED", "Unsupported expression: " + e.Key());
        }

        // ---------- AST helpers ----------
        static ColName Col(string table, string name) { ColName c = new ColName(); c.Table = table; c.Name = name; return c; }
        static Lit LitOf(object v, DataType t) { Lit l = new Lit(); l.Value = v; l.Type = t; return l; }
        static Lit NullLit() { return LitOf(null, DataType.Null); }
        static Lit True() { return LitOf(true, DataType.Bool); }
        static Lit False() { return LitOf(false, DataType.Bool); }
        static Lit Zero() { return LitOf(0L, DataType.BigInt); }
        static BinOp Bin(string op, Expr l, Expr r) { BinOp b = new BinOp(); b.Op = op; b.L = l; b.R = r; return b; }
        static Expr AndOf(Expr a, Expr b) { return a == null ? b : b == null ? a : Bin("AND", a, b); }
        static UnOp NotOf(Expr x) { UnOp u = new UnOp(); u.Op = "NOT"; u.X = x; return u; }
        static IsNullE IsNullOf(Expr x, bool not) { IsNullE n = new IsNullE(); n.X = x; n.Not = not; return n; }
        static Call Fn(string name, params Expr[] args) { Call c = new Call(); c.Name = name; c.Args.AddRange(args); return c; }
        static Call CountStar() { Call c = new Call(); c.Name = "count"; c.Star = true; return c; }
        static SelectItem Item(Expr e, string alias) { SelectItem it = new SelectItem(); it.E = e; it.Alias = alias; return it; }
        static CaseE CaseOf(List<Expr> whens, List<Expr> thens, Expr els) { CaseE c = new CaseE(); c.Whens.AddRange(whens); c.Thens.AddRange(thens); c.Else = els; return c; }
        static bool HasSub(Expr e) { bool f = false; Walk(e, x => { if (x is SubE) f = true; }, false); return f; }

        // Copy of e with each direct child replaced by m(child); leaves and subquery queries are kept.
        static Expr MapChildren(Expr e, Func<Expr, Expr> m)
        {
            Call c = e as Call;
            if (c != null)
            {
                Call n = new Call(); n.Name = c.Name; n.Distinct = c.Distinct; n.Star = c.Star; n.Over = c.Over; n.Filter = c.Filter != null ? m(c.Filter) : null;
                foreach (Expr a in c.Args) n.Args.Add(m(a));
                return n;
            }
            BinOp b = e as BinOp; if (b != null) return Bin(b.Op, m(b.L), m(b.R));
            UnOp u = e as UnOp; if (u != null) { UnOp n = new UnOp(); n.Op = u.Op; n.X = m(u.X); return n; }
            IsNullE isn = e as IsNullE; if (isn != null) return IsNullOf(m(isn.X), isn.Not);
            InE ine = e as InE; if (ine != null) { InE n = new InE(); n.Not = ine.Not; n.X = m(ine.X); foreach (Expr x in ine.List) n.List.Add(m(x)); return n; }
            BetweenE bt = e as BetweenE; if (bt != null) { BetweenE n = new BetweenE(); n.Not = bt.Not; n.X = m(bt.X); n.Lo = m(bt.Lo); n.Hi = m(bt.Hi); return n; }
            LikeE lk = e as LikeE; if (lk != null) { LikeE n = new LikeE(); n.Not = lk.Not; n.Insensitive = lk.Insensitive; n.X = m(lk.X); n.Pat = m(lk.Pat); return n; }
            CaseE ce = e as CaseE;
            if (ce != null)
            {
                CaseE n = new CaseE(); n.Operand = ce.Operand != null ? m(ce.Operand) : null; n.Else = ce.Else != null ? m(ce.Else) : null;
                foreach (Expr x in ce.Whens) n.Whens.Add(m(x)); foreach (Expr x in ce.Thens) n.Thens.Add(m(x));
                return n;
            }
            CastE ca = e as CastE; if (ca != null) { CastE n = new CastE(); n.T = ca.T; n.Try = ca.Try; n.X = m(ca.X); return n; }
            RowE r = e as RowE; if (r != null) { RowE n = new RowE(); foreach (Expr x in r.Items) n.Items.Add(m(x)); return n; }
            InSubE ins = e as InSubE; if (ins != null) { InSubE n = new InSubE(); n.Q = ins.Q; n.Not = ins.Not; n.X = m(ins.X); return n; }
            QuantE qe = e as QuantE; if (qe != null) { QuantE n = new QuantE(); n.Q = qe.Q; n.Op = qe.Op; n.All = qe.All; n.X = m(qe.X); return n; }
            return e;
        }

        // ---------- GROUP BY ROLLUP / CUBE / GROUPING SETS: one grouped query per set, UNION ALL ----------
        static bool IsGroupingElem(Expr g)
        {
            Call c = g as Call;
            return g is GroupingSetsE || (c != null && c.Over == null && (c.Name == "rollup" || c.Name == "cube"));
        }
        Planned PlanGroupingSets(SelectStmt s, QueryStmt q)
        {
            List<List<Expr>> sets = new List<List<Expr>> { new List<Expr>() };
            foreach (Expr g in s.GroupBy)
            {
                List<List<Expr>> opts = new List<List<Expr>>();
                GroupingSetsE gs = g as GroupingSetsE; Call c = g as Call;
                if (gs != null) opts.AddRange(gs.Sets);
                else if (IsGroupingElem(g))
                {
                    List<List<Expr>> units = new List<List<Expr>>();
                    foreach (Expr a in c.Args) { RowE re = a as RowE; units.Add(re != null ? re.Items : new List<Expr> { a }); }
                    if (c.Name == "rollup")
                        for (int k = units.Count; k >= 0; k--) { List<Expr> set = new List<Expr>(); for (int i = 0; i < k; i++) set.AddRange(units[i]); opts.Add(set); }
                    else
                    {
                        if (units.Count > 12) throw new EngineException("SQL_GROUP", "CUBE supports up to 12 columns.");
                        List<int> masks = Enumerable.Range(0, 1 << units.Count).OrderByDescending(m => Bits(m)).ThenByDescending(m => m).ToList();
                        foreach (int m in masks) { List<Expr> set = new List<Expr>(); for (int i = 0; i < units.Count; i++) if ((m & (1 << (units.Count - 1 - i))) != 0) set.AddRange(units[i]); opts.Add(set); }
                    }
                }
                else opts.Add(new List<Expr> { g });
                List<List<Expr>> next = new List<List<Expr>>();
                foreach (List<Expr> a in sets) foreach (List<Expr> b in opts) { List<Expr> n = new List<Expr>(a); n.AddRange(b); next.Add(n); }
                sets = next;
            }
            Dictionary<string, Expr> all = new Dictionary<string, Expr>();
            foreach (List<Expr> set in sets) foreach (Expr e in set) all[e.Key()] = e;
            object body = null;
            foreach (List<Expr> set in sets)
            {
                HashSet<string> inSet = new HashSet<string>(set.Select(e => e.Key()));
                SelectStmt c = s.Clone(); c.GroupAll = false; c.GroupBy = new List<Expr>();
                foreach (Expr e in set) if (!c.GroupBy.Any(x => x.Key() == e.Key())) c.GroupBy.Add(e);
                Func<Expr, Expr> f = null;
                f = e =>
                {
                    if (e == null) return null;
                    Call cl = e as Call;
                    if (cl != null && cl.Over == null && (cl.Name == "grouping" || cl.Name == "grouping_id"))
                    {
                        long v = 0; foreach (Expr a in cl.Args) v = v * 2 + (inSet.Contains(a.Key()) ? 0 : 1);
                        return LitOf(v, DataType.BigInt);
                    }
                    if (all.ContainsKey(e.Key()) && !inSet.Contains(e.Key())) return NullLit();
                    if (cl != null && cl.Over == null && Functions.Aggregates.Contains(cl.Name)) return e;   // aggregate arguments keep their columns
                    return MapChildren(e, f);
                };
                foreach (SelectItem it in c.Items) { if (it.E is StarE) continue; if (it.Alias == null) it.Alias = NameOf(it.E); it.E = f(it.E); }
                c.Having = f(c.Having);
                if (body == null) body = c;
                else { SetOp u = new SetOp(); u.Left = body; u.Right = c; u.Op = "UNION"; u.All = true; body = u; }
            }
            QueryStmt qq = q.Copy(); qq.Body = body; qq.With = new List<KeyValuePair<string, QueryStmt>>();
            return OrderLimit(PlanSet(body), qq, null);
        }
        static int Bits(int m) { int n = 0; while (m != 0) { n += m & 1; m >>= 1; } return n; }

        // ---------- subqueries in expressions -> helper joins ----------
        // Each subquery becomes a derived table joined to FROM (CROSS JOIN when uncorrelated, LEFT JOIN on the
        // correlation keys otherwise); the expression then reads that table's columns. Correlation must be equality
        // conditions between the subquery and the outer query (inner.col = outer.col).
        sealed class UnCtx { public TableRef From; public Scope Outer; }
        SelectStmt Unnest(SelectStmt s)
        {
            UnCtx cx = new UnCtx();
            cx.Outer = s.From != null ? PlanFrom(s.From).Scope : new Scope();
            cx.From = s.From;
            if (cx.From == null)
            {
                SelectStmt one = new SelectStmt(); one.Items.Add(Item(LitOf(1L, DataType.BigInt), "__one"));
                QueryStmt oq = new QueryStmt(); oq.Body = one;
                SubqueryTable st = new SubqueryTable(); st.Query = oq; st.Alias = "__one"; st.Hidden = true; cx.From = st;
            }
            bool aggregating = s.GroupAll || s.GroupBy.Count > 0 || s.Having != null || s.Items.Any(i => HasAgg(i.E));
            SelectStmt n = s.Clone();
            n.Where = Sub(n.Where, cx, false);
            for (int i = 0; i < n.Items.Count; i++)
            {
                SelectItem it = n.Items[i];
                if (it.E is StarE || !HasSub(it.E)) continue;
                if (it.Alias == null) it.Alias = NameOf(it.E);
                // A grouped item (GROUP BY 2 / its alias / GROUP BY ALL) is a group key, not wrapped in any_value.
                string alias = it.Alias; int pos = i + 1;
                bool grouped = s.GroupAll ? !HasAgg(it.E) : s.GroupBy.Any(g =>
                {
                    Lit l = g as Lit; ColName c = g as ColName;
                    return (l != null && l.Value is long && (long)l.Value == pos) || (c != null && c.Table == null && string.Equals(c.Name, alias, StringComparison.OrdinalIgnoreCase));
                });
                it.E = Sub(it.E, cx, aggregating && !grouped);
            }
            n.GroupBy = n.GroupBy.Select(g => Sub(g, cx, false)).ToList();
            n.Having = Sub(n.Having, cx, aggregating);
            n.From = cx.From;
            return n;
        }
        // wrap: the query aggregates and e is outside any aggregate, so a value read from a helper join is any_value(...).
        Expr Sub(Expr e, UnCtx cx, bool wrap)
        {
            if (e == null || !HasSub(e)) return e;
            SubE se = e as SubE;
            if (se != null) { Expr r = UnnestOne(se, cx); return wrap ? Fn("any_value", r) : r; }
            Call c = e as Call;
            bool agg = c != null && c.Over == null && Functions.Aggregates.Contains(c.Name);
            return MapChildren(e, x => Sub(x, cx, wrap && !agg));
        }
        Expr UnnestOne(SubE se, UnCtx cx)
        {
            InSubE ins = se as InSubE; QuantE qe = se as QuantE;
            Expr x = ins != null ? Sub(ins.X, cx, false) : qe != null ? Sub(qe.X, cx, false) : null;
            string A = "__sq" + System.Threading.Interlocked.Increment(ref sqSeq);
            bool needVal = !(se is ExistsE);
            Planned whole = null; EngineException firstErr = null;
            try { whole = Plan(se.Q); }
            catch (EngineException ex) { if (ex.Code != "COLUMN_NOT_FOUND") throw; firstErr = ex; }

            TableRef baseRef; Expr rest = null, val = null;
            List<Expr> innerKeys = new List<Expr>(), outerKeys = new List<Expr>();
            if (firstErr == null)
            {
                // Uncorrelated: the whole subquery is the base table.
                SubqueryTable b = new SubqueryTable(); b.Query = se.Q; b.Alias = A + "b";
                if (needVal)
                {
                    if (whole.Op.Schema.Count != 1) throw new EngineException("SQL_SUBQUERY", "A subquery used as a value must return exactly one column (this one returns " + whole.Op.Schema.Count + ").");
                    b.ColAliases = new List<string> { "__x" }; val = Col(A + "b", "__x");
                }
                else if (se.Q.Limit < 0) { QueryStmt lq = se.Q.Copy(); lq.Limit = 1; b.Query = lq; }   // EXISTS: one row is enough
                baseRef = b;
            }
            else
            {
                SelectStmt isel = se.Q.Body as SelectStmt;
                if (isel == null || se.Q.With.Count > 0 || isel.From == null) throw firstErr;
                if (isel.GroupBy.Count > 0 || isel.GroupAll || isel.Having != null || se.Q.Limit >= 0 || (isel.Distinct && needVal && !(se is InSubE) && !(se is QuantE)))
                    throw new EngineException("SQL_UNSUPPORTED", "A correlated subquery (one that uses columns of the outer query) can't use GROUP BY, HAVING or LIMIT.");
                Scope inner = PlanFrom(isel.From).Scope;
                Phase ip = Ph(inner), op = Ph(cx.Outer);
                if (isel.Where != null)
                    foreach (Expr c in Conjuncts(isel.Where))
                    {
                        BExpr tmp;
                        if (HasSub(c) || TryBind(c, ip, out tmp)) { rest = AndOf(rest, c); continue; }
                        BinOp eq = c as BinOp;
                        if (eq != null && eq.Op == "=")
                        {
                            bool li = TryBind(eq.L, ip, out tmp), ri = TryBind(eq.R, ip, out tmp), lo = TryBind(eq.L, op, out tmp), ro = TryBind(eq.R, op, out tmp);
                            if (li && !ri && ro) { innerKeys.Add(eq.L); outerKeys.Add(eq.R); continue; }
                            if (ri && !li && lo) { innerKeys.Add(eq.R); outerKeys.Add(eq.L); continue; }
                            if (!li && !ri && !lo && !ro) throw firstErr;
                        }
                        throw new EngineException("SQL_UNSUPPORTED", "A correlated subquery can only be linked to the outer query by equality conditions (inner.col = outer.col); not supported: " + NameOf(c) + ".");
                    }
                if (innerKeys.Count == 0) throw firstErr;
                if (needVal)
                {
                    if (isel.Items.Count != 1 || isel.Items[0].E is StarE) throw new EngineException("SQL_SUBQUERY", "A subquery used as a value must return exactly one column.");
                    val = isel.Items[0].E;
                }
                baseRef = isel.From;
            }

            // Derived table: correlation keys (grouped) + what the expression needs.
            Func<string, SelectStmt> derived = alias =>
            {
                SelectStmt d = new SelectStmt(); d.From = baseRef; d.Where = rest;
                for (int i = 0; i < innerKeys.Count; i++) { d.Items.Add(Item(innerKeys[i], "__k" + i)); d.GroupBy.Add(innerKeys[i]); }
                return d;
            };
            Func<string, Expr> keysOn = alias => { Expr on = null; for (int i = 0; i < outerKeys.Count; i++) on = AndOf(on, Bin("=", outerKeys[i], Col(alias, "__k" + i))); return on; };
            Action<SelectStmt, string, Expr> join = (d, alias, on) =>
            {
                QueryStmt dq = new QueryStmt(); dq.Body = d;
                SubqueryTable st = new SubqueryTable(); st.Query = dq; st.Alias = alias; st.Hidden = true;
                JoinRef j = new JoinRef(); j.Left = cx.From; j.Right = st; j.Kind = on == null ? "CROSS" : "LEFT"; j.On = on;
                cx.From = j;
            };

            if (se is ExistsE)
            {
                SelectStmt d = derived(A); d.Items.Add(Item(CountStar(), "__c")); join(d, A, keysOn(A));
                return Bin(">", Fn("coalesce", Col(A, "__c"), Zero()), Zero());
            }
            if (se is SubqueryE)
            {
                if (innerKeys.Count > 0 && HasAgg(val))
                {
                    // Correlated aggregate: per-key value; keys with no rows get the aggregate of an empty input.
                    SelectStmt d = derived(A); d.Items.Add(Item(val, "__v")); d.Items.Add(Item(True(), "__m")); join(d, A, keysOn(A));
                    SelectStmt e = new SelectStmt(); e.Items.Add(Item(val, "__e"));
                    TableRef empty = EmptyOf(baseRef);
                    if (empty != null) e.From = empty; else { e.From = baseRef; e.Where = False(); }
                    join(e, A + "e", null);
                    return CaseOf(new List<Expr> { IsNullOf(Col(A, "__m"), false) }, new List<Expr> { Col(A + "e", "__e") }, Col(A, "__v"));
                }
                SelectStmt d1 = derived(A); d1.Items.Add(Item(CountStar(), "__n")); d1.Items.Add(Item(Fn("any_value", val), "__v")); join(d1, A, keysOn(A));
                return Fn("__one_row", Col(A, "__n"), Col(A, "__v"));
            }
            // IN / ANY / ALL: counts and min/max of the subquery's values (per key).
            SelectStmt ds = derived(A);
            ds.Items.Add(Item(CountStar(), "__c")); ds.Items.Add(Item(Fn("count", val), "__cv"));
            ds.Items.Add(Item(Fn("min", val), "__mn")); ds.Items.Add(Item(Fn("max", val), "__mx"));
            join(ds, A, keysOn(A));
            Expr cnt = Fn("coalesce", Col(A, "__c"), Zero()), cv = Fn("coalesce", Col(A, "__cv"), Zero()), mn = Col(A, "__mn"), mx = Col(A, "__mx");
            string qop = qe != null ? qe.Op : "="; bool all = qe != null && qe.All, neg = ins != null && ins.Not;
            if (ins != null || (qop == "=" && !all) || (qop == "<>" && all))
            {
                if (qop == "<>" && all) neg = true;
                // Membership: distinct (key, value) pairs joined on the keys and the value.
                SelectStmt dm = derived(A + "m"); dm.Where = AndOf(rest, IsNullOf(val, true));
                dm.Items.Add(Item(val, "__v")); dm.GroupBy.Add(val); dm.Items.Add(Item(True(), "__m"));
                join(dm, A + "m", AndOf(keysOn(A + "m"), Bin("=", x, Col(A + "m", "__v"))));
                Expr r = CaseOf(new List<Expr> { Col(A + "m", "__m"), Bin("=", cnt, Zero()), IsNullOf(x, false), Bin("<", cv, cnt) },
                                new List<Expr> { True(), False(), NullLit(), NullLit() }, False());
                return neg ? (Expr)NotOf(r) : r;
            }
            if (qop == "=" || qop == "<>")
            {
                // = ALL (all values equal x); <> ANY is NOT (= ALL).
                Expr r = CaseOf(new List<Expr> { Bin("=", cnt, Zero()), IsNullOf(x, false), Bin("<>", mn, mx), Bin("<>", x, mn), Bin("<", cv, cnt) },
                                new List<Expr> { True(), NullLit(), False(), False(), NullLit() }, True());
                return qop == "<>" ? (Expr)NotOf(r) : r;
            }
            bool greater = qop == ">" || qop == ">=";
            if (!all)
                return CaseOf(new List<Expr> { Bin("=", cnt, Zero()), IsNullOf(x, false), Bin(qop, x, greater ? mn : mx), Bin("<", cv, cnt) },
                              new List<Expr> { False(), NullLit(), True(), NullLit() }, False());
            return CaseOf(new List<Expr> { Bin("=", cnt, Zero()), IsNullOf(x, false), NotOf(Bin(qop, x, greater ? mx : mn)), Bin("<", cv, cnt) },
                          new List<Expr> { True(), NullLit(), False(), NullLit() }, True());
        }
        // The same table with no rows (LIMIT 0), keeping its name, for "aggregate over nothing"; null for joins.
        static TableRef EmptyOf(TableRef t)
        {
            if (t is JoinRef || t is PivotRef || t.ColAliases != null) return null;
            NamedTable nt = t as NamedTable;
            string alias = t.Alias ?? (nt != null ? nt.Name : null);
            if (alias == null) return null;
            TableRef inner;
            if (nt != null) { NamedTable c = new NamedTable(); c.Name = nt.Name; inner = c; }
            else { SubqueryTable sq = t as SubqueryTable; if (sq == null) return null; SubqueryTable c = new SubqueryTable(); c.Query = sq.Query; c.Alias = "__e"; inner = c; }
            SelectStmt s = new SelectStmt(); s.Items.Add(Item(new StarE(), null)); s.From = inner;
            QueryStmt q = new QueryStmt(); q.Body = s; q.Limit = 0;
            SubqueryTable r = new SubqueryTable(); r.Query = q; r.Alias = alias;
            return r;
        }

        // Literal argument helpers for table functions.
        public static string StrArg(Expr e, string fn)
        {
            Lit l = e as Lit;
            if (l == null || !(l.Value is string)) throw new EngineException("FUNCTION_ARGS", fn + "() needs a text argument in quotes.");
            return (string)l.Value;
        }
        public static List<string> StrList(Expr e, string fn)
        {
            ListE le = e as ListE;
            List<string> r = new List<string>();
            if (le != null) { foreach (Expr x in le.Items) r.Add(StrArg(x, fn)); return r; }
            r.Add(StrArg(e, fn));
            return r;
        }
        public static object LitArg(Expr e)
        {
            Lit l = e as Lit; if (l != null) return l.Value;
            UnOp u = e as UnOp; if (u != null && u.Op == "-") { object v = LitArg(u.X); if (v is long) return -(long)v; if (v is double) return -(double)v; }
            return null;
        }
        public int BatchRows { get { return batchRows; } }
    }
}
