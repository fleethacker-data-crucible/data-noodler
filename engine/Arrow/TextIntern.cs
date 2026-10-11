// Shared strings for repeated text while reading a column (CSV fields, Arrow UTF-8 buffers, resident datasets).
// A 10M-row column holding 10k distinct values then makes 10k strings instead of 10M: much less garbage and memory,
// and the garbage collector has far fewer objects to walk (the same effect as Parquet's dictionary pages).
// Mostly-distinct columns turn it off by themselves (after 4096 values with over half new), so they pay almost nothing.
using System;
using System.Collections.Generic;
using System.Text;

namespace NativeDataEngine
{
    public sealed class TextIntern
    {
        const int MaxEntries = 1 << 16, Probe = 4096;
        int mask = 255, used, seen;
        int[] hash = new int[256];
        string[] vals = new string[256];
        bool off;

        // Text of a char range: the shared string when the same text was seen before.
        public string Get(char[] a, int s, int n)
        {
            if (off) return new string(a, s, n);
            seen++;
            int h = unchecked((int)2166136261);
            for (int i = 0; i < n; i++) h = (h ^ a[s + i]) * 16777619;
            int k = h & mask;
            for (string v; (v = vals[k]) != null; k = (k + 1) & mask)
                if (hash[k] == h && v.Length == n && Same(v, a, s, n)) return v;
            return Add(k, h, new string(a, s, n));
        }
        // Text of a UTF-8 byte range (Arrow): compared by bytes, decoded once.
        public string Get(byte[] a, int s, int n)
        {
            if (off) return Encoding.UTF8.GetString(a, s, n);
            seen++;
            int h = unchecked((int)2166136261);
            for (int i = 0; i < n; i++) h = (h ^ a[s + i]) * 16777619;
            h ^= n << 24;
            int k = h & mask;
            for (string v; (v = vals[k]) != null; k = (k + 1) & mask)
                if (hash[k] == h && Utf8Same(v, a, s, n)) return v;
            return Add(k, h, Encoding.UTF8.GetString(a, s, n));
        }
        // A string already made (resident datasets): the shared one if it is a repeat.
        public string Get(string x)
        {
            if (off || x == null) return x;
            seen++;
            int h = unchecked((int)2166136261);
            for (int i = 0; i < x.Length; i++) h = (h ^ x[i]) * 16777619;
            int k = h & mask;
            for (string v; (v = vals[k]) != null; k = (k + 1) & mask)
                if (hash[k] == h && string.Equals(v, x)) return v;
            return Add(k, h, x);
        }
        // New distinct values (shared strings counted once; resident memory accounting).
        public int Distinct { get { return used; } }
        public bool Off { get { return off; } }

        string Add(int k, int h, string v)
        {
            hash[k] = h; vals[k] = v; used++;
            if (seen >= Probe && used * 2 > seen) { off = true; return v; }   // mostly distinct: stop sharing
            if (used * 2 > mask + 1)
            {
                if (mask + 1 >= MaxEntries) { off = true; return v; }
                Grow();
            }
            return v;
        }
        void Grow()
        {
            int[] oh = hash; string[] ov = vals;
            mask = mask * 2 + 1; hash = new int[mask + 1]; vals = new string[mask + 1];
            for (int i = 0; i < ov.Length; i++)
            {
                if (ov[i] == null) continue;
                int k = oh[i] & mask;
                while (vals[k] != null) k = (k + 1) & mask;
                hash[k] = oh[i]; vals[k] = ov[i];
            }
        }
        static bool Same(string v, char[] a, int s, int n) { for (int i = 0; i < n; i++) if (v[i] != a[s + i]) return false; return true; }
        // UTF-8 bytes equal to the string's UTF-8 form (ASCII fast; anything else re-encodes once).
        static bool Utf8Same(string v, byte[] a, int s, int n)
        {
            if (v.Length > n) return false;
            if (v.Length == n)
            {
                bool ascii = true;
                for (int i = 0; i < n; i++) { char c = v[i]; if (c >= 0x80) { ascii = false; break; } if (c != a[s + i]) return false; }
                if (ascii) return true;
            }
            byte[] b = Encoding.UTF8.GetBytes(v);
            if (b.Length != n) return false;
            for (int i = 0; i < n; i++) if (b[i] != a[s + i]) return false;
            return true;
        }
    }
}
