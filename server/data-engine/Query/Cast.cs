using System;
using System.Globalization;

namespace NativeDataEngine
{
    // Vectorised type conversion. tryMode: a value that does not convert becomes NULL (TRY_CAST);
    // otherwise it raises CAST_FAILED (CAST).
    public static class Cast
    {
        public static Column To(Column c, DataType t, bool tryMode)
        {
            if (c.Type.SameAs(t)) return c;
            int n = c.Length;
            Column r = new Column(t, n);
            Kind from = c.Type.Kind;
            if (from == Kind.Null) { for (int i = 0; i < n; i++) r.SetNull(i); return r; }
            for (int i = 0; i < n; i++)
            {
                if (c.IsNull(i)) { r.SetNull(i); continue; }
                if (!One(c, i, r, i, t))
                {
                    if (tryMode) { r.SetNull(i); continue; }
                    throw new EngineException("CAST_FAILED", "Could not convert '" + Values.Text(c, i) + "' to " + t.Name + ". Use TRY_CAST to turn bad values into NULL.");
                }
            }
            return r;
        }

        // Converts c[i] into r[j]; false = does not fit.
        public static bool One(Column c, int i, Column r, int j, DataType t)
        {
            Kind from = c.Type.Kind;
            switch (t.Kind)
            {
                case Kind.String:
                    r.S[j] = Values.Text(c, i); return true;
                case Kind.Bool:
                    if (from == Kind.Bool) { r.B[j] = c.B[i]; return true; }
                    if (from == Kind.Int) { r.B[j] = c.I[i] != 0; return true; }
                    if (from == Kind.Double || from == Kind.Decimal) { r.B[j] = c.F[i] != 0; return true; }
                    if (from == Kind.String) { bool b; if (Values.ParseBool(c.S[i], out b)) { r.B[j] = b; return true; } }
                    return false;
                case Kind.Int:
                    {
                        long v;
                        if (from == Kind.Int) v = c.I[i];
                        else if (from == Kind.Bool) v = c.B[i] ? 1 : 0;
                        else if (from == Kind.Double || from == Kind.Decimal)
                        {
                            double d = Math.Round(c.F[i], MidpointRounding.AwayFromZero);
                            if (double.IsNaN(d) || d > 9.2233720368547758e18 || d < -9.2233720368547758e18) return false;
                            v = (long)d;
                        }
                        else if (from == Kind.String)
                        {
                            string s = c.S[i];
                            if (!Values.ParseLong(s, out v))
                            {
                                double d;
                                if (!Values.ParseDouble(s, out d) || double.IsNaN(d) || double.IsInfinity(d)) return false;
                                d = Math.Round(d, MidpointRounding.AwayFromZero);
                                if (d > 9.2233720368547758e18 || d < -9.2233720368547758e18) return false;
                                v = (long)d;
                            }
                        }
                        else if (from == Kind.Date || from == Kind.Timestamp) return false;
                        else return false;
                        if (t.Bits == 32 && (v > int.MaxValue || v < int.MinValue)) return false;
                        if (t.Bits == 16 && (v > short.MaxValue || v < short.MinValue)) return false;
                        if (t.Bits == 8 && (v > sbyte.MaxValue || v < sbyte.MinValue)) return false;
                        r.I[j] = v; return true;
                    }
                case Kind.Double:
                case Kind.Decimal:
                    {
                        double d;
                        if (from == Kind.Int) d = c.I[i];
                        else if (from == Kind.Double || from == Kind.Decimal) d = c.F[i];
                        else if (from == Kind.Bool) d = c.B[i] ? 1 : 0;
                        else if (from == Kind.String) { if (!Values.ParseDouble(c.S[i], out d)) return false; }
                        else return false;
                        if (t.Kind == Kind.Decimal)
                        {
                            if (double.IsNaN(d) || double.IsInfinity(d)) return false;
                            d = Math.Round(d, Math.Min(15, t.Scale), MidpointRounding.AwayFromZero);
                            if (Math.Abs(d) >= Math.Pow(10, t.Precision - t.Scale)) return false;
                        }
                        r.F[j] = d; return true;
                    }
                case Kind.Date:
                    if (from == Kind.Date) { r.I[j] = c.I[i]; return true; }
                    if (from == Kind.Timestamp) { r.I[j] = FloorDiv(c.I[i], 86400000000L); return true; }
                    if (from == Kind.String)
                    {
                        long d; if (Values.ParseDate(c.S[i], out d)) { r.I[j] = d; return true; }
                        long m; if (Values.ParseTimestamp(c.S[i], out m)) { r.I[j] = FloorDiv(m, 86400000000L); return true; }
                    }
                    return false;
                case Kind.Timestamp:
                    if (from == Kind.Timestamp) { r.I[j] = c.I[i]; return true; }
                    if (from == Kind.Date) { r.I[j] = c.I[i] * 86400000000L; return true; }
                    if (from == Kind.String) { long m; if (Values.ParseTimestamp(c.S[i], out m)) { r.I[j] = m; return true; } }
                    return false;
            }
            return false;
        }

        public static long FloorDiv(long a, long b) { long q = a / b; if ((a % b != 0) && ((a < 0) != (b < 0))) q--; return q; }

        // Common type of two inputs for comparisons, CASE branches, COALESCE, UNION.
        public static DataType Common(DataType a, DataType b)
        {
            if (a.Kind == Kind.Null) return b;
            if (b.Kind == Kind.Null) return a;
            if (a.SameAs(b)) return a;
            if (a.Kind == Kind.Int && b.Kind == Kind.Int) return a.Bits >= b.Bits ? a : b;
            if (a.IsNumeric && b.IsNumeric)
            {
                if (a.Kind == Kind.Decimal && b.Kind == Kind.Decimal) return DataType.Decimal(Math.Min(38, Math.Max(a.Precision - a.Scale, b.Precision - b.Scale) + Math.Max(a.Scale, b.Scale)), Math.Max(a.Scale, b.Scale));
                if (a.Kind == Kind.Decimal && b.Kind == Kind.Int) return a;
                if (b.Kind == Kind.Decimal && a.Kind == Kind.Int) return b;
                return DataType.Double;
            }
            if ((a.Kind == Kind.Date && b.Kind == Kind.Timestamp) || (a.Kind == Kind.Timestamp && b.Kind == Kind.Date)) return DataType.Timestamp;
            if (a.Kind == Kind.String && (b.Kind == Kind.Date || b.Kind == Kind.Timestamp || b.IsNumeric || b.Kind == Kind.Bool)) return b;
            if (b.Kind == Kind.String && (a.Kind == Kind.Date || a.Kind == Kind.Timestamp || a.IsNumeric || a.Kind == Kind.Bool)) return a;
            return DataType.Varchar;
        }
    }
}
