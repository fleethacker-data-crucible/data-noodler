// Scalar functions: Oracle functions (BindOracle) and the engine's own names used by internal SQL. Aggregates and window functions live in Aggregates.cs / Window.cs.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace NativeDataEngine
{
    public static class Functions
    {
        public static readonly HashSet<string> Aggregates = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "count", "sum", "avg", "mean", "min", "max", "any_value", "first", "last", "arbitrary", "string_agg", "group_concat", "listagg",
            "stddev", "stddev_samp", "stddev_pop", "variance", "var_samp", "var_pop", "median", "quantile_cont", "quantile", "quantile_disc",
            "bool_and", "bool_or", "count_if", "countif", "approx_count_distinct", "product", "fsum", "sumkahan", "kahan_sum", "mode" };
        public static readonly HashSet<string> WindowOnly = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value" };

        static Column Map(Column[] a, int n, DataType t, Func<int, Column, bool> f)
        {
            Column o = new Column(t, n);
            bool text = t.Kind == Kind.String;
            for (int i = 0; i < n; i++)
            {
                bool anyNull = false;
                foreach (Column c in a) if (c.IsNull(i) || c.Type.Kind == Kind.Null) { anyNull = true; break; }
                if (anyNull || !f(i, o)) o.SetNull(i);
                else if (text && o.S[i] != null && o.S[i].Length == 0) o.SetNull(i);   // Oracle: '' is NULL
            }
            return o;
        }
        // Like Map, but NULL inputs reach f (Oracle REPLACE / CONCAT-style functions that treat NULL as '').
        static Column MapNulls(Column[] a, int n, DataType t, Func<int, Column, bool> f)
        {
            Column o = new Column(t, n);
            for (int i = 0; i < n; i++)
            {
                if (!f(i, o)) o.SetNull(i);
                else if (t.Kind == Kind.String && string.IsNullOrEmpty(o.S[i])) o.SetNull(i);
            }
            return o;
        }
        static string Str(Column c, int i) { return c.Type.Kind == Kind.Null || c.IsNull(i) ? null : c.S[i]; }
        static BExpr ConstStr(BExpr e) { return e; }
        static string LitText(BExpr e) { BLit l = e as BLit; return l != null && l.Value != null ? Convert.ToString(l.Value, CultureInfo.InvariantCulture) : null; }
        static bool IsTime(BExpr e) { return e.Type.Kind == Kind.Date || e.Type.Kind == Kind.Timestamp; }
        // A date-time value of row i as DateTime + its microseconds (Date -> midnight).
        static long MicrosOf(Column c, int i) { return c.Type.Kind == Kind.Date ? c.I[i] * 86400000000L : c.I[i]; }
        static void SetTime(Column o, int i, DateTime d, long fracMicros)
        {
            d = DateTime.SpecifyKind(d, DateTimeKind.Utc);
            if (o.Type.Kind == Kind.Date) o.I[i] = Values.Days(d); else o.I[i] = Values.Micros(d) + fracMicros;
        }
        static long NowMicros(bool wholeSeconds)
        {
            DateTime d = DateTime.Now; if (wholeSeconds) d = new DateTime(d.Year, d.Month, d.Day, d.Hour, d.Minute, d.Second);
            return Values.Micros(DateTime.SpecifyKind(d, DateTimeKind.Utc));
        }

        // Oracle functions (and Oracle meanings of shared names). Returns null when fn is not one of them.
        static BExpr BindOracle(string fn, List<BExpr> a)
        {
            switch (fn)
            {
                case "__cast_date": case "__try_cast_date":
                    Need("CAST", a, 1, 1);
                    if (a[0].Type.Kind == Kind.Timestamp || a[0].Type.Kind == Kind.Date) return a[0];   // Oracle DATE keeps the time
                    return new BCast(a[0], DataType.Date, fn == "__try_cast_date");
                case "sysdate": return new BLit(NowMicros(true), DataType.Timestamp);
                case "systimestamp": return new BLit(NowMicros(false), DataType.Timestamp);
                case "to_char":
                    {
                        Need("TO_CHAR", a, 1, 3);
                        BExpr x = a[0]; string fmtLit = a.Count > 1 ? LitText(a[1]) : null;
                        List<BExpr> xa = new List<BExpr> { x }; if (a.Count > 1) xa.Add(BCast.To(a[1], DataType.Varchar));
                        if (IsTime(x))
                            return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                            {
                                long us = MicrosOf(c[0], i); DateTime d = Values.TimeOf(us);
                                string f = c.Length > 1 ? c[1].S[i] : (c[0].Type.Kind == Kind.Date ? "YYYY-MM-DD" : "YYYY-MM-DD HH24:MI:SS");
                                o.S[i] = OraFormat.FormatDate(d, f, us); return true;
                            }));
                        if (x.Type.IsNumeric || x.Type.Kind == Kind.Null)
                        {
                            xa[0] = BCast.To(x, DataType.Double);
                            return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                            {
                                o.S[i] = c.Length > 1 ? OraFormat.FormatNumber(c[0].F[i], c[1].S[i]) : OraFormat.NumberText(c[0].F[i]); return true;
                            }));
                        }
                        if (x.Type.Kind == Kind.Bool) xa[0] = BCast.To(x, DataType.Varchar);
                        return F(fn, DataType.Varchar, new List<BExpr> { BCast.To(x, DataType.Varchar) }, (c, n) => Map(c, n, DataType.Varchar, (i, o) => { o.S[i] = c[0].S[i]; return true; }));
                    }
                case "to_date": case "to_timestamp": case "__try_to_date": case "__try_to_timestamp":
                    {
                        string name = fn.Replace("__try_", "").ToUpperInvariant(); bool tryMode = fn.StartsWith("__try_");
                        Need(name, a, 1, 3);
                        if (IsTime(a[0]) && a.Count == 1) return fn.EndsWith("timestamp") ? BCast.To(a[0], DataType.Timestamp) : a[0];
                        string fmtLit = a.Count > 1 ? LitText(a[1]) : null;
                        // TO_DATE with a format that has no time of day gives a plain date; otherwise a date-time.
                        DataType t = fn.EndsWith("timestamp") ? DataType.Timestamp
                            : a.Count > 1 && fmtLit != null && !OraFormat.HasTime(fmtLit) ? DataType.Date
                            : a.Count == 1 && LitText(a[0]) != null && LitText(a[0]).IndexOf(':') < 0 ? DataType.Date : DataType.Timestamp;
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar) }; if (a.Count > 1) xa.Add(BCast.To(a[1], DataType.Varchar));
                        return F(fn, t, xa, (c, n) => Map(c, n, t, (i, o) =>
                        {
                            string s = c[0].S[i].Trim(); long us;
                            bool ok = c.Length > 1 ? OraFormat.ParseDate(s, c[1].S[i], out us) : (Values.ParseTimestamp(s, out us));
                            if (!ok)
                            {
                                if (tryMode) return false;
                                throw new EngineException("CAST_FAILED", name + ": '" + s + "' does not match " + (c.Length > 1 ? "the format '" + c[1].S[i] + "'" : "a date") + ".");
                            }
                            if (t.Kind == Kind.Date) o.I[i] = (long)Math.Floor(us / 86400e6); else o.I[i] = us;
                            return true;
                        }));
                    }
                case "to_number": case "__try_to_number":
                    {
                        Need("TO_NUMBER", a, 1, 3); bool tryMode = fn.StartsWith("__try_");
                        if (a[0].Type.IsNumeric) return BCast.To(a[0], DataType.Double);
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar) }; if (a.Count > 1) xa.Add(BCast.To(a[1], DataType.Varchar));
                        return F(fn, DataType.Double, xa, (c, n) => Map(c, n, DataType.Double, (i, o) =>
                        {
                            double v;
                            if (OraFormat.ParseNumber(c[0].S[i], c.Length > 1 ? c[1].S[i] : null, out v)) { o.F[i] = v; return true; }
                            if (tryMode) return false;
                            throw new EngineException("CAST_FAILED", "TO_NUMBER: '" + c[0].S[i] + "' is not a number.");
                        }));
                    }
                case "add_months":
                    {
                        Need("ADD_MONTHS", a, 2, 2);
                        BExpr d = IsTime(a[0]) ? a[0] : BCast.To(a[0], DataType.Timestamp); DataType t = d.Type;
                        List<BExpr> xa = new List<BExpr> { d, BCast.To(a[1], DataType.Double) };
                        return F(fn, t, xa, (c, n) => Map(c, n, t, (i, o) =>
                        {
                            long us = MicrosOf(c[0], i); DateTime x = Values.TimeOf(us); int m = (int)Math.Truncate(c[1].F[i]);
                            DateTime r = x.AddMonths(m);
                            // Oracle: from the last day of a month, the result is the last day of the target month
                            if (x.Day == DateTime.DaysInMonth(x.Year, x.Month)) r = new DateTime(r.Year, r.Month, DateTime.DaysInMonth(r.Year, r.Month), x.Hour, x.Minute, x.Second);
                            SetTime(o, i, r, ((us % 1000000) + 1000000) % 1000000); return true;
                        }));
                    }
                case "months_between":
                    {
                        Need("MONTHS_BETWEEN", a, 2, 2);
                        List<BExpr> xa = new List<BExpr> { IsTime(a[0]) ? a[0] : BCast.To(a[0], DataType.Timestamp), IsTime(a[1]) ? a[1] : BCast.To(a[1], DataType.Timestamp) };
                        return F(fn, DataType.Double, xa, (c, n) => Map(c, n, DataType.Double, (i, o) =>
                        {
                            DateTime x = Values.TimeOf(MicrosOf(c[0], i)), y = Values.TimeOf(MicrosOf(c[1], i));
                            int months = (x.Year - y.Year) * 12 + (x.Month - y.Month);
                            bool xl = x.Day == DateTime.DaysInMonth(x.Year, x.Month), yl = y.Day == DateTime.DaysInMonth(y.Year, y.Month);
                            if (x.Day == y.Day || (xl && yl)) { o.F[i] = months; return true; }
                            double dx = x.Day + x.TimeOfDay.TotalDays, dy = y.Day + y.TimeOfDay.TotalDays;
                            o.F[i] = months + (dx - dy) / 31.0; return true;
                        }));
                    }
                case "next_day":
                    {
                        Need("NEXT_DAY", a, 2, 2);
                        BExpr d = IsTime(a[0]) ? a[0] : BCast.To(a[0], DataType.Timestamp); DataType t = d.Type;
                        List<BExpr> xa = new List<BExpr> { d, BCast.To(a[1], DataType.Varchar) };
                        return F(fn, t, xa, (c, n) => Map(c, n, t, (i, o) =>
                        {
                            long us = MicrosOf(c[0], i); DateTime x = Values.TimeOf(us); string w = c[1].S[i].Trim();
                            int want = -1;
                            for (int k = 0; k < 7; k++)
                            {
                                string dn = CultureInfo.InvariantCulture.DateTimeFormat.DayNames[k];
                                if (string.Equals(dn, w, StringComparison.OrdinalIgnoreCase) || (w.Length >= 2 && dn.StartsWith(w, StringComparison.OrdinalIgnoreCase))) { want = k; break; }
                            }
                            if (want < 0) throw new EngineException("FUNCTION_ARGS", "NEXT_DAY: '" + w + "' is not a day name.");
                            int add = (want - (int)x.DayOfWeek + 7) % 7; if (add == 0) add = 7;
                            SetTime(o, i, x.AddDays(add), ((us % 1000000) + 1000000) % 1000000); return true;
                        }));
                    }
                case "last_day":
                    {
                        Need("LAST_DAY", a, 1, 1);
                        BExpr d = IsTime(a[0]) ? a[0] : BCast.To(a[0], DataType.Timestamp); DataType t = d.Type;
                        return F(fn, t, new List<BExpr> { d }, (c, n) => Map(c, n, t, (i, o) =>
                        {
                            long us = MicrosOf(c[0], i); DateTime x = Values.TimeOf(us);
                            SetTime(o, i, new DateTime(x.Year, x.Month, DateTime.DaysInMonth(x.Year, x.Month), x.Hour, x.Minute, x.Second), ((us % 1000000) + 1000000) % 1000000); return true;
                        }));
                    }
                case "trunc": case "round":
                    {
                        if (!IsTime(a[0]))
                        {
                            if (fn == "round" || a.Count < 2) return null;   // numbers: below
                            // TRUNC(n, digits)
                            Need("TRUNC", a, 2, 2); List<BExpr> ta = new List<BExpr> { BCast.To(a[0], DataType.Double), BCast.To(a[1], DataType.BigInt) };
                            return F(fn, DataType.Double, ta, (c, n) => Map(c, n, DataType.Double, (i, o) => { double p10 = Math.Pow(10, c[1].I[i]); o.F[i] = Math.Truncate(c[0].F[i] * p10) / p10; return true; }));
                        }
                        Need(fn.ToUpperInvariant(), a, 1, 2);
                        string f = a.Count > 1 ? LitText(a[1]) : "DD";
                        if (f == null) throw new EngineException("FUNCTION_ARGS", fn.ToUpperInvariant() + "(date, format) needs a constant format, e.g. 'MM'.");
                        bool round = fn == "round", day;
                        OraFormat.TruncDate(new DateTime(2000, 1, 1), f, false, out day);   // validates the format, tells the result type
                        DataType t = day ? DataType.Date : DataType.Timestamp;
                        return F(fn, t, new List<BExpr> { a[0] }, (c, n) => Map(c, n, t, (i, o) =>
                        {
                            bool dd; DateTime r = OraFormat.TruncDate(Values.TimeOf(MicrosOf(c[0], i)), f, round, out dd);
                            SetTime(o, i, r, 0); return true;
                        }));
                    }
                case "initcap":
                    {
                        Need("INITCAP", a, 1, 1);
                        return F(fn, DataType.Varchar, As(a, DataType.Varchar), (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                        {
                            char[] ch = c[0].S[i].ToCharArray(); bool start = true;
                            for (int k = 0; k < ch.Length; k++) { if (char.IsLetterOrDigit(ch[k])) { ch[k] = start ? char.ToUpperInvariant(ch[k]) : char.ToLowerInvariant(ch[k]); start = false; } else start = true; }
                            o.S[i] = new string(ch); return true;
                        }));
                    }
                case "translate":
                    {
                        Need("TRANSLATE", a, 3, 3);
                        return F(fn, DataType.Varchar, As(a, DataType.Varchar), (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                        {
                            string s = c[0].S[i], from = c[1].S[i], to = c[2].S[i]; StringBuilder sb = new StringBuilder(s.Length);
                            foreach (char ch in s) { int k = from.IndexOf(ch); if (k < 0) sb.Append(ch); else if (k < to.Length) sb.Append(to[k]); }
                            o.S[i] = sb.ToString(); return true;
                        }));
                    }
                case "chr":
                    Need("CHR", a, 1, 1);
                    return F(fn, DataType.Varchar, As(a, DataType.BigInt), (c, n) => Map(c, n, DataType.Varchar, (i, o) => { long v = c[0].I[i]; if (v < 0 || v > 0x10FFFF) return false; o.S[i] = char.ConvertFromUtf32((int)v); return true; }));
                case "ascii":
                    Need("ASCII", a, 1, 1);
                    return F(fn, DataType.BigInt, As(a, DataType.Varchar), (c, n) => Map(c, n, DataType.BigInt, (i, o) => { string s = c[0].S[i]; if (s.Length == 0) return false; o.I[i] = char.ConvertToUtf32(s, 0); return true; }));
                case "soundex":
                    Need("SOUNDEX", a, 1, 1);
                    return F(fn, DataType.Varchar, As(a, DataType.Varchar), (c, n) => Map(c, n, DataType.Varchar, (i, o) => { o.S[i] = Soundex(c[0].S[i]); return true; }));
                case "instr":
                    {
                        // INSTR(text, find [, position [, occurrence]]): negative position searches backwards from the end
                        Need("INSTR", a, 2, 4);
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar), BCast.To(a[1], DataType.Varchar) };
                        for (int k = 2; k < a.Count; k++) xa.Add(BCast.To(a[k], DataType.BigInt));
                        return F(fn, DataType.BigInt, xa, (c, n) => Map(c, n, DataType.BigInt, (i, o) =>
                        {
                            string s = c[0].S[i], f = c[1].S[i]; long pos = c.Length > 2 ? c[2].I[i] : 1, occ = c.Length > 3 ? c[3].I[i] : 1;
                            if (pos == 0 || occ < 1) { o.I[i] = 0; return true; }
                            int found = 0, at = -1;
                            if (pos > 0)
                            {
                                int from = (int)Math.Min(pos - 1, s.Length);
                                while (found < occ) { at = s.IndexOf(f, from, StringComparison.Ordinal); if (at < 0) break; found++; from = at + 1; }
                            }
                            else
                            {
                                int from = s.Length + (int)pos;   // start index of the last possible match
                                while (found < occ && from >= 0) { at = from + f.Length <= s.Length ? s.LastIndexOf(f, Math.Min(s.Length - 1, from + f.Length - 1), StringComparison.Ordinal) : -1; if (at < 0 || at > from) { at = -1; break; } found++; from = at - 1; }
                            }
                            o.I[i] = found == occ && at >= 0 ? at + 1 : 0; return true;
                        }));
                    }
                case "replace":
                    {
                        // REPLACE(text, find [, with]): NULL / '' find = text unchanged, no 'with' = remove
                        Need("REPLACE", a, 2, 3);
                        List<BExpr> xa = As(a, DataType.Varchar);
                        return F(fn, DataType.Varchar, xa, (c, n) => MapNulls(c, n, DataType.Varchar, (i, o) =>
                        {
                            string s = Str(c[0], i), f = Str(c[1], i), w = c.Length > 2 ? Str(c[2], i) : null;
                            if (s == null) return false;
                            o.S[i] = string.IsNullOrEmpty(f) ? s : s.Replace(f, w ?? ""); return true;
                        }));
                    }
                case "concat":
                    {
                        Need("CONCAT", a, 2, 2);
                        return F(fn, DataType.Varchar, As(a, DataType.Varchar), (c, n) => MapNulls(c, n, DataType.Varchar, (i, o) => { o.S[i] = (Str(c[0], i) ?? "") + (Str(c[1], i) ?? ""); return true; }));
                    }
                case "substr":
                    {
                        // SUBSTR(text, start [, length]): start 0 = 1, negative = from the end; length < 1 = NULL
                        Need("SUBSTR", a, 2, 3);
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar), BCast.To(a[1], DataType.Double) };
                        if (a.Count > 2) xa.Add(BCast.To(a[2], DataType.Double));
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                        {
                            string s = c[0].S[i]; long st = (long)Math.Truncate(c[1].F[i]); long len = c.Length > 2 ? (long)Math.Truncate(c[2].F[i]) : long.MaxValue / 4;
                            if (len < 1) return false;
                            if (st == 0) st = 1;
                            if (st < 0) { st = s.Length + st + 1; if (st < 1) return false; }
                            if (st > s.Length) return false;
                            long to = Math.Min((long)s.Length + 1, st + len);
                            o.S[i] = s.Substring((int)st - 1, (int)(to - st)); return true;
                        }));
                    }
                case "lpad": case "rpad":
                    {
                        // LPAD(text, width [, pad]): pad defaults to a space; text longer than width is cut
                        Need(fn.ToUpperInvariant(), a, 2, 3);
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar), BCast.To(a[1], DataType.Double), a.Count > 2 ? BCast.To(a[2], DataType.Varchar) : new BLit(" ", DataType.Varchar) };
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                        {
                            string s = c[0].S[i], pad = c[2].S[i]; int w = (int)Math.Max(0, Math.Min(100000, Math.Truncate(c[1].F[i])));
                            if (w == 0) return false;
                            if (s.Length >= w) { o.S[i] = s.Substring(0, w); return true; }
                            StringBuilder sb = new StringBuilder(); while (sb.Length < w - s.Length) sb.Append(pad);
                            string fill = sb.ToString().Substring(0, w - s.Length);
                            o.S[i] = fn == "lpad" ? fill + s : s + fill; return true;
                        }));
                    }
                case "mod": case "remainder":
                    {
                        // MOD(a, b): a - b * TRUNC(a / b), MOD(a, 0) = a. REMAINDER: a - b * ROUND(a / b).
                        Need(fn.ToUpperInvariant(), a, 2, 2);
                        if (fn == "mod" && a[0].Type.Kind == Kind.Int && a[1].Type.Kind == Kind.Int)
                            return F(fn, DataType.BigInt, As(a, DataType.BigInt), (c, n) => Map(c, n, DataType.BigInt, (i, o) => { long y = c[1].I[i]; o.I[i] = y == 0 ? c[0].I[i] : c[0].I[i] % y; return true; }));
                        return F(fn, DataType.Double, As(a, DataType.Double), (c, n) => Map(c, n, DataType.Double, (i, o) =>
                        {
                            double x = c[0].F[i], y = c[1].F[i];
                            if (y == 0) { if (fn == "mod") { o.F[i] = x; return true; } return false; }
                            o.F[i] = fn == "mod" ? x - y * Math.Truncate(x / y) : x - y * Math.Round(x / y, MidpointRounding.ToEven); return true;
                        }));
                    }
                case "bitand":
                    Need("BITAND", a, 2, 2);
                    return F(fn, DataType.BigInt, As(a, DataType.BigInt), (c, n) => Map(c, n, DataType.BigInt, (i, o) => { o.I[i] = c[0].I[i] & c[1].I[i]; return true; }));
                case "sinh": case "cosh": case "tanh":
                    Need(fn.ToUpperInvariant(), a, 1, 1);
                    return F(fn, DataType.Double, As(a, DataType.Double), (c, n) => Map(c, n, DataType.Double, (i, o) => { double v = c[0].F[i]; o.F[i] = fn == "sinh" ? Math.Sinh(v) : fn == "cosh" ? Math.Cosh(v) : Math.Tanh(v); return true; }));
                case "greatest": case "least":
                    {
                        // Oracle: NULL when any argument is NULL
                        if (a.Count < 1) Need(fn.ToUpperInvariant(), a, 1, 99);
                        DataType t = DataType.Null; foreach (BExpr e in a) t = Cast.Common(t, e.Type);
                        if (t.Kind == Kind.Int) t = DataType.BigInt;
                        List<BExpr> xa = As(a, t); bool g = fn == "greatest";
                        return F(fn, t, xa, (c, n) =>
                        {
                            Column o = new Column(t, n);
                            for (int i = 0; i < n; i++)
                            {
                                int best = -1; bool nul = false;
                                for (int k = 0; k < c.Length && !nul; k++)
                                {
                                    if (c[k].IsNull(i) || c[k].Type.Kind == Kind.Null) { nul = true; break; }
                                    if (best < 0) { best = k; continue; }
                                    int cmp = BCmp.Compare(c[k], i, c[best], i);
                                    if (g ? cmp > 0 : cmp < 0) best = k;
                                }
                                if (nul || best < 0) o.SetNull(i); else BCase.Copy(c[best], i, o, i);
                            }
                            return o;
                        });
                    }
                case "regexp_like":
                    {
                        Need("REGEXP_LIKE", a, 2, 3);
                        return F(fn, DataType.Bool, As(a, DataType.Varchar), (c, n) => Map(c, n, DataType.Bool, (i, o) => { o.B[i] = OraFormat.Rx(c[1].S[i], c.Length > 2 ? c[2].S[i] : null).IsMatch(c[0].S[i]); return true; }));
                    }
                case "regexp_substr": case "regexp_instr": case "regexp_count": case "regexp_replace":
                    return BindRegexp(fn, a);
            }
            return null;
        }
        // REGEXP_SUBSTR(s, p [, pos [, occ [, flags [, group]]]]), REGEXP_INSTR(s, p [, pos [, occ [, retopt [, flags [, group]]]]]),
        // REGEXP_COUNT(s, p [, pos [, flags]]), REGEXP_REPLACE(s, p [, with [, pos [, occ [, flags]]]]) (occ 0 = all, the default).
        static BExpr BindRegexp(string fn, List<BExpr> a)
        {
            int max = fn == "regexp_substr" ? 6 : fn == "regexp_instr" ? 7 : fn == "regexp_count" ? 4 : 6;
            Need(fn.ToUpperInvariant(), a, 2, max);
            // argument roles
            int posI = fn == "regexp_replace" ? 3 : 2, occI = fn == "regexp_replace" ? 4 : fn == "regexp_count" ? -1 : 3;
            int flagI = fn == "regexp_substr" ? 4 : fn == "regexp_instr" ? 5 : fn == "regexp_count" ? 3 : 5;
            int groupI = fn == "regexp_substr" ? 5 : fn == "regexp_instr" ? 6 : -1, retI = fn == "regexp_instr" ? 4 : -1;
            List<BExpr> xa = new List<BExpr>();
            for (int k = 0; k < a.Count; k++)
            {
                bool num = k == posI || k == occI || k == groupI || k == retI;
                xa.Add(BCast.To(a[k], num ? DataType.BigInt : DataType.Varchar));
            }
            bool replace = fn == "regexp_replace";
            DataType t = fn == "regexp_substr" || replace ? DataType.Varchar : DataType.BigInt;
            return F(fn, t, xa, (c, n) => (replace ? (Func<Column[], int, DataType, Func<int, Column, bool>, Column>)MapNulls : MapSkipNullOptional)(c, n, t, (i, o) =>
            {
                string s = Str(c[0], i), pat = Str(c[1], i);
                if (s == null) return false;
                Func<int, long, long> arg = (k, d) => k >= 0 && k < c.Length && !c[k].IsNull(i) && c[k].Type.Kind != Kind.Null ? c[k].I[i] : d;
                string flags = flagI < c.Length ? Str(c[flagI], i) : null;
                int pos = (int)Math.Max(1, arg(posI, 1)) - 1;
                if (replace)
                {
                    if (pat == null) { o.S[i] = s; return true; }
                    if (pos > s.Length) { o.S[i] = s; return true; }
                    Regex rx = OraFormat.Rx(pat, flags); string with = OraFormat.Replacement(c.Length > 2 ? Str(c[2], i) : null);
                    long occ = arg(occI, 0);
                    string head = s.Substring(0, pos), tail = s.Substring(pos);
                    if (occ == 0) { o.S[i] = head + rx.Replace(tail, with); return true; }
                    int seen = 0;
                    o.S[i] = head + rx.Replace(tail, m => ++seen == occ ? m.Result(with) : m.Value);
                    return true;
                }
                if (pat == null) return false;
                Regex r = OraFormat.Rx(pat, flags);
                if (pos > s.Length) { if (fn == "regexp_substr") return false; o.I[i] = 0; return true; }
                if (fn == "regexp_count") { o.I[i] = r.Matches(s.Substring(pos)).Count; return true; }
                long want = Math.Max(1, arg(occI, 1)); Match m2 = r.Match(s, pos); long k2 = 1;
                while (m2.Success && k2 < want) { m2 = m2.NextMatch(); k2++; }
                int grp = (int)arg(groupI, 0);
                if (fn == "regexp_substr")
                {
                    if (!m2.Success) return false;
                    Group gr = m2.Groups[Math.Min(grp, m2.Groups.Count - 1)];
                    if (gr.Length == 0) return false;
                    o.S[i] = gr.Value; return true;
                }
                if (!m2.Success) { o.I[i] = 0; return true; }
                Group g2 = m2.Groups[Math.Min(grp, m2.Groups.Count - 1)];
                o.I[i] = arg(retI, 0) == 1 ? g2.Index + g2.Length + 1 : g2.Index + 1; return true;
            }));
        }
        // NULL text / pattern -> NULL; NULL optional numbers / flags use their defaults.
        static Column MapSkipNullOptional(Column[] a, int n, DataType t, Func<int, Column, bool> f)
        {
            Column o = new Column(t, n);
            for (int i = 0; i < n; i++)
            {
                if (a[0].IsNull(i) || a[0].Type.Kind == Kind.Null || a[1].IsNull(i) || a[1].Type.Kind == Kind.Null || !f(i, o)) o.SetNull(i);
                else if (t.Kind == Kind.String && string.IsNullOrEmpty(o.S[i])) o.SetNull(i);
            }
            return o;
        }
        static string Soundex(string s)
        {
            const string codes = "01230120022455012623010202";   // A..Z
            StringBuilder sb = new StringBuilder(); char last = '\0';
            foreach (char ch0 in s)
            {
                char ch = char.ToUpperInvariant(ch0);
                if (ch < 'A' || ch > 'Z') continue;
                char code = codes[ch - 'A'];
                if (sb.Length == 0) { sb.Append(ch); last = code; continue; }
                if (code != '0' && code != last) sb.Append(code);
                if (ch != 'H' && ch != 'W') last = code;
                if (sb.Length == 4) break;
            }
            if (sb.Length == 0) return "";
            return sb.ToString().PadRight(4, '0');
        }
        static BExpr F(string name, DataType t, List<BExpr> args, Func<Column[], int, Column> impl) { return new BFunc(name, t, args, impl, false); }
        static void Need(string name, List<BExpr> a, int min, int max)
        {
            if (a.Count < min || a.Count > max)
                throw new EngineException("FUNCTION_ARGS", name + "() takes " + (min == max ? min.ToString() : min + " to " + max) + " argument(s), got " + a.Count + ".");
        }
        static List<BExpr> As(List<BExpr> a, DataType t) { List<BExpr> r = new List<BExpr>(); foreach (BExpr e in a) r.Add(BCast.To(e, t)); return r; }
        static string LitStr(BExpr e, string fn)
        {
            BLit l = e as BLit;
            if (l == null || l.Value == null) throw new EngineException("FUNCTION_ARGS", fn + "() needs a constant text argument.");
            return Convert.ToString(l.Value, CultureInfo.InvariantCulture).ToLowerInvariant();
        }
        static DateTime Dt(Column c, int i) { return c.Type.Kind == Kind.Date ? Values.DateOf(c.I[i]) : Values.TimeOf(c.I[i]); }
        static BExpr AsTime(BExpr e) { return e.Type.Kind == Kind.Date || e.Type.Kind == Kind.Timestamp ? e : BCast.To(e, DataType.Timestamp); }

        // Error text for ERROR_MESSAGE() while a script runs a CATCH block (Script.cs), per thread.
        [ThreadStatic] public static string CatchError;
        [ThreadStatic] public static long CatchErrorNumber;   // SQLCODE

        public static BExpr Bind(string name, List<BExpr> a)
        {
            string fn = name.ToLowerInvariant();
            BExpr ora = BindOracle(fn, a);
            if (ora != null) return ora;
            switch (fn)
            {
                case "__one_row":   // scalar subquery value: (row count, value); more than one row is an error
                    {
                        Need(fn, a, 2, 2);
                        DataType t = a[1].Type;
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.BigInt), a[1] };
                        return new BFunc(fn, t, xa, (c, n) =>
                        {
                            Column o = new Column(t.Kind == Kind.Null ? DataType.Null : t, n);
                            for (int i = 0; i < n; i++)
                            {
                                if (!c[0].IsNull(i) && c[0].I[i] > 1) throw new EngineException("SUBQUERY_MULTIPLE_ROWS", "A subquery used as a single value returned more than one row.");
                                BCase.Copy(c[1], i, o, i);
                            }
                            return o;
                        }, true);
                    }
                case "error_message": Need(fn, a, 0, 0); return CatchError == null ? new BLit(null, DataType.Varchar) : new BLit(CatchError, DataType.Varchar);
                case "error_number": Need(fn, a, 0, 0); return CatchError == null ? new BLit(null, DataType.BigInt) : new BLit(CatchErrorNumber, DataType.BigInt);
                case "error_severity": Need(fn, a, 0, 0); return CatchError == null ? new BLit(null, DataType.BigInt) : new BLit(16L, DataType.BigInt);
                case "error_state": Need(fn, a, 0, 0); return CatchError == null ? new BLit(null, DataType.BigInt) : new BLit(1L, DataType.BigInt);
                // ---- numbers ----
                case "abs":
                    {
                        Need(fn, a, 1, 1); BExpr x = a[0].Type.Kind == Kind.Int ? BCast.To(a[0], DataType.BigInt) : BCast.To(a[0], DataType.Double);
                        List<BExpr> xa = new List<BExpr> { x };
                        if (x.Type.Kind == Kind.Int) return F(fn, DataType.BigInt, xa, (c, n) => Map(c, n, DataType.BigInt, (i, o) => { o.I[i] = Math.Abs(c[0].I[i]); return true; }));
                        return F(fn, DataType.Double, xa, (c, n) => Map(c, n, DataType.Double, (i, o) => { o.F[i] = Math.Abs(c[0].F[i]); return true; }));
                    }
                case "round": case "round_even":
                    {
                        Need(fn, a, 1, 2); List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Double), a.Count > 1 ? BCast.To(a[1], DataType.BigInt) : new BLit(0L, DataType.BigInt) };
                        bool even = fn == "round_even";
                        return F(fn, DataType.Double, xa, (c, n) => Map(c, n, DataType.Double, (i, o) =>
                        {
                            int d = (int)c[1].I[i];
                            if (d >= 0) o.F[i] = Math.Round(c[0].F[i], Math.Min(15, d), even ? MidpointRounding.ToEven : MidpointRounding.AwayFromZero);
                            else { double p = Math.Pow(10, -d); o.F[i] = Math.Round(c[0].F[i] / p, even ? MidpointRounding.ToEven : MidpointRounding.AwayFromZero) * p; }
                            return true;
                        }));
                    }
                case "floor": case "ceil": case "ceiling": case "trunc": case "sqrt": case "ln": case "log": case "log10": case "log2": case "exp": case "sign":
                case "sin": case "cos": case "tan": case "asin": case "acos": case "atan": case "degrees": case "radians": case "cbrt": case "even":
                    {
                        if (fn == "log" && a.Count == 2)
                        {
                            List<BExpr> la = As(a, DataType.Double);
                            return F(fn, DataType.Double, la, (c, n) => Map(c, n, DataType.Double, (i, o) => { o.F[i] = Math.Log(c[1].F[i], c[0].F[i]); return true; }));
                        }
                        Need(fn, a, 1, 1); List<BExpr> xa = As(a, DataType.Double);
                        Func<double, double> m;
                        switch (fn)
                        {
                            case "floor": m = Math.Floor; break;
                            case "ceil": case "ceiling": m = Math.Ceiling; break;
                            case "trunc": m = Math.Truncate; break;
                            case "sqrt": m = Math.Sqrt; break;
                            case "ln": m = Math.Log; break;
                            case "log": case "log10": m = Math.Log10; break;
                            case "log2": m = v => Math.Log(v, 2); break;
                            case "exp": m = Math.Exp; break;
                            case "sign": m = v => Math.Sign(v); break;
                            case "sin": m = Math.Sin; break;
                            case "cos": m = Math.Cos; break;
                            case "tan": m = Math.Tan; break;
                            case "asin": m = Math.Asin; break;
                            case "acos": m = Math.Acos; break;
                            case "atan": m = Math.Atan; break;
                            case "degrees": m = v => v * 180 / Math.PI; break;
                            case "radians": m = v => v * Math.PI / 180; break;
                            case "cbrt": m = v => Math.Sign(v) * Math.Pow(Math.Abs(v), 1.0 / 3); break;
                            default: m = v => Math.Ceiling(Math.Abs(v) / 2) * 2 * Math.Sign(v); break;
                        }
                        bool intOut = (fn == "floor" || fn == "ceil" || fn == "ceiling" || fn == "trunc" || fn == "sign") && a[0].Type.Kind == Kind.Int;
                        if (intOut) return BCast.To(a[0], DataType.BigInt);
                        return F(fn, DataType.Double, xa, (c, n) => Map(c, n, DataType.Double, (i, o) => { o.F[i] = m(c[0].F[i]); return !double.IsNaN(o.F[i]); }));
                    }
                case "pow": case "power": case "atan2": case "mod": case "fmod":
                    {
                        Need(fn, a, 2, 2); List<BExpr> xa = As(a, DataType.Double);
                        return F(fn, DataType.Double, xa, (c, n) => Map(c, n, DataType.Double, (i, o) =>
                        {
                            double x = c[0].F[i], y = c[1].F[i];
                            if (fn == "atan2") o.F[i] = Math.Atan2(x, y);
                            else if (fn == "mod" || fn == "fmod") { if (y == 0) return false; o.F[i] = x % y; }
                            else o.F[i] = Math.Pow(x, y);
                            return true;
                        }));
                    }
                case "pi": return new BLit(Math.PI, DataType.Double);
                case "random":
                    {
                        Random rnd = new Random();
                        return new BFunc(fn, DataType.Double, new List<BExpr>(), (c, n) => { Column o = new Column(DataType.Double, n); lock (rnd) for (int i = 0; i < n; i++) o.F[i] = rnd.NextDouble(); return o; }, true);
                    }
                case "greatest": case "least":
                    {
                        if (a.Count < 1) Need(fn, a, 1, 99);
                        DataType t = DataType.Null; foreach (BExpr e in a) t = Cast.Common(t, e.Type);
                        if (t.Kind == Kind.Int) t = DataType.BigInt;
                        List<BExpr> xa = As(a, t); bool g = fn == "greatest";
                        return F(fn, t, xa, (c, n) =>
                        {
                            Column o = new Column(t, n);
                            for (int i = 0; i < n; i++)
                            {
                                int best = -1;
                                for (int k = 0; k < c.Length; k++)
                                {
                                    if (c[k].IsNull(i) || c[k].Type.Kind == Kind.Null) continue;
                                    if (best < 0) { best = k; continue; }
                                    int cmp = BCmp.Compare(c[k], i, c[best], i);
                                    if (g ? cmp > 0 : cmp < 0) best = k;
                                }
                                if (best < 0) o.SetNull(i); else BCase.Copy(c[best], i, o, i);
                            }
                            return o;
                        });
                    }
                case "hash":
                    {
                        if (a.Count < 1) Need(fn, a, 1, 99);
                        return F(fn, DataType.BigInt, a, (c, n) =>
                        {
                            Column o = new Column(DataType.BigInt, n);
                            for (int i = 0; i < n; i++)
                            {
                                ulong h = 14695981039346656037UL;
                                foreach (Column col in c) h = Mix(h, HashCell(col, i));
                                o.I[i] = (long)(h & 0x7FFFFFFFFFFFFFFFUL);
                            }
                            return o;
                        });
                    }
                // ---- text ----
                case "lower": case "lcase": case "upper": case "ucase": case "trim": case "ltrim": case "rtrim": case "reverse": case "md5_text":
                    {
                        if (a.Count == 2 && (fn == "trim" || fn == "ltrim" || fn == "rtrim"))
                        {
                            List<BExpr> ta = As(a, DataType.Varchar);
                            return F(fn, DataType.Varchar, ta, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                            {
                                char[] cs = c[1].S[i].ToCharArray();
                                o.S[i] = fn == "trim" ? c[0].S[i].Trim(cs) : fn == "ltrim" ? c[0].S[i].TrimStart(cs) : c[0].S[i].TrimEnd(cs); return true;
                            }));
                        }
                        Need(fn, a, 1, 1); List<BExpr> xa = As(a, DataType.Varchar);
                        Func<string, string> m;
                        switch (fn)
                        {
                            case "lower": case "lcase": m = s => s.ToLowerInvariant(); break;
                            case "upper": case "ucase": m = s => s.ToUpperInvariant(); break;
                            case "trim": m = s => s.Trim(); break;
                            case "ltrim": m = s => s.TrimStart(); break;
                            case "rtrim": m = s => s.TrimEnd(); break;
                            default: m = s => { char[] ch = s.ToCharArray(); Array.Reverse(ch); return new string(ch); }; break;
                        }
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) => { o.S[i] = m(c[0].S[i]); return true; }));
                    }
                case "length": case "len": case "char_length": case "character_length": case "strlen":
                    {
                        Need(fn, a, 1, 1); List<BExpr> xa = As(a, DataType.Varchar);
                        bool bytes = fn == "strlen";
                        return F(fn, DataType.BigInt, xa, (c, n) => Map(c, n, DataType.BigInt, (i, o) =>
                        {
                            Column x = c[0];
                            if (x.IsLazyText) { int s0 = x.Offs[i], len = x.Offs[i + 1] - s0; o.I[i] = bytes ? len : Utf8Ops.Utf16Length(x.Utf8, s0, len); return true; }   // counted on the bytes
                            o.I[i] = bytes ? Encoding.UTF8.GetByteCount(x.S[i]) : x.S[i].Length; return true;
                        }));
                    }
                case "substr": case "substring":
                    {
                        Need(fn, a, 2, 3);
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar), BCast.To(a[1], DataType.BigInt) };
                        if (a.Count > 2) xa.Add(BCast.To(a[2], DataType.BigInt));
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                        {
                            string s = c[0].S[i]; long st = c[1].I[i]; long len = c.Length > 2 ? c[2].I[i] : long.MaxValue / 4;
                            if (st < 0) st = s.Length + st + 1;
                            long from = Math.Max(1, st), to = Math.Min((long)s.Length + 1, st + len);
                            o.S[i] = to > from ? s.Substring((int)from - 1, (int)(to - from)) : ""; return true;
                        }));
                    }
                case "left": case "right":
                    {
                        Need(fn, a, 2, 2);
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar), BCast.To(a[1], DataType.BigInt) };
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                        {
                            string s = c[0].S[i]; int k = (int)Math.Max(0, Math.Min(s.Length, c[1].I[i]));
                            o.S[i] = fn == "left" ? s.Substring(0, k) : s.Substring(s.Length - k); return true;
                        }));
                    }
                case "replace":
                    {
                        Need(fn, a, 3, 3); List<BExpr> xa = As(a, DataType.Varchar);
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) => { o.S[i] = c[1].S[i].Length == 0 ? c[0].S[i] : c[0].S[i].Replace(c[1].S[i], c[2].S[i]); return true; }));
                    }
                case "concat":
                    {
                        List<BExpr> xa = As(a, DataType.Varchar);
                        return F(fn, DataType.Varchar, xa, (c, n) =>
                        {
                            Column o = new Column(DataType.Varchar, n); StringBuilder sb = new StringBuilder();
                            for (int i = 0; i < n; i++) { sb.Length = 0; foreach (Column col in c) if (!col.IsNull(i) && col.Type.Kind != Kind.Null) sb.Append(col.S[i]); o.S[i] = sb.ToString(); }
                            return o;
                        });
                    }
                case "concat_ws":
                    {
                        if (a.Count < 2) Need(fn, a, 2, 99);
                        List<BExpr> xa = As(a, DataType.Varchar);
                        return F(fn, DataType.Varchar, xa, (c, n) =>
                        {
                            Column o = new Column(DataType.Varchar, n); List<string> parts = new List<string>();
                            for (int i = 0; i < n; i++)
                            {
                                if (c[0].IsNull(i)) { o.SetNull(i); continue; }
                                parts.Clear(); for (int k = 1; k < c.Length; k++) if (!c[k].IsNull(i) && c[k].Type.Kind != Kind.Null) parts.Add(c[k].S[i]);
                                o.S[i] = string.Join(c[0].S[i], parts);
                            }
                            return o;
                        });
                    }
                case "contains": case "starts_with": case "ends_with": case "prefix": case "suffix":
                    {
                        Need(fn, a, 2, 2); List<BExpr> xa = As(a, DataType.Varchar);
                        return F(fn, DataType.Bool, xa, (c, n) => Map(c, n, DataType.Bool, (i, o) =>
                        {
                            string s = c[0].S[i], t = c[1].S[i];
                            o.B[i] = fn == "contains" ? s.IndexOf(t, StringComparison.Ordinal) >= 0 : (fn == "starts_with" || fn == "prefix") ? s.StartsWith(t, StringComparison.Ordinal) : s.EndsWith(t, StringComparison.Ordinal);
                            return true;
                        }));
                    }
                case "strpos": case "instr": case "position":
                    {
                        Need(fn, a, 2, 2); List<BExpr> xa = As(a, DataType.Varchar);
                        return F(fn, DataType.BigInt, xa, (c, n) => Map(c, n, DataType.BigInt, (i, o) => { o.I[i] = c[0].S[i].IndexOf(c[1].S[i], StringComparison.Ordinal) + 1; return true; }));
                    }
                case "split_part":
                    {
                        Need(fn, a, 3, 3);
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar), BCast.To(a[1], DataType.Varchar), BCast.To(a[2], DataType.BigInt) };
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                        {
                            string[] parts = c[1].S[i].Length == 0 ? new[] { c[0].S[i] } : c[0].S[i].Split(new[] { c[1].S[i] }, StringSplitOptions.None);
                            long k = c[2].I[i]; if (k < 0) k = parts.Length + k + 1;
                            o.S[i] = k >= 1 && k <= parts.Length ? parts[k - 1] : ""; return true;
                        }));
                    }
                case "lpad": case "rpad":
                    {
                        Need(fn, a, 3, 3);
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar), BCast.To(a[1], DataType.BigInt), BCast.To(a[2], DataType.Varchar) };
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                        {
                            string s = c[0].S[i], pad = c[2].S[i]; int w = (int)Math.Max(0, Math.Min(100000, c[1].I[i]));
                            if (s.Length >= w) { o.S[i] = s.Substring(0, w); return true; }
                            if (pad.Length == 0) { o.S[i] = s; return true; }
                            StringBuilder sb = new StringBuilder(); while (sb.Length < w - s.Length) sb.Append(pad);
                            string fill = sb.ToString().Substring(0, w - s.Length);
                            o.S[i] = fn == "lpad" ? fill + s : s + fill; return true;
                        }));
                    }
                case "repeat":
                    {
                        Need(fn, a, 2, 2);
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.Varchar), BCast.To(a[1], DataType.BigInt) };
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) => { StringBuilder sb = new StringBuilder(); for (long k = 0; k < Math.Min(100000, c[1].I[i]); k++) sb.Append(c[0].S[i]); o.S[i] = sb.ToString(); return true; }));
                    }
                case "regexp_matches": case "regexp_full_match": case "regexp_extract": case "regexp_replace":
                    {
                        Need(fn, a, 2, fn == "regexp_replace" ? 4 : 3);
                        List<BExpr> xa = As(a, DataType.Varchar);
                        bool global = fn == "regexp_replace" && a.Count > 3 && LitStr(a[3], fn).Contains("g");
                        Dictionary<string, Regex> cache = new Dictionary<string, Regex>();
                        Func<string, Regex> rx = p => { Regex r; lock (cache) { if (!cache.TryGetValue(p, out r)) { r = new Regex(p, RegexOptions.CultureInvariant); cache[p] = r; } } return r; };
                        DataType t = fn == "regexp_matches" || fn == "regexp_full_match" ? DataType.Bool : DataType.Varchar;
                        return F(fn, t, xa, (c, n) => Map(c, n, t, (i, o) =>
                        {
                            string s = c[0].S[i]; Regex r = rx(c[1].S[i]);
                            if (fn == "regexp_matches") o.B[i] = r.IsMatch(s);
                            else if (fn == "regexp_full_match") { Match m = r.Match(s); o.B[i] = m.Success && m.Index == 0 && m.Length == s.Length; }
                            else if (fn == "regexp_extract") { Match m = r.Match(s); int g = c.Length > 2 ? int.Parse(c[2].S[i], CultureInfo.InvariantCulture) : 0; o.S[i] = m.Success ? m.Groups[g].Value : ""; }
                            else o.S[i] = global ? r.Replace(s, c[2].S[i].Replace("\\", "$")) : r.Replace(s, c[2].S[i].Replace("\\", "$"), 1);
                            return true;
                        }));
                    }
                // ---- nulls / logic ----
                case "coalesce": case "ifnull":
                    {
                        if (a.Count < 1) Need(fn, a, 1, 99);
                        DataType t = DataType.Null; foreach (BExpr e in a) t = Cast.Common(t, e.Type);
                        if (t.Kind == Kind.Null) return new BLit(null, DataType.Null);
                        List<BExpr> xa = As(a, t);
                        return F(fn, t, xa, (c, n) =>
                        {
                            Column o = new Column(t, n);
                            for (int i = 0; i < n; i++)
                            {
                                bool got = false;
                                foreach (Column col in c) if (!col.IsNull(i) && col.Type.Kind != Kind.Null) { BCase.Copy(col, i, o, i); got = true; break; }
                                if (!got) o.SetNull(i);
                            }
                            return o;
                        });
                    }
                case "nullif":
                    {
                        Need(fn, a, 2, 2);
                        BExpr eq = new BCmp("=", a[0], a[1]);
                        List<BExpr> xa = new List<BExpr> { a[0], eq };
                        DataType t = a[0].Type;
                        return F(fn, t, xa, (c, n) =>
                        {
                            Column o = new Column(t.Kind == Kind.Null ? DataType.Null : t, n);
                            for (int i = 0; i < n; i++) { if (c[0].IsNull(i) || (!c[1].IsNull(i) && c[1].B[i])) o.SetNull(i); else BCase.Copy(c[0], i, o, i); }
                            return o;
                        });
                    }
                case "if": case "iff":
                    {
                        Need(fn, a, 3, 3);
                        return new BCase(null, new List<BExpr> { a[0] }, new List<BExpr> { a[1] }, a[2]);
                    }
                case "choose":   // choose(k, v1, v2, ...): the k-th value (1-based), NULL when out of range
                    {
                        if (a.Count < 2) Need(fn, a, 2, 999);
                        DataType t = DataType.Null; for (int k = 1; k < a.Count; k++) t = Cast.Common(t, a[k].Type);
                        if (t.Kind == Kind.Int) t = DataType.BigInt;
                        List<BExpr> xa = new List<BExpr> { BCast.To(a[0], DataType.BigInt) }; for (int k = 1; k < a.Count; k++) xa.Add(BCast.To(a[k], t));
                        return F(fn, t, xa, (c, n) =>
                        {
                            Column o = new Column(t, n);
                            for (int i = 0; i < n; i++)
                            {
                                if (c[0].IsNull(i)) { o.SetNull(i); continue; }
                                long k = c[0].I[i];
                                if (k < 1 || k >= c.Length) o.SetNull(i); else BCase.Copy(c[k], i, o, i);
                            }
                            return o;
                        });
                    }
                case "add_seconds": case "add_days":
                    {
                        Need(fn, a, 2, 2); bool days = fn == "add_days";
                        List<BExpr> xa = new List<BExpr> { BCast.To(AsTime(a[0]), DataType.Timestamp), BCast.To(a[1], DataType.Double) };
                        return F(fn, DataType.Timestamp, xa, (c, n) => Map(c, n, DataType.Timestamp, (i, o) => { o.I[i] = c[0].I[i] + (long)Math.Round(c[1].F[i] * (days ? 86400e6 : 1e6)); return true; }));
                    }
                case "typeof":
                    Need(fn, a, 1, 1); return new BLit(a[0].Type.Name, DataType.Varchar);
                // ---- dates ----
                case "current_date": case "today": return new BLit(Values.Days(DateTime.UtcNow.Date), DataType.Date);
                case "now": case "get_current_timestamp": return new BLit(Values.Micros(DateTime.UtcNow), DataType.Timestamp);
                case "year": case "month": case "day": case "dayofmonth": case "quarter": case "dayofweek": case "dow": case "isodow": case "dayofyear": case "doy":
                case "week": case "weekofyear": case "hour": case "minute": case "second": case "yearweek": case "epoch": case "millisecond":
                    {
                        Need(fn, a, 1, 1);
                        string part = fn;
                        List<BExpr> xa = new List<BExpr> { AsTime(a[0]) };
                        return F(fn, part == "epoch" ? DataType.Double : DataType.BigInt, xa, (c, n) => Part(part, c[0], n));
                    }
                case "date_part": case "datepart":
                    {
                        Need(fn, a, 2, 2); string part = LitStr(a[0], fn);
                        List<BExpr> xa = new List<BExpr> { AsTime(a[1]) };
                        return F(fn, part == "epoch" ? DataType.Double : DataType.BigInt, xa, (c, n) => Part(part, c[0], n));
                    }
                case "date_trunc": case "datetrunc":
                    {
                        Need(fn, a, 2, 2); string part = LitStr(a[0], fn);
                        BExpr x = AsTime(a[1]); DataType t = (part == "hour" || part == "minute" || part == "second") ? DataType.Timestamp : x.Type;
                        return F(fn, t, new List<BExpr> { x }, (c, n) => Map(c, n, t, (i, o) =>
                        {
                            DateTime d = Dt(c[0], i), r;
                            switch (part)
                            {
                                case "year": r = new DateTime(d.Year, 1, 1); break;
                                case "quarter": r = new DateTime(d.Year, (d.Month - 1) / 3 * 3 + 1, 1); break;
                                case "month": r = new DateTime(d.Year, d.Month, 1); break;
                                case "week": r = d.Date.AddDays(-(((int)d.DayOfWeek + 6) % 7)); break;
                                case "day": r = d.Date; break;
                                case "hour": r = new DateTime(d.Year, d.Month, d.Day, d.Hour, 0, 0); break;
                                case "minute": r = new DateTime(d.Year, d.Month, d.Day, d.Hour, d.Minute, 0); break;
                                case "second": r = new DateTime(d.Year, d.Month, d.Day, d.Hour, d.Minute, d.Second); break;
                                default: throw new EngineException("FUNCTION_ARGS", "date_trunc: unknown part '" + part + "'.");
                            }
                            r = DateTime.SpecifyKind(r, DateTimeKind.Utc);
                            if (t.Kind == Kind.Date) o.I[i] = Values.Days(r); else o.I[i] = Values.Micros(r);
                            return true;
                        }));
                    }
                case "date_add":
                    {
                        Need(fn, a, 2, 2);
                        return new BArith("+", AsTime(a[0]), BCast.To(a[1], DataType.BigInt));
                    }
                case "date_diff": case "datediff": case "date_sub": case "datesub":
                    {
                        Need(fn, a, 3, 3); string part = LitStr(a[0], fn);
                        List<BExpr> xa = new List<BExpr> { BCast.To(AsTime(a[1]), DataType.Timestamp), BCast.To(AsTime(a[2]), DataType.Timestamp) };
                        return F(fn, DataType.BigInt, xa, (c, n) => Map(c, n, DataType.BigInt, (i, o) =>
                        {
                            DateTime x = Values.TimeOf(c[0].I[i]), y = Values.TimeOf(c[1].I[i]);
                            switch (part)
                            {
                                case "year": case "years": o.I[i] = y.Year - x.Year; break;
                                case "quarter": o.I[i] = (y.Year * 4 + (y.Month - 1) / 3) - (x.Year * 4 + (x.Month - 1) / 3); break;
                                case "month": case "months": o.I[i] = (y.Year * 12 + y.Month) - (x.Year * 12 + x.Month); break;
                                case "week": case "weeks": o.I[i] = (long)Math.Floor((y.Date - x.Date).TotalDays / 7); break;
                                case "day": case "days": o.I[i] = (long)(y.Date - x.Date).TotalDays; break;
                                case "hour": case "hours": o.I[i] = (long)Math.Floor((y - x).TotalHours); break;
                                case "minute": case "minutes": o.I[i] = (long)Math.Floor((y - x).TotalMinutes); break;
                                case "second": case "seconds": o.I[i] = (long)Math.Floor((y - x).TotalSeconds); break;
                                default: throw new EngineException("FUNCTION_ARGS", fn + ": unknown part '" + part + "'.");
                            }
                            return true;
                        }));
                    }
                case "make_date":
                    {
                        Need(fn, a, 3, 3); List<BExpr> xa = As(a, DataType.BigInt);
                        return F(fn, DataType.Date, xa, (c, n) => Map(c, n, DataType.Date, (i, o) =>
                        {
                            try { o.I[i] = Values.Days(new DateTime((int)c[0].I[i], (int)c[1].I[i], (int)c[2].I[i], 0, 0, 0, DateTimeKind.Utc)); return true; } catch { return false; }
                        }));
                    }
                case "last_day":
                    {
                        Need(fn, a, 1, 1); List<BExpr> xa = new List<BExpr> { AsTime(a[0]) };
                        return F(fn, DataType.Date, xa, (c, n) => Map(c, n, DataType.Date, (i, o) => { DateTime d = Dt(c[0], i); o.I[i] = Values.Days(DateTime.SpecifyKind(new DateTime(d.Year, d.Month, DateTime.DaysInMonth(d.Year, d.Month)), DateTimeKind.Utc)); return true; }));
                    }
                case "strftime":
                    {
                        Need(fn, a, 2, 2);
                        List<BExpr> xa = new List<BExpr> { AsTime(a[0]), BCast.To(a[1], DataType.Varchar) };
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) => { o.S[i] = StrFTime(Dt(c[0], i), c[1].S[i]); return true; }));
                    }
                case "strptime": case "try_strptime":
                    {
                        Need(fn, a, 2, 2); List<BExpr> xa = As(a, DataType.Varchar); bool tryMode = fn == "try_strptime";
                        return F(fn, DataType.Timestamp, xa, (c, n) => Map(c, n, DataType.Timestamp, (i, o) =>
                        {
                            DateTime d;
                            if (DateTime.TryParseExact(c[0].S[i], NetFormat(c[1].S[i]), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out d))
                            { o.I[i] = Values.Micros(DateTime.SpecifyKind(d, DateTimeKind.Utc)); return true; }
                            if (tryMode) return false;
                            throw new EngineException("CAST_FAILED", "strptime: '" + c[0].S[i] + "' does not match '" + c[1].S[i] + "'.");
                        }));
                    }
                case "monthname": case "dayname":
                    {
                        Need(fn, a, 1, 1); List<BExpr> xa = new List<BExpr> { AsTime(a[0]) };
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) => { DateTime d = Dt(c[0], i); o.S[i] = fn == "monthname" ? d.ToString("MMMM", CultureInfo.InvariantCulture) : d.DayOfWeek.ToString(); return true; }));
                    }
                case "to_json": case "md5":
                    {
                        Need(fn, a, 1, 1); List<BExpr> xa = As(a, DataType.Varchar);
                        return F(fn, DataType.Varchar, xa, (c, n) => Map(c, n, DataType.Varchar, (i, o) =>
                        {
                            if (fn == "to_json") o.S[i] = Values.JsonEscape(c[0].S[i]);
                            else using (System.Security.Cryptography.MD5 md = System.Security.Cryptography.MD5.Create())
                                { byte[] h = md.ComputeHash(Encoding.UTF8.GetBytes(c[0].S[i])); StringBuilder sb = new StringBuilder(); foreach (byte x in h) sb.Append(x.ToString("x2")); o.S[i] = sb.ToString(); }
                            return true;
                        }));
                    }
            }
            throw new EngineException("FUNCTION_UNKNOWN", "Unknown function " + name + "().");
        }

        static Column Part(string part, Column c, int n)
        {
            DataType t = part == "epoch" ? DataType.Double : DataType.BigInt;
            return Map(new[] { c }, n, t, (i, o) =>
            {
                DateTime d = Dt(c, i);
                switch (part)
                {
                    case "year": case "years": o.I[i] = d.Year; break;
                    case "month": case "months": o.I[i] = d.Month; break;
                    case "day": case "days": case "dayofmonth": o.I[i] = d.Day; break;
                    case "quarter": o.I[i] = (d.Month - 1) / 3 + 1; break;
                    case "dayofweek": case "dow": o.I[i] = (int)d.DayOfWeek; break;
                    case "isodow": o.I[i] = ((int)d.DayOfWeek + 6) % 7 + 1; break;
                    case "dayofyear": case "doy": o.I[i] = d.DayOfYear; break;
                    case "week": case "weekofyear": o.I[i] = IsoWeek(d); break;
                    case "yearweek": o.I[i] = d.Year * 100 + IsoWeek(d); break;
                    case "hour": case "hours": o.I[i] = d.Hour; break;
                    case "minute": case "minutes": o.I[i] = d.Minute; break;
                    case "second": case "seconds": o.I[i] = d.Second; break;
                    case "millisecond": case "milliseconds": o.I[i] = d.Second * 1000 + d.Millisecond; break;
                    case "epoch": o.F[i] = c.Type.Kind == Kind.Date ? c.I[i] * 86400.0 : c.I[i] / 1e6; break;
                    default: throw new EngineException("FUNCTION_ARGS", "Unknown date part '" + part + "'.");
                }
                return true;
            });
        }
        static int IsoWeek(DateTime d) { return CultureInfo.InvariantCulture.Calendar.GetWeekOfYear(d.AddDays(3 - ((int)d.DayOfWeek + 6) % 7), CalendarWeekRule.FirstFourDayWeek, DayOfWeek.Monday); }

        static string StrFTime(DateTime d, string f)
        {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < f.Length; i++)
            {
                if (f[i] != '%' || i + 1 >= f.Length) { sb.Append(f[i]); continue; }
                char k = f[++i];
                switch (k)
                {
                    case 'Y': sb.Append(d.Year.ToString("0000")); break;
                    case 'y': sb.Append((d.Year % 100).ToString("00")); break;
                    case 'm': sb.Append(d.Month.ToString("00")); break;
                    case 'd': sb.Append(d.Day.ToString("00")); break;
                    case 'H': sb.Append(d.Hour.ToString("00")); break;
                    case 'M': sb.Append(d.Minute.ToString("00")); break;
                    case 'S': sb.Append(d.Second.ToString("00")); break;
                    case 'f': sb.Append((d.Ticks % 10000000 / 10).ToString("000000")); break;
                    case 'B': sb.Append(d.ToString("MMMM", CultureInfo.InvariantCulture)); break;
                    case 'b': sb.Append(d.ToString("MMM", CultureInfo.InvariantCulture)); break;
                    case 'A': sb.Append(d.DayOfWeek.ToString()); break;
                    case 'a': sb.Append(d.DayOfWeek.ToString().Substring(0, 3)); break;
                    case 'j': sb.Append(d.DayOfYear.ToString("000")); break;
                    case 'V': sb.Append(IsoWeek(d).ToString("00")); break;
                    case '%': sb.Append('%'); break;
                    default: sb.Append('%').Append(k); break;
                }
            }
            return sb.ToString();
        }
        static string NetFormat(string f)
        {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < f.Length; i++)
            {
                if (f[i] != '%' || i + 1 >= f.Length) { if (char.IsLetter(f[i])) sb.Append('\'').Append(f[i]).Append('\''); else sb.Append(f[i] == '\'' ? "\\'" : f[i].ToString()); continue; }
                char k = f[++i];
                switch (k)
                {
                    case 'Y': sb.Append("yyyy"); break; case 'y': sb.Append("yy"); break; case 'm': sb.Append("MM"); break; case 'd': sb.Append("dd"); break;
                    case 'H': sb.Append("HH"); break; case 'M': sb.Append("mm"); break; case 'S': sb.Append("ss"); break; case 'f': sb.Append("FFFFFF"); break;
                    case 'B': sb.Append("MMMM"); break; case 'b': sb.Append("MMM"); break; case 'p': sb.Append("tt"); break; case 'I': sb.Append("hh"); break;
                    default: sb.Append(k); break;
                }
            }
            return sb.ToString();
        }

        public static ulong Mix(ulong h, ulong v) { h ^= v; h *= 1099511628211UL; h ^= h >> 29; return h; }
        public static ulong HashCell(Column c, int i)
        {
            if (c.IsNull(i) || c.Type.Kind == Kind.Null) return 0x9E3779B97F4A7C15UL;
            if (c.I != null) return Fmix((ulong)c.I[i]);
            if (c.F != null) { double d = c.F[i]; if (d == Math.Floor(d) && Math.Abs(d) < 9e18) return Fmix((ulong)(long)d); return Fmix((ulong)BitConverter.DoubleToInt64Bits(d)); }
            if (c.B != null) return c.B[i] ? 1UL : 2UL;
            string s = c.S[i]; ulong h = 14695981039346656037UL;
            for (int k = 0; k < s.Length; k++) { h ^= s[k]; h *= 1099511628211UL; }
            return Fmix(h);
        }
        public static ulong Fmix(ulong k) { k ^= k >> 33; k *= 0xff51afd7ed558ccdUL; k ^= k >> 33; k *= 0xc4ceb9fe1a85ec53UL; k ^= k >> 33; return k; }
    }
}
