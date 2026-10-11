// Columnar in-memory model (Arrow-style): typed column buffers + null flags, grouped into record batches.
// C# 5 only: compiled by PowerShell 5.1 Add-Type (see .server/engine-loader.ps1).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace NativeDataEngine
{
    public enum Kind { Null, Bool, Int, Double, Decimal, String, Date, Timestamp }

    // Logical type. Storage: Bool -> B; Int/Date/Timestamp -> I (Date = days since 1970-01-01, Timestamp = microseconds);
    // Double/Decimal -> F (Decimal keeps precision/scale for Parquet output); String -> S.
    public sealed class DataType
    {
        public readonly Kind Kind;
        public readonly int Bits;        // Int: 8 / 16 / 32 / 64
        public readonly int Precision;   // Decimal
        public readonly int Scale;       // Decimal

        private DataType(Kind k, int bits, int p, int s) { Kind = k; Bits = bits; Precision = p; Scale = s; }

        public static readonly DataType Null = new DataType(Kind.Null, 0, 0, 0);
        public static readonly DataType Bool = new DataType(Kind.Bool, 0, 0, 0);
        public static readonly DataType TinyInt = new DataType(Kind.Int, 8, 0, 0);
        public static readonly DataType SmallInt = new DataType(Kind.Int, 16, 0, 0);
        public static readonly DataType Integer = new DataType(Kind.Int, 32, 0, 0);
        public static readonly DataType BigInt = new DataType(Kind.Int, 64, 0, 0);
        public static readonly DataType Double = new DataType(Kind.Double, 0, 0, 0);
        public static readonly DataType Varchar = new DataType(Kind.String, 0, 0, 0);
        public static readonly DataType Date = new DataType(Kind.Date, 0, 0, 0);
        public static readonly DataType Timestamp = new DataType(Kind.Timestamp, 0, 0, 0);

        public static DataType Decimal(int p, int s)
        {
            if (p < 1 || p > 38 || s < 0 || s > p) throw new EngineException("TYPE_INVALID", "Invalid DECIMAL(" + p + "," + s + ").");
            return new DataType(Kind.Decimal, 0, p, s);
        }

        public bool IsNumeric { get { return Kind == Kind.Int || Kind == Kind.Double || Kind == Kind.Decimal; } }
        public bool UsesI { get { return Kind == Kind.Int || Kind == Kind.Date || Kind == Kind.Timestamp; } }
        public bool UsesF { get { return Kind == Kind.Double || Kind == Kind.Decimal; } }

        public string Name
        {
            get
            {
                switch (Kind)
                {
                    case Kind.Null: return "NULL";
                    case Kind.Bool: return "BOOLEAN";
                    case Kind.Int: return Bits == 8 ? "TINYINT" : Bits == 16 ? "SMALLINT" : Bits == 32 ? "INTEGER" : "BIGINT";
                    case Kind.Double: return "DOUBLE";
                    case Kind.Decimal: return "DECIMAL(" + Precision + "," + Scale + ")";
                    case Kind.String: return "VARCHAR";
                    case Kind.Date: return "DATE";
                    default: return "TIMESTAMP";
                }
            }
        }
        public override string ToString() { return Name; }
        public bool SameAs(DataType o) { return o != null && o.Kind == Kind && o.Bits == Bits && o.Precision == Precision && o.Scale == Scale; }

        public static DataType Parse(string name)
        {
            DataType t = TryParse(name);
            if (t == null) throw new EngineException("TYPE_UNKNOWN", "Unknown type: " + name);
            return t;
        }
        public static DataType TryParse(string name)
        {
            string n = (name ?? "").Trim().ToUpperInvariant();
            int paren = n.IndexOf('(');
            string args = null;
            if (paren > 0) { args = n.Substring(paren + 1).TrimEnd(')', ' '); n = n.Substring(0, paren).Trim(); }
            switch (n)
            {
                case "VARCHAR": case "TEXT": case "STRING": case "CHAR": case "BPCHAR": case "NVARCHAR": case "UUID": case "JSON": case "BLOB": return Varchar;
                case "BIGINT": case "INT8": case "LONG": case "HUGEINT": case "UBIGINT": case "UINTEGER": return BigInt;
                case "INTEGER": case "INT": case "INT4": case "SIGNED": case "USMALLINT": return Integer;
                case "SMALLINT": case "INT2": case "SHORT": case "UTINYINT": return SmallInt;
                case "TINYINT": case "INT1": return TinyInt;
                case "DOUBLE": case "FLOAT8": case "FLOAT": case "FLOAT4": case "REAL": return Double;
                case "DATE": return Date;
                case "TIMESTAMP": case "DATETIME": case "TIMESTAMP_US": case "TIMESTAMP_MS": case "TIMESTAMP_S": case "TIMESTAMPTZ": case "TIMESTAMP WITH TIME ZONE": return Timestamp;
                case "BOOLEAN": case "BOOL": case "LOGICAL": return Bool;
                case "DECIMAL": case "NUMERIC":
                    if (args == null) return Decimal(18, 3);
                    string[] a = args.Split(',');
                    int p = int.Parse(a[0].Trim(), CultureInfo.InvariantCulture);
                    int s = a.Length > 1 ? int.Parse(a[1].Trim(), CultureInfo.InvariantCulture) : 0;
                    return Decimal(p, s);
            }
            return null;
        }
    }

    public sealed class Field
    {
        public string Name;
        public DataType Type;
        public Field(string name, DataType type) { Name = name; Type = type; }
    }

    public sealed class Schema
    {
        public readonly List<Field> Fields;
        public Schema(List<Field> fields) { Fields = fields; }
        public int Count { get { return Fields.Count; } }
        public Field this[int i] { get { return Fields[i]; } }
        public int IndexOf(string name)
        {
            for (int i = 0; i < Fields.Count; i++) if (Fields[i].Name == name) return i;
            for (int i = 0; i < Fields.Count; i++) if (string.Equals(Fields[i].Name, name, StringComparison.OrdinalIgnoreCase)) return i;
            return -1;
        }
    }

    // One column of one batch. Nulls == null means "no nulls".
    // Text may also be held as Arrow buffers (Utf8 bytes + Offs, row i = Utf8[Offs[i] .. Offs[i + 1])) with no strings
    // made yet: resident datasets keep mostly-distinct text this way (one byte array instead of millions of objects for
    // the garbage collector to walk). S then decodes on first use, into this Column object only (MemSource hands each
    // query its own copy, so the resident column stays bytes).
    public sealed class Column
    {
        public DataType Type;
        public int Length;
        public long[] I;
        public double[] F;
        string[] s;
        public byte[] Utf8; public int[] Offs;
        public string[] S
        {
            get { if (s == null && Utf8 != null) s = DecodeUtf8(); return s; }
            set { s = value; }
        }
        public bool[] B;
        public bool[] Nulls;
        public bool IsLazyText { get { return s == null && Utf8 != null; } }

        string[] DecodeUtf8()
        {
            // Only mostly-distinct text is kept as bytes, so no sharing here: one string per value.
            string[] o = new string[Length]; byte[] u = Utf8; int[] f = Offs; bool[] nl = Nulls;
            for (int i = 0; i < Length; i++)
            {
                if (nl != null && nl[i]) continue;
                int a = f[i], n = f[i + 1] - a;
                o[i] = n == 0 ? "" : Encoding.UTF8.GetString(u, a, n);
            }
            return o;
        }
        // Text column -> Arrow buffers, strings dropped (see above).
        public static Column LazyText(Column c)
        {
            string[] src = c.S; int n = c.Length;
            int[] offs = new int[n + 1]; long total = 0;
            for (int i = 0; i < n; i++) { string v = src[i]; if (v != null && !(c.Nulls != null && c.Nulls[i])) total += Encoding.UTF8.GetByteCount(v); }
            if (total > int.MaxValue) return c;
            byte[] data = new byte[total]; int at = 0;
            for (int i = 0; i < n; i++)
            {
                offs[i] = at; string v = src[i];
                if (v != null && !(c.Nulls != null && c.Nulls[i])) at += Encoding.UTF8.GetBytes(v, 0, v.Length, data, at);
            }
            offs[n] = at;
            Column r = new Column(); r.Type = c.Type; r.Length = n; r.Nulls = c.Nulls; r.Utf8 = data; r.Offs = offs;
            return r;
        }
        // A fresh Column over the same values (lazy text decodes into the copy, not into this one).
        public Column ShallowCopy()
        {
            Column r = new Column(); r.Type = Type; r.Length = Length; r.I = I; r.F = F; r.s = s; r.Utf8 = Utf8; r.Offs = Offs; r.B = B; r.Nulls = Nulls;
            return r;
        }

        public Column(DataType t, int n)
        {
            Type = t; Length = n;
            if (t.UsesI) I = new long[n];
            else if (t.UsesF) F = new double[n];
            else if (t.Kind == Kind.String) S = new string[n];
            else if (t.Kind == Kind.Bool) B = new bool[n];
            else { Nulls = new bool[n]; for (int i = 0; i < n; i++) Nulls[i] = true; }
        }
        private Column() { }

        public bool IsNull(int i) { return Nulls != null && Nulls[i]; }
        public void SetNull(int i)
        {
            if (Nulls == null) Nulls = new bool[Length];
            Nulls[i] = true;
        }
        public bool HasNulls
        {
            get { if (Nulls == null) return false; for (int i = 0; i < Length; i++) if (Nulls[i]) return true; return false; }
        }

        // Approximate memory, for the memory guard.
        public long Bytes
        {
            get
            {
                long b = 32 + (Nulls != null ? Length : 0);
                if (I != null || F != null) b += 8L * Length;
                else if (B != null) b += Length;
                else if (IsLazyText) b += Utf8.LongLength + 4L * Offs.Length;
                else if (s != null) { b += 8L * Length; for (int i = 0; i < Length; i++) if (s[i] != null) b += 24 + 2 * s[i].Length; }
                return b;
            }
        }

        public static Column Constant(DataType t, object v, int n)
        {
            Column c = new Column(t, n);
            if (v == null) { c.Nulls = new bool[n]; for (int i = 0; i < n; i++) c.Nulls[i] = true; return c; }
            for (int i = 0; i < n; i++) c.SetObj(i, v);
            return c;
        }

        // Boxed access (slow path: grouping keys, sorting, JSON output).
        public object Get(int i)
        {
            if (Nulls != null && Nulls[i]) return null;
            switch (Type.Kind)
            {
                case Kind.Bool: return B[i];
                case Kind.Int: case Kind.Date: case Kind.Timestamp: return I[i];
                case Kind.Double: case Kind.Decimal: return F[i];
                case Kind.String: return S[i];
                default: return null;
            }
        }
        public void SetObj(int i, object v)
        {
            if (v == null) { SetNull(i); return; }
            switch (Type.Kind)
            {
                case Kind.Bool: B[i] = (bool)v; break;
                case Kind.Int: case Kind.Date: case Kind.Timestamp: I[i] = Convert.ToInt64(v, CultureInfo.InvariantCulture); break;
                case Kind.Double: case Kind.Decimal: F[i] = Convert.ToDouble(v, CultureInfo.InvariantCulture); break;
                case Kind.String: S[i] = v as string ?? Values.ToText(v, null); break;
            }
        }

        public Column Slice(int start, int count)
        {
            Column c = new Column(); c.Type = Type; c.Length = count;
            if (I != null) { c.I = new long[count]; Array.Copy(I, start, c.I, 0, count); }
            if (F != null) { c.F = new double[count]; Array.Copy(F, start, c.F, 0, count); }
            if (S != null) { c.S = new string[count]; Array.Copy(S, start, c.S, 0, count); }
            if (B != null) { c.B = new bool[count]; Array.Copy(B, start, c.B, 0, count); }
            if (Nulls != null) { c.Nulls = new bool[count]; Array.Copy(Nulls, start, c.Nulls, 0, count); }
            return c;
        }

        // Rows picked by index (filter, sort, join).
        public Column Take(int[] idx, int count)
        {
            Column c = new Column(); c.Type = Type; c.Length = count;
            if (I != null) { long[] a = new long[count]; for (int k = 0; k < count; k++) a[k] = I[idx[k]]; c.I = a; }
            if (F != null) { double[] a = new double[count]; for (int k = 0; k < count; k++) a[k] = F[idx[k]]; c.F = a; }
            if (S != null) { string[] a = new string[count]; for (int k = 0; k < count; k++) a[k] = S[idx[k]]; c.S = a; }
            if (B != null) { bool[] a = new bool[count]; for (int k = 0; k < count; k++) a[k] = B[idx[k]]; c.B = a; }
            if (Nulls != null)
            {
                bool[] a = new bool[count]; bool any = false;
                for (int k = 0; k < count; k++) { a[k] = Nulls[idx[k]]; any |= a[k]; }
                if (any) c.Nulls = a;
            }
            return c;
        }
        // Like Take, but idx < 0 gives a null (outer joins).
        public Column TakeOrNull(int[] idx, int count)
        {
            Column c = new Column(Type.Kind == Kind.Null ? DataType.Null : Type, count);
            for (int k = 0; k < count; k++)
            {
                int j = idx[k];
                if (j < 0 || IsNull(j)) { c.SetNull(k); continue; }
                if (I != null) c.I[k] = I[j]; else if (F != null) c.F[k] = F[j]; else if (S != null) c.S[k] = S[j]; else if (B != null) c.B[k] = B[j];
            }
            return c;
        }

        public static Column Concat(DataType t, List<Column> parts)
        {
            int n = 0; foreach (Column p in parts) n += p.Length;
            Column c = new Column(t, n);
            int at = 0;
            foreach (Column p0 in parts)
            {
                Column p = p0.Type.SameAs(t) || (p0.Type.UsesI && t.UsesI) || (p0.Type.UsesF && t.UsesF) ? p0 : Cast.To(p0, t, true);
                if (p.I != null && c.I != null) Array.Copy(p.I, 0, c.I, at, p.Length);
                else if (p.F != null && c.F != null) Array.Copy(p.F, 0, c.F, at, p.Length);
                else if (p.S != null && c.S != null) Array.Copy(p.S, 0, c.S, at, p.Length);
                else if (p.B != null && c.B != null) Array.Copy(p.B, 0, c.B, at, p.Length);
                if (p.Nulls != null || p.Type.Kind == Kind.Null)
                    for (int i = 0; i < p.Length; i++) if (p.IsNull(i) || p.Type.Kind == Kind.Null) c.SetNull(at + i);
                at += p.Length;
            }
            return c;
        }
    }

    public sealed class Batch
    {
        public Schema Schema;
        public Column[] Cols;
        public int Rows;
        public Batch(Schema s, Column[] cols, int rows) { Schema = s; Cols = cols; Rows = rows; }
        public long Bytes { get { long b = 0; foreach (Column c in Cols) b += c.Bytes; return b; } }
        public Batch Take(int[] idx, int n)
        {
            Column[] cs = new Column[Cols.Length];
            for (int i = 0; i < cs.Length; i++) cs[i] = Cols[i].Take(idx, n);
            return new Batch(Schema, cs, n);
        }
        public Batch Slice(int start, int n)
        {
            Column[] cs = new Column[Cols.Length];
            for (int i = 0; i < cs.Length; i++) cs[i] = Cols[i].Slice(start, n);
            return new Batch(Schema, cs, n);
        }
        public static Batch Empty(Schema s)
        {
            Column[] cs = new Column[s.Count];
            for (int i = 0; i < cs.Length; i++) cs[i] = new Column(s[i].Type, 0);
            return new Batch(s, cs, 0);
        }
        public static Batch Concat(Schema s, List<Batch> bs)
        {
            if (bs.Count == 1) return bs[0];
            Column[] cs = new Column[s.Count]; int n = 0;
            foreach (Batch b in bs) n += b.Rows;
            for (int i = 0; i < cs.Length; i++)
            {
                List<Column> parts = new List<Column>(bs.Count);
                foreach (Batch b in bs) parts.Add(b.Cols[i]);
                cs[i] = Column.Concat(s[i].Type, parts);
            }
            return new Batch(s, cs, n);
        }
    }

    // Value helpers: dates, timestamps, text output.
    public static class Values
    {
        public static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        public static DateTime DateOf(long days) { return Epoch.AddDays(days); }
        public static DateTime TimeOf(long micros) { return Epoch.AddTicks(micros * 10); }
        public static long Days(DateTime d) { return (long)Math.Floor((d - Epoch).TotalDays); }
        public static long Micros(DateTime d) { return (d.Ticks - Epoch.Ticks) / 10; }

        // Text of dates / timestamps / numbers is built by hand (the same characters .NET's formatting gives, much faster:
        // CSV and SQLite exports, the Data Grid and JSON output turn millions of values into text). The *Slow versions
        // are the reference and the fallback.
        public static string DateText(long days)
        {
            DateTime t = DateOf(days);
            char[] c = new char[10]; Put4(c, 0, t.Year); c[4] = '-'; Put2(c, 5, t.Month); c[7] = '-'; Put2(c, 8, t.Day);
            return new string(c);
        }
        public static string TimeText(long micros)
        {
            DateTime t = TimeOf(micros);
            long frac = ((micros % 1000000) + 1000000) % 1000000;
            int fd = 0; if (frac != 0) { fd = 6; while (frac % 10 == 0) { frac /= 10; fd--; } }
            char[] c = new char[19 + (fd > 0 ? fd + 1 : 0)];
            Put4(c, 0, t.Year); c[4] = '-'; Put2(c, 5, t.Month); c[7] = '-'; Put2(c, 8, t.Day); c[10] = ' ';
            Put2(c, 11, t.Hour); c[13] = ':'; Put2(c, 14, t.Minute); c[16] = ':'; Put2(c, 17, t.Second);
            if (fd > 0) { c[19] = '.'; for (int k = fd - 1; k >= 0; k--) { c[20 + k] = (char)('0' + frac % 10); frac /= 10; } }
            return new string(c);
        }
        static void Put2(char[] c, int at, int v) { c[at] = (char)('0' + v / 10); c[at + 1] = (char)('0' + v % 10); }
        static void Put4(char[] c, int at, int v) { c[at] = (char)('0' + v / 1000); c[at + 1] = (char)('0' + v / 100 % 10); c[at + 2] = (char)('0' + v / 10 % 10); c[at + 3] = (char)('0' + v % 10); }
        public static string DateTextSlow(long days) { return DateOf(days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }
        public static string TimeTextSlow(long micros)
        {
            DateTime t = TimeOf(micros);
            long frac = ((micros % 1000000) + 1000000) % 1000000;
            string s = t.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            if (frac != 0) s += "." + frac.ToString("000000", CultureInfo.InvariantCulture).TrimEnd('0');
            return s;
        }
        // iv / 10^k as text with exactly k decimals ("-12.30", "0.05", "7").
        static string Fixed(long iv, int k)
        {
            bool neg = iv < 0; ulong u = neg ? (ulong)(-iv) : (ulong)iv;
            char[] c = new char[24]; int at = c.Length;
            for (int i = 0; i < k; i++) { c[--at] = (char)('0' + (int)(u % 10)); u /= 10; }
            if (k > 0) c[--at] = '.';
            do { c[--at] = (char)('0' + (int)(u % 10)); u /= 10; } while (u > 0);
            if (neg) c[--at] = '-';
            return new string(c, at, c.Length - at);
        }
        // DECIMAL(p, s) text: Math.Round(v, s) shown with s decimals ("F" + s), built by hand when the rounded value has
        // at most 15 digits (then "F" shows exactly those digits).
        public static string DecimalText(double v, int scale)
        {
            double r = Math.Round(v, scale);
            if (scale <= 15 && !double.IsNaN(r) && Math.Abs(r) * P10[scale] < 1e15)
            {
                long iv = (long)Math.Round(r * P10[scale]);
                return iv == 0 ? Fixed(0, scale) : Fixed(iv, scale);
            }
            return r.ToString("F" + scale, CultureInfo.InvariantCulture);
        }
        // Shortest text that reads back as exactly d: 15 digits when they do (checked with the engine's exact parser),
        // else "R". (.NET Framework's "R" checks with its own parse, which can be a bit off, and then prints 17 digits.)
        // Fast path: a value with at most 15 digits and 0.0001 <= |d| < 1e15 (where G15 writes plain digits): the fewest
        // decimals k whose value / 10^k is d again (the engine's parser makes exactly that division) is G15's text.
        public static string R(double d)
        {
            double a = Math.Abs(d);
            if (a >= 1e-4 && a < 1e15)
            {
                for (int k = 0; k <= 15; k++)
                {
                    double m = Math.Round(d * P10[k]);
                    if (Math.Abs(m) >= 1e15) break;
                    if (m / P10[k] == d) return Fixed((long)m, k);
                }
            }
            return RSlow(d);
        }
        public static string RSlow(double d)
        {
            string s = d.ToString("G15", CultureInfo.InvariantCulture);
            double back;
            if (FastDouble(s, null, 0, s.Length, out back) && back == d) return s;
            return d.ToString("R", CultureInfo.InvariantCulture);
        }
        public static string Num(double d)
        {
            if (double.IsNaN(d)) return "nan";
            if (double.IsInfinity(d)) return d > 0 ? "inf" : "-inf";
            return R(d);
        }
        public static string ToText(object v, DataType t)
        {
            if (v == null) return null;
            if (t != null && t.Kind == Kind.Date) return DateText((long)v);
            if (t != null && t.Kind == Kind.Timestamp) return TimeText((long)v);
            if (v is bool) return (bool)v ? "true" : "false";
            if (v is double) return Num((double)v);
            if (v is long) return ((long)v).ToString(CultureInfo.InvariantCulture);
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }
        public static string Text(Column c, int i)
        {
            if (c.IsNull(i)) return null;
            switch (c.Type.Kind)
            {
                case Kind.String: return c.S[i];
                case Kind.Bool: return c.B[i] ? "true" : "false";
                case Kind.Int: return c.I[i].ToString(CultureInfo.InvariantCulture);
                case Kind.Date: return DateText(c.I[i]);
                case Kind.Timestamp: return TimeText(c.I[i]);
                case Kind.Decimal: return DecimalText(c.F[i], c.Type.Scale);
                case Kind.Double: return Num(c.F[i]);
            }
            return null;
        }

        // ---- Fast exact parsers over text in a string (str) or a char buffer (arr[s..s+n)): no allocation. ----
        // FastDouble: up to 15 significant digits, no exponent -> one IEEE division of two exact values, i.e. the correctly
        // rounded double (.NET Framework's double.Parse can be one bit off). ParseDouble, CSV and SQL number literals all
        // use it, so the same text always gives the same double. Anything else returns false (callers fall back).
        static readonly double[] P10 = { 1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22 };
        static bool White(char c) { return c == ' ' || (c >= '\t' && c <= '\r'); }
        public static bool FastDouble(string str, char[] arr, int s, int n, out double v)
        {
            v = 0; int i = s, e = s + n;
            while (i < e && White(str != null ? str[i] : arr[i])) i++;
            while (e > i && White(str != null ? str[e - 1] : arr[e - 1])) e--;
            bool neg = false;
            if (i < e) { char c0 = str != null ? str[i] : arr[i]; if (c0 == '-' || c0 == '+') { neg = c0 == '-'; i++; } }
            long m = 0; int digits = 0, frac = 0; bool dot = false, any = false;
            for (; i < e; i++)
            {
                char c = str != null ? str[i] : arr[i];
                if (c >= '0' && c <= '9')
                {
                    any = true;
                    if (dot) frac++;
                    if (m == 0 && c == '0') { if (dot && frac > 22) return false; continue; }
                    if (++digits > 15) return false;
                    m = m * 10 + (c - '0');
                }
                else if (c == '.' && !dot) dot = true;
                else return false;
            }
            if (!any || frac > 22) return false;
            if (m == 0) { v = 0; return true; }
            double d = frac > 0 ? m / P10[frac] : m;
            v = neg ? -d : d;
            return true;
        }
        public static bool FastLong(char[] a, int s, int n, out long v)
        {
            v = 0; int i = s, e = s + n;
            while (i < e && White(a[i])) i++;
            while (e > i && White(a[e - 1])) e--;
            bool neg = false;
            if (i < e && (a[i] == '-' || a[i] == '+')) { neg = a[i] == '-'; i++; }
            if (i >= e || e - i > 18) return false;
            long m = 0;
            for (; i < e; i++) { char c = a[i]; if (c < '0' || c > '9') return false; m = m * 10 + (c - '0'); }
            v = neg ? -m : m;
            return true;
        }
        // yyyy-MM-dd exactly (ParseDate accepts more: callers fall back to it).
        public static bool FastDate(char[] a, int s, int n, out long days)
        {
            days = 0;
            if (n != 10 || a[s + 4] != '-' || a[s + 7] != '-') return false;
            int y = 0, mo = 0, d = 0;
            for (int k = 0; k < 10; k++)
            {
                if (k == 4 || k == 7) continue;
                char c = a[s + k]; if (c < '0' || c > '9') return false;
                if (k < 4) y = y * 10 + (c - '0'); else if (k < 7) mo = mo * 10 + (c - '0'); else d = d * 10 + (c - '0');
            }
            if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > DateTime.DaysInMonth(y, mo)) return false;
            days = Days(new DateTime(y, mo, d, 0, 0, 0, DateTimeKind.Utc));
            return true;
        }

        // yyyy-MM-dd HH:mm:ss (or T between), optional .fraction (up to 7 digits) -> microseconds, UTC: the same value
        // ParseTimestamp gives for these forms; anything else returns false (the general parser decides).
        public static bool FastTimestamp(char[] a, int s, int n, out long micros)
        {
            micros = 0;
            if (n < 19 || (a[s + 10] != ' ' && a[s + 10] != 'T') || a[s + 13] != ':' || a[s + 16] != ':') return false;
            long days; if (!FastDate(a, s, 10, out days)) return false;
            int h, mi, se;
            if (!Two(a, s + 11, out h) || !Two(a, s + 14, out mi) || !Two(a, s + 17, out se) || h > 23 || mi > 59 || se > 59) return false;
            long frac = 0;
            if (n > 19)
            {
                if (a[s + 19] != '.' || n == 20 || n > 27) return false;
                int digits = n - 20; long scale = 1;
                for (int k = 0; k < digits; k++) { char c = a[s + 20 + k]; if (c < '0' || c > '9') return false; frac = frac * 10 + (c - '0'); }
                for (int k = digits; k < 7; k++) scale *= 10;
                frac = frac * scale / 10;   // 100 ns ticks -> microseconds
            }
            micros = days * 86400000000L + h * 3600000000L + mi * 60000000L + se * 1000000L + frac;
            return true;
        }
        static bool Two(char[] a, int s, out int v) { char x = a[s], y = a[s + 1]; v = 0; if (x < '0' || x > '9' || y < '0' || y > '9') return false; v = (x - '0') * 10 + (y - '0'); return true; }
        // true / false / t / f / yes / no / y / n / 1 / 0 (any case), as ParseBool, without making a string.
        public static bool FastBool(char[] a, int s, int n, out bool v)
        {
            v = false;
            if (n == 1) { char c = (char)(a[s] | 0x20); if (c == 't' || c == 'y' || a[s] == '1') { v = true; return true; } if (c == 'f' || c == 'n' || a[s] == '0') return true; return false; }
            if (n == 4 && (a[s] | 0x20) == 't' && (a[s + 1] | 0x20) == 'r' && (a[s + 2] | 0x20) == 'u' && (a[s + 3] | 0x20) == 'e') { v = true; return true; }
            if (n == 5 && (a[s] | 0x20) == 'f' && (a[s + 1] | 0x20) == 'a' && (a[s + 2] | 0x20) == 'l' && (a[s + 3] | 0x20) == 's' && (a[s + 4] | 0x20) == 'e') return true;
            if (n == 3 && (a[s] | 0x20) == 'y' && (a[s + 1] | 0x20) == 'e' && (a[s + 2] | 0x20) == 's') { v = true; return true; }
            if (n == 2 && (a[s] | 0x20) == 'n' && (a[s + 1] | 0x20) == 'o') return true;
            return false;
        }

        // Text -> value parsers (CSV, casts). Return false when the text does not fit the type.
        public static bool ParseLong(string s, out long v)
        {
            return long.TryParse(s, NumberStyles.AllowLeadingSign | NumberStyles.AllowLeadingWhite | NumberStyles.AllowTrailingWhite, CultureInfo.InvariantCulture, out v);
        }
        public static bool ParseDouble(string s, out double v)
        {
            if (FastDouble(s, null, 0, s.Length, out v)) return true;
            if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return true;
            string t = s.Trim().ToLowerInvariant();
            if (t == "nan") { v = double.NaN; return true; }
            if (t == "inf" || t == "infinity") { v = double.PositiveInfinity; return true; }
            if (t == "-inf" || t == "-infinity") { v = double.NegativeInfinity; return true; }
            return false;
        }
        public static bool ParseBool(string s, out bool v)
        {
            string t = s.Trim().ToLowerInvariant();
            if (t == "true" || t == "t" || t == "yes" || t == "y" || t == "1") { v = true; return true; }
            if (t == "false" || t == "f" || t == "no" || t == "n" || t == "0") { v = false; return true; }
            v = false; return false;
        }
        private static readonly string[] DateFormats = { "yyyy-MM-dd", "yyyy-M-d", "yyyy/MM/dd", "yyyy/M/d" };
        private static readonly string[] TimeFormats = {
            "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm",
            "yyyy-MM-dd HH:mm:ss.FFFFFFF", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF", "yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK",
            "yyyy-MM-dd HH:mm:ssK", "yyyy-MM-dd HH:mm:ss.FFFFFFFK", "yyyy/MM/dd HH:mm:ss", "yyyy-MM-dd" };
        public static bool ParseDate(string s, out long days)
        {
            DateTime d;
            if (s.Length >= 8 && s.Length <= 10 && DateTime.TryParseExact(s.Trim(), DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out d)) { days = Days(DateTime.SpecifyKind(d, DateTimeKind.Utc)); return true; }
            days = 0; return false;
        }
        public static bool ParseTimestamp(string s, out long micros)
        {
            DateTime d;
            if (s.Length >= 10 && DateTime.TryParseExact(s.Trim(), TimeFormats, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out d))
            { micros = Micros(DateTime.SpecifyKind(d, DateTimeKind.Utc)); return true; }
            micros = 0; return false;
        }

        public static string JsonEscape(string s)
        {
            StringBuilder sb = new StringBuilder(s.Length + 2);
            AppendJsonString(sb, s);
            return sb.ToString();
        }
        public static void AppendJsonString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20 || ch == (char)0x2028 || ch == (char)0x2029) sb.Append("\\u").Append(((int)ch).ToString("x4")); else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
        }
        // A cell as a JSON value. Big integers that JS cannot hold exactly become strings.
        public static void AppendJson(StringBuilder sb, Column c, int i)
        {
            if (c.IsNull(i) || c.Type.Kind == Kind.Null) { sb.Append("null"); return; }
            switch (c.Type.Kind)
            {
                case Kind.Bool: sb.Append(c.B[i] ? "true" : "false"); return;
                case Kind.Int:
                    long v = c.I[i];
                    if (v > 9007199254740991L || v < -9007199254740991L) AppendJsonString(sb, v.ToString(CultureInfo.InvariantCulture));
                    else sb.Append(v.ToString(CultureInfo.InvariantCulture));
                    return;
                case Kind.Double: case Kind.Decimal:
                    double d = c.F[i];
                    if (double.IsNaN(d) || double.IsInfinity(d)) AppendJsonString(sb, Num(d));
                    else sb.Append(R(c.Type.Kind == Kind.Decimal ? Math.Round(d, c.Type.Scale) : d));
                    return;
                default: AppendJsonString(sb, Text(c, i)); return;
            }
        }
    }
}
