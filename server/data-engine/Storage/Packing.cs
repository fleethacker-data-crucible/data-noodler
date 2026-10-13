// Packed columns for resident datasets: the same values in less memory, unpacked into a plain copy per query
// (MemSource), so every operator still sees long[] / double[] / string[].
//  - Whole numbers, dates, timestamps: value = PackBase + d * PackStep, d held in 1, 2 or 4 bytes (byte / ushort / uint).
//    PackStep is 1, or 1000 / 1000000 when every value is a whole multiple of it past the base (timestamps in whole
//    seconds or milliseconds).
//  - Doubles / decimals that are exact decimals with up to 4 places (prices, amounts, whole numbers): held as whole
//    numbers q (packed as above) with value = q / PackDiv; packed only when every value comes back bit for bit.
//  - Repeated text (shared strings): codes into Dict (byte / ushort / int per row instead of an 8-byte reference).
// Anything that does not get smaller stays as it is. Null rows hold 0 (their value is never read).
using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace NativeDataEngine
{
    public static class Packing
    {
        static readonly double[] Divs = { 1, 10, 100, 1000, 10000 };
        static readonly long[] Steps = { 1000000, 1000 };

        public static Column Pack(Column c)
        {
            if (c.IsPacked || c.IsLazyText || c.Length == 0) return c;
            if (c.I != null) return Ints(c, c.I, 0) ?? c;
            if (c.F != null)
            {
                long[] q; double div;
                return Scaled(c, out q, out div) ? (Ints(c, q, div) ?? c) : c;
            }
            if (c.Type.Kind == Kind.String && c.S != null) return Codes(c);
            return c;
        }

        // Plain copy for one query.
        public static Column Unpack(Column c)
        {
            int n = c.Length;
            if (c.Dict != null)
            {
                string[] o = new string[n]; string[] dict = c.Dict; bool[] nl = c.Nulls;
                byte[] b8 = c.Packed as byte[]; ushort[] b16 = c.Packed as ushort[]; int[] b32 = c.Packed as int[];
                if (b8 != null) for (int i = 0; i < n; i++) o[i] = dict[b8[i]];
                else if (b16 != null) for (int i = 0; i < n; i++) o[i] = dict[b16[i]];
                else for (int i = 0; i < n; i++) o[i] = dict[b32[i]];
                if (nl != null) for (int i = 0; i < n; i++) if (nl[i]) o[i] = null;
                return Column.Strings(c.Type, n, nl, o);
            }
            long bas = c.PackBase, step = c.PackStep;
            byte[] p8 = c.Packed as byte[]; ushort[] p16 = c.Packed as ushort[]; uint[] p32 = c.Packed as uint[];
            if (c.PackDiv > 0)
            {
                Column r = new Column(c.Type, n); r.Nulls = c.Nulls; double[] f = r.F; double div = c.PackDiv;
                if (p8 != null) for (int i = 0; i < n; i++) f[i] = (bas + p8[i] * step) / div;
                else if (p16 != null) for (int i = 0; i < n; i++) f[i] = (bas + p16[i] * step) / div;
                else for (int i = 0; i < n; i++) f[i] = (bas + p32[i] * step) / div;
                return r;
            }
            Column x = new Column(c.Type, n); x.Nulls = c.Nulls; long[] v = x.I;
            if (step == 1)
            {
                if (p8 != null) for (int i = 0; i < n; i++) v[i] = bas + p8[i];
                else if (p16 != null) for (int i = 0; i < n; i++) v[i] = bas + p16[i];
                else for (int i = 0; i < n; i++) v[i] = bas + p32[i];
            }
            else
            {
                if (p8 != null) for (int i = 0; i < n; i++) v[i] = bas + p8[i] * step;
                else if (p16 != null) for (int i = 0; i < n; i++) v[i] = bas + p16[i] * step;
                else for (int i = 0; i < n; i++) v[i] = bas + (long)p32[i] * step;
            }
            return x;
        }

        // Whole numbers v (div = 0: the column's own longs; div > 0: doubles scaled by div). null = no gain.
        static Column Ints(Column c, long[] v, double div)
        {
            int n = c.Length; bool[] nl = c.Nulls;
            long min = long.MaxValue, max = long.MinValue;
            for (int i = 0; i < n; i++) { if (nl != null && nl[i]) continue; long x = v[i]; if (x < min) min = x; if (x > max) max = x; }
            if (min > max) { min = 0; max = 0; }   // all null
            if (max - min < 0) return null;        // range overflows a long
            ulong range = (ulong)(max - min); long step = 1;
            if (range > ushort.MaxValue)
                foreach (long s in Steps)
                {
                    if (range / (ulong)s == 0) continue;
                    bool all = true;
                    for (int i = 0; i < n && all; i++) if (!(nl != null && nl[i]) && (v[i] - min) % s != 0) all = false;
                    if (all) { step = s; range /= (ulong)s; break; }
                }
            Array p;
            if (range <= byte.MaxValue) { byte[] a = new byte[n]; for (int i = 0; i < n; i++) if (!(nl != null && nl[i])) a[i] = (byte)((v[i] - min) / step); p = a; }
            else if (range <= ushort.MaxValue) { ushort[] a = new ushort[n]; for (int i = 0; i < n; i++) if (!(nl != null && nl[i])) a[i] = (ushort)((v[i] - min) / step); p = a; }
            else if (range <= uint.MaxValue) { uint[] a = new uint[n]; for (int i = 0; i < n; i++) if (!(nl != null && nl[i])) a[i] = (uint)((v[i] - min) / step); p = a; }
            else return null;
            return Column.PackedOf(c.Type, n, nl, p, min, step, div, null);
        }

        // Doubles that are exact decimals (up to 4 places): q = v * div as whole numbers, with q / div == v bit for bit.
        static bool Scaled(Column c, out long[] q, out double div)
        {
            int n = c.Length; double[] f = c.F; bool[] nl = c.Nulls;
            q = new long[n]; div = 0;
            foreach (double d in Divs)
            {
                bool ok = true;
                for (int i = 0; i < n; i++)
                {
                    if (nl != null && nl[i]) { q[i] = 0; continue; }
                    double v = f[i], x = Math.Round(v * d);
                    if (double.IsNaN(x) || Math.Abs(x) > 9007199254740992.0) { ok = false; break; }
                    long w = (long)x;
                    if (BitConverter.DoubleToInt64Bits(w / d) != BitConverter.DoubleToInt64Bits(v)) { ok = false; break; }
                    q[i] = w;
                }
                if (ok) { div = d; return true; }
            }
            q = null; return false;
        }

        // Shared strings -> codes into a per-batch dictionary (equal values are one string object, so references are
        // compared; a value held twice just gets two codes).
        static Column Codes(Column c)
        {
            int n = c.Length; string[] s = c.S; bool[] nl = c.Nulls;
            Dictionary<string, int> at = new Dictionary<string, int>(Same.Instance);
            List<string> dict = new List<string>();
            int[] code = new int[n];
            for (int i = 0; i < n; i++)
            {
                string v = s[i]; if (v == null) continue;
                int k; if (!at.TryGetValue(v, out k)) { k = dict.Count; at[v] = k; dict.Add(v); }
                code[i] = k;
            }
            if (dict.Count == 0) dict.Add(null);
            Array p;
            if (dict.Count <= 256) { byte[] a = new byte[n]; for (int i = 0; i < n; i++) a[i] = (byte)code[i]; p = a; }
            else if (dict.Count <= 65536) { ushort[] a = new ushort[n]; for (int i = 0; i < n; i++) a[i] = (ushort)code[i]; p = a; }
            else p = code;
            return Column.PackedOf(c.Type, n, nl, p, 0, 1, 0, dict.ToArray());
        }
        sealed class Same : IEqualityComparer<string>
        {
            public static readonly Same Instance = new Same();
            public bool Equals(string a, string b) { return ReferenceEquals(a, b); }
            public int GetHashCode(string s) { return RuntimeHelpers.GetHashCode(s); }
        }
    }
}
