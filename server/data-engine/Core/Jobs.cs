// Long work (import, write, export, pipeline runs) runs as a job: the request returns a job id at once and the
// browser polls /api/data-engine/job?id=. Jobs can be cancelled; finished jobs are kept for 30 minutes.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

namespace NativeDataEngine
{
    public sealed class Job
    {
        static int seq;
        public readonly string Id, Kind, Label;
        public volatile string State = "queued";
        public volatile string Stage = "";
        public double Progress = -1;
        public Func<double> Live;   // when set: the progress, worked out on each poll (WriteTables)
        long rows, bytes; public long BytesTotal, RowsTotal;
        public readonly DateTime Created = DateTime.UtcNow;
        public DateTime Finished;
        public readonly Stopwatch Clock = new Stopwatch();
        public object Result;
        public EngineError Error;
        public readonly CancellationTokenSource Cts = new CancellationTokenSource();
        internal readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        // Blocks up to ms milliseconds; true once the job has finished (done, failed or cancelled).
        public bool WaitDone(int ms) { return Done.Wait(ms); }

        public Job(string kind, string label) { Id = "job-" + Interlocked.Increment(ref seq); Kind = kind; Label = label; }
        public void AddRows(long n) { Interlocked.Add(ref rows, n); }
        public void AddBytes(long n) { long b = Interlocked.Add(ref bytes, n); if (BytesTotal > 0) Progress = Math.Min(0.99, b / (double)BytesTotal); }
        public long Rows { get { return Interlocked.Read(ref rows); } }

        public Dictionary<string, object> ToJson()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["ok"] = true; d["jobId"] = Id; d["kind"] = Kind; d["label"] = Label; d["state"] = State; d["stage"] = Stage;
            double p = Progress;
            if (Live != null) { try { p = Live(); } catch { } }
            if (p < 0 && RowsTotal > 0) p = Math.Min(0.99, Rows / (double)RowsTotal);
            d["progress"] = p < 0 ? null : (object)Math.Round(p, 4);
            d["rowsProcessed"] = Rows; d["bytesProcessed"] = Interlocked.Read(ref bytes); d["bytesTotal"] = BytesTotal;
            d["elapsedMs"] = Clock.ElapsedMilliseconds;
            if (Result != null) d["result"] = Result;
            if (Error != null) d["error"] = Error.ToJson();
            return d;
        }
    }

    public sealed class JobManager
    {
        readonly ConcurrentDictionary<string, Job> jobs = new ConcurrentDictionary<string, Job>();

        public Job Start(string kind, string label, Func<Job, object> work)
        {
            Job j = new Job(kind, label);
            jobs[j.Id] = j;
            Prune();
            Thread t = new Thread(() =>
            {
                j.State = "running"; j.Clock.Start();
                bool quiet = kind == "query" || kind == "cache";   // Benchmark steps: not logged one by one
                if (!quiet) EngineLog.Write("engine", "Job " + j.Id + " started: " + kind + " " + label);
                try
                {
                    j.Result = work(j);
                    j.State = "done"; j.Progress = 1;
                    if (!quiet) EngineLog.Write("engine", "Job " + j.Id + " done in " + j.Clock.ElapsedMilliseconds + " ms: " + kind + " " + label);
                }
                catch (Exception e)
                {
                    j.Error = EngineError.From(e);
                    j.State = j.Error.Code == "CANCELLED" ? "cancelled" : "failed";
                    EngineLog.Write(j.State == "cancelled" ? "engine" : "err", "Job " + j.Id + " " + j.State + ": " + kind + " " + label + ": " + j.Error.Message);
                    if (j.State == "failed" && !(e is EngineException)) EngineLog.Write("err", j.Error.Detail);
                }
                finally { j.Clock.Stop(); j.Finished = DateTime.UtcNow; j.Done.Set(); }
            });
            t.IsBackground = true; t.Name = "Job-" + j.Id;
            t.Start();
            return j;
        }
        public Job Get(string id) { Job j; return id != null && jobs.TryGetValue(id, out j) ? j : null; }
        public bool Cancel(string id) { Job j = Get(id); if (j == null) return false; j.Cts.Cancel(); return true; }
        public int Running { get { int n = 0; foreach (Job j in jobs.Values) if (j.State == "running" || j.State == "queued") n++; return n; } }
        public List<Job> All() { return new List<Job>(jobs.Values); }
        void Prune()
        {
            foreach (Job j in jobs.Values)
                if ((j.State == "done" || j.State == "failed" || j.State == "cancelled") && (DateTime.UtcNow - j.Finished).TotalMinutes > 30) { Job x; jobs.TryRemove(j.Id, out x); }
        }
        public void CancelAll() { foreach (Job j in jobs.Values) j.Cts.Cancel(); }
    }
}
