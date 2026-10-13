// Resident datasets: project datasets (workspace/projects/<p>/data/source|imported/<name>/) held in engine memory as columnar
// batches, so every module (Transform, Dashboard, D3 Studio, Publish) queries RAM instead of decoding Parquet again.
// Parquet stays the on-disk / export format; memory is only a faster copy of it.
//  - One batch per Parquet row group, in file order: a resident dataset gives the same units, order and answers.
//  - Freshness: each entry keeps a signature (file sizes + write times); a changed dataset is never served stale,
//    and a dataset write (DatasetWriter commit) drops its entry at once.
//  - Memory: entries hold a MemoryLease (they count against the engine budget) and share at most ResidentFraction
//    of it; least recently used entries are dropped to make room. A dataset that does not fit stays on disk.
//  - Batches are never changed in place by operators, so queries can share them; dropping an entry only drops
//    the reference (a query still reading it keeps its batches alive until it ends).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace NativeDataEngine
{
    public sealed class ResidentDatasets
    {
        sealed class Entry
        {
            public string Key, Sig, Rel; public List<string> Files; public Schema Schema; public List<Batch> Batches;
            public long Bytes, Rows, Ms, LastUsed, Hits; public MemoryLease Lease;
        }

        readonly DataEngine e;
        readonly object gate = new object();
        readonly Dictionary<string, Entry> entries = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, string> loading = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // key -> rel path
        readonly Dictionary<string, string> skipped = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // key|sig -> reason (too big)
        readonly Dictionary<string, string> failed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);    // key -> last load error
        // Module windows (client ids) -> the dataset folders each asked for. A closing window releases its own;
        // when none is left, the engine purges (DataEngine.Release).
        readonly Dictionary<string, HashSet<string>> holders = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        long clock;

        public ResidentDatasets(DataEngine e) { this.e = e; }

        public long Cap { get { return (long)(e.Mem.Budget * Math.Max(0.0, Math.Min(0.9, e.Options.ResidentFraction))); } }
        public bool Enabled { get { return e.Options.ResidentFraction > 0; } }
        public long Bytes { get { lock (gate) { long b = 0; foreach (Entry x in entries.Values) b += x.Bytes; return b; } } }

        // A project dataset folder that may be held in memory (only data/source and data/imported inside a project).
        public bool Eligible(string full)
        {
            if (!Enabled || full == null || !Directory.Exists(full)) return false;
            string rel = PathGuard.Rel(e.Root, full).Replace('\\', '/');
            if (rel == full) return false;   // outside the project root
            string[] seg = rel.Split('/');
            return seg.Length == 6 && string.Equals(seg[0], "workspace", StringComparison.OrdinalIgnoreCase) && string.Equals(seg[1], "projects", StringComparison.OrdinalIgnoreCase) && string.Equals(seg[3], "data", StringComparison.OrdinalIgnoreCase) &&
                (string.Equals(seg[4], "source", StringComparison.OrdinalIgnoreCase) || string.Equals(seg[4], "imported", StringComparison.OrdinalIgnoreCase));
        }

        static string Signature(List<string> files, string folder)
        {
            StringBuilder sb = new StringBuilder();
            foreach (string f in files)
            {
                FileInfo fi = new FileInfo(f);
                if (!fi.Exists) return null;
                sb.Append(f.ToLowerInvariant()).Append('|').Append(fi.Length).Append('|').Append(fi.LastWriteTimeUtc.Ticks).Append(';');
            }
            FileInfo m = new FileInfo(Path.Combine(folder, "dataset.json"));
            if (m.Exists) sb.Append(m.Length).Append('|').Append(m.LastWriteTimeUtc.Ticks);
            return sb.ToString();
        }

        // The dataset as an in-memory source, or null (not resident / changed on disk). A miss starts a background
        // load when warm is true, so the next query reads memory.
        public Source TryGet(string full, List<string> files, bool warm)
        {
            if (!Eligible(full)) return null;
            string sig = Signature(files, full);
            if (sig == null) return null;
            lock (gate)
            {
                Entry x;
                if (entries.TryGetValue(full, out x))
                {
                    if (x.Sig == sig) { x.LastUsed = ++clock; x.Hits++; return new MemSource(x.Schema, x.Batches, true); }
                    Drop(x);   // stale
                }
            }
            if (warm) StartLoad(full, files, sig);
            return null;
        }

        // Starts background loads; returns what each path is doing (resident / loading / skipped / error). waitMs > 0:
        // waits up to that long for the loads to finish first (the Dashboard waits so its first queries read RAM).
        // client (optional): the module window asking; it holds these datasets until it releases them.
        public List<Dictionary<string, object>> Preload(IEnumerable<string> rels, int waitMs, string client)
        {
            List<string> list = new List<string>(rels);
            List<string> fulls = new List<string>();
            if (!string.IsNullOrEmpty(client)) lock (gate) if (!holders.ContainsKey(client)) holders[client] = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string rel in list)
            {
                string full = null;
                try
                {
                    full = PathGuard.Project(e.Root, rel, false);
                    if (Eligible(full))
                    {
                        if (!string.IsNullOrEmpty(client)) lock (gate) holders[client].Add(full);
                        List<string> files = Datasets.Files(full);
                        if (Find(full, Signature(files, full)) == null) StartLoad(full, files, Signature(files, full));
                    }
                }
                catch { }
                fulls.Add(full);
            }
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            while (waitMs > 0 && sw.ElapsedMilliseconds < waitMs)
            {
                bool busy = false;
                lock (gate) foreach (string f in fulls) if (f != null && loading.ContainsKey(f)) busy = true;
                if (!busy) break;
                Thread.Sleep(25);
            }
            List<Dictionary<string, object>> r = new List<Dictionary<string, object>>();
            for (int i = 0; i < list.Count; i++)
            {
                Dictionary<string, object> d = new Dictionary<string, object>(); d["path"] = list[i];
                try
                {
                    string full = fulls[i] ?? PathGuard.Project(e.Root, list[i], false);
                    if (!Eligible(full)) { d["state"] = "skipped"; d["reason"] = "not a project dataset folder (data/source or data/imported)"; r.Add(d); continue; }
                    List<string> files = Datasets.Files(full);
                    string sig = Signature(files, full);
                    Entry x = Find(full, sig);
                    string why;
                    if (x != null) { d["state"] = "resident"; d["rows"] = x.Rows; d["bytes"] = x.Bytes; d["loadMs"] = x.Ms; }
                    else lock (gate)
                        {
                            if (loading.ContainsKey(full)) d["state"] = "loading";
                            else if (skipped.TryGetValue(full + "|" + sig, out why) || failed.TryGetValue(full, out why)) { d["state"] = "skipped"; d["reason"] = why; }
                            else d["state"] = "loading";
                        }
                }
                catch (Exception ex) { d["state"] = "error"; d["reason"] = EngineError.From(ex).Message; }
                r.Add(d);
            }
            return r;
        }
        Entry Find(string full, string sig)
        {
            lock (gate) { Entry x; return sig != null && entries.TryGetValue(full, out x) && x.Sig == sig ? x : null; }
        }

        // null = loading (now or already); else why it will not load.
        string StartLoad(string full, List<string> files, string sig)
        {
            if (sig == null) return "files changed while reading";
            lock (gate)
            {
                if (loading.ContainsKey(full)) return null;
                string why; if (skipped.TryGetValue(full + "|" + sig, out why)) return why;
                loading[full] = PathGuard.Rel(e.Root, full); failed.Remove(full);
            }
            Thread t = new Thread(() => Load(full, files, sig));
            t.IsBackground = true; t.Name = "ResidentLoad"; t.Start();
            return null;
        }

        void Load(string full, List<string> files, string sig)
        {
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            Entry x = new Entry(); x.Key = full; x.Sig = sig; x.Files = files; x.Rel = PathGuard.Rel(e.Root, full);
            x.Lease = new MemoryLease(e.Mem, "Resident dataset " + Path.GetFileName(full));
            bool ok = false; string reason = null;
            try
            {
                Source ps = DataFiles.Open(files);
                x.Schema = ps.Schema; x.Batches = new List<Batch>();
                ExecCtx ctx = e.Ctx(null, 0, CancellationToken.None);
                try
                {
                    int n = ps.Units(ctx);
                    TextIntern[] shared = new TextIntern[x.Schema.Count];
                    for (int c = 0; c < shared.Length; c++) if (x.Schema[c].Type.Kind == Kind.String) shared[c] = new TextIntern();
                    foreach (Batch b in e.Pool.Ordered(n, Math.Min(n, ctx.Parallel), u => { List<Batch> l = new List<Batch>(ps.RunUnit(ctx, u)); return l.Count == 1 ? l[0] : Batch.Concat(ps.Schema, l); }, CancellationToken.None, e.Mem))
                    {
                        long bytes = Share(b, shared);
                        if (!Room(full, x.Bytes + bytes)) { reason = "larger than the in-memory share (" + MemoryGuard.Mb(Cap) + "): read from its files"; break; }
                        x.Lease.Add(bytes);
                        x.Batches.Add(b); x.Rows += b.Rows; x.Bytes += bytes;
                    }
                }
                finally { ctx.End(); }
                if (reason == null && Signature(files, full) != sig) reason = "changed while loading";
                ok = reason == null;
            }
            catch (Exception ex) { reason = EngineError.From(ex).Message; }
            x.Ms = sw.ElapsedMilliseconds;
            lock (gate)
            {
                loading.Remove(full);
                if (ok)
                {
                    Entry old; if (entries.TryGetValue(full, out old)) Drop(old);
                    x.LastUsed = ++clock; entries[full] = x;
                }
                else if (reason != null && reason.StartsWith("larger")) skipped[full + "|" + sig] = reason;
                else if (reason != null) failed[full] = reason;
            }
            if (ok) EngineLog.Write("engine", "In memory: " + x.Rel + " (" + x.Rows.ToString("N0") + " rows, " + MemoryGuard.Mb(x.Bytes) + ") in " + x.Ms + " ms.");
            else
            {
                x.Lease.Dispose(); x.Batches = null;
                EngineLog.Write("engine", "Not in memory: " + x.Rel + ": " + reason);
            }
        }

        // Text for memory (the batch is fresh from the reader, so it is changed in place before anyone sees it):
        //  - repeated text across the whole dataset becomes one shared string per distinct value;
        //  - mostly-distinct text (the sharing turned itself off) is kept as Arrow bytes, decoded per query
        //    (Column.LazyText): millions of strings held for hours would make every garbage collection slow.
        // Returns the batch's memory, each distinct shared string counted once.
        static long Share(Batch b, TextIntern[] shared)
        {
            long bytes = 0;
            for (int c = 0; c < b.Cols.Length; c++)
            {
                Column col = b.Cols[c];
                if (col.S == null || shared[c] == null) { bytes += col.Bytes; continue; }
                TextIntern t = shared[c];
                if (!t.Off)
                {
                    string[] s = col.S; long strBytes = 0;
                    for (int i = 0; i < s.Length && !t.Off; i++)
                    {
                        string v = s[i]; if (v == null) continue;
                        int before = t.Distinct;
                        s[i] = t.Get(v);
                        if (t.Distinct > before) strBytes += 24 + 2L * v.Length;
                    }
                    if (!t.Off) { bytes += 32 + 8L * col.Length + (col.Nulls != null ? col.Length : 0) + strBytes; continue; }
                }
                Column lazy = Column.LazyText(col);
                b.Cols[c] = lazy; bytes += lazy.Bytes;
            }
            return bytes;
        }

        // Room for `need` bytes of dataset `key`: drops least recently used entries (never the one asked for).
        bool Room(string key, long need)
        {
            if (need > Cap) return false;
            lock (gate)
            {
                while (true)
                {
                    long used = 0; foreach (Entry x in entries.Values) if (!string.Equals(x.Key, key, StringComparison.OrdinalIgnoreCase)) used += x.Bytes;
                    if (used + need <= Cap) return true;
                    Entry lru = entries.Values.Where(x => !string.Equals(x.Key, key, StringComparison.OrdinalIgnoreCase)).OrderBy(x => x.LastUsed).FirstOrDefault();
                    if (lru == null) return used + need <= Cap;
                    Drop(lru);
                    EngineLog.Write("engine", "In memory: dropped " + lru.Rel + " to make room.");
                }
            }
        }

        void Drop(Entry x)   // caller holds gate
        {
            entries.Remove(x.Key);
            x.Lease.Dispose(); x.Batches = null;
        }

        // A dataset folder was rewritten (or deleted): free its memory now (the signature check would also catch it).
        public void Forget(string full)
        {
            lock (gate) { Entry x; if (entries.TryGetValue(full.TrimEnd('\\'), out x)) Drop(x); }
        }

        // Drops every entry under a path (rel, project-relative; null or "" = all). Returns how many were dropped.
        public int DropUnder(string rel)
        {
            string pre = string.IsNullOrEmpty(rel) ? null : PathGuard.Project(e.Root, rel, false);
            int n = 0;
            lock (gate)
            {
                foreach (Entry x in entries.Values.ToList())
                    if (pre == null || string.Equals(x.Key, pre, StringComparison.OrdinalIgnoreCase) || x.Key.StartsWith(pre + "\\", StringComparison.OrdinalIgnoreCase)) { Drop(x); n++; }
            }
            if (n > 0) GC.Collect();
            return n;
        }

        // A module window closed: forgets it and drops every dataset no open window holds (also ones loaded by a
        // query alone). open = windows still holding datasets. Returns how many were dropped.
        public int Release(string client, out int open)
        {
            int n = 0;
            lock (gate)
            {
                if (!string.IsNullOrEmpty(client)) holders.Remove(client);
                open = holders.Count;
                HashSet<string> keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (HashSet<string> h in holders.Values) keep.UnionWith(h);
                foreach (Entry x in entries.Values.ToList()) if (!keep.Contains(x.Key)) { Drop(x); n++; }
            }
            return n;
        }
        public int Windows { get { lock (gate) return holders.Count; } }

        // Free RAM is under the floor: drop entries, least recently used first, until it recovers or none is left.
        public void Trim()
        {
            while (e.Mem.LowRam)
            {
                Entry lru;
                lock (gate) { lru = entries.Values.OrderBy(x => x.LastUsed).FirstOrDefault(); if (lru != null) Drop(lru); }
                if (lru == null) return;
                EngineLog.Write("engine", "In memory: dropped " + lru.Rel + " (free RAM under " + MemoryGuard.Mb(e.Mem.MinFree) + ").");
                DataEngine.Compact();
            }
        }

        public Dictionary<string, object> Info()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            List<object> l = new List<object>();
            lock (gate)
            {
                foreach (Entry x in entries.Values.OrderByDescending(v => v.LastUsed))
                {
                    Dictionary<string, object> o = new Dictionary<string, object>();
                    o["path"] = x.Rel; o["rows"] = x.Rows; o["bytes"] = x.Bytes; o["columns"] = x.Schema.Count; o["batches"] = x.Batches.Count; o["loadMs"] = x.Ms; o["hits"] = x.Hits;
                    l.Add(o);
                }
                d["loading"] = loading.Values.ToList();
            }
            d["datasets"] = l; d["bytes"] = Bytes; d["cap"] = Cap; d["enabled"] = Enabled; d["windows"] = Windows;
            return d;
        }
    }
}
