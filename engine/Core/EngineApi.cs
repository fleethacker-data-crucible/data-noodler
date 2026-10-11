// /api/engine/* : the PowerShell server checks the request (host, origin, token) and hands the HttpListenerContext
// here; the engine answers it on its own thread, so the server's main loop never waits on a query.
//   GET  status                       engine, workers, memory
//   POST query    {sql | query, views, limit, workers}  -> {cols, types, rows, rowCount, truncated, ms}  (query = QuerySpec)
//   POST describe {sql, views}                          -> {columns}
//   POST check    {sql, views}                          -> {errors: [{pos, end, line, message, code}]}  (editor)
//   POST preview  {sql, views, limit, workers}          -> query result + {count}  (sql may be a script)
//   POST open     {src, table}                          -> {kind, tables, columns, rows, size, modified}
//   POST write    {sql, views, dest, meta, codec}       -> {jobId}   (partitioned Parquet dataset)
//   POST export   {sql, views, to, format, table, workers} -> {jobId}   (csv / parquet / sqlite file)
//   POST pipeline {datasets, nodes, changed, version}   -> {jobId}
//   GET  job?id=  /  POST job/cancel?id=  /  GET jobs
//   POST cache/load {name, sql, views}  /  POST cache/drop {name}     (in-memory tables for the engine bench)
//   GET  memory  /  POST memory/load {paths, wait}  /  POST memory/drop {path}   (resident project datasets)
//   GET / POST options {batchRows}                      rows per batch (Benchmark page)
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace NativeDataEngine
{
    public static class EngineApi
    {
        public static void Handle(DataEngine e, HttpListenerContext ctx, string op)
        {
            ThreadPool.QueueUserWorkItem(_ => Run(e, ctx, op));
        }

        static void Run(DataEngine e, HttpListenerContext ctx, string op)
        {
            HttpListenerResponse res = ctx.Response;
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            int code = 200; string body;
            try
            {
                Dictionary<string, object> req = ctx.Request.HttpMethod == "POST" ? Json.Parse(ReadBody(ctx.Request)) : new Dictionary<string, object>();
                body = Route(e, ctx, op, req);
            }
            catch (Exception ex)
            {
                EngineError er = EngineError.From(ex);
                EngineException ee = ex as EngineException;
                code = ee != null ? ee.Status : (er.Code == "QUERY_OUT_OF_MEMORY" ? 507 : er.Code == "FILE_NOT_FOUND" ? 404 : er.Code == "ACCESS_DENIED" ? 403 : 500);
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["ok"] = false; d["error"] = er.Message; d["code"] = er.Code;
                body = Json.Write(d);
                if (op != "status") EngineLog.Write(code >= 500 && ee == null ? "err" : "engine", "Engine " + op + ": " + er.Code + ": " + er.Message);
                if (ee == null && code >= 500) EngineLog.Write("err", er.Detail);
            }
            try
            {
                byte[] b = Encoding.UTF8.GetBytes(body);
                res.StatusCode = code;
                res.ContentType = "application/json";
                res.Headers["Cache-Control"] = "no-store";
                res.AddHeader("Cross-Origin-Resource-Policy", "same-origin");
                res.ContentLength64 = b.Length;
                res.OutputStream.Write(b, 0, b.Length);
            }
            catch { }
            finally { try { res.Close(); } catch { } }
            if (op != "status" && op != "job" && op != "jobs" && op != "workers")   // polled: not logged
                EngineLog.Write("req", ctx.Request.HttpMethod + "|" + code + "|" + body.Length + "|" + sw.ElapsedMilliseconds + "|/api/engine/" + op);
        }

        static string ReadBody(HttpListenerRequest r)
        {
            using (StreamReader sr = new StreamReader(r.InputStream, Encoding.UTF8)) return sr.ReadToEnd();
        }
        static Dictionary<string, string> Views(Dictionary<string, object> req)
        {
            Dictionary<string, string> v = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, object> o = Json.Obj(req, "views");
            if (o != null) foreach (KeyValuePair<string, object> kv in o) if (kv.Value != null) v[kv.Key] = Convert.ToString(kv.Value);
            return v;
        }
        static string Need(Dictionary<string, object> req, string k)
        {
            string s = Json.Str(req, k);
            if (string.IsNullOrEmpty(s)) throw new EngineException("ARG_MISSING", "Missing \"" + k + "\".");
            return s;
        }
        static string Ok(Dictionary<string, object> d) { d["ok"] = true; return Json.Write(d); }

        static string Route(DataEngine e, HttpListenerContext ctx, string op, Dictionary<string, object> req)
        {
            string q = ctx.Request.QueryString["id"];
            switch (op)
            {
                case "status": return Json.Write(e.Status());
                case "workers":
                    {
                        // Activity lights: per worker 0 idle, 1 reading / computing, 2 writing; writers = writing threads outside the pool.
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["states"] = e.Pool.States(); d["writers"] = WorkerPool.Writers; return Ok(d);
                    }
                case "query":
                    {
                        Dictionary<string, object> spec = Json.Obj(req, "query");
                        string sql = spec != null ? QuerySpec.ToSql(spec) : Need(req, "sql");
                        if (Json.Bool(req, "async", false))
                        {
                            // As a job (rows read so far are reported while it runs); the result is the usual query answer.
                            Dictionary<string, string> v0 = Views(req); int lim = (int)Json.Long(req, "limit", 0), wk = (int)Json.Long(req, "workers", 0);
                            Job jq = e.Jobs.Start("query", "query", jb => Json.Parse(ResultJson(e.Query(sql, v0, lim, wk, jb.Cts.Token, jb))));
                            return Json.Write(jq.ToJson());
                        }
                        QueryResult r = e.Query(sql, Views(req), (int)Json.Long(req, "limit", 0), (int)Json.Long(req, "workers", 0), CancellationToken.None);
                        return ResultJson(r);
                    }
                case "preview":
                    {
                        long n;
                        QueryResult r = e.Preview(Need(req, "sql"), Views(req), (int)Json.Long(req, "limit", 100), (int)Json.Long(req, "workers", 0), CancellationToken.None, out n);
                        string j = ResultJson(r);
                        return j.Substring(0, j.Length - 1) + ",\"count\":" + n + "}";
                    }
                case "check": return Ok(e.Check(Json.Str(req, "sql") ?? "", Views(req)));
                case "describe":
                    {
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["columns"] = DataEngine.Cols(e.Describe(Need(req, "sql"), Views(req)));
                        return Ok(d);
                    }
                case "open": return Ok(e.OpenSource(Need(req, "src"), Json.Str(req, "table")));
                case "write":
                    {
                        string sql = Need(req, "sql"), dest = Need(req, "dest");
                        Dictionary<string, string> v = Views(req);
                        Dictionary<string, object> meta = Json.Obj(req, "meta");
                        int codec = Codec.Parse(Json.Str(req, "codec")), workers = (int)Json.Long(req, "workers", 0);
                        Job j = e.StartWrite(sql, v, dest, meta, codec, workers);
                        return Json.Write(j.ToJson());
                    }
                case "export":
                    {
                        string sql = Need(req, "sql"), to = Need(req, "to"), fmt = Json.Str(req, "format"), table = Json.Str(req, "table");
                        int workers = (int)Json.Long(req, "workers", 0);
                        Dictionary<string, string> v = Views(req);
                        Job j = e.Jobs.Start("export", to, jb => e.Export(jb, sql, v, to, fmt, table, workers));
                        return Json.Write(j.ToJson());
                    }
                case "pipeline":
                    {
                        Job j = e.Jobs.Start("pipeline", Json.Str(req, "name") ?? "pipeline", jb => e.RunPipeline(jb, req));
                        return Json.Write(j.ToJson());
                    }
                case "job":
                    {
                        Job j = e.Jobs.Get(q);
                        if (j == null) throw new EngineException("JOB_NOT_FOUND", "Job " + q + " not found.", 404);
                        return Json.Write(j.ToJson());
                    }
                case "job/cancel":
                    {
                        if (!e.Jobs.Cancel(q)) throw new EngineException("JOB_NOT_FOUND", "Job " + q + " not found.", 404);
                        Dictionary<string, object> d = new Dictionary<string, object>(); d["jobId"] = q; return Ok(d);
                    }
                case "jobs":
                    {
                        List<object> l = new List<object>();
                        foreach (Job j in e.Jobs.All()) l.Add(j.ToJson());
                        Dictionary<string, object> d = new Dictionary<string, object>(); d["jobs"] = l; return Ok(d);
                    }
                case "cache/load":
                    {
                        string name = Need(req, "name"), sql = Need(req, "sql"); Dictionary<string, string> v = Views(req); int wk = (int)Json.Long(req, "workers", 0);
                        if (!Json.Bool(req, "async", false)) return Ok(e.CacheLoad(name, sql, v, wk));
                        Job jc = e.Jobs.Start("cache", name, jb => e.CacheLoad(name, sql, v, wk, jb));   // as a job: rows read reported live
                        return Json.Write(jc.ToJson());
                    }
                case "memory/purge":
                    {
                        // Frees engine memory: cached tables (and their spills), resident datasets, then a compacting GC.
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["tables"] = e.CacheDrop(null); d["datasets"] = e.Resident.DropUnder(null);
                        System.Runtime.GCSettings.LargeObjectHeapCompactionMode = System.Runtime.GCLargeObjectHeapCompactionMode.CompactOnce;
                        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
                        d["managed"] = GC.GetTotalMemory(false); return Ok(d);
                    }
                case "cache/drop": { Dictionary<string, object> d = new Dictionary<string, object>(); d["dropped"] = e.CacheDrop(Json.Str(req, "name")); return Ok(d); }
                case "options":
                    {
                        // Rows per batch (also per row group / record batch written): the Benchmark page tries several.
                        if (req.ContainsKey("batchRows")) e.Options.BatchRowCount = (int)Math.Max(1000, Math.Min(2000000, Json.Long(req, "batchRows", 100000)));
                        Dictionary<string, object> d = new Dictionary<string, object>(); d["batchRows"] = e.Options.BatchRowCount; return Ok(d);
                    }
                case "memory": return Ok(e.Resident.Info());
                case "memory/load":
                    {
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["datasets"] = e.Resident.Preload(Json.Strs(req, "paths"), Json.Bool(req, "wait", false) ? 600000 : 0);
                        return Ok(d);
                    }
                case "memory/drop": { Dictionary<string, object> d = new Dictionary<string, object>(); d["dropped"] = e.Resident.DropUnder(Json.Str(req, "path")); return Ok(d); }
            }
            throw new EngineException("NOT_FOUND", "Unknown engine call: " + op, 404);
        }

        public static string ResultJson(QueryResult r)
        {
            StringBuilder sb = new StringBuilder(256 + (int)Math.Min(r.Rows * 32, 1 << 26));
            sb.Append("{\"ok\":true,\"cols\":[");
            for (int c = 0; c < r.Schema.Count; c++) { if (c > 0) sb.Append(','); Values.AppendJsonString(sb, r.Schema[c].Name); }
            sb.Append("],\"types\":[");
            for (int c = 0; c < r.Schema.Count; c++) { if (c > 0) sb.Append(','); Values.AppendJsonString(sb, (r.Schema[c].Type.Kind == Kind.Null ? DataType.Varchar : r.Schema[c].Type).Name); }
            sb.Append("],\"rows\":[");
            bool first = true;
            foreach (Batch b in r.Batches)
                for (int i = 0; i < b.Rows; i++)
                {
                    if (!first) sb.Append(','); first = false;
                    sb.Append('[');
                    for (int c = 0; c < b.Cols.Length; c++) { if (c > 0) sb.Append(','); Values.AppendJson(sb, b.Cols[c], i); }
                    sb.Append(']');
                }
            sb.Append("],\"rowCount\":").Append(r.Rows).Append(",\"truncated\":").Append(r.Truncated ? "true" : "false").Append(",\"ms\":").Append(r.Ms.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)).Append('}');
            return sb.ToString();
        }
    }
}
