// Text keys hashed and compared as UTF-8 bytes (GROUP BY, joins, DISTINCT, count(DISTINCT), Parquet dictionaries).
// A key arrives either as bytes (Column.IsLazyText: no string is made) or as a string (encoded into a per-thread buffer),
// so batches held either way meet in the same table. A key's string is made only when asked for (Key).
// Get (adds) is for one thread at a time; Find (read only) may run on many threads once the table is built.
using System;
using System.Text;

namespace NativeDataEngine
{
    public sealed class TextKeys
    {
        byte[] data = new byte[1024]; int used;          // every key's bytes, back to back
        int[] start = new int[16], len = new int[16];    // per id
        string[] str = new string[16];                   // per id, made on demand
        int[] slots = new int[32]; int mask = 31;         // id + 1 (0 = empty)
        int[] hashes = new int[16];
        int count;
        [ThreadStatic] static byte[] scratch;            // per thread: Find runs on many workers at once (join probes)

        public int Count { get { return count; } }

        public static int Hash(byte[] u, int a, int n)
        {
            unchecked { int h = (int)2166136261; for (int i = a; i < a + n; i++) h = (h ^ u[i]) * 16777619; return h ^ (n << 16); }
        }

        // Id of the key (added when new; added = true then).
        public int Get(byte[] u, int a, int n, out bool added)
        {
            int h = Hash(u, a, n), k = h & mask;
            for (int s; (s = slots[k]) != 0; k = (k + 1) & mask)
            {
                int id = s - 1;
                if (hashes[id] == h && len[id] == n && Same(id, u, a, n)) { added = false; return id; }
            }
            added = true;
            return Add(k, h, u, a, n);
        }
        public int Get(byte[] u, int a, int n) { bool x; return Get(u, a, n, out x); }
        // Id of the key, or -1 (never adds).
        public int Find(byte[] u, int a, int n)
        {
            int h = Hash(u, a, n), k = h & mask;
            for (int s; (s = slots[k]) != 0; k = (k + 1) & mask)
            {
                int id = s - 1;
                if (hashes[id] == h && len[id] == n && Same(id, u, a, n)) return id;
            }
            return -1;
        }
        public int Get(string v, out bool added) { int n = Enc(v); int id = Get(scratch, 0, n, out added); if (added) str[id] = v; return id; }
        public int Get(string v) { bool x; return Get(v, out x); }
        public int Find(string v) { int n = Enc(v); return Find(scratch, 0, n); }
        // Row i of a text column (bytes or strings).
        public int Get(Column c, int i, out bool added) { if (c.IsLazyText) return Get(c.Utf8, c.Offs[i], c.Offs[i + 1] - c.Offs[i], out added); return Get(c.S[i], out added); }
        public int Get(Column c, int i) { bool x; return Get(c, i, out x); }
        public int Find(Column c, int i) { if (c.IsLazyText) return Find(c.Utf8, c.Offs[i], c.Offs[i + 1] - c.Offs[i]); return Find(c.S[i]); }

        public string Key(int id) { return str[id] ?? (str[id] = len[id] == 0 ? "" : Encoding.UTF8.GetString(data, start[id], len[id])); }
        public byte[] Bytes { get { return data; } }
        public int Start(int id) { return start[id]; }
        public int Length(int id) { return len[id]; }

        int Enc(string v)
        {
            int max = v.Length * 3;
            if (scratch == null || scratch.Length < max) scratch = new byte[Math.Max(max, 256)];
            return Encoding.UTF8.GetBytes(v, 0, v.Length, scratch, 0);
        }
        bool Same(int id, byte[] u, int a, int n)
        {
            int s = start[id];
            for (int j = 0; j < n; j++) if (data[s + j] != u[a + j]) return false;
            return true;
        }
        int Add(int k, int h, byte[] u, int a, int n)
        {
            int id = count++;
            if (id == start.Length)
            {
                int cap = start.Length * 2;
                Array.Resize(ref start, cap); Array.Resize(ref len, cap); Array.Resize(ref str, cap); Array.Resize(ref hashes, cap);
            }
            if (used + n > data.Length) Array.Resize(ref data, Math.Max(used + n, data.Length * 2));
            Buffer.BlockCopy(u, a, data, used, n);
            start[id] = used; len[id] = n; hashes[id] = h; used += n;
            slots[k] = id + 1;
            if (count * 2 > slots.Length) Grow();
            return id;
        }
        void Grow()
        {
            int[] ns = new int[slots.Length * 2]; int nm = ns.Length - 1;
            for (int id = 0; id < count; id++) { int k = hashes[id] & nm; while (ns[k] != 0) k = (k + 1) & nm; ns[k] = id + 1; }
            slots = ns; mask = nm;
        }
    }
}
