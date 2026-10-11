// The engine: one instance per server. Owns the worker pool, memory guard, jobs, cached tables and resident datasets.
// Query / Describe / Write (partitioned Arrow dataset) / Export (csv, parquet, sqlite) / RunPipeline / OpenSource.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace NativeDataEngine
{
    public sealed class QueryResult
    {
        public Schema Schema; public List<Batch> Batches = new List<Batch>(); public long Rows; public bool Truncated; public long Ms;
    }

    public sealed class MemTable { public Schema Schema; public List<Batch> Batches; public long Bytes, Rows; public MemoryLease Lease; }

    public sealed partial class DataEngine : IDisposable
    {
        public const string Version = "1.0.0";
        public readonly EngineOptions Options;
        public readonly WorkerPool Pool;
        public readonly MemoryGuard Mem;
        public readonly JobManager Jobs = new JobManager();
        public readonly ResidentDatasets Resident;
        public readonly string Root;
        readonly ConcurrentDictionary<string, MemTable> tables = new ConcurrentDictionary<string, MemTable>(StringComparer.OrdinalIgnoreCase);
        readonly DateTime started = DateTime.UtcNow;

        public DataEngine(EngineOptions options)
        {
            if (options == null) throw new ArgumentNullException("options");
            Options = options;
            Root = Path.GetFullPath(options.RootPath ?? ".").TrimEnd('\\');
            int workers = Math.Max(1, Math.Min(Math.Min(64, options.MaxWorkers), Environment.ProcessorCount));
            Pool = new WorkerPool(workers);
            Mem = new MemoryGuard(options);
            Resident = new ResidentDatasets(this);
            EngineLog.Write("engine", "Native engine " + Version + ": " + workers + " workers (" + Environment.ProcessorCount + " cores), memory budget " + MemoryGuard.Mb(Mem.Budget) +
                " of " + MemoryGuard.Mb(Mem.TotalPhys) + (Environment.Is64BitProcess ? "" : " (32-bit process: limited)"));
        }
        public int WorkerCount { get { return Pool.WorkerCount; } }

        public ExecCtx Ctx(Job job, int workers, CancellationToken ct)
        {
            ExecCtx c = new ExecCtx();
            c.Engine = this; c.Pool = Pool; c.Mem = Mem; c.Job = job; c.Ct = ct;
            c.Parallel = workers > 0 ? Math.Min(workers, Pool.WorkerCount) : Pool.WorkerCount;
            return c;
        }

        // ---------- catalog ----------
        // Names a query can read: script session tables / views first, then the request's views (datasets), then
        // cached tables. Disposing it frees the session's in-memory tables.
        internal sealed class Catalog : ICatalog, IDisposable
        {
            readonly DataEngine e; readonly Dictionary<string, string> views;
            public long KnownRows, SourceBytes;
            public ScriptSession Session;
            public Catalog(DataEngine e, Dictionary<string, string> views) { this.e = e; this.views = views ?? new Dictionary<string, string>(); }
            public string BaseViewSql(string name) { string s; return views.TryGetValue(name, out s) ? s : null; }
            public string ViewSql(string name)
            {
                if (Session != null)
                {
                    if (Session.Tables.ContainsKey(name)) return null;
                    string v; if (Session.Views.TryGetValue(name, out v)) return v;
                    if (Session.Dropped.Contains(name)) return null;
                }
                return BaseViewSql(name);
            }
            public Source MemTable(string name)
            {
                if (Session != null)
                {
                    SessTable st;
                    if (Session.Tables.TryGetValue(name, out st)) return new MemSource(st.Schema, st.Batches);
                    if (Session.Dropped.Contains(name)) return null;
                }
                MemTable t; if (!e.tables.TryGetValue(name, out t)) return null;
                return new MemSource(t.Schema, t.Batches);
            }
            public void Dispose() { if (Session != null) { Session.Dispose(); Session = null; } }
            public Source TableFunction(FuncTable f, Planner p)
            {
                switch (f.Name)
                {
                    case "read_parquet": case "parquet_scan": case "read_dataset": case "read_arrow": case "arrow_scan":
                        {
                            // A dataset folder / file (Arrow or Parquet parts). A project dataset already in engine memory
                            // is read from there; otherwise from disk, and it is loaded into memory in the background.
                            if (f.Args.Count < 1) throw new EngineException("FUNCTION_ARGS", f.Name + "() needs a file or folder.");
                            List<string> names = Planner.StrList(f.Args[0], f.Name);
                            List<string> files = new List<string>();
                            foreach (string s in names) files.AddRange(e.ParquetFiles(s));
                            foreach (string x in files) { try { KnownRows += DataFiles.Rows(x); } catch { } }
                            if (names.Count == 1 && !PathGuard.IsExternal(names[0]) && names[0].IndexOf('*') < 0)
                            {
                                Source mem = e.Resident.TryGet(PathGuard.Project(e.Root, names[0], false), files, true);
                                if (mem != null) return mem;
                            }
                            return DataFiles.Open(files);
                        }
                    case "read_csv": case "read_csv_auto": case "csv_scan":
                        {
                            if (f.Args.Count < 1) throw new EngineException("FUNCTION_ARGS", f.Name + "() needs a file.");
                            List<string> list = Planner.StrList(f.Args[0], f.Name);
                            if (list.Count != 1) throw new EngineException("FUNCTION_ARGS", "read_csv() reads one file at a time.");
                            string full = PathGuard.Source(e.Root, list[0]);
                            SourceBytes += new FileInfo(full).Exists ? new FileInfo(full).Length : 0;
                            return new CsvSource(full, list[0], CsvSource.Options(f), e.Options.BatchRowCount);
                        }
                    case "read_sqlite": case "sqlite_scan":
                        {
                            if (f.Args.Count < 1) throw new EngineException("FUNCTION_ARGS", f.Name + "() needs a file.");
                            string full = PathGuard.Source(e.Root, Planner.StrArg(f.Args[0], f.Name));
                            return new SqliteSource(full, f.Args.Count > 1 ? Planner.StrArg(f.Args[1], f.Name) : null, e.Options.BatchRowCount);
                        }
                    case "range": case "generate_series":
                        {
                            List<long> a = new List<long>();
                            foreach (Expr x in f.Args) { object v = Planner.LitArg(x); if (!(v is long)) throw new EngineException("FUNCTION_ARGS", f.Name + "() needs whole numbers."); a.Add((long)v); }
                            if (a.Count == 0 || a.Count > 3) throw new EngineException("FUNCTION_ARGS", f.Name + "(stop) or " + f.Name + "(start, stop[, step]).");
                            long start = a.Count == 1 ? 0 : a[0], stop = a.Count == 1 ? a[0] : a[1], step = a.Count == 3 ? a[2] : 1;
                            if (f.Name == "generate_series") stop += step > 0 ? 1 : -1;
                            return new RangeSource(f.Name, start, stop, step, e.Options.BatchRowCount);
                        }
                }
                throw new EngineException("FUNCTION_UNKNOWN", "Unknown table function " + f.Name + "().");
            }
        }

        // Data files (.arrow / .parquet) of a path: a file, a dataset folder, or a folder/*.ext pattern.
        public List<string> ParquetFiles(string p)
        {
            if (p.IndexOf('*') >= 0)
            {
                string dir = Path.GetDirectoryName(p.Replace('/', '\\')), pat = Path.GetFileName(p);
                string full = PathGuard.Source(Root, dir.Length == 0 ? "." : dir);
                List<string> r = Directory.GetFiles(full, pat).Where(x => DataFiles.IsParquet(x) || DataFiles.IsArrow(x)).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
                if (r.Count == 0) throw new EngineException("FILE_NOT_FOUND", "No Arrow or Parquet files match " + p + ".", 404);
                return r;
            }
            string f = PathGuard.IsExternal(p) ? Path.GetFullPath(p) : PathGuard.Project(Root, p, false);
            if (PathGuard.IsExternal(p) && !Directory.Exists(f)) PathGuard.Source(Root, p);
            return Datasets.Files(f);
        }

        // sql may be one query or a script (Script.cs); the caller disposes cat when the result has been read.
        Planned Plan(string sql, Dictionary<string, string> views, out QueryStmt q, out Catalog cat, CancellationToken ct)
        {
            q = Prepare(sql, views, out cat, ct);
            try { return PlanQ(q, cat); }
            catch { cat.Dispose(); throw; }
        }
        Planned Plan(string sql, Dictionary<string, string> views, out QueryStmt q, out Catalog cat) { return Plan(sql, views, out q, out cat, CancellationToken.None); }
        Planned PlanQ(QueryStmt q, Catalog cat)
        {
            Planned p = new Planner(cat, Options.BatchRowCount).Plan(q);
            Optimizer.Prune(p.Op);
            return p;
        }

        // Runs fn; a CSV column that turns out wider than its sample retries with the wider type.
        T WithWiden<T>(Func<T> fn)
        {
            for (int attempt = 0; ; attempt++)
            {
                try { return fn(); }
                catch (Exception ex)
                {
                    TypeWidenException w = Find<TypeWidenException>(ex);
                    if (w == null || attempt >= 50) throw Unwrap(ex);
                    CsvSource.Widen(w);
                    EngineLog.Write("engine", "CSV " + Path.GetFileName(w.File) + ": column " + (w.Column + 1) + " has values that need " + w.To.Name + "; re-reading.");
                }
            }
        }
        static T Find<T>(Exception e) where T : Exception
        {
            for (Exception x = e; x != null; x = x.InnerException)
            {
                T t = x as T; if (t != null) return t;
                AggregateException a = x as AggregateException;
                if (a != null) foreach (Exception i in a.InnerExceptions) { T r = Find<T>(i); if (r != null) return r; }
            }
            return null;
        }
        static Exception Unwrap(Exception e)
        {
            while ((e is AggregateException || e is System.Reflection.TargetInvocationException) && e.InnerException != null) e = e.InnerException;
            return e;
        }

        // ---------- query ----------
        public QueryResult Query(string sql, Dictionary<string, string> views, int maxRows, int workers, CancellationToken ct)
        {
            return WithWiden(() =>
            {
                Stopwatch sw = Stopwatch.StartNew();
                QueryStmt q; Catalog cat;
                Planned p = Plan(sql, views, out q, out cat, ct);
                try
                {
                    QueryResult r = new QueryResult(); r.Schema = p.Op.Schema;
                    if (q.Describe) { r.Schema = DescribeSchema(p.Op.Schema, r); r.Ms = sw.ElapsedMilliseconds; return r; }
                    CollectRows(p, r, maxRows, workers, ct);
                    r.Ms = sw.ElapsedMilliseconds;
                    return r;
                }
                finally { cat.Dispose(); }
            });
        }
        void CollectRows(Planned p, QueryResult r, long maxRows, int workers, CancellationToken ct)
        {
            ExecCtx ctx = Ctx(null, workers, ct);
            long limit = maxRows > 0 ? maxRows : Options.MaxResultRows;
            using (MemoryLease lease = new MemoryLease(Mem, "Query result"))
            {
                try
                {
                    foreach (Batch b in p.Op.Run(ctx))
                    {
                        Batch x = b;
                        if (r.Rows + x.Rows > limit) { x = x.Slice(0, (int)(limit - r.Rows)); r.Truncated = true; }
                        if (x.Rows > 0) { lease.Add(x.Bytes); r.Batches.Add(x); r.Rows += x.Rows; }
                        if (r.Truncated) break;
                    }
                }
                finally { ctx.End(); }
            }
        }

        // Preview: the first `limit` rows and the total row count of a query or script. A script's statements run
        // once; the rows and the count are then two plans of the final query, run at the same time on the workers.
        public QueryResult Preview(string sql, Dictionary<string, string> views, int limit, int workers, CancellationToken ct, out long count)
        {
            long n = -1;
            QueryResult res = WithWiden(() =>
            {
                Stopwatch sw = Stopwatch.StartNew();
                Catalog cat;
                QueryStmt q = Prepare(sql, views, out cat, ct);
                try
                {
                    q = q.Copy(); q.Describe = false;
                    QueryStmt top = Wrap(q, false), cnt = Wrap(q, true);
                    top.Limit = limit > 0 ? limit : 100;
                    Planned pTop = PlanQ(top, cat), pCnt = PlanQ(cnt, cat);
                    long total = -1; Exception cntErr = null;
                    Thread th = new Thread(() =>
                    {
                        try
                        {
                            ExecCtx cx = Ctx(null, workers, ct);
                            try { foreach (Batch b in pCnt.Op.Run(cx)) if (b.Rows > 0) total = b.Cols[0].IsNull(0) ? 0 : b.Cols[0].I[0]; }
                            finally { cx.End(); }
                        }
                        catch (Exception e) { cntErr = e; }
                    });
                    th.IsBackground = true; th.Start();
                    QueryResult r = new QueryResult(); r.Schema = pTop.Op.Schema;
                    try { CollectRows(pTop, r, 0, workers, ct); }
                    finally { th.Join(); }
                    if (cntErr != null) throw cntErr;
                    n = total;
                    r.Ms = sw.ElapsedMilliseconds;
                    return r;
                }
                finally { cat.Dispose(); }
            });
            count = n;
            return res;
        }
        // SELECT * / count(*) FROM (q)
        static QueryStmt Wrap(QueryStmt q, bool count)
        {
            SelectStmt s = new SelectStmt();
            SelectItem it = new SelectItem();
            if (count) { Call c = new Call(); c.Name = "count"; c.Star = true; it.E = c; it.Alias = "n"; } else it.E = new StarE();
            s.Items.Add(it);
            SubqueryTable st = new SubqueryTable(); st.Query = q; st.Alias = "__preview"; s.From = st;
            QueryStmt w = new QueryStmt(); w.Body = s;
            return w;
        }

        static Schema DescribeSchema(Schema s, QueryResult r)
        {
            Schema d = new Schema(new List<Field> { new Field("column_name", DataType.Varchar), new Field("column_type", DataType.Varchar) });
            Column a = new Column(DataType.Varchar, s.Count), b = new Column(DataType.Varchar, s.Count);
            for (int i = 0; i < s.Count; i++) { a.S[i] = s[i].Name; b.S[i] = (s[i].Type.Kind == Kind.Null ? DataType.Varchar : s[i].Type).Name; }
            r.Batches.Add(new Batch(d, new[] { a, b }, s.Count)); r.Rows = s.Count;
            return d;
        }

        public Schema Describe(string sql, Dictionary<string, string> views)
        {
            return WithWiden(() => { QueryStmt q; Catalog cat; Schema s = Plan(sql, views, out q, out cat).Op.Schema; cat.Dispose(); return s; });
        }

        // ---------- write a dataset (Arrow IPC parts; Parquet parts when Options.DatasetFormat = "parquet") ----------
        public Dictionary<string, object> Write(Job j, string sql, Dictionary<string, string> views, string destRel, Dictionary<string, object> meta, int codec, int workers)
        {
            string dest = PathGuard.Project(Root, destRel, false);
            if (dest.EndsWith(".parquet", StringComparison.OrdinalIgnoreCase)) dest = dest.Substring(0, dest.Length - 8);
            else if (dest.EndsWith(".arrow", StringComparison.OrdinalIgnoreCase)) dest = dest.Substring(0, dest.Length - 6);
            return WithWiden(() =>
            {
                QueryStmt q; Catalog cat;
                j.Stage = "Planning";
                Planned p = Plan(sql, views, out q, out cat, j.Cts.Token);
                if (cat.SourceBytes > 0) j.BytesTotal = cat.SourceBytes; else if (cat.KnownRows > 0) j.RowsTotal = cat.KnownRows;
                ExecCtx ctx = Ctx(j, workers, j.Cts.Token);
                bool arrow = !string.Equals(Options.DatasetFormat, "parquet", StringComparison.OrdinalIgnoreCase);
                j.Stage = arrow ? "Writing Arrow" : "Writing Parquet";
                try
                {
                    using (DatasetWriter w = new DatasetWriter(Root, dest, p.Op.Schema, arrow, codec, Options.PartBytes, Options.PartRows))
                    {
                        if (arrow) Encode<EncodedBatch>(p.Op, ctx, ArrowFileWriter.Encode, w.Append);
                        else Encode<EncodedRowGroup>(p.Op, ctx, rg => ParquetFileWriter.Encode(rg, codec), w.Append);
                        j.Stage = "Saving";
                        Dictionary<string, object> m = w.Commit(meta);
                        Resident.Forget(dest);
                        return m;
                    }
                }
                finally { ctx.End(); cat.Dispose(); }
            });
        }

        public Job StartWrite(string sql, Dictionary<string, string> views, string destRel, Dictionary<string, object> meta, int codec, int workers)
        {
            return Jobs.Start("write", destRel, j => Write(j, sql, views, destRel, meta, codec, workers));
        }

        // Rows -> batches of BatchRowCount, encoded on the workers (bounded), appended in order.
        void Encode<T>(Op root, ExecCtx ctx, Func<Batch, T> encode, Action<T> append)
        {
            int per = Options.BatchRowCount;
            Queue<Work<T>> q = new Queue<Work<T>>();
            int maxInflight = Math.Max(2, ctx.Parallel);
            List<Batch> pend = new List<Batch>(); int pendRows = 0;
            Schema s = root.Schema;
            Action<Batch> submit = rg =>
            {
                q.Enqueue(Pool.Submit(() => encode(rg)));
                while (q.Count >= maxInflight || (q.Count > 0 && !Mem.RoomForMore())) append(q.Dequeue().Wait(ctx.Ct));
            };
            foreach (Batch b0 in root.Run(ctx))
            {
                Batch b = b0; int at = 0;
                while (at < b.Rows)
                {
                    int take = Math.Min(per - pendRows, b.Rows - at);
                    pend.Add(at == 0 && take == b.Rows ? b : b.Slice(at, take)); pendRows += take; at += take;
                    if (pendRows == per) { submit(Batch.Concat(s, pend)); pend = new List<Batch>(); pendRows = 0; }
                }
                ctx.Ct.ThrowIfCancellationRequested();
            }
            if (pendRows > 0) submit(Batch.Concat(s, pend));
            while (q.Count > 0) append(q.Dequeue().Wait(ctx.Ct));
        }

        // ---------- export ----------
        public Dictionary<string, object> Export(Job j, string sql, Dictionary<string, string> views, string toRel, string format, string table)
        {
            string to = PathGuard.Project(Root, toRel, false);
            format = (format ?? Path.GetExtension(to).TrimStart('.')).ToLowerInvariant();
            Directory.CreateDirectory(Path.GetDirectoryName(to));
            string tmp = to + ".tmp-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            return WithWiden(() =>
            {
                QueryStmt q; Catalog cat;
                Planned p = Plan(sql, views, out q, out cat, j.Cts.Token);
                if (cat.KnownRows > 0) j.RowsTotal = cat.KnownRows;
                ExecCtx ctx = Ctx(j, 0, j.Cts.Token);
                long rows = 0;
                j.Stage = "Exporting " + format.ToUpperInvariant();
                try
                {
                    if (format == "csv" || format == "tsv" || format == "txt")
                    {
                        char d = format == "tsv" ? '\t' : ',';
                        using (StreamWriter w = new StreamWriter(tmp, false, new UTF8Encoding(false), 1 << 20))
                        {
                            List<string> names = ParquetFileWriter.UniqueNames(p.Op.Schema);
                            w.Write(string.Join(d.ToString(), names.Select(n => CsvCell(n, d))) + "\r\n");
                            StringBuilder sb = new StringBuilder();
                            foreach (Batch b in p.Op.Run(ctx))
                            {
                                for (int r = 0; r < b.Rows; r++)
                                {
                                    sb.Length = 0;
                                    for (int c = 0; c < b.Cols.Length; c++) { if (c > 0) sb.Append(d); string v = Values.Text(b.Cols[c], r); if (v != null) sb.Append(CsvCell(v, d)); }
                                    sb.Append("\r\n"); w.Write(sb.ToString());
                                }
                                rows += b.Rows;
                            }
                        }
                    }
                    else if (format == "parquet" || format == "pq")
                    {
                        using (ParquetFileWriter w = new ParquetFileWriter(tmp, p.Op.Schema, Codec.Snappy))
                        {
                            Encode<EncodedRowGroup>(p.Op, ctx, rg => ParquetFileWriter.Encode(rg, Codec.Snappy), w.Append);
                            w.Close(); rows = w.Rows;
                        }
                    }
                    else if (format == "sqlite" || format == "db" || format == "sqlite3")
                    {
                        rows = SqliteSource.Export(tmp, string.IsNullOrEmpty(table) ? Path.GetFileNameWithoutExtension(to) : table, p.Op.Run(ctx), p.Op.Schema, ctx);
                    }
                    else throw new EngineException("EXPORT_FORMAT", "Unknown export format: " + format + " (use csv, parquet or sqlite).");
                    if (File.Exists(to)) File.Delete(to);
                    File.Move(tmp, to);
                }
                catch { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } throw; }
                finally { ctx.End(); cat.Dispose(); }
                Dictionary<string, object> res = new Dictionary<string, object>();
                res["path"] = PathGuard.Rel(Root, to); res["rows"] = rows; res["bytes"] = new FileInfo(to).Length; res["format"] = format;
                return res;
            });
        }
        static string CsvCell(string v, char d)
        {
            if (v.IndexOf(d) < 0 && v.IndexOf('"') < 0 && v.IndexOf('\n') < 0 && v.IndexOf('\r') < 0) return v;
            return "\"" + v.Replace("\"", "\"\"") + "\"";
        }

        // ---------- sources ----------
        public Dictionary<string, object> OpenSource(string src, string table)
        {
            string full = PathGuard.Source(Root, src);
            string ext = Path.GetExtension(full).ToLowerInvariant();
            Dictionary<string, object> r = new Dictionary<string, object>();
            Schema s; long rows = -1;
            if (ext == ".sqlite" || ext == ".sqlite3" || ext == ".db")
            {
                List<string> ts = SqliteSource.TablesOf(full);
                r["kind"] = "sqlite"; r["tables"] = ts;
                s = ts.Count > 0 ? new SqliteSource(full, table ?? ts[0], 1000).Schema : new Schema(new List<Field>());
            }
            else if (ext == ".csv" || ext == ".tsv" || ext == ".txt")
            {
                CsvShape sh = CsvSource.Detect(full, new CsvOptions());
                r["kind"] = "csv"; r["tables"] = new[] { "" }; r["delimiter"] = sh.Delimiter.ToString(); r["header"] = sh.Header;
                s = sh.Schema;
            }
            else
            {
                Source ps = DataFiles.Open(ParquetFiles(src));
                r["kind"] = ps is ArrowSource ? "arrow" : "parquet"; r["tables"] = new[] { "" };
                s = ps.Schema; rows = ps.KnownRows(null);
            }
            r["columns"] = Cols(s);
            r["rows"] = rows < 0 ? null : (object)rows;
            FileInfo fi = new FileInfo(full);
            if (fi.Exists) { r["size"] = fi.Length; r["modified"] = fi.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture); }
            return r;
        }
        public static List<Dictionary<string, object>> Cols(Schema s)
        {
            List<Dictionary<string, object>> l = new List<Dictionary<string, object>>();
            foreach (Field f in s.Fields) { Dictionary<string, object> d = new Dictionary<string, object>(); d["name"] = f.Name; d["type"] = (f.Type.Kind == Kind.Null ? DataType.Varchar : f.Type).Name; l.Add(d); }
            return l;
        }

        // ---------- in-memory tables (engine bench) ----------
        public Dictionary<string, object> CacheLoad(string name, string sql, Dictionary<string, string> views, int workers)
        {
            CacheDrop(name);
            Stopwatch sw = Stopwatch.StartNew();
            MemTable t = WithWiden(() =>
            {
                QueryStmt q; Catalog cat;
                Planned p = Plan(sql, views, out q, out cat);
                ExecCtx ctx = Ctx(null, workers, CancellationToken.None);
                MemTable m = new MemTable(); m.Schema = p.Op.Schema; m.Batches = new List<Batch>(); m.Lease = new MemoryLease(Mem, "Cached table");
                try { foreach (Batch b in p.Op.Run(ctx)) { m.Lease.Add(b.Bytes); m.Batches.Add(b); m.Rows += b.Rows; m.Bytes += b.Bytes; } }
                catch { m.Lease.Dispose(); throw; }
                finally { ctx.End(); cat.Dispose(); }
                return m;
            });
            tables[name] = t;
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["name"] = name; r["rows"] = t.Rows; r["bytes"] = t.Bytes; r["ms"] = sw.ElapsedMilliseconds;
            return r;
        }
        public int CacheDrop(string name)
        {
            int n = 0;
            foreach (string k in tables.Keys.ToList())
            {
                if (name != null && !string.Equals(k, name, StringComparison.OrdinalIgnoreCase)) continue;
                MemTable t; if (tables.TryRemove(k, out t)) { t.Lease.Dispose(); n++; }
            }
            if (n > 0) GC.Collect();
            return n;
        }
        public long CachedBytes { get { long b = 0; foreach (MemTable t in tables.Values) b += t.Bytes; return b; } }

        // ---------- pipeline ----------
        // spec: { datasets: {name: path}, nodes: [{id, name, sql, output, dest}], changed: [names] (optional), version }
        public Dictionary<string, object> RunPipeline(Job j, Dictionary<string, object> spec)
        {
            Stopwatch sw = Stopwatch.StartNew();
            Dictionary<string, string> datasets = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, object> ds = Json.Obj(spec, "datasets") ?? new Dictionary<string, object>();
            foreach (KeyValuePair<string, object> kv in ds) datasets[kv.Key] = Convert.ToString(kv.Value, CultureInfo.InvariantCulture);
            List<Dictionary<string, object>> nodes = new List<Dictionary<string, object>>();
            object[] na = Json.Arr(spec, "nodes") ?? new object[0];
            foreach (object o in na) nodes.Add((Dictionary<string, object>)o);

            // Views: datasets first, steps override (a step may re-define a name).
            Dictionary<string, string> views = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, string> kv in datasets) views[kv.Key] = "SELECT * FROM read_parquet('" + kv.Value.Replace("'", "''") + "')";
            Dictionary<string, Dictionary<string, object>> byName = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            foreach (Dictionary<string, object> n in nodes)
            {
                string name = Json.Str(n, "name");
                if (string.IsNullOrEmpty(name)) throw new EngineException("PIPELINE_INVALID", "A pipeline step has no name.");
                if (byName.ContainsKey(name)) throw new EngineException("PIPELINE_INVALID", "Two steps are named \"" + name + "\".");
                byName[name] = n; views[name] = Json.Str(n, "sql") ?? "";
            }
            // Dependencies from the SQL itself, cycle check, topological order.
            j.Stage = "Validating";
            Dictionary<string, HashSet<string>> deps = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (Dictionary<string, object> n in nodes)
            {
                string name = Json.Str(n, "name");
                QueryStmt q;
                try { q = Parser.ParseQuery(views[name]); }
                catch (EngineException e) { throw new EngineException(e.Code, "Step \"" + name + "\": " + e.Message); }
                HashSet<string> refs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                Refs.Collect(q, refs);
                refs.RemoveWhere(r => !views.ContainsKey(r) || string.Equals(r, name, StringComparison.OrdinalIgnoreCase) && !datasets.ContainsKey(r));
                deps[name] = refs;
            }
            List<string> order = Topo(nodes.Select(n => Json.Str(n, "name")).ToList(), deps);
            // Which outputs to run: all, or (Update) those downstream of a changed dataset/step.
            List<string> changed = Json.Strs(spec, "changed");
            Func<string, HashSet<string>> closure = null;
            Dictionary<string, HashSet<string>> memo = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
            closure = name =>
            {
                HashSet<string> c;
                if (memo.TryGetValue(name, out c)) return c;
                c = new HashSet<string>(StringComparer.OrdinalIgnoreCase); memo[name] = c;
                HashSet<string> d;
                if (deps.TryGetValue(name, out d)) foreach (string x in d) { c.Add(x); if (byName.ContainsKey(x) && !string.Equals(x, name, StringComparison.OrdinalIgnoreCase)) c.UnionWith(closure(x)); }
                return c;
            };
            List<string> outputs = order.Where(n => Json.Bool(byName[n], "output", false)).ToList();
            List<string> skipped = new List<string>();
            if (spec.ContainsKey("changed") && Json.Arr(spec, "changed") != null)
            {
                List<string> run = new List<string>();
                foreach (string o in outputs) { if (changed.Any(c => string.Equals(c, o, StringComparison.OrdinalIgnoreCase) || closure(o).Contains(c))) run.Add(o); else skipped.Add(o); }
                outputs = run;
            }
            // Validate every step up front (plan only), so a typo fails before anything is written.
            foreach (string n in order)
            {
                try { Describe("SELECT * FROM " + Q(n), views); }
                catch (EngineException e) { throw new EngineException(e.Code, "Step \"" + n + "\": " + e.Message); }
            }
            long version = Json.Long(spec, "version", 0);
            List<Dictionary<string, object>> results = new List<Dictionary<string, object>>();
            object gate = new object(); Exception first = null; int nextOut = 0, doneOut = 0;
            int lanes = Math.Max(1, Math.Min(3, outputs.Count));
            // Independent outputs write in parallel (up to 3 at once); each write is atomic.
            List<Thread> threads = new List<Thread>();
            for (int l = 0; l < lanes; l++)
            {
                Thread t = new Thread(() =>
                {
                    while (true)
                    {
                        string n;
                        lock (gate) { if (first != null || nextOut >= outputs.Count) return; n = outputs[nextOut++]; }
                        try
                        {
                            Dictionary<string, object> node = byName[n];
                            string dest = Json.Str(node, "dest");
                            if (string.IsNullOrEmpty(dest)) throw new EngineException("PIPELINE_INVALID", "Output step \"" + n + "\" has no destination.");
                            Dictionary<string, object> meta = new Dictionary<string, object>();
                            Dictionary<string, object> lineage = new Dictionary<string, object>();
                            lineage["pipelineNode"] = Json.Str(node, "id"); lineage["pipelineStep"] = n; lineage["pipelineVersion"] = version;
                            List<Dictionary<string, object>> up = new List<Dictionary<string, object>>();
                            foreach (string u in closure(n).Where(x => datasets.ContainsKey(x) && !byName.ContainsKey(x)).OrderBy(x => x))
                            {
                                Dictionary<string, object> ud = new Dictionary<string, object>(); ud["dataset"] = u;
                                try { string full = PathGuard.Project(Root, datasets[u], false); Dictionary<string, object> m = Directory.Exists(full) ? Datasets.Manifest(full) : null; ud["version"] = m != null ? Json.Long(m, "version", 0) : (object)null; } catch { ud["version"] = null; }
                                up.Add(ud);
                            }
                            lineage["upstream"] = up;
                            meta["lineage"] = lineage;
                            lock (gate) j.Stage = "Writing " + n;
                            Dictionary<string, object> w = Write(j, "SELECT * FROM " + Q(n), views, dest, meta, Codec.Snappy, 0);
                            w["step"] = n;
                            lock (gate) { results.Add(w); doneOut++; j.Progress = doneOut / (double)Math.Max(1, outputs.Count) * 0.99; }
                        }
                        catch (Exception e) { lock (gate) { if (first == null) first = new EngineException(EngineError.From(e).Code, "Step \"" + n + "\": " + EngineError.From(e).Message); } }
                    }
                });
                t.IsBackground = true; t.Start(); threads.Add(t);
            }
            foreach (Thread t in threads) t.Join();
            if (first != null) throw first;
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["outputs"] = results.OrderBy(r => outputs.IndexOf((string)r["step"])).ToList();
            res["skipped"] = skipped;
            res["order"] = order;
            res["ms"] = sw.ElapsedMilliseconds;
            return res;
        }
        static string Q(string n) { return "\"" + n.Replace("\"", "\"\"") + "\""; }

        static List<string> Topo(List<string> names, Dictionary<string, HashSet<string>> deps)
        {
            List<string> order = new List<string>(); Dictionary<string, int> state = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            Action<string, List<string>> visit = null;
            visit = (n, path) =>
            {
                int s; state.TryGetValue(n, out s);
                if (s == 2) return;
                if (s == 1) throw new EngineException("PIPELINE_CYCLE", "Steps refer to each other in a loop: " + string.Join(" -> ", path) + " -> " + n + ".");
                state[n] = 1; path.Add(n);
                HashSet<string> d;
                if (deps.TryGetValue(n, out d)) foreach (string x in d) if (deps.ContainsKey(x) && !string.Equals(x, n, StringComparison.OrdinalIgnoreCase)) visit(x, path);
                path.RemoveAt(path.Count - 1); state[n] = 2; order.Add(n);
            };
            foreach (string n in names) visit(n, new List<string>());
            return order;
        }

        public Dictionary<string, object> Status()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["ok"] = true; d["status"] = "ok"; d["engine"] = "NativeDataEngine"; d["version"] = Version;
            d["workers"] = Pool.WorkerCount; d["maxWorkers"] = 64; d["cores"] = Environment.ProcessorCount; d["busy"] = Pool.Busy;
            d["is64"] = Environment.Is64BitProcess; d["clr"] = Environment.Version.ToString();
            Dictionary<string, object> m = new Dictionary<string, object>();
            m["budget"] = Mem.Budget; m["reserved"] = Mem.Reserved; m["managed"] = Mem.Managed; m["availPhys"] = Mem.AvailPhys; m["totalPhys"] = Mem.TotalPhys; m["cached"] = CachedBytes; m["resident"] = Resident.Bytes; m["residentCap"] = Resident.Cap;
            m["process"] = Process.GetCurrentProcess().PrivateMemorySize64;
            d["memory"] = m;
            d["jobs"] = Jobs.Running; d["batchRows"] = Options.BatchRowCount; d["partBytes"] = Options.PartBytes;
            d["uptime"] = (long)(DateTime.UtcNow - started).TotalSeconds;
            return d;
        }

        public void Dispose()
        {
            Jobs.CancelAll();
            CacheDrop(null);
            Resident.DropUnder(null);
            Pool.Dispose();
        }
    }

    // Table names a query reads (for pipeline dependencies).
    public static class Refs
    {
        public static void Collect(QueryStmt q, HashSet<string> into)
        {
            HashSet<string> ctes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, QueryStmt> w in q.With) { ctes.Add(w.Key); Collect(w.Value, into); }
            Body(q.Body, into);
            foreach (string c in ctes) into.Remove(c);
        }
        static void Body(object b, HashSet<string> into)
        {
            SelectStmt s = b as SelectStmt; if (s != null) { if (s.From != null) Table(s.From, into); return; }
            QueryStmt q = b as QueryStmt; if (q != null) { Collect(q, into); return; }
            SetOp so = b as SetOp; if (so != null) { Body(so.Left, into); Body(so.Right, into); }
        }
        static void Table(TableRef t, HashSet<string> into)
        {
            NamedTable n = t as NamedTable; if (n != null) { into.Add(n.Name); return; }
            SubqueryTable sq = t as SubqueryTable; if (sq != null) { Collect(sq.Query, into); return; }
            JoinRef j = t as JoinRef; if (j != null) { Table(j.Left, into); Table(j.Right, into); }
        }
    }
}
