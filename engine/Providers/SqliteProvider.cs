// SQLite through Windows' own winsqlite3.dll (System32 on Windows 10/11): no third-party DLL.
// Import streams rows (sqlite3_step) into batches; export writes in one transaction with a prepared INSERT.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace NativeDataEngine
{
    internal static class WinSQLite
    {
        const string Dll = "winsqlite3.dll";
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
        public override int Units(ExecCtx ctx) { return 1; }
        public override long KnownRows(ExecCtx ctx) { return -1; }
        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit)
        {
            int w = Schema.Count;
            using (SqliteDb db = new SqliteDb(path, false))
            using (SqliteStmt s = db.Prepare("SELECT * FROM " + SqliteDb.Q(table)))
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
        public static long Export(string path, string table, IEnumerable<Batch> batches, Schema s, ExecCtx ctx)
        {
            long n = 0;
            using (SqliteDb db = new SqliteDb(path, true))
            {
                db.Exec("DROP TABLE IF EXISTS " + SqliteDb.Q(table));
                List<string> cols = new List<string>();
                List<string> names = ParquetFileWriter.UniqueNames(s);
                for (int c = 0; c < s.Count; c++)
                {
                    DataType t = s[c].Type; string decl = t.Kind == Kind.Int || t.Kind == Kind.Bool ? "INTEGER" : t.Kind == Kind.Double || t.Kind == Kind.Decimal ? "REAL" : t.Kind == Kind.Date ? "DATE" : t.Kind == Kind.Timestamp ? "TIMESTAMP" : "TEXT";
                    cols.Add(SqliteDb.Q(names[c]) + " " + decl);
                }
                db.Exec("CREATE TABLE " + SqliteDb.Q(table) + " (" + string.Join(", ", cols) + ")");
                db.Exec("BEGIN");
                string ph = string.Join(", ", new string[s.Count].Select_("?"));
                using (SqliteStmt ins = db.Prepare("INSERT INTO " + SqliteDb.Q(table) + " VALUES (" + ph + ")"))
                {
                    foreach (Batch b in batches)
                    {
                        for (int r = 0; r < b.Rows; r++)
                        {
                            for (int c = 0; c < s.Count; c++) ins.Bind(c + 1, b.Cols[c], r);
                            ins.Step(); ins.Reset();
                        }
                        n += b.Rows;
                        ctx.Ct.ThrowIfCancellationRequested();
                    }
                }
                db.Exec("COMMIT");
            }
            return n;
        }
    }

    internal static class ArrExt
    {
        public static string[] Select_(this string[] a, string v) { for (int i = 0; i < a.Length; i++) a[i] = v; return a; }
    }
}
