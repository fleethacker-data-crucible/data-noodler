// Streaming CSV: state-machine parser (quotes, doubled quotes, delimiters and newlines inside quotes, CRLF/LF,
// UTF-8 BOM), delimiter + header detection, type inference on a sample, explicit types, empty = NULL.
// Never loads the file: reads a buffer at a time and emits batches of BatchRowCount rows.
// A value that does not fit the inferred type widens that column (TypeWidenException) and the query restarts.
// Parallel: a big file is cut into byte ranges that start on record boundaries (one quote-aware byte scan, cached per
// file version); each range is one unit, parsed on its own worker, results kept in file order.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace NativeDataEngine
{
    public sealed class CsvOptions
    {
        public char Delimiter = '\0';   // 0 = detect
        public int Header = -1;         // -1 detect, 0 no, 1 yes
        public char Quote = '"';
        public string NullText = "";
        public Dictionary<string, DataType> Types = new Dictionary<string, DataType>(StringComparer.OrdinalIgnoreCase);
        public bool AllVarchar;
        public int SampleRows = 20000;
    }

    public sealed class TypeWidenException : Exception
    {
        public readonly string File; public readonly int Column; public readonly DataType To;
        public TypeWidenException(string file, int col, DataType to) : base("widen") { File = file; Column = col; To = to; }
    }

    public sealed class CsvParser : IDisposable
    {
        readonly TextReader r; readonly char delim, quote;
        readonly char[] buf = new char[1 << 16]; int len, pos; bool eof;
        public long Records;
        // The current record: field k is Rec[Start[k] .. Start[k] + Len[k]) (quotes removed, "" unescaped); Quoted[k] = it was
        // quoted. Read straight from here (no string per field); Text(k) makes one when needed.
        public char[] Rec = new char[1024]; public int[] Start = new int[64], Len = new int[64]; public bool[] Quoted = new bool[64];
        public int Count;
        int recLen;

        public CsvParser(Stream s, char delim, char quote)
        {
            r = new StreamReader(s, new UTF8Encoding(false), true, 1 << 16);
            this.delim = delim; this.quote = quote;
        }
        bool Fill() { if (eof) return false; len = r.Read(buf, 0, buf.Length); pos = 0; if (len <= 0) { eof = true; len = 0; return false; } return true; }
        void Put(char c) { if (recLen == Rec.Length) Array.Resize(ref Rec, Rec.Length * 2); Rec[recLen++] = c; }
        void End(int fieldStart, bool wasQuoted)
        {
            if (Count == Start.Length) { Array.Resize(ref Start, Count * 2); Array.Resize(ref Len, Count * 2); Array.Resize(ref Quoted, Count * 2); }
            Start[Count] = fieldStart; Len[Count] = recLen - fieldStart; Quoted[Count] = wasQuoted; Count++;
        }
        public string Text(int k) { return new string(Rec, Start[k], Len[k]); }

        // Next record into Rec / Start / Len / Quoted / Count. Returns false at end of file.
        public bool Next()
        {
            Count = 0; recLen = 0;
            if (pos >= len && !Fill()) return false;
            int fs = 0;
            bool quoted = false, wasQuoted = false;
            while (true)
            {
                if (pos >= len && !Fill())
                {
                    if (quoted) throw new EngineException("CSV_INVALID_QUOTE", "Unclosed quote in the last record (record " + (Records + 1) + ").");
                    End(fs, wasQuoted); Records++; return true;
                }
                char c = buf[pos++];
                if (quoted)
                {
                    if (c == quote)
                    {
                        if (pos >= len) Fill();
                        if (pos < len && buf[pos] == quote) { Put(quote); pos++; }
                        else quoted = false;
                    }
                    else Put(c);
                    continue;
                }
                if (c == delim) { End(fs, wasQuoted); fs = recLen; wasQuoted = false; continue; }
                if (c == '\n' || c == '\r')
                {
                    if (c == '\r') { if (pos >= len) Fill(); if (pos < len && buf[pos] == '\n') pos++; }
                    if (Count == 0 && recLen == fs && !wasQuoted) { if (pos >= len && !Fill()) return false; continue; }   // blank line
                    End(fs, wasQuoted); Records++; return true;
                }
                if (c == quote && recLen == fs && !wasQuoted) { quoted = true; wasQuoted = true; continue; }
                Put(c);
            }
        }
        // Next record as strings (detection, samples): a quoted field carries a "\0Q" prefix (Clean removes it).
        public bool Next(List<string> fields)
        {
            fields.Clear();
            if (!Next()) return false;
            for (int k = 0; k < Count; k++) { string s = Text(k); fields.Add(Quoted[k] ? "\u0000Q" + s : s); }
            return true;
        }
        public static string Clean(string s, out bool quoted) { quoted = s.StartsWith("\u0000Q", StringComparison.Ordinal); return quoted ? s.Substring(2) : s; }
        public void Dispose() { r.Dispose(); }
    }

    // Read-only view of the next `length` bytes of a stream (one CSV range).
    sealed class RangeStream : Stream
    {
        readonly Stream s; readonly long length; long done;
        public RangeStream(Stream s, long length) { this.s = s; this.length = length; }
        public override int Read(byte[] b, int o, int n)
        {
            long left = length - done; if (left <= 0) return 0;
            int r = s.Read(b, o, (int)Math.Min(n, left)); done += r; return r;
        }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position { get { return done; } set { throw new NotSupportedException(); } }
        public override void Flush() { }
        public override long Seek(long o, SeekOrigin k) { throw new NotSupportedException(); }
        public override void SetLength(long v) { throw new NotSupportedException(); }
        public override void Write(byte[] b, int o, int n) { throw new NotSupportedException(); }
        protected override void Dispose(bool d) { if (d) s.Dispose(); base.Dispose(d); }
    }

    public sealed class CsvShape
    {
        public char Delimiter; public bool Header; public Schema Schema; public long Size; public DateTime Modified;
    }

    public sealed class CsvSource : Source
    {
        readonly string path, display; readonly CsvOptions opt; readonly int per; readonly CsvShape shape;
        static readonly ConcurrentDictionary<string, CsvShape> shapes = new ConcurrentDictionary<string, CsvShape>(StringComparer.OrdinalIgnoreCase);
        // Columns widened after a failed conversion, per file version: key = path|size|mtime|col.
        static readonly ConcurrentDictionary<string, DataType> widened = new ConcurrentDictionary<string, DataType>(StringComparer.OrdinalIgnoreCase);

        public CsvSource(string path, string display, CsvOptions opt, int per)
        {
            this.path = path; this.display = display; this.opt = opt; this.per = per;
            shape = Detect(path, opt);
            Schema = shape.Schema;
        }
        HashSet<int> needed;   // null = all; columns the query never reads are not converted
        public void SetNeeded(HashSet<int> cols) { needed = cols; }

        const long MinSplit = 16L << 20;   // files under 16 MB stay one unit
        static readonly ConcurrentDictionary<string, long[]> splits = new ConcurrentDictionary<string, long[]>(StringComparer.OrdinalIgnoreCase);
        long[] starts;   // record-boundary byte offsets; unit u = [starts[u], starts[u + 1])

        public override int Units(ExecCtx ctx)
        {
            if (starts == null)
            {
                int workers = ctx != null && ctx.Parallel > 0 ? ctx.Parallel : 1;
                string key = path + "|" + shape.Size + "|" + shape.Modified.Ticks + "|" + shape.Delimiter + opt.Quote + "|" + workers;
                long[] s;
                if (!splits.TryGetValue(key, out s)) { s = Split(path, shape.Size, shape.Delimiter, opt.Quote, workers); splits[key] = s; }
                starts = s;
            }
            return starts.Length - 1;
        }

        // Cut points: about 4 ranges per worker (min 8 MB each), each moved forward to the next record start.
        // The scan follows the parser's quote rules on raw bytes (quote, delimiter and newline are ASCII, so UTF-8 is safe).
        static long[] Split(string path, long size, char delimCh, char quoteCh, int workers)
        {
            if (size < MinSplit || workers <= 1 || delimCh > 127 || quoteCh > 127) return new long[] { 0, size };
            long target = Math.Max(8L << 20, size / (workers * 4));
            List<long> at = new List<long>(); at.Add(0);
            byte quote = (byte)quoteCh, delim = (byte)delimCh;
            byte[] buf = new byte[1 << 20];
            bool inQ = false, maybeClose = false, fieldStart = true;
            long next = target, pos = 0;
            using (Stream st = OpenRead(path))
            {
                int n;
                while ((n = st.Read(buf, 0, buf.Length)) > 0)
                {
                    for (int i = 0; i < n; i++)
                    {
                        byte c = buf[i];
                        if (maybeClose) { maybeClose = false; if (c == quote) continue; inQ = false; }
                        if (inQ) { if (c == quote) maybeClose = true; continue; }
                        if (c == (byte)'\n')
                        {
                            fieldStart = true;
                            long p = pos + i + 1;
                            if (p >= next && p < size) { at.Add(p); next = p + target; }
                            continue;
                        }
                        if (c == quote && fieldStart) { inQ = true; fieldStart = false; continue; }
                        fieldStart = c == (byte)'\r' || c == delim;
                    }
                    pos += n;
                }
            }
            at.Add(size);
            return at.ToArray();
        }

        static Stream OpenRead(string path)
        {
            return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.SequentialScan);
        }

        static string WidenKey(string path, CsvShape s, int col) { return path + "|" + s.Size + "|" + s.Modified.Ticks + "|" + col; }
        public static void Widen(TypeWidenException w)
        {
            FileInfo fi = new FileInfo(w.File);
            widened[w.File + "|" + fi.Length + "|" + fi.LastWriteTimeUtc.Ticks + "|" + w.Column] = w.To;
            CsvShape s; foreach (string k in shapes.Keys) if (k.StartsWith(w.File + "|", StringComparison.OrdinalIgnoreCase)) shapes.TryRemove(k, out s);
        }

        public static CsvShape Detect(string path, CsvOptions opt)
        {
            FileInfo fi = new FileInfo(path);
            if (!fi.Exists) throw new EngineException("FILE_NOT_FOUND", "File not found: " + Path.GetFileName(path), 404);
            string key = path + "|" + fi.Length + "|" + fi.LastWriteTimeUtc.Ticks + "|" + opt.Delimiter + opt.Header + opt.AllVarchar + "|" + string.Join(",", opt.Types.Keys);
            CsvShape cached;
            if (opt.Types.Count == 0 && shapes.TryGetValue(key, out cached)) return cached;
            CsvShape s = new CsvShape(); s.Size = fi.Length; s.Modified = fi.LastWriteTimeUtc;
            // Delimiter: the candidate splitting the first lines most consistently into the most fields.
            s.Delimiter = opt.Delimiter != '\0' ? opt.Delimiter : DetectDelimiter(path, opt.Quote);
            List<List<string>> sample = new List<List<string>>();
            using (Stream st = OpenRead(path))
            using (CsvParser p = new CsvParser(st, s.Delimiter, opt.Quote))
            {
                List<string> f = new List<string>();
                while (sample.Count < opt.SampleRows + 1 && p.Next(f)) sample.Add(new List<string>(f));
            }
            int width = 0; foreach (List<string> row in sample) width = Math.Max(width, row.Count);
            List<string> first = sample.Count > 0 ? sample[0] : new List<string>();
            DataType[] types = new DataType[width];
            for (int c = 0; c < width; c++) types[c] = Infer(sample, c, 1);
            DataType[] typesAll = new DataType[width];
            for (int c = 0; c < width; c++) typesAll[c] = Infer(sample, c, 0);
            if (opt.Header >= 0) s.Header = opt.Header == 1;
            else
            {
                // Header if some first-row value is text where the column below is not, or all first-row values are text and unique.
                bool header = false, allText = true; HashSet<string> seen = new HashSet<string>();
                for (int c = 0; c < first.Count; c++)
                {
                    bool q; string v = CsvParser.Clean(first[c], out q);
                    if (types[c].Kind != Kind.String && v.Length > 0 && !Fits(v, types[c])) header = true;
                    if (v.Length == 0 || !seen.Add(v)) allText = false;
                    DataType one = Infer1(v);
                    if (one.Kind != Kind.String) allText = false;
                }
                s.Header = header || (allText && first.Count > 0);
            }
            DataType[] use = s.Header ? types : typesAll;
            List<Field> fields = new List<Field>(); HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int c = 0; c < width; c++)
            {
                string n = "column" + c;
                if (s.Header && c < first.Count) { bool q; n = CsvParser.Clean(first[c], out q).Trim(); if (n.Length == 0) n = "column" + c; }
                string b = n; int k = 1; while (!names.Add(n)) n = b + "_" + (k++);
                DataType t = opt.AllVarchar ? DataType.Varchar : use[c];
                DataType forced; if (opt.Types.TryGetValue(n, out forced)) t = forced;
                DataType w; if (widened.TryGetValue(WidenKey(path, s, c), out w)) t = w;
                fields.Add(new Field(n, t));
            }
            s.Schema = new Schema(fields);
            if (opt.Types.Count == 0) shapes[key] = s;
            return s;
        }

        static char DetectDelimiter(string path, char quote)
        {
            char[] cands = { ',', ';', '\t', '|' };
            List<string> lines = new List<string>();
            using (StreamReader r = new StreamReader(OpenRead(path), new UTF8Encoding(false), true))
            {
                string l; while (lines.Count < 30 && (l = r.ReadLine()) != null) if (l.Length > 0) lines.Add(l);
            }
            char best = ','; double bestScore = -1;
            foreach (char d in cands)
            {
                List<int> counts = new List<int>();
                foreach (string l in lines) { int n = 0; bool q = false; foreach (char c in l) { if (c == quote) q = !q; else if (c == d && !q) n++; } counts.Add(n); }
                if (counts.Count == 0 || counts[0] == 0) continue;
                int same = 0; foreach (int n in counts) if (n == counts[0]) same++;
                double score = same * 1000.0 / counts.Count + counts[0];
                if (score > bestScore) { bestScore = score; best = d; }
            }
            return best;
        }

        static DataType Infer1(string v)
        {
            long l; double d; bool b; long t;
            if (v.Length == 0) return DataType.Null;
            if (Values.ParseLong(v, out l) && !LeadingZero(v)) return DataType.BigInt;
            if (Values.ParseDouble(v, out d) && v.IndexOf(',') < 0 && !char.IsLetter(v.Trim()[0]) && !LeadingZero(v)) return DataType.Double;
            if (Values.ParseBool(v, out b) && v.Length > 1) return DataType.Bool;
            if (Values.ParseDate(v, out t)) return DataType.Date;
            if (Values.ParseTimestamp(v, out t)) return DataType.Timestamp;
            return DataType.Varchar;
        }
        // "007" stays text (codes, zip codes); "0", "0.5" are numbers.
        static bool LeadingZero(string v) { string s = v.Trim().TrimStart('-', '+'); return s.Length > 1 && s[0] == '0' && s[1] != '.'; }

        static DataType Infer(List<List<string>> rows, int c, int from)
        {
            DataType t = DataType.Null;
            for (int i = from; i < rows.Count; i++)
            {
                if (c >= rows[i].Count) continue;
                bool q; string v = CsvParser.Clean(rows[i][c], out q);
                if (v.Length == 0) continue;
                t = Merge(t, Infer1(v));
                if (t.Kind == Kind.String) break;
            }
            return t.Kind == Kind.Null ? DataType.Varchar : t;
        }
        static DataType Merge(DataType a, DataType b)
        {
            if (a.Kind == Kind.Null) return b;
            if (b.Kind == Kind.Null || a.SameAs(b)) return a;
            if ((a.Kind == Kind.Int && b.Kind == Kind.Double) || (a.Kind == Kind.Double && b.Kind == Kind.Int)) return DataType.Double;
            if ((a.Kind == Kind.Date && b.Kind == Kind.Timestamp) || (a.Kind == Kind.Timestamp && b.Kind == Kind.Date)) return DataType.Timestamp;
            return DataType.Varchar;
        }
        static bool Fits(string v, DataType t)
        {
            long l; double d; bool b;
            switch (t.Kind)
            {
                case Kind.Int: return Values.ParseLong(v, out l);
                case Kind.Double: case Kind.Decimal: return Values.ParseDouble(v, out d);
                case Kind.Bool: return Values.ParseBool(v, out b);
                case Kind.Date: return Values.ParseDate(v, out l);
                case Kind.Timestamp: return Values.ParseTimestamp(v, out l) || Values.ParseDate(v, out l);
            }
            return true;
        }

        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit)
        {
            Schema s = Schema; int w = s.Count;
            Units(ctx);
            long from = starts[unit], to = starts[unit + 1], reported = 0;
            Stream raw = OpenRead(path); raw.Seek(from, SeekOrigin.Begin);
            using (Stream st = new RangeStream(raw, to - from))
            using (CsvParser p = new CsvParser(st, shape.Delimiter, opt.Quote))
            {
                if (shape.Header && unit == 0) p.Next();
                ColumnBuilder[] cb = NewBuilders(s, per);
                bool[] read = new bool[w]; for (int c = 0; c < w; c++) read[c] = needed == null || needed.Contains(c);
                TextIntern[] intern = new TextIntern[w]; for (int c = 0; c < w; c++) if (s[c].Type.Kind == Kind.String) intern[c] = new TextIntern();
                int rows = 0;
                while (p.Next())
                {
                    if (p.Count == 1 && w > 1 && p.Len[0] == 0) continue;
                    for (int c = 0; c < w; c++)
                    {
                        if (!read[c]) continue;
                        if (c >= p.Count) { cb[c].AddNull(); continue; }
                        AddField(cb[c], s[c].Type, p, c, intern[c], ctx);
                    }
                    if (++rows == per)
                    {
                        yield return Build(s, cb, rows);
                        cb = NewBuilders(s, per); rows = 0;
                        if (ctx.Job != null) { long now = st.Position; ctx.Job.AddBytes(now - reported); reported = now; }
                    }
                }
                if (rows > 0) yield return Build(s, cb, rows);
                if (ctx.Job != null) ctx.Job.AddBytes(st.Length - reported);
            }
        }
        static ColumnBuilder[] NewBuilders(Schema s, int per) { ColumnBuilder[] cb = new ColumnBuilder[s.Count]; for (int c = 0; c < cb.Length; c++) cb[c] = new ColumnBuilder(s[c].Type, per); return cb; }
        Batch Build(Schema s, ColumnBuilder[] cb, int rows)
        {
            Column[] cs = new Column[cb.Length];
            for (int c = 0; c < cs.Length; c++)
            {
                if (needed != null && !needed.Contains(c)) { Column ph = new Column(DataType.Null, 0); ph.Type = s[c].Type; ph.Length = rows; ph.Nulls = null; cs[c] = ph; }   // never read: length only
                else cs[c] = cb[c].Detach();   // a full batch hands its arrays over (no copy)
            }
            return new Batch(s, cs, rows);
        }

        // One field straight from the parser's record buffer: numbers and yyyy-MM-dd dates without making a string
        // (exact fast parsers), repeated text shared; anything else takes the general path (Add) with the same rules.
        void AddField(ColumnBuilder b, DataType t, CsvParser p, int c, TextIntern intern, ExecCtx ctx)
        {
            int st = p.Start[c], n = p.Len[c]; char[] a = p.Rec;
            if (n > 0 && opt.NullText.Length == 0)
            {
                switch (t.Kind)
                {
                    case Kind.String: b.AddString(intern.Get(a, st, n)); return;
                    case Kind.Int: { long l; if (Values.FastLong(a, st, n, out l)) { b.AddLong(l); return; } break; }
                    case Kind.Double: case Kind.Decimal: { double d; if (Values.FastDouble(null, a, st, n, out d)) { b.AddDouble(d); return; } break; }
                    case Kind.Date: { long d; if (Values.FastDate(a, st, n, out d)) { b.AddLong(d); return; } break; }
                }
            }
            Add(b, t, p.Text(c), p.Quoted[c], c, ctx);
        }

        void Add(ColumnBuilder b, DataType t, string v, bool quoted, int c, ExecCtx ctx)
        {
            if (v.Length == 0 && !(quoted && t.Kind == Kind.String)) { if (t.Kind == Kind.String && opt.NullText != "") b.AddString(v); else b.AddNull(); return; }
            if (opt.NullText != "" && v == opt.NullText) { b.AddNull(); return; }
            switch (t.Kind)
            {
                case Kind.String: b.AddString(v); return;
                case Kind.Int: { long l; if (Values.ParseLong(v, out l)) { b.AddLong(l); return; } double d; throw new TypeWidenException(path, c, Values.ParseDouble(v, out d) && v.IndexOf(',') < 0 ? DataType.Double : DataType.Varchar); }
                case Kind.Double: case Kind.Decimal: { double d; if (Values.ParseDouble(v, out d)) { b.AddDouble(d); return; } throw new TypeWidenException(path, c, DataType.Varchar); }
                case Kind.Bool: { bool x; if (Values.ParseBool(v, out x)) { b.AddBool(x); return; } throw new TypeWidenException(path, c, DataType.Varchar); }
                case Kind.Date: { long d; if (Values.ParseDate(v, out d)) { b.AddLong(d); return; } long m; throw new TypeWidenException(path, c, Values.ParseTimestamp(v, out m) ? DataType.Timestamp : DataType.Varchar); }
                case Kind.Timestamp: { long m; if (Values.ParseTimestamp(v, out m)) { b.AddLong(m); return; } if (Values.ParseDate(v, out m)) { b.AddLong(m * 86400000000L); return; } throw new TypeWidenException(path, c, DataType.Varchar); }
            }
            b.AddString(v);
        }

        public static CsvOptions Options(FuncTable f)
        {
            CsvOptions o = new CsvOptions();
            foreach (KeyValuePair<string, Expr> kv in f.Named)
            {
                object v = Planner.LitArg(kv.Value);
                switch (kv.Key.ToLowerInvariant())
                {
                    case "delim": case "sep": case "delimiter": { string s = Convert.ToString(v); if (s == "\\t") s = "\t"; if (!string.IsNullOrEmpty(s)) o.Delimiter = s[0]; break; }
                    case "header": o.Header = v is bool ? ((bool)v ? 1 : 0) : -1; break;
                    case "quote": { string s = Convert.ToString(v); if (!string.IsNullOrEmpty(s)) o.Quote = s[0]; break; }
                    case "nullstr": o.NullText = Convert.ToString(v) ?? ""; break;
                    case "all_varchar": o.AllVarchar = v is bool && (bool)v; break;
                    case "sample_size": if (v is long) o.SampleRows = (int)Math.Max(100, Math.Min(1000000, (long)v)); break;
                }
            }
            return o;
        }
    }
}
