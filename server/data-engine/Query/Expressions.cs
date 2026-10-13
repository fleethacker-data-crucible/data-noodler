// Bound (typed, column-index resolved) expressions, evaluated a whole batch at a time.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace NativeDataEngine
{
    public abstract class BExpr
    {
        public DataType Type;
        public abstract Column Eval(Batch b);
        public virtual bool IsConst { get { return false; } }
        public virtual void Refs(HashSet<int> s) { }   // input columns this expression reads
        public static void RefsOf(IEnumerable<BExpr> es, HashSet<int> s) { foreach (BExpr e in es) if (e != null) e.Refs(s); }
    }

    public sealed class BCol : BExpr
    {
        public override void Refs(HashSet<int> s) { s.Add(Index); }

        public readonly int Index;
        public BCol(int i, DataType t) { Index = i; Type = t; }
        public override Column Eval(Batch b) { return b.Cols[Index]; }
    }

    public sealed class BLit : BExpr
    {
        public readonly object Value;
        public BLit(object v, DataType t) { Value = v; Type = t; }
        public override bool IsConst { get { return true; } }
        public override Column Eval(Batch b) { return Column.Constant(Type, Value, b.Rows); }
    }

    public sealed class BCast : BExpr
    {
        public override void Refs(HashSet<int> s) { x.Refs(s); }

        readonly BExpr x; readonly bool tryMode;
        public BCast(BExpr x, DataType t, bool tryMode) { this.x = x; Type = t; this.tryMode = tryMode; }
        public override Column Eval(Batch b) { return Cast.To(x.Eval(b), Type, tryMode); }
        public override bool IsConst { get { return x.IsConst; } }
        public static BExpr To(BExpr x, DataType t)
        {
            if (x.Type.SameAs(t)) return x;
            if (x.Type.UsesI && t.UsesI && x.Type.Kind == t.Kind) return x;   // int widths share storage
            BLit l = x as BLit;
            if (l != null)
            {
                Column c = Cast.To(Column.Constant(l.Type, l.Value, 1), t, false);
                return new BLit(c.Get(0), t);
            }
            return new BCast(x, t, false);
        }
    }

    public sealed class BArith : BExpr
    {
        public override void Refs(HashSet<int> s) { l.Refs(s); r.Refs(s); }

        readonly string op; readonly BExpr l, r;
        public BArith(string op, BExpr l, BExpr r)
        {
            this.op = op;
            DataType a = l.Type, c = r.Type;
            if (op == "||") { this.l = BCast.To(l, DataType.Varchar); this.r = BCast.To(r, DataType.Varchar); Type = DataType.Varchar; return; }
            if (a.Kind == Kind.Null) a = c; if (c.Kind == Kind.Null) c = a;
            if ((a.Kind == Kind.Date || a.Kind == Kind.Timestamp) && (op == "+" || op == "-") && c.Kind == Kind.Int)
            { this.l = l; this.r = r; Type = a; return; }
            if (a.Kind == Kind.Date && c.Kind == Kind.Date && op == "-") { this.l = l; this.r = r; Type = DataType.BigInt; return; }
            if (a.Kind == Kind.String && c.IsNumeric) a = c.Kind == Kind.Int ? DataType.Double : c;
            if (c.Kind == Kind.String && a.IsNumeric) c = a.Kind == Kind.Int ? DataType.Double : a;
            if (!(a.IsNumeric && c.IsNumeric)) throw new EngineException("TYPE_MISMATCH", "Cannot apply '" + op + "' to " + l.Type.Name + " and " + r.Type.Name + ".");
            if (a.Kind == Kind.Int && c.Kind == Kind.Int && op != "/") { Type = DataType.BigInt; this.l = BCast.To(l, DataType.BigInt); this.r = BCast.To(r, DataType.BigInt); }
            else { Type = DataType.Double; this.l = BCast.To(l, DataType.Double); this.r = BCast.To(r, DataType.Double); }
        }
        public override bool IsConst { get { return l.IsConst && r.IsConst; } }
        // a || b with either side held as UTF-8 bytes: the result is bytes too (a string side is encoded, nothing decoded).
        static Column ConcatBytes(Column x, Column y, int n, bool[] nulls)
        {
            System.IO.MemoryStream ms = new System.IO.MemoryStream(); int[] offs = new int[n + 1]; byte[] tmp = new byte[64];
            for (int i = 0; i < n; i++)
            {
                offs[i] = (int)ms.Length;
                if (nulls != null && nulls[i]) continue;
                foreach (Column c in new[] { x, y })
                {
                    if (c.IsLazyText) { ms.Write(c.Utf8, c.Offs[i], c.Offs[i + 1] - c.Offs[i]); continue; }
                    string s = c.S[i]; int max = s.Length * 3; if (tmp.Length < max) tmp = new byte[Math.Max(max, tmp.Length * 2)];
                    ms.Write(tmp, 0, Encoding.UTF8.GetBytes(s, 0, s.Length, tmp, 0));
                }
            }
            offs[n] = (int)ms.Length;
            return Column.Utf8Text(DataType.Varchar, n, nulls, ms.ToArray(), offs);
        }
        public override Column Eval(Batch b)
        {
            Column x = l.Eval(b), y = r.Eval(b);
            int n = b.Rows;
            Column o = new Column(Type, n);
            if (x.Type.Kind == Kind.Null || y.Type.Kind == Kind.Null) { for (int i = 0; i < n; i++) o.SetNull(i); return o; }
            for (int i = 0; i < n; i++) if (x.IsNull(i) || y.IsNull(i)) o.SetNull(i);
            if (op == "||" && (x.IsLazyText || y.IsLazyText)) return ConcatBytes(x, y, n, o.Nulls);   // text as bytes: joined as bytes
            if (op == "||") { for (int i = 0; i < n; i++) if (!o.IsNull(i)) o.S[i] = x.S[i] + y.S[i]; return o; }
            if (Type.UsesI && x.I != null && y.I != null)
            {
                long[] a = x.I, c = y.I, d = o.I;
                switch (op)
                {
                    case "+": for (int i = 0; i < n; i++) d[i] = a[i] + c[i]; break;
                    case "-": for (int i = 0; i < n; i++) d[i] = a[i] - c[i]; break;
                    case "*": for (int i = 0; i < n; i++) d[i] = a[i] * c[i]; break;
                    case "//": for (int i = 0; i < n; i++) { if (c[i] == 0) o.SetNull(i); else d[i] = Cast.FloorDiv(a[i], c[i]); } break;
                    case "%": for (int i = 0; i < n; i++) { if (c[i] == 0) o.SetNull(i); else d[i] = a[i] % c[i]; } break;
                }
                return o;
            }
            double[] fa = x.F, fc = y.F, fd = o.F;
            switch (op)
            {
                case "+": for (int i = 0; i < n; i++) fd[i] = fa[i] + fc[i]; break;
                case "-": for (int i = 0; i < n; i++) fd[i] = fa[i] - fc[i]; break;
                case "*": for (int i = 0; i < n; i++) fd[i] = fa[i] * fc[i]; break;
                case "/": for (int i = 0; i < n; i++) { if (fc[i] == 0) o.SetNull(i); else fd[i] = fa[i] / fc[i]; } break;
                case "//": for (int i = 0; i < n; i++) { if (fc[i] == 0) o.SetNull(i); else fd[i] = Math.Floor(fa[i] / fc[i]); } break;
                case "%": for (int i = 0; i < n; i++) { if (fc[i] == 0) o.SetNull(i); else fd[i] = fa[i] % fc[i]; } break;
            }
            return o;
        }
    }

    public sealed class BNeg : BExpr
    {
        public override void Refs(HashSet<int> s) { x.Refs(s); }

        readonly BExpr x;
        public BNeg(BExpr x) { if (!x.Type.IsNumeric) throw new EngineException("TYPE_MISMATCH", "Cannot negate " + x.Type.Name + "."); this.x = x; Type = x.Type.Kind == Kind.Int ? DataType.BigInt : x.Type; }
        public override Column Eval(Batch b)
        {
            Column c = x.Eval(b); Column o = new Column(Type, b.Rows);
            for (int i = 0; i < b.Rows; i++) { if (c.IsNull(i)) { o.SetNull(i); continue; } if (o.I != null) o.I[i] = -c.I[i]; else o.F[i] = -c.F[i]; }
            return o;
        }
    }

    public sealed class BCmp : BExpr
    {
        public override void Refs(HashSet<int> s) { l.Refs(s); r.Refs(s); }

        string op; BExpr l, r; readonly bool distinct;
        public BCmp(string op, BExpr l, BExpr r)
        {
            Type = DataType.Bool;
            if (op == "IS DISTINCT FROM" || op == "IS NOT DISTINCT FROM") { distinct = true; }
            this.op = op;
            DataType t = Cast.Common(l.Type, r.Type);
            if (t.Kind == Kind.Int) t = DataType.BigInt;
            if (t.Kind == Kind.Decimal) t = DataType.Double;
            this.l = BCast.To(l, t); this.r = BCast.To(r, t);
            // Constant on the left: swap sides so the fast path (column vs constant) applies.
            if (this.l is BLit && !(this.r is BLit))
            {
                BExpr tmp = this.l; this.l = this.r; this.r = tmp;
                switch (op) { case "<": this.op = ">"; break; case ">": this.op = "<"; break; case "<=": this.op = ">="; break; case ">=": this.op = "<="; break; }
            }
        }
        public override bool IsConst { get { return l.IsConst && r.IsConst; } }
        // Column vs non-null constant: no constant column is built.
        Column EvalConst(Batch b, object v)
        {
            Column x = l.Eval(b); int n = b.Rows; Column o = new Column(DataType.Bool, n); bool[] d = o.B;
            int code = op == "=" || op == "IS NOT DISTINCT FROM" ? 0 : op == "<>" || op == "IS DISTINCT FROM" ? 1 : op == "<" ? 2 : op == ">" ? 3 : op == "<=" ? 4 : 5;
            bool nulls = x.Nulls != null || x.Type.Kind == Kind.Null;
            if (x.I != null && v is long)
            {
                long c = (long)v; long[] a = x.I;
                for (int i = 0; i < n; i++)
                {
                    long q = a[i];
                    d[i] = code == 0 ? q == c : code == 1 ? q != c : code == 2 ? q < c : code == 3 ? q > c : code == 4 ? q <= c : q >= c;
                }
            }
            else if (x.F != null && (v is double || v is long))
            {
                double c = Convert.ToDouble(v, CultureInfo.InvariantCulture); double[] a = x.F;
                for (int i = 0; i < n; i++)
                {
                    double q = a[i];
                    d[i] = code == 0 ? q == c : code == 1 ? q != c : code == 2 ? q < c : code == 3 ? q > c : code == 4 ? q <= c : q >= c;
                }
            }
            else if (x.IsLazyText && v is string)
            {
                byte[] k = Utf8Ops.Bytes((string)v), u = x.Utf8; int[] f = x.Offs;
                for (int i = 0; i < n; i++)
                {
                    if (x.IsNull(i)) continue;
                    int a = f[i], len = f[i + 1] - a;
                    if (code <= 1) { bool eq = Utf8Ops.Equal(u, a, len, k); d[i] = code == 0 ? eq : !eq; continue; }
                    int r0 = Utf8Ops.Compare(u, a, len, k);
                    d[i] = code == 2 ? r0 < 0 : code == 3 ? r0 > 0 : code == 4 ? r0 <= 0 : r0 >= 0;
                }
            }
            else if (x.S != null && v is string)
            {
                string c = (string)v; string[] a = x.S;
                for (int i = 0; i < n; i++)
                {
                    if (a[i] == null) continue;
                    int r0 = string.CompareOrdinal(a[i], c);
                    d[i] = code == 0 ? r0 == 0 : code == 1 ? r0 != 0 : code == 2 ? r0 < 0 : code == 3 ? r0 > 0 : code == 4 ? r0 <= 0 : r0 >= 0;
                }
            }
            else return null;
            if (nulls)
                for (int i = 0; i < n; i++)
                    if (x.Type.Kind == Kind.Null || x.IsNull(i)) { if (distinct) d[i] = op == "IS DISTINCT FROM"; else o.SetNull(i); }
            return o;
        }
        public override Column Eval(Batch b)
        {
            BLit lit = r as BLit;
            if (lit != null && lit.Value != null) { Column fast = EvalConst(b, lit.Value); if (fast != null) return fast; }
            Column x = l.Eval(b), y = r.Eval(b);
            int n = b.Rows; Column o = new Column(DataType.Bool, n);
            bool[] d = o.B;
            for (int i = 0; i < n; i++)
            {
                bool xn = x.IsNull(i) || x.Type.Kind == Kind.Null, yn = y.IsNull(i) || y.Type.Kind == Kind.Null;
                if (xn || yn)
                {
                    if (distinct) { bool same = xn && yn; d[i] = op == "IS DISTINCT FROM" ? !same : same; }
                    else o.SetNull(i);
                    continue;
                }
                int c = Compare(x, i, y, i);
                switch (op)
                {
                    case "=": case "IS NOT DISTINCT FROM": d[i] = c == 0; break;
                    case "<>": case "IS DISTINCT FROM": d[i] = c != 0; break;
                    case "<": d[i] = c < 0; break;
                    case ">": d[i] = c > 0; break;
                    case "<=": d[i] = c <= 0; break;
                    case ">=": d[i] = c >= 0; break;
                }
            }
            return o;
        }
        // Both columns non-null at these rows, same storage.
        public static int Compare(Column x, int i, Column y, int j)
        {
            if (x.I != null && y.I != null) return x.I[i].CompareTo(y.I[j]);
            if (x.F != null && y.F != null) return x.F[i].CompareTo(y.F[j]);
            if (x.IsLazyText && y.IsLazyText) return Utf8Ops.Compare(x.Utf8, x.Offs[i], x.Offs[i + 1] - x.Offs[i], y.Utf8, y.Offs[j], y.Offs[j + 1] - y.Offs[j]);
            if (x.S != null && y.S != null) return string.CompareOrdinal(x.S[i], y.S[j]);
            if (x.B != null && y.B != null) return x.B[i].CompareTo(y.B[j]);
            if (x.I != null && y.F != null) return ((double)x.I[i]).CompareTo(y.F[j]);
            if (x.F != null && y.I != null) return x.F[i].CompareTo((double)y.I[j]);
            return string.CompareOrdinal(Values.Text(x, i), Values.Text(y, j));
        }
    }

    public sealed class BLogic : BExpr
    {
        public override void Refs(HashSet<int> s) { l.Refs(s); r.Refs(s); }

        readonly bool and; readonly BExpr l, r;
        public BLogic(bool and, BExpr l, BExpr r) { this.and = and; this.l = BCast.To(l, DataType.Bool); this.r = BCast.To(r, DataType.Bool); Type = DataType.Bool; }
        public override Column Eval(Batch b)
        {
            Column x = l.Eval(b), y = r.Eval(b); int n = b.Rows; Column o = new Column(DataType.Bool, n);
            for (int i = 0; i < n; i++)
            {
                bool xn = x.IsNull(i), yn = y.IsNull(i);
                bool xv = !xn && x.B[i], yv = !yn && y.B[i];
                if (and)
                {
                    if ((!xn && !xv) || (!yn && !yv)) o.B[i] = false;
                    else if (xn || yn) o.SetNull(i);
                    else o.B[i] = true;
                }
                else
                {
                    if (xv || yv) o.B[i] = true;
                    else if (xn || yn) o.SetNull(i);
                    else o.B[i] = false;
                }
            }
            return o;
        }
    }

    public sealed class BNot : BExpr
    {
        public override void Refs(HashSet<int> s) { x.Refs(s); }

        readonly BExpr x;
        public BNot(BExpr x) { this.x = BCast.To(x, DataType.Bool); Type = DataType.Bool; }
        public override Column Eval(Batch b)
        {
            Column c = x.Eval(b); Column o = new Column(DataType.Bool, b.Rows);
            for (int i = 0; i < b.Rows; i++) { if (c.IsNull(i)) o.SetNull(i); else o.B[i] = !c.B[i]; }
            return o;
        }
    }

    public sealed class BIsNull : BExpr
    {
        public override void Refs(HashSet<int> s) { x.Refs(s); }

        readonly BExpr x; readonly bool not;
        public BIsNull(BExpr x, bool not) { this.x = x; this.not = not; Type = DataType.Bool; }
        public override Column Eval(Batch b)
        {
            Column c = x.Eval(b); Column o = new Column(DataType.Bool, b.Rows);
            bool allNull = c.Type.Kind == Kind.Null;
            for (int i = 0; i < b.Rows; i++) o.B[i] = (allNull || c.IsNull(i)) != not;
            return o;
        }
    }

    public sealed class BIn : BExpr
    {
        public override void Refs(HashSet<int> s) { x.Refs(s); RefsOf(items, s); }

        readonly BExpr x; readonly List<BExpr> items; readonly bool not;
        public BIn(BExpr x, List<BExpr> items, bool not)
        {
            DataType t = x.Type;
            foreach (BExpr e in items) t = Cast.Common(t, e.Type);
            if (t.Kind == Kind.Int) t = DataType.BigInt;
            if (t.Kind == Kind.Decimal) t = DataType.Double;
            this.x = BCast.To(x, t); this.items = new List<BExpr>();
            foreach (BExpr e in items) this.items.Add(BCast.To(e, t));
            this.not = not; Type = DataType.Bool;
        }
        public override Column Eval(Batch b)
        {
            Column c = x.Eval(b); int n = b.Rows; Column o = new Column(DataType.Bool, n);
            if (c.IsLazyText && items.TrueForAll(e => e is BLit && ((BLit)e).Value is string))
            {
                // Text as bytes vs text constants: compared on the bytes.
                byte[][] ks = items.Select(e => Utf8Ops.Bytes((string)((BLit)e).Value)).ToArray(); byte[] u = c.Utf8; int[] f = c.Offs;
                for (int i = 0; i < n; i++)
                {
                    if (c.IsNull(i)) { o.SetNull(i); continue; }
                    int a = f[i], len = f[i + 1] - a; bool found = false;
                    foreach (byte[] k in ks) if (Utf8Ops.Equal(u, a, len, k)) { found = true; break; }
                    o.B[i] = found != not;
                }
                return o;
            }
            List<Column> vs = new List<Column>();
            foreach (BExpr e in items) vs.Add(e.Eval(b));
            for (int i = 0; i < n; i++)
            {
                if (c.IsNull(i)) { o.SetNull(i); continue; }
                bool found = false, sawNull = false;
                foreach (Column v in vs)
                {
                    if (v.IsNull(i) || v.Type.Kind == Kind.Null) { sawNull = true; continue; }
                    if (BCmp.Compare(c, i, v, i) == 0) { found = true; break; }
                }
                if (found) o.B[i] = !not;
                else if (sawNull) o.SetNull(i);
                else o.B[i] = not;
            }
            return o;
        }
    }

    public sealed class BLike : BExpr
    {
        public override void Refs(HashSet<int> s) { x.Refs(s); pat.Refs(s); }

        readonly BExpr x, pat; readonly bool not, ci; Regex fixedRx; LikeMatch fast;
        public BLike(BExpr x, BExpr pat, bool not, bool ci)
        {
            this.x = BCast.To(x, DataType.Varchar); this.pat = BCast.To(pat, DataType.Varchar); this.not = not; this.ci = ci; Type = DataType.Bool;
            BLit l = this.pat as BLit;
            if (l != null && l.Value != null) { fast = LikeMatch.Of((string)l.Value, ci); if (fast == null) fixedRx = Make((string)l.Value, ci); }
        }
        public static Regex Make(string p, bool ci)
        {
            StringBuilder sb = new StringBuilder("^");
            foreach (char ch in p)
            {
                if (ch == '%') sb.Append(".*"); else if (ch == '_') sb.Append('.'); else sb.Append(Regex.Escape(ch.ToString()));
            }
            sb.Append(@"\z");   // the very end (a plain $ would also match before a trailing newline)
            return new Regex(sb.ToString(), RegexOptions.Singleline | RegexOptions.CultureInvariant | (ci ? RegexOptions.IgnoreCase : RegexOptions.None));
        }
        public override Column Eval(Batch b)
        {
            Column c = x.Eval(b); Column pc = fixedRx == null && fast == null ? pat.Eval(b) : null;
            Column o = new Column(DataType.Bool, b.Rows);
            if (fast != null && c.IsLazyText)
            {
                // Text as bytes: matched on the bytes (ILIKE: a non-ASCII value is decoded and matched as a string).
                byte[] u = c.Utf8; int[] f = c.Offs; LikeBytes lb = fast.Bytes;
                for (int i = 0; i < b.Rows; i++)
                {
                    if (c.IsNull(i)) { o.SetNull(i); continue; }
                    int a = f[i], len = f[i + 1] - a;
                    bool m = ci && !Utf8Ops.Ascii(u, a, len) ? fast.Match(Encoding.UTF8.GetString(u, a, len)) : lb.Match(u, a, len);
                    o.B[i] = m != not;
                }
                return o;
            }
            string[] s = c.S;
            for (int i = 0; i < b.Rows; i++)
            {
                if (c.IsNull(i) || (pc != null && pc.IsNull(i))) { o.SetNull(i); continue; }
                if (fast != null) { o.B[i] = fast.Match(s[i]) != not; continue; }
                Regex rx = fixedRx ?? Make(pc.S[i], ci);
                o.B[i] = rx.IsMatch(s[i]) != not;
            }
            return o;
        }
    }

    // LIKE / ILIKE patterns made of text and % only (no _): the pieces are found in order without a regex. ILIKE
    // compares characters the way the regex (IgnoreCase | CultureInvariant) does: each side lowered with the invariant
    // culture, so the answers are the same; ASCII letters take a fast path.
    public sealed class LikeMatch
    {
        readonly string[] segs; readonly bool start, end, ci; readonly int minLen;
        public readonly LikeBytes Bytes;   // the same pattern on UTF-8 bytes (Utf8Ops.cs)
        LikeMatch(string[] segs, bool start, bool end, bool ci) { this.segs = segs; this.start = start; this.end = end; this.ci = ci; foreach (string g in segs) minLen += g.Length; Bytes = new LikeBytes(segs, start, end, ci); }
        public static LikeMatch Of(string p, bool ci)
        {
            if (p.IndexOf('_') >= 0) return null;
            string[] parts = p.Split('%');
            List<string> segs = new List<string>();
            foreach (string g in parts) segs.Add(ci ? Lower(g) : g);
            return new LikeMatch(segs.ToArray(), !p.StartsWith("%"), !p.EndsWith("%") || p.Length == 0, ci);
        }
        static string Lower(string g) { char[] a = g.ToCharArray(); for (int i = 0; i < a.Length; i++) a[i] = Fold(a[i]); return new string(a); }
        static char Fold(char ch) { return ch < 128 ? (ch >= 'A' && ch <= 'Z' ? (char)(ch + 32) : ch) : char.ToLowerInvariant(ch); }
        bool At(string s, int at, string g)
        {
            if (!ci) return string.CompareOrdinal(s, at, g, 0, g.Length) == 0;
            for (int k = 0; k < g.Length; k++) if (Fold(s[at + k]) != g[k]) return false;
            return true;
        }
        int Find(string s, string g, int from, int limit)   // first index >= from where g fits entirely before limit, or -1
        {
            if (g.Length == 0) return from;
            if (!ci) { int r = s.IndexOf(g, from, limit - from, StringComparison.Ordinal); return r; }
            char g0 = g[0];
            for (int i = from; i + g.Length <= limit; i++) if (Fold(s[i]) == g0 && At(s, i, g)) return i;
            return -1;
        }
        public bool Match(string s)
        {
            if (s.Length < minLen) return false;
            int n = segs.Length;
            if (n == 1) return s.Length == segs[0].Length && At(s, 0, segs[0]);   // no %: whole text
            int pos = 0, limit = s.Length;
            if (start) { if (!At(s, 0, segs[0])) return false; pos = segs[0].Length; }
            if (end) { string last = segs[n - 1]; if (s.Length - last.Length < pos || !At(s, s.Length - last.Length, last)) return false; limit = s.Length - last.Length; }
            for (int k = start ? 1 : 0; k < (end ? n - 1 : n); k++)
            {
                int at = Find(s, segs[k], pos, limit);
                if (at < 0) return false;
                pos = at + segs[k].Length;
            }
            return true;
        }
    }

    public sealed class BCase : BExpr
    {
        public override void Refs(HashSet<int> s) { RefsOf(whens, s); RefsOf(thens, s); if (els != null) els.Refs(s); }

        readonly List<BExpr> whens = new List<BExpr>(), thens = new List<BExpr>(); readonly BExpr els;
        public BCase(BExpr operand, List<BExpr> ws, List<BExpr> ts, BExpr el)
        {
            DataType t = DataType.Null;
            foreach (BExpr e in ts) t = Cast.Common(t, e.Type);
            if (el != null) t = Cast.Common(t, el.Type);
            if (t.Kind == Kind.Null) t = DataType.Varchar;
            Type = t;
            for (int i = 0; i < ws.Count; i++)
            {
                whens.Add(operand != null ? new BCmp("=", operand, ws[i]) : BCast.To(ws[i], DataType.Bool));
                thens.Add(BCast.To(ts[i], t));
            }
            els = el != null ? BCast.To(el, t) : null;
        }
        public override Column Eval(Batch b)
        {
            int n = b.Rows; Column o = new Column(Type, n);
            bool[] done = new bool[n];
            for (int k = 0; k < whens.Count; k++)
            {
                Column w = whens[k].Eval(b), v = thens[k].Eval(b);
                for (int i = 0; i < n; i++)
                {
                    if (done[i] || w.IsNull(i) || !w.B[i]) continue;
                    done[i] = true; Copy(v, i, o, i);
                }
            }
            Column e = els != null ? els.Eval(b) : null;
            for (int i = 0; i < n; i++) if (!done[i]) { if (e == null) o.SetNull(i); else Copy(e, i, o, i); }
            return o;
        }
        public static void Copy(Column from, int i, Column to, int j)
        {
            if (from.IsNull(i) || from.Type.Kind == Kind.Null) { to.SetNull(j); return; }
            if (to.I != null) to.I[j] = from.I[i]; else if (to.F != null) to.F[j] = from.F[i]; else if (to.S != null) to.S[j] = from.S[i]; else if (to.B != null) to.B[j] = from.B[i];
        }
    }

    // (a, b): a composite value, used for count(DISTINCT (a, b)) and IN on tuples. Encoded as text.
    public sealed class BRow : BExpr
    {
        public override void Refs(HashSet<int> s) { RefsOf(items, s); }

        readonly List<BExpr> items;
        public BRow(List<BExpr> items) { this.items = items; Type = DataType.Varchar; }
        public override Column Eval(Batch b)
        {
            List<Column> cs = new List<Column>(); foreach (BExpr e in items) cs.Add(e.Eval(b));
            Column o = new Column(DataType.Varchar, b.Rows); StringBuilder sb = new StringBuilder();
            for (int i = 0; i < b.Rows; i++)
            {
                sb.Length = 0; sb.Append('(');
                for (int k = 0; k < cs.Count; k++)
                {
                    if (k > 0) sb.Append('\u0001');
                    string s = Values.Text(cs[k], i);
                    sb.Append(s == null ? "\u0002" : s);
                }
                o.S[i] = sb.Append(')').ToString();
            }
            return o;
        }
    }

    // Scalar function: impl gets the evaluated argument columns and the row count.
    public sealed class BFunc : BExpr
    {
        public override void Refs(HashSet<int> s) { RefsOf(args, s); }

        public readonly string Name; readonly List<BExpr> args; readonly Func<Column[], int, Column> impl; readonly bool constant;
        public BFunc(string name, DataType t, List<BExpr> args, Func<Column[], int, Column> impl, bool volatileFn)
        { Name = name; Type = t; this.args = args; this.impl = impl; bool c = !volatileFn; foreach (BExpr a in args) c &= a.IsConst; constant = c; }
        public override bool IsConst { get { return constant; } }
        public override Column Eval(Batch b)
        {
            Column[] cs = new Column[args.Count];
            for (int i = 0; i < cs.Length; i++) cs[i] = args[i].Eval(b);
            return impl(cs, b.Rows);
        }
    }
}
