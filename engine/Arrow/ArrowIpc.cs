// Arrow IPC file format (Arrow "Feather v2" .arrow files): the engine's on-disk working format for datasets.
// A file = "ARROW1" + schema message + one record batch message per row group + footer (schema + batch blocks).
// Any Arrow reader (pyarrow, DuckDB, Polars) can open these files; Parquet is only produced on export.
//  - Hand-written FlatBuffers (Fb / FbOut below): no third-party code. Only what Arrow metadata needs.
//  - Types written: Int8/16/32/64, Float64, Decimal128, Utf8, Bool, Date32 (days), Timestamp(us), all nullable.
//    Read: also unsigned ints, Float16/32, Date64, other timestamp units, LargeUtf8, Binary, Null.
//  - Uncompressed, 8-byte aligned buffers: a batch reads back with block copies (no decoding except UTF-8 text).
//  - Reads only the columns a query needs (each column's buffers are one contiguous byte range of the body).
//  - Files are read with short-lived FileStreams (shared read/delete), never memory-mapped, so a dataset folder can
//    always be swapped, archived or deleted while the app is open.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Numerics;
using System.Text;

namespace NativeDataEngine
{
    // ---------------- FlatBuffers: tiny writer (front to back) + reader ----------------
    public abstract class FbObj { }
    public sealed class FbStr : FbObj { public byte[] B; public FbStr(string s) { B = Encoding.UTF8.GetBytes(s ?? ""); } }
    public sealed class FbVec : FbObj { public List<FbObj> Items = new List<FbObj>(); }   // vector of tables / strings
    public sealed class FbStructs : FbObj { public byte[] Raw; public int Count; }       // vector of 8-byte-aligned structs
    public sealed class FbTable : FbObj
    {
        internal sealed class F { public int Index, Size; public long Value; public FbObj Child; }
        internal readonly List<F> Fields = new List<F>();
        public FbTable Scalar(int index, int size, long value) { F f = new F(); f.Index = index; f.Size = size; f.Value = value; Fields.Add(f); return this; }
        public FbTable Obj(int index, FbObj child) { F f = new F(); f.Index = index; f.Size = 4; f.Child = child; Fields.Add(f); return this; }
    }

    public sealed class FbOut
    {
        byte[] b = new byte[512]; int n;
        void Need(int k) { if (n + k > b.Length) Array.Resize(ref b, Math.Max(b.Length * 2, n + k)); }
        void Zero(int k) { Need(k); n += k; }
        void Pad(int align) { while (n % align != 0) Zero(1); }
        void U16(int v) { Need(2); b[n++] = (byte)v; b[n++] = (byte)(v >> 8); }
        void I32(int v) { Need(4); for (int i = 0; i < 4; i++) b[n++] = (byte)(v >> (8 * i)); }
        void PutI32(int at, int v) { for (int i = 0; i < 4; i++) b[at + i] = (byte)(v >> (8 * i)); }

        // Root table -> bytes, padded to a multiple of 8.
        public static byte[] Finish(FbTable root)
        {
            FbOut o = new FbOut();
            o.Zero(8);   // root uoffset (+ padding)
            int t = o.Write(root);
            o.PutI32(0, t);
            o.Pad(8);
            byte[] r = new byte[o.n]; Buffer.BlockCopy(o.b, 0, r, 0, o.n);
            return r;
        }

        int Write(FbObj x)
        {
            FbTable t = x as FbTable; if (t != null) return Table(t);
            FbStr s = x as FbStr;
            if (s != null) { Pad(4); int at = n; I32(s.B.Length); Need(s.B.Length + 1); Buffer.BlockCopy(s.B, 0, b, n, s.B.Length); n += s.B.Length; b[n++] = 0; return at; }
            FbStructs st = x as FbStructs;
            if (st != null) { while ((n + 4) % 8 != 0) Zero(1); int at = n; I32(st.Count); Need(st.Raw.Length); Buffer.BlockCopy(st.Raw, 0, b, n, st.Raw.Length); n += st.Raw.Length; return at; }
            FbVec v = (FbVec)x;
            {
                Pad(4); int at = n; I32(v.Items.Count);
                int slots = n; Zero(4 * v.Items.Count);
                for (int i = 0; i < v.Items.Count; i++) { int c = Write(v.Items[i]); PutI32(slots + 4 * i, c - (slots + 4 * i)); }
                return at;
            }
        }

        int Table(FbTable t)
        {
            int max = -1; foreach (FbTable.F f in t.Fields) max = Math.Max(max, f.Index);
            int[] off = new int[max + 1]; int cur = 4;
            foreach (FbTable.F f in t.Fields) { while (cur % f.Size != 0) cur++; off[f.Index] = cur; cur += f.Size; }
            int inline = cur; while (inline % 4 != 0) inline++;
            Pad(2); int vt = n;
            U16(4 + 2 * (max + 1)); U16(inline);
            for (int i = 0; i <= max; i++) U16(off[i]);
            Pad(8); int tp = n;
            Zero(inline);
            PutI32(tp, tp - vt);
            foreach (FbTable.F f in t.Fields)
                if (f.Child == null) for (int i = 0; i < f.Size; i++) b[tp + off[f.Index] + i] = (byte)(f.Value >> (8 * i));
            foreach (FbTable.F f in t.Fields)
                if (f.Child != null) { int c = Write(f.Child); PutI32(tp + off[f.Index], c - (tp + off[f.Index])); }
            return tp;
        }
    }

    public static class Fb
    {
        public static int I32(byte[] b, int p) { return BitConverter.ToInt32(b, p); }
        public static long I64(byte[] b, int p) { return BitConverter.ToInt64(b, p); }
        public static int Root(byte[] b, int start) { return start + I32(b, start); }
        static int Slot(byte[] b, int t, int idx)
        {
            int vt = t - I32(b, t); int size = BitConverter.ToUInt16(b, vt); int o = 4 + 2 * idx;
            if (o + 2 > size) return 0;
            int fo = BitConverter.ToUInt16(b, vt + o);
            return fo == 0 ? 0 : t + fo;
        }
        public static long Long(byte[] b, int t, int idx, long def) { int p = Slot(b, t, idx); return p == 0 ? def : I64(b, p); }
        public static int Int(byte[] b, int t, int idx, int def) { int p = Slot(b, t, idx); return p == 0 ? def : I32(b, p); }
        public static int Short(byte[] b, int t, int idx, int def) { int p = Slot(b, t, idx); return p == 0 ? def : BitConverter.ToInt16(b, p); }
        public static int Byte(byte[] b, int t, int idx, int def) { int p = Slot(b, t, idx); return p == 0 ? def : b[p]; }
        public static bool Bool(byte[] b, int t, int idx, bool def) { int p = Slot(b, t, idx); return p == 0 ? def : b[p] != 0; }
        public static int Table(byte[] b, int t, int idx) { int p = Slot(b, t, idx); return p == 0 ? 0 : p + I32(b, p); }
        public static int Vec(byte[] b, int t, int idx) { int p = Slot(b, t, idx); return p == 0 ? 0 : p + I32(b, p); }   // -> length field
        public static int VecLen(byte[] b, int v) { return v == 0 ? 0 : I32(b, v); }
        public static int VecTable(byte[] b, int v, int i) { int p = v + 4 + 4 * i; return p + I32(b, p); }
        public static string Str(byte[] b, int t, int idx) { int p = Slot(b, t, idx); if (p == 0) return null; int s = p + I32(b, p); return Encoding.UTF8.GetString(b, s + 4, I32(b, s)); }
    }

    // ---------------- Arrow schema <-> engine types ----------------
    public static class ArrowTypes
    {
        // Type union ids (Schema.fbs).
        public const int Null = 1, Int = 2, FloatingPoint = 3, Binary = 4, Utf8 = 5, Bool = 6, Decimal = 7, Date = 8, Timestamp = 10, LargeBinary = 19, LargeUtf8 = 20;

        // Engine type -> (union id, type table).
        public static FbTable Type(DataType t, out int id)
        {
            FbTable x = new FbTable();
            switch (t.Kind)
            {
                case Kind.Bool: id = Bool; break;
                case Kind.Int: id = Int; x.Scalar(0, 4, t.Bits).Scalar(1, 1, 1); break;
                case Kind.Double: id = FloatingPoint; x.Scalar(0, 2, 2); break;
                case Kind.Decimal: id = Decimal; x.Scalar(0, 4, t.Precision).Scalar(1, 4, t.Scale).Scalar(2, 4, 128); break;
                case Kind.Date: id = Date; x.Scalar(0, 2, 0); break;                     // DAY
                case Kind.Timestamp: id = Timestamp; x.Scalar(0, 2, 2); break;           // MICROSECOND, no time zone
                default: id = Utf8; break;
            }
            return x;
        }

        public static FbTable Schema(Schema s, List<string> names)
        {
            FbVec fields = new FbVec();
            for (int c = 0; c < s.Count; c++)
            {
                int id; FbTable type = Type(Stored(s[c].Type), out id);
                FbTable f = new FbTable();
                f.Obj(0, new FbStr(names[c])).Scalar(1, 1, 1).Scalar(2, 1, id).Obj(3, type).Obj(5, new FbVec());
                fields.Items.Add(f);
            }
            FbVec meta = new FbVec();
            FbTable kv = new FbTable(); kv.Obj(0, new FbStr("created_by")).Obj(1, new FbStr("data-noodler native engine")); meta.Items.Add(kv);
            FbTable sc = new FbTable();
            sc.Scalar(0, 2, 0).Obj(1, fields).Obj(2, meta);
            return sc;
        }

        // A column of unknown type (all NULL) is stored as text, like the Parquet writer does.
        public static DataType Stored(DataType t) { return t.Kind == Kind.Null ? DataType.Varchar : t; }

        // Arrow field -> engine type; unit / width details for the reader.
        public sealed class Col { public string Name; public DataType Type; public int Id, Bits, Unit; public bool Signed = true; }

        public static Col Read(byte[] b, int f)
        {
            Col c = new Col(); c.Name = Fb.Str(b, f, 0) ?? "";
            c.Id = Fb.Byte(b, f, 2, 0); int t = Fb.Table(b, f, 3);
            if (Fb.Table(b, f, 4) != 0) throw new EngineException("ARROW_UNSUPPORTED", "Arrow column \"" + c.Name + "\" is dictionary-encoded (not supported).");
            switch (c.Id)
            {
                case Null: c.Type = DataType.Null; break;
                case Int:
                    c.Bits = Fb.Int(b, t, 0, 32); c.Signed = Fb.Bool(b, t, 1, true);
                    int bits = c.Signed ? c.Bits : Math.Min(64, c.Bits * 2);
                    c.Type = bits <= 8 ? DataType.TinyInt : bits <= 16 ? DataType.SmallInt : bits <= 32 ? DataType.Integer : DataType.BigInt; break;
                case FloatingPoint: c.Unit = Fb.Short(b, t, 0, 2); c.Type = DataType.Double; break;
                case Utf8: case LargeUtf8: case Binary: case LargeBinary: c.Type = DataType.Varchar; break;
                case Bool: c.Type = DataType.Bool; break;
                case Decimal:
                    c.Bits = Fb.Int(b, t, 2, 128);
                    if (c.Bits != 128) throw new EngineException("ARROW_UNSUPPORTED", "Arrow column \"" + c.Name + "\": only 128-bit decimals are supported.");
                    int p = Math.Max(1, Math.Min(38, Fb.Int(b, t, 0, 18))); c.Unit = Math.Max(0, Math.Min(p, Fb.Int(b, t, 1, 0)));
                    c.Type = DataType.Decimal(p, c.Unit); break;
                case Date: c.Unit = Fb.Short(b, t, 0, 1); c.Type = DataType.Date; break;
                case Timestamp: c.Unit = Fb.Short(b, t, 0, 0); c.Type = DataType.Timestamp; break;
                default: throw new EngineException("ARROW_UNSUPPORTED", "Arrow column \"" + c.Name + "\" has a type the engine does not read (type id " + c.Id + ").");
            }
            return c;
        }
        // Buffers per column in a record batch: validity + data (+ offsets for text).
        public static int Buffers(Col c) { return c.Id == Null ? 0 : (c.Id == Utf8 || c.Id == LargeUtf8 || c.Id == Binary || c.Id == LargeBinary) ? 3 : 2; }
    }

    // ---------------- writer ----------------
    public sealed class EncodedBatch { public byte[] Meta, Body; public int Rows; }

    public sealed class ArrowFileWriter : IDisposable
    {
        static readonly byte[] Magic = Encoding.ASCII.GetBytes("ARROW1");
        readonly FileStream fs; readonly Schema schema; readonly List<string> names;
        readonly List<long[]> blocks = new List<long[]>();   // {offset, metaLength, bodyLength}
        public long Rows; public string Path; bool closed;

        public ArrowFileWriter(string path, Schema schema)
        {
            Path = path; this.schema = schema; names = ParquetFileWriter.UniqueNames(schema);
            fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20);
            fs.Write(Magic, 0, 6); fs.Write(new byte[2], 0, 2);
            byte[] meta = Message(1, ArrowTypes.Schema(schema, names), 0);
            WriteMessage(meta, null);
        }
        public long Length { get { return fs.Position; } }

        static byte[] Message(int headerType, FbTable header, long bodyLength)
        {
            FbTable m = new FbTable();
            m.Scalar(0, 2, 4).Scalar(1, 1, headerType).Obj(2, header).Scalar(3, 8, bodyLength);   // MetadataVersion V5
            return FbOut.Finish(m);
        }
        long WriteMessage(byte[] meta, byte[] body)
        {
            long at = fs.Position;
            fs.Write(BitConverter.GetBytes(-1), 0, 4);
            fs.Write(BitConverter.GetBytes(meta.Length), 0, 4);
            fs.Write(meta, 0, meta.Length);
            if (body != null) fs.Write(body, 0, body.Length);
            return at;
        }

        // ---- encode one batch (pure, thread-safe: runs on the workers) ----
        public static EncodedBatch Encode(Batch b)
        {
            int n = b.Rows, nc = b.Cols.Length;
            Column[] cols = new Column[nc]; DataType[] types = new DataType[nc];
            long size = 0;
            int[][] utf = new int[nc][];
            for (int c = 0; c < nc; c++)
            {
                DataType t = ArrowTypes.Stored(b.Schema[c].Type); types[c] = t;
                Column col = b.Cols[c];
                if (col.Type.Kind == Kind.Null || !(col.Type.UsesI == t.UsesI && col.Type.UsesF == t.UsesF && (col.S != null) == (t.Kind == Kind.String))) col = Cast.To(col, t, true);
                cols[c] = col;
                size += Pad8(col.Nulls != null ? (n + 7) / 8 : 0);
                switch (t.Kind)
                {
                    case Kind.Bool: size += Pad8((n + 7) / 8); break;
                    case Kind.Int: size += Pad8((long)n * (t.Bits / 8)); break;
                    case Kind.Date: size += Pad8(4L * n); break;
                    case Kind.Decimal: size += Pad8(16L * n); break;
                    case Kind.String:
                        {
                            int[] len = new int[n]; long total = 0;
                            for (int i = 0; i < n; i++) { string s = col.IsNull(i) ? null : col.S[i]; if (s != null) { len[i] = Encoding.UTF8.GetByteCount(s); total += len[i]; } }
                            if (total > int.MaxValue) throw new EngineException("ARROW_TOO_LARGE", "Text column \"" + b.Schema[c].Name + "\" holds more than 2 GB in one batch.");
                            utf[c] = len; size += Pad8(4L * (n + 1)) + Pad8(total); break;
                        }
                    default: size += Pad8(8L * n); break;
                }
            }
            byte[] body = new byte[size];
            long at = 0;
            byte[] nodes = new byte[16 * nc];
            List<long> bufs = new List<long>();
            Action<long> buf = len => { bufs.Add(at); bufs.Add(len); at += Pad8(len); };
            for (int c = 0; c < nc; c++)
            {
                Column col = cols[c]; DataType t = types[c];
                long nulls = 0;
                if (col.Nulls != null)
                {
                    int vb = (int)at;
                    for (int i = 0; i < n; i++) { if (col.Nulls[i]) nulls++; else body[vb + (i >> 3)] |= (byte)(1 << (i & 7)); }
                    if (nulls == 0) { Array.Clear(body, vb, (n + 7) / 8); buf(0); at = vb + Pad8((n + 7) / 8); }   // keep the reserved space; no bitmap needed
                    else buf((n + 7) / 8);
                }
                else buf(0);
                Buffer.BlockCopy(BitConverter.GetBytes((long)n), 0, nodes, 16 * c, 8);
                Buffer.BlockCopy(BitConverter.GetBytes(nulls), 0, nodes, 16 * c + 8, 8);
                int p = (int)at;
                switch (t.Kind)
                {
                    case Kind.Bool:
                        for (int i = 0; i < n; i++) if (!col.IsNull(i) && col.B[i]) body[p + (i >> 3)] |= (byte)(1 << (i & 7));
                        buf((n + 7) / 8); break;
                    case Kind.Int:
                        {
                            int w = t.Bits / 8; long[] v = col.I;
                            if (w == 8) Buffer.BlockCopy(v, 0, body, p, 8 * n);
                            else for (int i = 0; i < n; i++) { long x = v[i]; for (int k = 0; k < w; k++) body[p + w * i + k] = (byte)(x >> (8 * k)); }
                            buf((long)w * n); break;
                        }
                    case Kind.Date:
                        for (int i = 0; i < n; i++) { int x = (int)col.I[i]; body[p + 4 * i] = (byte)x; body[p + 4 * i + 1] = (byte)(x >> 8); body[p + 4 * i + 2] = (byte)(x >> 16); body[p + 4 * i + 3] = (byte)(x >> 24); }
                        buf(4L * n); break;
                    case Kind.Timestamp: Buffer.BlockCopy(col.I, 0, body, p, 8 * n); buf(8L * n); break;
                    case Kind.Double: Buffer.BlockCopy(col.F, 0, body, p, 8 * n); buf(8L * n); break;
                    case Kind.Decimal:
                        {
                            decimal scale = 1; for (int s = 0; s < t.Scale; s++) scale *= 10;
                            double dscale = (double)scale;
                            for (int i = 0; i < n; i++)
                            {
                                if (col.IsNull(i)) continue;
                                // Fast path: the scaled value as a whole number in a long, when it is clearly not near a .5 tie
                                // and well inside 15 significant digits (so it is exactly what the decimal path gives).
                                double x = col.F[i] * dscale, r = Math.Round(x);
                                if (Math.Abs(x) < 1e14 && Math.Abs(Math.Abs(x - Math.Floor(x)) - 0.5) > 1e-6)
                                {
                                    long lv = (long)r; int q = p + 16 * i;
                                    for (int k = 0; k < 8; k++) body[q + k] = (byte)(lv >> (8 * k));
                                    byte hi = (byte)(lv < 0 ? 0xff : 0);
                                    for (int k = 8; k < 16; k++) body[q + k] = hi;
                                    continue;
                                }
                                decimal dv; try { dv = decimal.Round((decimal)col.F[i] * scale); } catch (OverflowException) { dv = 0; }
                                byte[] raw = new BigInteger(dv).ToByteArray();
                                byte fill = (byte)((raw[raw.Length - 1] & 0x80) != 0 ? 0xff : 0);
                                for (int k = 0; k < 16; k++) body[p + 16 * i + k] = k < raw.Length ? raw[k] : fill;
                            }
                            buf(16L * n); break;
                        }
                    case Kind.String:
                        {
                            int[] len = utf[c]; int dataAt = p + (int)Pad8(4L * (n + 1)); int o = 0;
                            for (int i = 0; i <= n; i++)
                            {
                                body[p + 4 * i] = (byte)o; body[p + 4 * i + 1] = (byte)(o >> 8); body[p + 4 * i + 2] = (byte)(o >> 16); body[p + 4 * i + 3] = (byte)(o >> 24);
                                if (i < n && len[i] > 0) { Encoding.UTF8.GetBytes(col.S[i], 0, col.S[i].Length, body, dataAt + o); o += len[i]; }
                            }
                            buf(4L * (n + 1)); buf(o); break;
                        }
                }
            }
            byte[] braw = new byte[8 * bufs.Count];
            for (int i = 0; i < bufs.Count; i++) Buffer.BlockCopy(BitConverter.GetBytes(bufs[i]), 0, braw, 8 * i, 8);
            FbStructs fn = new FbStructs(); fn.Raw = nodes; fn.Count = nc;
            FbStructs fb = new FbStructs(); fb.Raw = braw; fb.Count = bufs.Count / 2;
            FbTable rb = new FbTable(); rb.Scalar(0, 8, n).Obj(1, fn).Obj(2, fb);
            EncodedBatch e = new EncodedBatch(); e.Rows = n; e.Meta = Message(3, rb, at); e.Body = body;
            if (at != body.Length) { byte[] t2 = new byte[at]; Buffer.BlockCopy(body, 0, t2, 0, (int)at); e.Body = t2; }
            return e;
        }
        static long Pad8(long x) { return (x + 7) & ~7L; }

        // ---- append (single thread, in order) ----
        public void Append(EncodedBatch e)
        {
            long at = WriteMessage(e.Meta, e.Body);
            blocks.Add(new[] { at, 8L + e.Meta.Length, e.Body.LongLength });
            Rows += e.Rows;
        }

        public void Close()
        {
            fs.Write(BitConverter.GetBytes(-1), 0, 4); fs.Write(new byte[4], 0, 4);   // end of stream
            byte[] raw = new byte[24 * blocks.Count];
            for (int i = 0; i < blocks.Count; i++)
            {
                Buffer.BlockCopy(BitConverter.GetBytes(blocks[i][0]), 0, raw, 24 * i, 8);
                Buffer.BlockCopy(BitConverter.GetBytes((int)blocks[i][1]), 0, raw, 24 * i + 8, 4);
                Buffer.BlockCopy(BitConverter.GetBytes(blocks[i][2]), 0, raw, 24 * i + 16, 8);
            }
            FbStructs rbs = new FbStructs(); rbs.Raw = raw; rbs.Count = blocks.Count;
            FbStructs dicts = new FbStructs(); dicts.Raw = new byte[0]; dicts.Count = 0;
            FbTable footer = new FbTable();
            footer.Scalar(0, 2, 4).Obj(1, ArrowTypes.Schema(schema, names)).Obj(2, dicts).Obj(3, rbs);
            byte[] f = FbOut.Finish(footer);
            fs.Write(f, 0, f.Length);
            fs.Write(BitConverter.GetBytes(f.Length), 0, 4);
            fs.Write(Magic, 0, 6);
            fs.Flush(true); fs.Dispose(); closed = true;
        }
        public void Dispose() { if (!closed) { try { fs.Dispose(); } catch { } } }
    }

    // ---------------- reader ----------------
    public sealed class ArrowMeta
    {
        public string Path; public long Size; public DateTime Modified;
        public Schema Schema; public List<ArrowTypes.Col> Cols = new List<ArrowTypes.Col>();
        public List<long[]> Blocks = new List<long[]>();   // {offset, metaLength, bodyLength}
        public List<long> BatchRows = new List<long>();
        public long Rows;

        static readonly ConcurrentDictionary<string, ArrowMeta> cache = new ConcurrentDictionary<string, ArrowMeta>(StringComparer.OrdinalIgnoreCase);

        public static ArrowMeta Open(string path)
        {
            FileInfo fi = new FileInfo(path);
            if (!fi.Exists) throw new EngineException("FILE_NOT_FOUND", "Arrow file not found: " + System.IO.Path.GetFileName(path), 404);
            ArrowMeta m;
            if (cache.TryGetValue(path, out m) && m.Size == fi.Length && m.Modified == fi.LastWriteTimeUtc) return m;
            m = Read(path, fi);
            cache[path] = m;
            if (cache.Count > 4000) cache.Clear();
            return m;
        }
        public static void Forget(string pathPrefix)
        {
            foreach (string k in cache.Keys) if (k.StartsWith(pathPrefix, StringComparison.OrdinalIgnoreCase)) { ArrowMeta x; cache.TryRemove(k, out x); }
        }
        static EngineException Bad(string path, string why) { return new EngineException("ARROW_CORRUPT", "Not a valid Arrow file: " + System.IO.Path.GetFileName(path) + " (" + why + ")."); }
        public static FileStream OpenRead(string path) { return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16); }
        public static byte[] ReadAt(FileStream fs, long at, int n) { byte[] b = new byte[n]; fs.Seek(at, SeekOrigin.Begin); PqMeta.Fill(fs, b, n); return b; }

        static ArrowMeta Read(string path, FileInfo fi)
        {
            ArrowMeta m = new ArrowMeta(); m.Path = path; m.Size = fi.Length; m.Modified = fi.LastWriteTimeUtc;
            using (FileStream fs = OpenRead(path))
            {
                if (fs.Length < 18) throw Bad(path, "too short");
                byte[] head = ReadAt(fs, 0, 6), tail = ReadAt(fs, fs.Length - 10, 10);
                if (Encoding.ASCII.GetString(head) != "ARROW1" || Encoding.ASCII.GetString(tail, 4, 6) != "ARROW1") throw Bad(path, "no ARROW1 magic");
                int len = BitConverter.ToInt32(tail, 0);
                if (len <= 0 || len > fs.Length - 18) throw Bad(path, "bad footer length");
                byte[] f = ReadAt(fs, fs.Length - 10 - len, len);
                int root = Fb.Root(f, 0);
                int sc = Fb.Table(f, root, 1);
                if (sc == 0) throw Bad(path, "no schema");
                int fields = Fb.Vec(f, sc, 1);
                List<Field> fs2 = new List<Field>();
                for (int i = 0; i < Fb.VecLen(f, fields); i++) { ArrowTypes.Col c = ArrowTypes.Read(f, Fb.VecTable(f, fields, i)); m.Cols.Add(c); fs2.Add(new Field(c.Name, c.Type)); }
                m.Schema = new Schema(fs2);
                if (Fb.VecLen(f, Fb.Vec(f, root, 2)) > 0) throw new EngineException("ARROW_UNSUPPORTED", "Arrow file " + System.IO.Path.GetFileName(path) + " uses dictionaries (not supported).");
                int rbs = Fb.Vec(f, root, 3), nb = Fb.VecLen(f, rbs);
                for (int i = 0; i < nb; i++)
                {
                    int p = rbs + 4 + 24 * i;
                    long[] blk = { Fb.I64(f, p), Fb.I32(f, p + 8), Fb.I64(f, p + 16) };
                    m.Blocks.Add(blk);
                    // Row count: from the batch's own message header.
                    byte[] mh = ReadAt(fs, blk[0], (int)blk[1]);
                    int mo = BitConverter.ToInt32(mh, 0) == -1 ? 8 : 4;
                    int msg = Fb.Root(mh, mo);
                    int rb = Fb.Table(mh, msg, 2);
                    long rows = rb == 0 ? 0 : Fb.Long(mh, rb, 0, 0);
                    m.BatchRows.Add(rows); m.Rows += rows;
                }
            }
            return m;
        }

        // One record batch -> engine batch. needed = column indexes to read (null = all); the others are placeholders.
        public Batch ReadBatch(int i, HashSet<int> needed)
        {
            long[] blk = Blocks[i];
            int n = (int)BatchRows[i];
            Column[] outCols = new Column[Cols.Count];
            using (FileStream fs = OpenRead(Path))
            {
                byte[] mh = ReadAt(fs, blk[0], (int)blk[1]);
                int mo = BitConverter.ToInt32(mh, 0) == -1 ? 8 : 4;
                int msg = Fb.Root(mh, mo);
                if (Fb.Short(mh, msg, 4, 0) != 0 && Fb.Table(mh, Fb.Table(mh, msg, 2), 3) != 0) throw new EngineException("ARROW_UNSUPPORTED", "Compressed Arrow files are not supported: " + System.IO.Path.GetFileName(Path));
                int rb = Fb.Table(mh, msg, 2);
                if (Fb.Table(mh, rb, 3) != 0) throw new EngineException("ARROW_UNSUPPORTED", "Compressed Arrow files are not supported: " + System.IO.Path.GetFileName(Path));
                int nodes = Fb.Vec(mh, rb, 1), bufs = Fb.Vec(mh, rb, 2);
                long bodyAt = blk[0] + blk[1];
                int bi = 0;
                for (int c = 0; c < Cols.Count; c++)
                {
                    ArrowTypes.Col col = Cols[c];
                    int nb = ArrowTypes.Buffers(col);
                    long nullCount = Fb.I64(mh, nodes + 4 + 16 * c + 8);
                    if (needed != null && !needed.Contains(c)) { Column ph = new Column(DataType.Null, 0); ph.Type = col.Type; ph.Length = n; ph.Nulls = null; outCols[c] = ph; bi += nb; continue; }
                    if (nb == 0) { outCols[c] = new Column(DataType.Null, n); continue; }
                    long[] off = new long[nb], len = new long[nb];
                    long lo = long.MaxValue, hi = 0;
                    for (int k = 0; k < nb; k++)
                    {
                        off[k] = Fb.I64(mh, bufs + 4 + 16 * (bi + k)); len[k] = Fb.I64(mh, bufs + 4 + 16 * (bi + k) + 8);
                        if (len[k] > 0) { lo = Math.Min(lo, off[k]); hi = Math.Max(hi, off[k] + len[k]); }
                    }
                    bi += nb;
                    byte[] raw = lo == long.MaxValue ? new byte[0] : ReadAt(fs, bodyAt + lo, (int)(hi - lo));
                    if (lo == long.MaxValue) lo = 0;
                    outCols[c] = Decode(col, n, raw, off, len, lo, nullCount);
                }
            }
            return new Batch(Schema, outCols, n);
        }

        static Column Decode(ArrowTypes.Col a, int n, byte[] raw, long[] off, long[] len, long lo, long nullCount)
        {
            Column c = new Column(a.Type, n);
            if (nullCount > 0 && len[0] > 0)
            {
                bool[] nulls = new bool[n]; int v = (int)(off[0] - lo);
                for (int i = 0; i < n; i++) nulls[i] = (raw[v + (i >> 3)] & (1 << (i & 7))) == 0;
                c.Nulls = nulls;
            }
            else if (nullCount >= n && n > 0) { c.Nulls = new bool[n]; for (int i = 0; i < n; i++) c.Nulls[i] = true; }
            int p = (int)(off[1] - lo);
            switch (a.Id)
            {
                case ArrowTypes.Bool: for (int i = 0; i < n; i++) c.B[i] = (raw[p + (i >> 3)] & (1 << (i & 7))) != 0; break;
                case ArrowTypes.Int:
                    {
                        long[] o = c.I; int w = a.Bits / 8;
                        if (w == 8) Buffer.BlockCopy(raw, p, o, 0, 8 * n);
                        else if (w == 4) { if (a.Signed) for (int i = 0; i < n; i++) o[i] = BitConverter.ToInt32(raw, p + 4 * i); else for (int i = 0; i < n; i++) o[i] = BitConverter.ToUInt32(raw, p + 4 * i); }
                        else if (w == 2) { if (a.Signed) for (int i = 0; i < n; i++) o[i] = BitConverter.ToInt16(raw, p + 2 * i); else for (int i = 0; i < n; i++) o[i] = BitConverter.ToUInt16(raw, p + 2 * i); }
                        else { if (a.Signed) for (int i = 0; i < n; i++) o[i] = (sbyte)raw[p + i]; else for (int i = 0; i < n; i++) o[i] = raw[p + i]; }
                        break;
                    }
                case ArrowTypes.FloatingPoint:
                    if (a.Unit == 2) Buffer.BlockCopy(raw, p, c.F, 0, 8 * n);
                    else if (a.Unit == 1) for (int i = 0; i < n; i++) c.F[i] = BitConverter.ToSingle(raw, p + 4 * i);
                    else for (int i = 0; i < n; i++) c.F[i] = Half(BitConverter.ToUInt16(raw, p + 2 * i));
                    break;
                case ArrowTypes.Date:
                    if (a.Unit == 0) for (int i = 0; i < n; i++) c.I[i] = BitConverter.ToInt32(raw, p + 4 * i);
                    else for (int i = 0; i < n; i++) c.I[i] = (long)Math.Floor(BitConverter.ToInt64(raw, p + 8 * i) / 86400000.0);
                    break;
                case ArrowTypes.Timestamp:
                    for (int i = 0; i < n; i++)
                    {
                        long x = BitConverter.ToInt64(raw, p + 8 * i);
                        c.I[i] = a.Unit == 2 ? x : a.Unit == 0 ? x * 1000000 : a.Unit == 1 ? x * 1000 : Cast.FloorDiv(x, 1000);
                    }
                    break;
                case ArrowTypes.Decimal:
                    {
                        double s = Math.Pow(10, a.Unit); byte[] one = new byte[16];
                        for (int i = 0; i < n; i++) { if (c.IsNull(i)) continue; Buffer.BlockCopy(raw, p + 16 * i, one, 0, 16); c.F[i] = (double)new BigInteger(one) / s; }
                        break;
                    }
                default:   // Utf8 / LargeUtf8 / Binary / LargeBinary
                    {
                        bool large = a.Id == ArrowTypes.LargeUtf8 || a.Id == ArrowTypes.LargeBinary;
                        int d = (int)(off[2] - lo); string[] o = c.S;
                        TextIntern shared = new TextIntern();   // repeated values: one string each (like Parquet dictionaries)
                        for (int i = 0; i < n; i++)
                        {
                            if (c.IsNull(i)) continue;
                            long s0 = large ? BitConverter.ToInt64(raw, p + 8 * i) : BitConverter.ToInt32(raw, p + 4 * i);
                            long s1 = large ? BitConverter.ToInt64(raw, p + 8 * i + 8) : BitConverter.ToInt32(raw, p + 4 * i + 4);
                            o[i] = s1 == s0 ? "" : shared.Get(raw, d + (int)s0, (int)(s1 - s0));
                        }
                        break;
                    }
            }
            return c;
        }
        static double Half(ushort h)
        {
            int e = (h >> 10) & 0x1f, f = h & 0x3ff; double s = (h & 0x8000) != 0 ? -1 : 1;
            if (e == 0) return s * f * Math.Pow(2, -24);
            if (e == 31) return f == 0 ? s * double.PositiveInfinity : double.NaN;
            return s * (1 + f / 1024.0) * Math.Pow(2, e - 15);
        }
    }

    // A logical dataset of .arrow files as a splittable source: one unit per record batch.
    public sealed class ArrowSource : Source
    {
        public readonly List<string> Files;
        HashSet<int> needed;
        List<int[]> units;
        readonly object gate = new object();

        public ArrowSource(List<string> files)
        {
            if (files.Count == 0) throw new EngineException("DATASET_EMPTY", "No Arrow files to read.");
            Files = files;
            Schema = ArrowMeta.Open(files[0]).Schema;
        }
        public void SetNeeded(HashSet<int> cols) { needed = cols; }
        public override int Units(ExecCtx ctx)
        {
            lock (gate)
            {
                if (units == null)
                {
                    List<int[]> u = new List<int[]>();
                    for (int f = 0; f < Files.Count; f++) { ArrowMeta m = ArrowMeta.Open(Files[f]); for (int g = 0; g < m.Blocks.Count; g++) u.Add(new[] { f, g }); }
                    units = u;
                }
                return units.Count;
            }
        }
        public override long KnownRows(ExecCtx ctx) { long n = 0; foreach (string f in Files) n += ArrowMeta.Open(f).Rows; return n; }
        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit)
        {
            Units(ctx);
            int[] u = units[unit];
            ArrowMeta m = ArrowMeta.Open(Files[u[0]]);
            Batch b = m.ReadBatch(u[1], needed);
            if (u[0] == 0 || SameShape(m.Schema)) { yield return new Batch(Schema, b.Cols, b.Rows); yield break; }
            // A later part with other column order / types: match by name, like Parquet parts.
            Column[] cs = new Column[Schema.Count];
            for (int c = 0; c < Schema.Count; c++)
            {
                int k = m.Schema.IndexOf(Schema[c].Name);
                if (k < 0) { Column nc = new Column(Schema[c].Type, b.Rows); for (int i = 0; i < b.Rows; i++) nc.SetNull(i); cs[c] = nc; continue; }
                Column x = b.Cols[k]; DataType want = Schema[c].Type;
                if (x.Type.Kind == Kind.Null && x.I == null && x.F == null && x.S == null && x.B == null && x.Nulls == null) { x = new Column(DataType.Null, 0); x.Type = want; x.Length = b.Rows; x.Nulls = null; }
                else if (!x.Type.SameAs(want)) x = Cast.To(x, want, true);
                cs[c] = x;
            }
            yield return new Batch(Schema, cs, b.Rows);
        }
        bool SameShape(Schema s)
        {
            if (s.Count != Schema.Count) return false;
            for (int i = 0; i < s.Count; i++) if (!string.Equals(s[i].Name, Schema[i].Name, StringComparison.OrdinalIgnoreCase) || !s[i].Type.SameAs(Schema[i].Type)) return false;
            return true;
        }
    }

    // Dataset files -> the right source (all .arrow = ArrowSource, else Parquet).
    public static class DataFiles
    {
        public static bool IsArrow(string f) { string e = System.IO.Path.GetExtension(f).ToLowerInvariant(); return e == ".arrow" || e == ".feather" || e == ".ipc"; }
        public static bool IsParquet(string f) { string e = System.IO.Path.GetExtension(f).ToLowerInvariant(); return e == ".parquet" || e == ".pq"; }
        public static Source Open(List<string> files)
        {
            int arrow = 0; foreach (string f in files) if (IsArrow(f)) arrow++;
            if (arrow == 0) return new ParquetSource(files);
            if (arrow == files.Count) return new ArrowSource(files);
            throw new EngineException("DATASET_MIXED", "A dataset mixes Arrow and Parquet files; rebuild it.");
        }
        public static long Rows(string f) { return IsArrow(f) ? ArrowMeta.Open(f).Rows : PqMeta.Open(f).Rows; }
        public static void Forget(string prefix) { PqMeta.Forget(prefix); ArrowMeta.Forget(prefix); }
    }
}
