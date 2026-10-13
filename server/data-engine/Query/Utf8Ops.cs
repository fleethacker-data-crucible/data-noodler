// Text kept as UTF-8 bytes (Column.IsLazyText: resident datasets' mostly-distinct text, Arrow reads) is searched and
// compared on the bytes, so filters (LIKE / ILIKE, = / <> / < / >, IN) and min / max make no string per row.
// Answers are the same as on strings (ordinal):
//  - equality and substring search: UTF-8 is self-synchronising, so a byte match is a character match;
//  - order: UTF-8 byte order is code point order, which is UTF-16 ordinal order except U+E000..U+FFFF (lead byte
//    EE / EF) against supplementary characters (lead F0..F4); that one case is flipped (Compare).
//  - ILIKE: bytes are folded for ASCII only; a value with non-ASCII bytes is decoded and matched as a string.
using System;
using System.Text;

namespace NativeDataEngine
{
    public static class Utf8Ops
    {
        public static byte[] Bytes(string s) { return Encoding.UTF8.GetBytes(s); }

        // Row i vs constant bytes k: <0, 0, >0 with string.CompareOrdinal's order.
        public static int Compare(byte[] u, int a, int n, byte[] k)
        {
            int m = Math.Min(n, k.Length);
            for (int j = 0; j < m; j++)
            {
                byte x = u[a + j], y = k[j];
                if (x != y) return Order(x, y);
            }
            return n.CompareTo(k.Length);
        }
        // Two rows of byte columns.
        public static int Compare(byte[] u, int a, int n, byte[] v, int b, int m)
        {
            int l = Math.Min(n, m);
            for (int j = 0; j < l; j++)
            {
                byte x = u[a + j], y = v[b + j];
                if (x != y) return Order(x, y);
            }
            return n.CompareTo(m);
        }
        // First differing bytes: UTF-16 puts surrogate pairs (supplementary, lead F0..F4) before U+E000..U+FFFF (EE / EF).
        static int Order(byte x, byte y)
        {
            bool xs = x >= 0xF0, ys = y >= 0xF0, xh = x == 0xEE || x == 0xEF, yh = y == 0xEE || y == 0xEF;
            if (xs && yh) return -1;
            if (xh && ys) return 1;
            return x < y ? -1 : 1;
        }
        public static bool Equal(byte[] u, int a, int n, byte[] k)
        {
            if (n != k.Length) return false;
            for (int j = 0; j < n; j++) if (u[a + j] != k[j]) return false;
            return true;
        }
        // FNV-1a over UTF-16 code units: the same number for a string and for its UTF-8 bytes (decoded on the fly), so
        // spill partitions agree whichever way a batch holds its text.
        public static int CharHash(string s)
        {
            unchecked { int h = (int)2166136261; for (int i = 0; i < s.Length; i++) h = (h ^ s[i]) * 16777619; return h; }
        }
        public static int CharHash(byte[] u, int a, int n)
        {
            unchecked
            {
                int h = (int)2166136261, e = a + n;
                for (int i = a; i < e; )
                {
                    int b = u[i], cp;
                    if (b < 0x80) { cp = b; i++; }
                    else if (b < 0xE0) { cp = ((b & 0x1F) << 6) | (u[i + 1] & 0x3F); i += 2; }
                    else if (b < 0xF0) { cp = ((b & 0x0F) << 12) | ((u[i + 1] & 0x3F) << 6) | (u[i + 2] & 0x3F); i += 3; }
                    else
                    {
                        cp = ((b & 0x07) << 18) | ((u[i + 1] & 0x3F) << 12) | ((u[i + 2] & 0x3F) << 6) | (u[i + 3] & 0x3F); i += 4;
                        cp -= 0x10000;
                        h = (h ^ (0xD800 + (cp >> 10))) * 16777619;   // surrogate pair, as in the string
                        cp = 0xDC00 + (cp & 0x3FF);
                    }
                    h = (h ^ cp) * 16777619;
                }
                return h;
            }
        }
        // string.Length of the text: one per character, two for a 4-byte (supplementary) character.
        public static int Utf16Length(byte[] u, int a, int n)
        {
            int r = 0;
            for (int i = a; i < a + n; i++) { byte b = u[i]; if ((b & 0xC0) != 0x80) r += b >= 0xF0 ? 2 : 1; }
            return r;
        }
        // Sort helper: each row's first 8 bytes as one big-endian number (shorter text padded with 0), so most comparisons
        // are one number compare. slow[i]: the prefix holds a byte >= EE (the UTF-16 order exception), compare in full.
        // Equal prefixes also compare in full (they may still differ later, or in length).
        public static void Prefixes(Column c, out ulong[] pre, out bool[] slow)
        {
            int n = c.Length; byte[] u = c.Utf8; int[] f = c.Offs;
            pre = new ulong[n]; slow = new bool[n];
            for (int i = 0; i < n; i++)
            {
                int a = f[i], m = Math.Min(8, f[i + 1] - a); ulong p = 0; bool s = false;
                for (int j = 0; j < 8; j++) { byte b = j < m ? u[a + j] : (byte)0; if (b >= 0xEE) s = true; p = (p << 8) | b; }
                pre[i] = p; slow[i] = s;
            }
        }
        public static bool Ascii(byte[] u, int a, int n) { for (int j = 0; j < n; j++) if (u[a + j] >= 0x80) return false; return true; }
    }

    // LIKE / ILIKE with text and % only, on UTF-8 bytes (LikeMatch's rules; ci = ASCII folding, see Utf8Ops).
    public sealed class LikeBytes
    {
        readonly byte[][] segs; readonly bool start, end, ci; readonly int minLen;
        public LikeBytes(string[] segs, bool start, bool end, bool ci)
        {
            this.segs = new byte[segs.Length][]; for (int k = 0; k < segs.Length; k++) { this.segs[k] = Encoding.UTF8.GetBytes(segs[k]); minLen += this.segs[k].Length; }
            this.start = start; this.end = end; this.ci = ci;
        }
        static byte Fold(byte b) { return b >= (byte)'A' && b <= (byte)'Z' ? (byte)(b + 32) : b; }
        bool At(byte[] u, int at, byte[] g)
        {
            if (ci) { for (int k = 0; k < g.Length; k++) if (Fold(u[at + k]) != g[k]) return false; }
            else for (int k = 0; k < g.Length; k++) if (u[at + k] != g[k]) return false;
            return true;
        }
        int Find(byte[] u, byte[] g, int from, int limit)
        {
            if (g.Length == 0) return from;
            byte g0 = g[0];
            for (int i = from; i + g.Length <= limit; i++)
            {
                byte b = ci ? Fold(u[i]) : u[i];
                if (b == g0 && At(u, i, g)) return i;
            }
            return -1;
        }
        // Row text = u[a .. a + n).
        public bool Match(byte[] u, int a, int n)
        {
            if (n < minLen) return false;
            int k0 = segs.Length;
            if (k0 == 1) return n == segs[0].Length && At(u, a, segs[0]);
            int pos = a, limit = a + n;
            if (start) { if (!At(u, a, segs[0])) return false; pos = a + segs[0].Length; }
            if (end) { byte[] last = segs[k0 - 1]; if (limit - last.Length < pos || !At(u, limit - last.Length, last)) return false; limit -= last.Length; }
            for (int k = start ? 1 : 0; k < (end ? k0 - 1 : k0); k++)
            {
                int at = Find(u, segs[k], pos, limit);
                if (at < 0) return false;
                pos = at + segs[k].Length;
            }
            return true;
        }
    }
}
