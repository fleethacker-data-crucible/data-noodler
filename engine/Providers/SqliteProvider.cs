// SQLite through Windows' own winsqlite3.dll (System32 on Windows 10/11): no third-party DLL.
// Import streams rows (sqlite3_step) into batches; export writes in one transaction with a prepared INSERT.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace NativeDataEngine
{
    [System.Security.SuppressUnmanagedCodeSecurity]   // no security stack walk on each call (millions of binds)
    internal static class WinSQLite
    {
        const string Dll = "winsqlite3.dll";
        // Before SQLite starts: multi-thread mode (each connection is used by one thread at a time, so no per-connection
        // locks) and no global memory statistics (they lock one mutex on every allocation, which stops parallel writers
        // from scaling). Returns an error, harmlessly, if SQLite was already started in this process.
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_config(int op);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, EntryPoint = "sqlite3_config")] static extern int sqlite3_config_int(int op, int v);
        static WinSQLite() { try { sqlite3_config(2); sqlite3_config_int(9, 0); } catch { } }
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_close_v2(IntPtr db);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int nByte, out IntPtr stmt, IntPtr tail);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_step(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_reset(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_finalize(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_column_count(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern IntPtr sqlite3_column_name(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_column_type(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern long sqlite3_column_int64(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern double sqlite3_column_double(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern IntPtr sqlite3_column_text(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern IntPtr sqlite3_column_blob(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_column_bytes(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern IntPtr sqlite3_errmsg(IntPtr db);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_bind_null(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_bind_int64(IntPtr stmt, int i, long v);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_bind_double(IntPtr stmt, int i, double v);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] internal static extern int sqlite3_bind_text(IntPtr stmt, int i, byte[] v, int n, IntPtr destructor);
        [DllImport(Dll, CallingConvention = CallingConvention.StdCall, EntryPoint = "sqlite3_bind_text")] internal static extern int sqlite3_bind_text_ptr(IntPtr stmt, int i, IntPtr v, int n, IntPtr destructor);

        internal const int ROW = 100, DONE = 101, OPEN_READONLY = 1, OPEN_READWRITE = 2, OPEN_CREATE = 4;
        internal static readonly IntPtr TRANSIENT = new IntPtr(-1);

        internal static string Utf8(IntPtr p)
        {
            if (p == IntPtr.Zero) return null;
            int n = 0; while (Marshal.ReadByte(p, n) != 0) n++;
            byte[] b = new byte[n]; Marshal.Copy(p, b, 0, n);
            return Encoding.UTF8.GetString(b);
        }
        internal static byte[] Z(string s) { byte[] b = Encoding.UTF8.GetBytes(s); byte[] r = new byte[b.Length + 1]; Buffer.BlockCopy(b, 0, r, 0, b.Length); return r; }
    }

    public sealed class SqliteDb : IDisposable
    {
        IntPtr db;
        public SqliteDb(string path, bool write)
        {
            int rc;
            try { rc = WinSQLite.sqlite3_open_v2(WinSQLite.Z(path), out db, write ? WinSQLite.OPEN_READWRITE | WinSQLite.OPEN_CREATE : WinSQLite.OPEN_READONLY, IntPtr.Zero); }
            catch (DllNotFoundException) { throw new EngineException("SQLITE_UNAVAILABLE", "winsqlite3.dll was not found (it ships with Windows 10/11)."); }
            if (rc != 0) { string m = Err(); Dispose(); throw new EngineException("SQLITE_OPEN_FAILED", "Could not open SQLite file " + Path.GetFileName(path) + ": " + m); }
        }
        public string Err() { return db == IntPtr.Zero ? "unknown error" : WinSQLite.Utf8(WinSQLite.sqlite3_errmsg(db)); }
        public SqliteStmt Prepare(string sql)
        {
            IntPtr st; byte[] b = WinSQLite.Z(sql);
            int rc = WinSQLite.sqlite3_prepare_v2(db, b, b.Length, out st, IntPtr.Zero);
            if (rc != 0) throw new EngineException("SQLITE_QUERY_FAILED", "SQLite: " + Err());
            return new SqliteStmt(this, st);
        }
        public void Exec(string sql) { using (SqliteStmt s = Prepare(sql)) s.Step(); }
        public List<string> Tables()
        {
            List<string> r = new List<string>();
            using (SqliteStmt s = Prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY 1"))
                while (s.Step()) r.Add(s.Text(0));
            return r;
        }
        public void Dispose() { if (db != IntPtr.Zero) { WinSQLite.sqlite3_close_v2(db); db = IntPtr.Zero; } }
        public static string Q(string name) { return "\"" + name.Replace("\"", "\"\"") + "\""; }

        // SQLite declared type -> engine type (SQLite affinity rules).
        public static DataType TypeOf(string decl)
        {
            string t = (decl ?? "").ToUpperInvariant();
            if (t.Contains("INT")) return DataType.BigInt;
            if (t.Contains("CHAR") || t.Contains("CLOB") || t.Contains("TEXT")) return DataType.Varchar;
            if (t.Contains("REAL") || t.Contains("FLOA") || t.Contains("DOUB") || t.Contains("DEC") || t.Contains("NUM")) return DataType.Double;
            if (t.Contains("BOOL")) return DataType.Bool;
            return DataType.Varchar;
        }
    }

    public sealed class SqliteStmt : IDisposable
    {
        readonly SqliteDb db; IntPtr st;
        internal SqliteStmt(SqliteDb db, IntPtr st) { this.db = db; this.st = st; }
        internal IntPtr Handle { get { return st; } }
        public bool Step()
        {
            int rc = WinSQLite.sqlite3_step(st);
            if (rc == WinSQLite.ROW) return true;
            if (rc == WinSQLite.DONE) return false;
            throw new EngineException("SQLITE_QUERY_FAILED", "SQLite: " + db.Err());
        }
        public void Reset() { WinSQLite.sqlite3_reset(st); }
        public int Columns { get { return WinSQLite.sqlite3_column_count(st); } }
        public string Name(int i) { return WinSQLite.Utf8(WinSQLite.sqlite3_column_name(st, i)); }
        public int Kind(int i) { return WinSQLite.sqlite3_column_type(st, i); }
        public long Long(int i) { return WinSQLite.sqlite3_column_int64(st, i); }
        public double Double(int i) { return WinSQLite.sqlite3_column_double(st, i); }
        public string Text(int i)
        {
            IntPtr p = WinSQLite.sqlite3_column_text(st, i); if (p == IntPtr.Zero) return null;
            int n = WinSQLite.sqlite3_column_bytes(st, i); byte[] b = new byte[n]; Marshal.Copy(p, b, 0, n);
            return Encoding.UTF8.GetString(b);
        }
        public string Blob(int i)
        {
            IntPtr p = WinSQLite.sqlite3_column_blob(st, i); int n = WinSQLite.sqlite3_column_bytes(st, i);
            if (p == IntPtr.Zero || n == 0) return "";
            byte[] b = new byte[n]; Marshal.Copy(p, b, 0, n); return Convert.ToBase64String(b);
        }
        public void Bind(int i, Column c, int r)
        {
            if (c.IsNull(r) || c.Type.Kind == NativeDataEngine.Kind.Null) { WinSQLite.sqlite3_bind_null(st, i); return; }
            switch (c.Type.Kind)
            {
                case NativeDataEngine.Kind.Int: WinSQLite.sqlite3_bind_int64(st, i, c.I[r]); return;
                case NativeDataEngine.Kind.Bool: WinSQLite.sqlite3_bind_int64(st, i, c.B[r] ? 1 : 0); return;
                case NativeDataEngine.Kind.Double: case NativeDataEngine.Kind.Decimal: WinSQLite.sqlite3_bind_double(st, i, c.F[r]); return;
                default: { byte[] b = Encoding.UTF8.GetBytes(Values.Text(c, r)); WinSQLite.sqlite3_bind_text(st, i, b, b.Length, WinSQLite.TRANSIENT); return; }
            }
        }
        public void Dispose() { if (st != IntPtr.Zero) { WinSQLite.sqlite3_finalize(st); st = IntPtr.Zero; } }
    }

    public sealed class SqliteSource : Source
    {
        readonly string path, table; readonly int per;
        public SqliteSource(string path, string table, int per)
        {
            this.path = path; this.per = per;
            using (SqliteDb db = new SqliteDb(path, false))
            {
                if (string.IsNullOrEmpty(table))
                {
                    List<string> ts = db.Tables();
                    if (ts.Count == 0) throw new EngineException("SQLITE_EMPTY", "The SQLite file has no tables.");
                    table = ts[0];
                }
                this.table = table;
                List<Field> fs = new List<Field>();
                using (SqliteStmt s = db.Prepare("PRAGMA table_info(" + SqliteDb.Q(table) + ")"))
                    while (s.Step()) fs.Add(new Field(s.Text(1), SqliteDb.TypeOf(s.Text(2))));
                if (fs.Count == 0) throw new EngineException("SQLITE_TABLE_NOT_FOUND", "SQLite table \"" + table + "\" not found.");
                Schema = new Schema(fs);
            }
        }
        // Parallel read: a table with rowids is cut into rowid ranges (about 200k rows each, up to 64), one unit each, read
        // on its own read-only connection; units come back in rowid order, the order a plain SELECT * returns. Views and
        // WITHOUT ROWID tables (no rowid) stay one unit.
        long[] cuts;   // unit u = rowid in [cuts[u], cuts[u + 1]); null = one unit, plain SELECT *
        bool planned;
        readonly object gate = new object();
        void Plan()
        {
            lock (gate)
            {
                if (planned) return;
                planned = true;
                try
                {
                    using (SqliteDb db = new SqliteDb(path, false))
                    using (SqliteStmt s = db.Prepare("SELECT min(rowid), max(rowid) FROM " + SqliteDb.Q(table)))
                    {
                        if (!s.Step() || s.Kind(0) == 5) return;
                        long lo = s.Long(0), hi = s.Long(1);
                        long span = hi - lo + 1, k = Math.Max(1, Math.Min(64, span / 200000));
                        if (k < 2) return;
                        long[] c = new long[k + 1];
                        for (long u = 0; u <= k; u++) c[u] = lo + span * u / k;
                        c[k] = hi + 1;
                        cuts = c;
                    }
                }
                catch (EngineException) { cuts = null; }   // no rowid (view / WITHOUT ROWID): one unit
            }
        }
        public override int Units(ExecCtx ctx) { Plan(); return cuts == null ? 1 : cuts.Length - 1; }
        public override long KnownRows(ExecCtx ctx) { return -1; }
        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit)
        {
            int w = Schema.Count;
            Plan();
            string sql = cuts == null ? "SELECT * FROM " + SqliteDb.Q(table)
                : "SELECT * FROM " + SqliteDb.Q(table) + " WHERE rowid >= " + cuts[unit] + " AND rowid < " + cuts[unit + 1] + " ORDER BY rowid";
            using (SqliteDb db = new SqliteDb(path, false))
            using (SqliteStmt s = db.Prepare(sql))
            {
                ColumnBuilder[] cb = New(); int rows = 0;
                while (s.Step())
                {
                    for (int c = 0; c < w; c++)
                    {
                        int k = s.Kind(c); DataType t = Schema[c].Type;
                        if (k == 5) { cb[c].AddNull(); continue; }
                        switch (t.Kind)
                        {
                            case Kind.Int:
                                if (k == 1) cb[c].AddLong(s.Long(c));
                                else if (k == 2) { double d = s.Double(c); if (d == Math.Floor(d) && Math.Abs(d) < 9e18) cb[c].AddLong((long)d); else cb[c].AddNull(); }
                                else { long l; if (Values.ParseLong(s.Text(c) ?? "", out l)) cb[c].AddLong(l); else cb[c].AddNull(); }
                                break;
                            case Kind.Double:
                                if (k == 1 || k == 2) cb[c].AddDouble(s.Double(c));
                                else { double d; if (Values.ParseDouble(s.Text(c) ?? "", out d)) cb[c].AddDouble(d); else cb[c].AddNull(); }
                                break;
                            case Kind.Bool:
                                if (k == 1 || k == 2) cb[c].AddBool(s.Long(c) != 0);
                                else { bool b; if (Values.ParseBool(s.Text(c) ?? "", out b)) cb[c].AddBool(b); else cb[c].AddNull(); }
                                break;
                            default: cb[c].AddString(k == 4 ? s.Blob(c) : s.Text(c)); break;
                        }
                    }
                    if (++rows == per)
                    {
                        yield return Build(cb, rows); cb = New(); rows = 0;
                        ctx.Ct.ThrowIfCancellationRequested();
                    }
                }
                if (rows > 0) yield return Build(cb, rows);
            }
        }
        ColumnBuilder[] New() { ColumnBuilder[] cb = new ColumnBuilder[Schema.Count]; for (int c = 0; c < cb.Length; c++) cb[c] = new ColumnBuilder(Schema[c].Type, Math.Min(per, 4096)); return cb; }
        Batch Build(ColumnBuilder[] cb, int rows) { Column[] cs = new Column[cb.Length]; for (int c = 0; c < cs.Length; c++) cs[c] = cb[c].ToColumn(); return new Batch(Schema, cs, rows); }

        public static List<string> TablesOf(string path) { using (SqliteDb db = new SqliteDb(path, false)) return db.Tables(); }

        // Export: one table, one transaction, prepared INSERT.
        // Export on all workers. One SQLite file has a single writer, so the rows are cut into slices of up to 64k and each
        // worker writes the slices it takes into its own piece file (temp\write), one table per slice with the final
        // table's exact layout. Then SQLite copies the slice tables into the final table in row order (ATTACH +
        // INSERT ... SELECT *: its raw record transfer, no decoding and no per-value calls), so the order is kept. One worker:
        // straight into the final file. The output is written to a staging path and swapped in when complete, so no
        // rollback journal or fsyncs are needed (journal off, synchronous off, exclusive lock, 64 KB pages, big cache).
        static readonly string[] Fast = { "page_size = 65536", "journal_mode = OFF", "synchronous = OFF", "locking_mode = EXCLUSIVE", "cache_size = -131072", "temp_store = MEMORY" };
        static string Decl(DataType t) { return t.Kind == Kind.Int || t.Kind == Kind.Bool ? "INTEGER" : t.Kind == Kind.Double || t.Kind == Kind.Decimal ? "REAL" : t.Kind == Kind.Date ? "DATE" : t.Kind == Kind.Timestamp ? "TIMESTAMP" : "TEXT"; }
        static SqliteDb OpenFast(string path) { SqliteDb db = new SqliteDb(path, true); foreach (string pr in Fast) db.Exec("PRAGMA " + pr); return db; }

        public static long Export(string path, string table, IEnumerable<Batch> batches, Schema s, ExecCtx ctx)
        {
            List<string> names = ParquetFileWriter.UniqueNames(s);
            List<string> cols = new List<string>(), qn = new List<string>();
            for (int c = 0; c < s.Count; c++) { qn.Add(SqliteDb.Q(names[c])); cols.Add(SqliteDb.Q(names[c]) + " " + Decl(s[c].Type)); }
            string marks = string.Join(", ", new string[s.Count].Select_("?"));
            int k = Math.Max(1, ctx.Parallel);   // every worker writes
            using (SqliteDb db = OpenFast(path))
            {
                db.Exec("DROP TABLE IF EXISTS " + SqliteDb.Q(table));
                db.Exec("CREATE TABLE " + SqliteDb.Q(table) + " (" + string.Join(", ", cols) + ")");
                if (k == 1)
                using (WorkerPool.Writing())
                {
                    db.Exec("BEGIN");
                    long n1 = 0;
                    using (SqliteStmt ins = db.Prepare("INSERT INTO " + SqliteDb.Q(table) + " VALUES (" + marks + ")"))
                        foreach (Batch b in batches) { Insert(ins, Encode(b, s), 0, 0); n1 += b.Rows; ctx.Ct.ThrowIfCancellationRequested(); }
                    db.Exec("COMMIT");
                    return n1;
                }
                // ---- pieces, written in parallel ----
                string dir = Datasets.Staging(path + ".parts"); Directory.CreateDirectory(dir);
                try
                {
                    // One shared queue: whichever writer is free takes the next slice (and notes which piece it went to).
                    var queue = new System.Collections.Concurrent.BlockingCollection<long[]>(2 * k);
                    var slices = new List<Batch>(); var ranges = new List<long[]>();   // ranges[i] = (piece, first row, last row)
                    var writers = new System.Threading.Tasks.Task[k];
                    var cts = System.Threading.CancellationTokenSource.CreateLinkedTokenSource(ctx.Ct);
                    for (int w = 0; w < k; w++)
                    {
                        int me = w;
                        string piece = Path.Combine(dir, "p" + w + ".sqlite");
                        writers[w] = System.Threading.Tasks.Task.Factory.StartNew(() =>
                        {
                            try
                            {
                                using (WorkerPool.Writing())
                                using (SqliteDb pdb = OpenFast(piece))
                                {
                                    pdb.Exec("BEGIN");
                                    foreach (long[] r in queue.GetConsumingEnumerable(cts.Token))
                                    {
                                        Batch b; lock (slices) { b = slices[(int)r[3]]; slices[(int)r[3]] = null; }
                                        r[0] = me;
                                        string tn = "s" + r[3];
                                        pdb.Exec("CREATE TABLE " + tn + " (" + string.Join(", ", cols) + ")");
                                        using (SqliteStmt ins = pdb.Prepare("INSERT INTO " + tn + " VALUES (" + marks + ")")) Insert(ins, Encode(b, s), 0, 0);
                                    }
                                    pdb.Exec("COMMIT");
                                }
                            }
                            catch { cts.Cancel(); throw; }
                        }, System.Threading.Tasks.TaskCreationOptions.LongRunning);
                    }
                    long next = 0;
                    try
                    {
                        // Each batch is cut into slices of at most 64k rows, so every writer stays busy.
                        foreach (Batch b0 in batches)
                        {
                            for (int at = 0; at < b0.Rows; at += 65536)
                            {
                                int len = Math.Min(65536, b0.Rows - at);
                                Batch b = at == 0 && len == b0.Rows ? b0 : b0.Slice(at, len);
                                long[] r; lock (slices) { r = new long[] { -1, next, next + len - 1, slices.Count }; slices.Add(b); }
                                ranges.Add(r);
                                queue.Add(r, cts.Token);
                                next += len;
                            }
                        }
                    }
                    catch (OperationCanceledException) { if (ctx.Ct.IsCancellationRequested) throw; }   // a writer failed: its error is below
                    finally { queue.CompleteAdding(); }
                    try { System.Threading.Tasks.Task.WaitAll(writers); }
                    catch (AggregateException ae)
                    {
                        ctx.Ct.ThrowIfCancellationRequested();
                        foreach (Exception x in ae.Flatten().InnerExceptions) if (!(x is OperationCanceledException)) throw x;
                        throw;
                    }
                    // ---- copy the slice tables into the final table, in row order ----
                    // SQLite attaches at most 10 files at once, so pieces are attached as their slices come up (the 9 most
                    // recent stay attached). ATTACH is not allowed inside a transaction; with no journal and no syncs each
                    // copy commits on its own at no extra cost.
                    using (WorkerPool.Writing())
                    {
                        List<long> open = new List<long>();
                        foreach (long[] r in ranges)
                        {
                            if (!open.Contains(r[0]))
                            {
                                if (open.Count >= 9) { db.Exec("DETACH DATABASE p" + open[0]); open.RemoveAt(0); }
                                db.Exec("ATTACH DATABASE '" + Path.Combine(dir, "p" + r[0] + ".sqlite").Replace("'", "''") + "' AS p" + r[0]);
                                open.Add(r[0]);
                            }
                            else { open.Remove(r[0]); open.Add(r[0]); }
                            db.Exec("INSERT INTO main." + SqliteDb.Q(table) + " SELECT * FROM p" + r[0] + ".s" + r[3]);
                            ctx.Ct.ThrowIfCancellationRequested();
                        }
                        foreach (long w in open) db.Exec("DETACH DATABASE p" + w);
                    }
                    return next;
                }
                finally { DatasetWriter.TryDelete(dir); }
            }
        }
        // INSERTs one encoded batch (lead = 1: the first parameter is the row number, starting at first).
        static void Insert(SqliteStmt ins, Encoded e, int lead, long first)
        {
            Batch b = e.B; IntPtr h = ins.Handle; int nc = e.Buf.Length;
            GCHandle[] pins = new GCHandle[nc]; IntPtr[] at = new IntPtr[nc];
            try
            {
                for (int c = 0; c < nc; c++) if (e.Buf[c] != null) { pins[c] = GCHandle.Alloc(e.Buf[c], GCHandleType.Pinned); at[c] = pins[c].AddrOfPinnedObject(); }
                for (int r = 0; r < b.Rows; r++)
                {
                    if (lead == 1) WinSQLite.sqlite3_bind_int64(h, 1, first + r);
                    for (int c = 0; c < nc; c++)
                    {
                        if (e.Buf[c] == null) { ins.Bind(c + 1 + lead, b.Cols[c], r); continue; }
                        Column col = b.Cols[c];
                        if (col.IsNull(r) || (col.Type.Kind == Kind.String && col.S[r] == null)) { WinSQLite.sqlite3_bind_null(h, c + 1 + lead); continue; }
                        int o = e.Off[c][r];
                        WinSQLite.sqlite3_bind_text_ptr(h, c + 1 + lead, at[c] + o, e.Off[c][r + 1] - o, WinSQLite.TRANSIENT);
                    }
                    ins.Step(); ins.Reset();
                }
            }
            finally { foreach (GCHandle g in pins) if (g.IsAllocated) g.Free(); }
        }
        // A batch ready to INSERT: each text / date / timestamp column's UTF-8 in one buffer (value r = Buf[Off[r] ..
        // Off[r + 1]]), so a batch makes a few arrays instead of one per value (the garbage collector pauses every thread).
        sealed class Encoded { public Batch B; public byte[][] Buf; public int[][] Off; }
        static Encoded Encode(Batch b, Schema s)
        {
            Encoded e = new Encoded(); e.B = b; e.Buf = new byte[s.Count][]; e.Off = new int[s.Count][];
            for (int c = 0; c < s.Count; c++)
            {
                Column col = b.Cols[c]; Kind k = col.Type.Kind;
                if (k == Kind.Int || k == Kind.Bool || k == Kind.Double || k == Kind.Decimal || k == Kind.Null) continue;
                int[] off = new int[b.Rows + 1]; byte[] buf = new byte[Math.Max(64, b.Rows * 12)]; int at = 0;
                string[] str = k == Kind.String ? col.S : null;
                for (int r = 0; r < b.Rows; r++)
                {
                    off[r] = at;
                    if (col.IsNull(r)) continue;
                    string v = str != null ? str[r] : Values.Text(col, r);
                    if (v == null) continue;
                    int need = at + v.Length * 3;
                    if (need > buf.Length) Array.Resize(ref buf, Math.Max(need, buf.Length * 2));
                    at += Encoding.UTF8.GetBytes(v, 0, v.Length, buf, at);
                }
                off[b.Rows] = at;
                e.Buf[c] = buf; e.Off[c] = off;
            }
            return e;
        }
    }

    internal static class ArrExt
    {
        public static string[] Select_(this string[] a, string v) { for (int i = 0; i < a.Length; i++) a[i] = v; return a; }
    }
}
