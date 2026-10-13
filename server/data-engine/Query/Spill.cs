// Spill to disk. A blocking operator (GROUP BY, join build side, sort, window) works in memory first; when it would go
// over the engine memory budget it runs again with its input cut into pieces on disk (temp\spill\q-*).
// Disk only holds rows: every piece is read back into memory and worked there.
//  - GROUP BY / window (PARTITION BY) / join: rows are split by a hash of their keys into partitions, so every key's
//    rows are in one partition; each partition is then done in memory on its own (a partition still too big splits again).
//  - Sort: sorted runs that fit in memory are written out, then merged a batch at a time.
// Spill files are a plain column dump (types, nulls, values; pruned placeholder columns stay placeholders).
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace NativeDataEngine
{
    public static class Spill
    {
        public const int Partitions = 64;
        public static int Count;   // spills since the engine started (status, tests)
        public static bool Enabled = true;   // EngineOptions.SpillToDisk; off = work that does not fit fails with QUERY_OUT_OF_MEMORY

        // True for the engine's own memory-budget error or a real .NET out-of-memory (also wrapped by the worker pool).
        public static bool IsOom(Exception e)
        {
            if (!Enabled) return false;
            while (e != null)
            {
                EngineException ee = e as EngineException;
                if (ee != null) return ee.Code == "QUERY_OUT_OF_MEMORY" && ee.Message.IndexOf("too many rows", StringComparison.Ordinal) < 0;
                if (e is OutOfMemoryException) return true;
                AggregateException ae = e as AggregateException;
                e = ae != null && ae.InnerExceptions.Count == 1 ? ae.InnerExceptions[0] : e.InnerException;
            }
            return false;
        }

        public static Column[] Eval(List<BExpr> es, Batch b)
        {
            Column[] r = new Column[es.Count];
            for (int k = 0; k < r.Length; k++) r[k] = es[k].Eval(b);
            return r;
        }

        // Partition of each row (same keys -> same partition; seed changes the split when a partition splits again).
        public static int[] PartOf(Column[] kc, int n, int parts, int seed)
        {
            int[] p = new int[n];
            for (int i = 0; i < n; i++)
            {
                ulong x = 1469598103934665603UL ^ (ulong)(seed * 0x9E3779B1L);
                foreach (Column c in kc)
                {
                    ulong h;
                    if (c.IsNull(i) || c.Type.Kind == Kind.Null) h = 7;
                    else if (c.I != null) h = (ulong)c.I[i];
                    else if (c.F != null) { double d = c.F[i]; h = (ulong)BitConverter.DoubleToInt64Bits(d == 0 ? 0.0 : d); }
                    else if (c.S != null) h = (ulong)(uint)StringComparer.Ordinal.GetHashCode(c.S[i]);
                    else h = c.B != null && c.B[i] ? 3UL : 5UL;
                    x = (x ^ h) * 1099511628211UL;
                    x ^= x >> 29;
                }
                x *= 0xBF58476D1CE4E5B9UL; x ^= x >> 31;
                p[i] = (int)(x % (ulong)parts);
            }
            return p;
        }

        // Splits input into partitions on disk by its keys.
        public static SpillFile[] Partition(SpillDir dir, Schema s, IEnumerable<Batch> input, Func<Batch, Column[]> keys, int parts, int seed, ExecCtx ctx)
        {
            SpillFile[] files = new SpillFile[parts];
            for (int p = 0; p < parts; p++) files[p] = dir.File(s);
            try
            {
                foreach (Batch b in input)
                {
                    ctx.Ct.ThrowIfCancellationRequested();
                    if (b.Rows == 0) continue;
                    int[] pt = PartOf(keys(b), b.Rows, parts, seed);
                    int[] count = new int[parts];
                    foreach (int x in pt) count[x]++;
                    int[][] idx = new int[parts][];
                    for (int p = 0; p < parts; p++) if (count[p] > 0) idx[p] = new int[count[p]];
                    int[] fill = new int[parts];
                    for (int i = 0; i < pt.Length; i++) idx[pt[i]][fill[pt[i]]++] = i;
                    for (int p = 0; p < parts; p++)
                        if (count[p] > 0) files[p].Append(count[p] == b.Rows ? b : b.Take(idx[p], count[p]));
                }
                foreach (SpillFile f in files) f.Finish();
                return files;
            }
            catch { foreach (SpillFile f in files) f.Dispose(); throw; }
        }

        public static bool IsPlaceholder(Column c) { return c.Type.Kind != Kind.Null && c.I == null && c.F == null && c.B == null && c.S == null; }
    }

    // A query's spill folder; deleted at the end of the query (or by Dispose).
    public sealed class SpillDir : IDisposable
    {
        public readonly string Path;
        public SpillDir(ExecCtx ctx, string what)
        {
            Path = System.IO.Path.Combine(DataEngine.SpillRoot, "q-" + Guid.NewGuid().ToString("N").Substring(0, 10));
            Directory.CreateDirectory(Path);
            ctx.OnEnd(this);
            System.Threading.Interlocked.Increment(ref Spill.Count);
            EngineLog.Write("engine", what + " does not fit in the memory budget: spilling to disk");
        }
        int n;
        public SpillFile File(Schema s) { return new SpillFile(System.IO.Path.Combine(Path, (n++).ToString("000000") + ".spill"), s); }
        public void Dispose() { try { if (Directory.Exists(Path)) Directory.Delete(Path, true); } catch { } }
    }

    // Batches written to one file, read back in the same order.
    public sealed class SpillFile : IDisposable
    {
        readonly string path; readonly Schema schema; FileStream fs; BinaryWriter w;
        public long Rows;
        public SpillFile(string path, Schema s) { this.path = path; schema = s; }
        public long Bytes { get { return System.IO.File.Exists(path) ? new FileInfo(path).Length : 0; } }

        public void Append(Batch b)
        {
            if (b.Rows == 0) return;
            if (w == null) { fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 20); w = new BinaryWriter(fs, Encoding.UTF8); }
            w.Write(b.Rows);
            foreach (Column c in b.Cols) WriteCol(c, b.Rows);
            Rows += b.Rows;
        }
        public void Finish() { if (w != null) { w.Flush(); w.Dispose(); w = null; fs = null; } }

        void WriteCol(Column c, int n)
        {
            byte kind = c.I != null ? (byte)1 : c.F != null ? (byte)2 : c.B != null ? (byte)4 : c.S != null ? (byte)3 : (byte)0;
            w.Write(kind);
            w.Write(c.Type.Name);
            w.Write(c.Nulls != null);
            if (c.Nulls != null) { byte[] nb = new byte[n]; for (int i = 0; i < n; i++) nb[i] = c.Nulls[i] ? (byte)1 : (byte)0; w.Write(nb); }
            switch (kind)
            {
                case 1: { byte[] a = new byte[8L * n]; Buffer.BlockCopy(c.I, 0, a, 0, a.Length); w.Write(a); break; }
                case 2: { byte[] a = new byte[8L * n]; Buffer.BlockCopy(c.F, 0, a, 0, a.Length); w.Write(a); break; }
                case 4: { byte[] a = new byte[n]; for (int i = 0; i < n; i++) a[i] = c.B[i] ? (byte)1 : (byte)0; w.Write(a); break; }
                case 3:
                    {
                        string[] s = c.S;
                        for (int i = 0; i < n; i++) { string v = s[i]; if (v == null) w.Write(false); else { w.Write(true); w.Write(v); } }
                        break;
                    }
            }
        }

        public IEnumerable<Batch> Read()
        {
            Finish();
            if (!System.IO.File.Exists(path)) yield break;
            using (FileStream r = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20))
            using (BinaryReader br = new BinaryReader(r, Encoding.UTF8))
            {
                while (r.Position < r.Length)
                {
                    int n = br.ReadInt32();
                    Column[] cs = new Column[schema.Count];
                    for (int k = 0; k < cs.Length; k++) cs[k] = ReadCol(br, n);
                    yield return new Batch(schema, cs, n);
                }
            }
        }
        static Column ReadCol(BinaryReader br, int n)
        {
            byte kind = br.ReadByte();
            string tn = br.ReadString();
            Column c = new Column(DataType.Null, 0);
            c.Type = tn == "NULL" ? DataType.Null : DataType.Parse(tn); c.Length = n; c.Nulls = null;
            if (br.ReadBoolean()) { byte[] nb = br.ReadBytes(n); c.Nulls = new bool[n]; for (int i = 0; i < n; i++) c.Nulls[i] = nb[i] != 0; }
            switch (kind)
            {
                case 1: { byte[] a = br.ReadBytes(8 * n); c.I = new long[n]; Buffer.BlockCopy(a, 0, c.I, 0, a.Length); break; }
                case 2: { byte[] a = br.ReadBytes(8 * n); c.F = new double[n]; Buffer.BlockCopy(a, 0, c.F, 0, a.Length); break; }
                case 4: { byte[] a = br.ReadBytes(n); c.B = new bool[n]; for (int i = 0; i < n; i++) c.B[i] = a[i] != 0; break; }
                case 3: { string[] s = new string[n]; for (int i = 0; i < n; i++) if (br.ReadBoolean()) s[i] = br.ReadString(); c.S = s; break; }
            }
            if (c.Type.Kind == Kind.Null && c.Nulls == null) { c.Nulls = new bool[n]; for (int i = 0; i < n; i++) c.Nulls[i] = true; }
            return c;
        }
        public void Dispose() { Finish(); try { if (System.IO.File.Exists(path)) System.IO.File.Delete(path); } catch { } }
    }
}
