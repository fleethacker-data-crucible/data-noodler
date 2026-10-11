// Paths, logical datasets (a folder of part-NNNNNN.arrow + dataset.json; older datasets: .parquet parts) and atomic dataset writes.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;

namespace NativeDataEngine
{
    public static class PathGuard
    {
        static readonly string[] DataExt = { ".csv", ".tsv", ".txt", ".parquet", ".pq", ".arrow", ".feather", ".sqlite", ".sqlite3", ".db" };

        // Project-relative path -> full path. Same rules as the server's Resolve-ProjectPath:
        // no absolute paths, no "..", no ':' and no dot-folders (.server, .git, .trash), no links.
        public static string Project(string root, string rel, bool allowRoot)
        {
            rel = (rel ?? "").Replace('\\', '/').Trim('/');
            if (rel.Length == 0 && !allowRoot) throw new EngineException("PATH_REQUIRED", "Path required.");
            if (rel.Contains(":") || rel.StartsWith("//")) throw new EngineException("PATH_FORBIDDEN", "Absolute paths are not allowed: " + rel, 403);
            foreach (string seg in rel.Split('/'))
            {
                if (seg == "..") throw new EngineException("PATH_FORBIDDEN", "Path is outside the project.", 403);
                if (seg.StartsWith(".")) throw new EngineException("PATH_FORBIDDEN", "Access to '" + seg + "' is not allowed.", 403);
            }
            string full = Path.GetFullPath(Path.Combine(root, rel.Replace('/', '\\'))).TrimEnd('\\');
            string r = root.TrimEnd('\\');
            if (!string.Equals(full, r, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(r + "\\", StringComparison.OrdinalIgnoreCase))
                throw new EngineException("PATH_FORBIDDEN", "Path is outside the project.", 403);
            for (string p = full; p.Length > r.Length; p = Path.GetDirectoryName(p))
                if ((File.Exists(p) || Directory.Exists(p)) && (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0)
                    throw new EngineException("PATH_FORBIDDEN", "Links are not allowed.", 403);
            return full;
        }

        // A source to read: project path, or a full local/network path (X:\... or \\server\share\...) to a data file (read only).
        public static string Source(string root, string p)
        {
            if (IsExternal(p))
            {
                string ext = Path.GetExtension(p).ToLowerInvariant();
                if (Array.IndexOf(DataExt, ext) < 0) throw new EngineException("PATH_FORBIDDEN", "Only data files (csv, tsv, txt, parquet, arrow, sqlite, db) can be read from outside the project.", 403);
                return Path.GetFullPath(p);
            }
            return Project(root, p, false);
        }
        public static bool IsExternal(string p) { return p != null && (System.Text.RegularExpressions.Regex.IsMatch(p, @"^[A-Za-z]:[\\/]") || p.StartsWith(@"\\")); }
        public static string Rel(string root, string full)
        {
            string r = root.TrimEnd('\\') + "\\";
            return full.StartsWith(r, StringComparison.OrdinalIgnoreCase) ? full.Substring(r.Length).Replace('\\', '/') : full;
        }
    }

    public static class Datasets
    {
        // Data files of a dataset: one .arrow / .parquet file, or a folder (dataset.json / manifest.json order, else part files by name).
        public static List<string> Files(string full)
        {
            if (File.Exists(full)) return new List<string> { full };
            if (!Directory.Exists(full)) throw new EngineException("DATASET_NOT_FOUND", "Dataset or file not found: " + Path.GetFileName(full), 404);
            foreach (string mf in new[] { "dataset.json", "manifest.json" })
            {
                string m = Path.Combine(full, mf);
                if (!File.Exists(m)) continue;
                Dictionary<string, object> j = Json.Parse(File.ReadAllText(m));
                object[] parts = Json.Arr(j, mf == "dataset.json" ? "partitions" : "parts");
                if (parts == null) continue;
                List<string> r = new List<string>();
                foreach (object o in parts)
                {
                    Dictionary<string, object> p = o as Dictionary<string, object>;
                    string f = p != null ? (Json.Str(p, "file") ?? Path.GetFileName(Json.Str(p, "path") ?? "")) : Convert.ToString(o);
                    r.Add(Path.Combine(full, f));
                }
                if (r.Count > 0) return r;
            }
            List<string> files = Directory.GetFiles(full, "*.arrow").OrderBy(f => f, StringComparer.OrdinalIgnoreCase).ToList();
            if (files.Count == 0) files = Directory.GetFiles(full, "*.parquet").OrderBy(f => f, StringComparer.OrdinalIgnoreCase).ToList();
            if (files.Count == 0) throw new EngineException("DATASET_EMPTY", "No Arrow or Parquet files in " + Path.GetFileName(full) + ".", 404);
            return files;
        }

        public static Dictionary<string, object> Manifest(string dir)
        {
            string m = Path.Combine(dir, "dataset.json");
            return File.Exists(m) ? Json.Parse(File.ReadAllText(m)) : null;
        }
    }

    // Writes a dataset into a temp folder, then swaps it in (the previous version stays intact until the swap).
    // Parts are Arrow IPC files (the working format, EngineOptions.DatasetFormat "arrow") or Parquet ("parquet").
    public sealed class DatasetWriter : IDisposable
    {
        readonly string dest, tmp, root; readonly Schema schema; readonly long partBytes, partRows; readonly bool arrow; readonly int codec;
        readonly List<Dictionary<string, object>> parts = new List<Dictionary<string, object>>();
        ArrowFileWriter cur; ParquetFileWriter pcur; int partNo; bool done;
        public long Rows, Bytes;

        public DatasetWriter(string root, string destFull, Schema schema, bool arrow, int codec, long partBytes, long partRows)
        {
            this.root = root; dest = destFull.TrimEnd('\\'); this.schema = schema; this.arrow = arrow; this.codec = codec; this.partBytes = partBytes; this.partRows = partRows;
            tmp = dest + ".tmp-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            Directory.CreateDirectory(tmp);
        }

        string PartPath() { return Path.Combine(tmp, "part-" + partNo.ToString("000000") + (arrow ? ".arrow" : ".parquet")); }
        public void Append(EncodedBatch g)
        {
            if (cur == null) cur = new ArrowFileWriter(PartPath(), schema);
            cur.Append(g);
            Rows += g.Rows;
            if (cur.Length >= partBytes || (partRows > 0 && cur.Rows >= partRows)) ClosePart();
        }
        public void Append(EncodedRowGroup g)
        {
            if (pcur == null) pcur = new ParquetFileWriter(PartPath(), schema, codec);
            pcur.Append(g);
            Rows += g.Rows;
            if (pcur.Length >= partBytes || (partRows > 0 && pcur.Rows >= partRows)) ClosePart();
        }
        void ClosePart()
        {
            string path; long rows;
            if (cur != null) { cur.Close(); path = cur.Path; rows = cur.Rows; cur = null; }
            else if (pcur != null) { pcur.Close(); path = pcur.Path; rows = pcur.Rows; pcur = null; }
            else return;
            long size = new FileInfo(path).Length; Bytes += size;
            Dictionary<string, object> p = new Dictionary<string, object>();
            p["file"] = Path.GetFileName(path); p["rows"] = rows; p["bytes"] = size;
            parts.Add(p); partNo++;
        }

        // meta: extra manifest fields (name, lineage, source...). Returns the manifest.
        public Dictionary<string, object> Commit(Dictionary<string, object> meta)
        {
            if (cur == null && pcur == null && parts.Count == 0) { if (arrow) cur = new ArrowFileWriter(PartPath(), schema); else pcur = new ParquetFileWriter(PartPath(), schema, codec); }   // empty dataset: one file with the schema
            ClosePart();
            Dictionary<string, object> old = Directory.Exists(dest) ? Datasets.Manifest(dest) : null;
            string now = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            Dictionary<string, object> m = new Dictionary<string, object>();
            m["name"] = Path.GetFileName(dest);
            m["formatVersion"] = 1;
            m["version"] = (old != null ? Json.Long(old, "version", 0) : 0) + 1;
            m["rowCount"] = Rows;
            m["bytes"] = Bytes;
            m["createdUtc"] = old != null && Json.Str(old, "createdUtc") != null ? Json.Str(old, "createdUtc") : now;
            m["updatedUtc"] = now;
            m["format"] = arrow ? "arrow" : "parquet";
            m["codec"] = arrow ? "none" : Codec.Name(codec);
            List<Dictionary<string, object>> cols = new List<Dictionary<string, object>>();
            List<string> names = ParquetFileWriter.UniqueNames(schema);
            for (int c = 0; c < schema.Count; c++) { Dictionary<string, object> d = new Dictionary<string, object>(); d["name"] = names[c]; d["type"] = (schema[c].Type.Kind == Kind.Null ? DataType.Varchar : schema[c].Type).Name; cols.Add(d); }
            m["columns"] = cols;
            m["partitions"] = parts;
            if (meta != null) foreach (KeyValuePair<string, object> kv in meta) m[kv.Key] = kv.Value;
            File.WriteAllText(Path.Combine(tmp, "dataset.json.tmp"), Json.Write(m));
            File.Move(Path.Combine(tmp, "dataset.json.tmp"), Path.Combine(tmp, "dataset.json"));

            // Swap: dest -> dest.old, tmp -> dest, then remove the old one (and a legacy single-file dest.parquet).
            string oldDir = dest + ".old-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            bool moved = false;
            if (Directory.Exists(dest)) { Retry(() => Directory.Move(dest, oldDir)); moved = true; }
            try { Retry(() => Directory.Move(tmp, dest)); }
            catch { if (moved) Directory.Move(oldDir, dest); throw; }
            DataFiles.Forget(dest);
            if (moved) TryDelete(oldDir);
            foreach (string single in new[] { dest + ".parquet", dest + ".arrow" })
                if (File.Exists(single)) { try { File.Delete(single); } catch { } }
            done = true;
            m["path"] = PathGuard.Rel(root, dest);
            List<string> files = new List<string>();
            foreach (Dictionary<string, object> p in parts) files.Add(PathGuard.Rel(root, Path.Combine(dest, (string)p["file"])));
            m["files"] = files;
            return m;
        }
        static void Retry(Action a)
        {
            for (int i = 0; ; i++)
            {
                try { a(); return; }
                catch (IOException) { if (i >= 20) throw; System.Threading.Thread.Sleep(150); }
                catch (UnauthorizedAccessException) { if (i >= 20) throw; System.Threading.Thread.Sleep(150); }
            }
        }
        public static void TryDelete(string dir) { for (int i = 0; i < 10; i++) { try { if (Directory.Exists(dir)) Directory.Delete(dir, true); return; } catch { System.Threading.Thread.Sleep(200); } } }

        public void Dispose()
        {
            if (done) return;
            if (cur != null) cur.Dispose();
            if (pcur != null) pcur.Dispose();
            TryDelete(tmp);   // failed or cancelled: the previous dataset is untouched
        }
    }
}
