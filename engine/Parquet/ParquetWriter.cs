// Minimal, correct Parquet writer: flat schema, OPTIONAL columns, data page v1, PLAIN values (dictionary for
// text columns with repeats), RLE definition levels, Snappy (default) / GZIP / none, min/max statistics.
// Row groups are encoded independently (Encode is pure, so it runs on worker threads) and appended in order.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace NativeDataEngine
{
    public sealed class EncodedChunk
    {
        public byte[] Bytes; public long DictRel = -1, DataRel; public long Values, Uncompressed;
        public List<int> Encodings = new List<int>(); public byte[] Min, Max; public long Nulls;
    }
    public sealed class EncodedRowGroup { public List<EncodedChunk> Chunks = new List<EncodedChunk>(); public int Rows; public long Bytes; }

    public static class ParquetTypes
    {
        public const int BOOLEAN = 0, INT32 = 1, INT64 = 2, INT96 = 3, FLOAT = 4, DOUBLE = 5, BYTE_ARRAY = 6, FIXED = 7;
        public static int Physical(DataType t)
        {
            switch (t.Kind)
            {
                case Kind.Bool: return BOOLEAN;
                case Kind.Int: return t.Bits == 64 ? INT64 : INT32;
                case Kind.Date: return INT32;
                case Kind.Timestamp: return INT64;
                case Kind.Double: return DOUBLE;
                case Kind.Decimal: return t.Precision <= 18 ? INT64 : FIXED;
                default: return BYTE_ARRAY;
            }
        }
    }

    public sealed class ParquetFileWriter : IDisposable
    {
        readonly FileStream fs; readonly Schema schema; readonly int codec; readonly List<string> names;
        readonly List<KeyValuePair<EncodedRowGroup, long[]>> groups = new List<KeyValuePair<EncodedRowGroup, long[]>>();
        public long Rows; public string Path;

        public ParquetFileWriter(string path, Schema schema, int codec)
        {
            Path = path; this.schema = schema; this.codec = codec;
            names = UniqueNames(schema);
            fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20);
            fs.Write(Encoding.ASCII.GetBytes("PAR1"), 0, 4);
        }
        public long Length { get { return fs.Position; } }

        public static List<string> UniqueNames(Schema s)
        {
            List<string> r = new List<string>(); HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Field f in s.Fields)
            {
                string n = string.IsNullOrEmpty(f.Name) ? "col" : f.Name, b = n; int k = 1;
                while (!seen.Add(n)) n = b + "_" + (k++);
                r.Add(n);
            }
            return r;
        }

        // ---- encode one row group (thread-safe, no I/O) ----
        public static EncodedRowGroup Encode(Batch b, int codec)
        {
            EncodedRowGroup g = new EncodedRowGroup(); g.Rows = b.Rows;
            for (int c = 0; c < b.Cols.Length; c++)
            {
                DataType t = b.Schema[c].Type.Kind == Kind.Null ? DataType.Varchar : b.Schema[c].Type;
                Column col = b.Cols[c];
                if (col.Type.Kind == Kind.Null || !(col.Type.UsesI == t.UsesI && col.Type.UsesF == t.UsesF && (col.S != null) == (t.Kind == Kind.String))) col = Cast.To(col, t, true);
                EncodedChunk ch = Chunk(col, t, b.Rows, codec);
                g.Chunks.Add(ch); g.Bytes += ch.Bytes.Length;
            }
            return g;
        }

        static EncodedChunk Chunk(Column col, DataType t, int n, int codec)
        {
            EncodedChunk ch = new EncodedChunk(); ch.Values = n;
            int[] def = new int[n]; int nonNull = 0;
            for (int i = 0; i < n; i++) { if (!col.IsNull(i)) { def[i] = 1; nonNull++; } }
            ch.Nulls = n - nonNull;
            ByteBuf levels = new ByteBuf(n / 8 + 16);
            ByteBuf lv = new ByteBuf(n / 8 + 16); Rle.Encode(lv, def, n, 1);
            levels.Int32(lv.N); levels.Bytes(lv.B, 0, lv.N);

            ByteBuf page = new ByteBuf(Math.Max(64, nonNull * 8));
            ByteBuf output = new ByteBuf(1024);
            int phys = ParquetTypes.Physical(t);

            // Text with repeats: dictionary page + RLE_DICTIONARY indices.
            if (t.Kind == Kind.String && nonNull > 0)
            {
                Dictionary<string, int> dict = new Dictionary<string, int>(StringComparer.Ordinal); List<string> order = new List<string>();
                int[] idx = new int[nonNull]; int k = 0; long dictBytes = 0; bool useDict = true;
                for (int i = 0; i < n && useDict; i++)
                {
                    if (col.IsNull(i)) continue;
                    string s = col.S[i]; int id;
                    if (!dict.TryGetValue(s, out id)) { id = order.Count; dict[s] = id; order.Add(s); dictBytes += 4 + s.Length; if (dictBytes > (1 << 20) || order.Count > 100000) useDict = false; }
                    idx[k++] = id;
                }
                if (useDict && order.Count < nonNull * 0.7)
                {
                    ByteBuf dp = new ByteBuf((int)dictBytes + 16);
                    foreach (string s in order) dp.Utf8(s);
                    WritePage(output, 2, dp, order.Count, codec, 2, ch);
                    ch.DictRel = 0;
                    ByteBuf data = new ByteBuf(nonNull / 2 + 16);
                    data.Bytes(levels.B, 0, levels.N);
                    int w = Rle.BitWidth(order.Count - 1);
                    data.Byte(w);
                    Rle.Encode(data, idx, nonNull, w);
                    ch.DataRel = output.N;
                    WritePage(output, 0, data, n, codec, 8, ch);
                    ch.Encodings.AddRange(new[] { 2, 3, 8 });
                    ch.Bytes = Trim(output);
                    return ch;
                }
            }

            page.Bytes(levels.B, 0, levels.N);
            bool hasStats = false; long lmin = long.MaxValue, lmax = long.MinValue; double dmin = double.MaxValue, dmax = double.MinValue;
            switch (t.Kind)
            {
                case Kind.Bool:
                    {
                        int bits = 0, acc = 0;
                        for (int i = 0; i < n; i++) { if (col.IsNull(i)) continue; if (col.B[i]) acc |= 1 << bits; if (++bits == 8) { page.Byte(acc); acc = 0; bits = 0; } }
                        if (bits > 0) page.Byte(acc);
                        break;
                    }
                case Kind.Int: case Kind.Date: case Kind.Timestamp:
                    for (int i = 0; i < n; i++)
                    {
                        if (col.IsNull(i)) continue;
                        long v = col.I[i]; if (v < lmin) lmin = v; if (v > lmax) lmax = v; hasStats = true;
                        if (phys == ParquetTypes.INT32) page.Int32((int)v); else page.Int64(v);
                    }
                    break;
                case Kind.Double:
                    for (int i = 0; i < n; i++)
                    {
                        if (col.IsNull(i)) continue;
                        double v = col.F[i]; if (!double.IsNaN(v)) { if (v < dmin) dmin = v; if (v > dmax) dmax = v; hasStats = true; }
                        page.Double(v);
                    }
                    break;
                case Kind.Decimal:
                    {
                        decimal scale = 1; for (int s = 0; s < t.Scale; s++) scale *= 10;
                        double dscale = (double)scale;
                        for (int i = 0; i < n; i++)
                        {
                            if (col.IsNull(i)) continue;
                            if (phys == ParquetTypes.INT64)
                            {
                                // Fast path (same value as the decimal path): clearly not a .5 tie, well inside 15 digits.
                                double x = col.F[i] * dscale;
                                if (Math.Abs(x) < 1e14 && Math.Abs(Math.Abs(x - Math.Floor(x)) - 0.5) > 1e-6)
                                { long fv = (long)Math.Round(x); page.Int64(fv); if (fv < lmin) lmin = fv; if (fv > lmax) lmax = fv; hasStats = true; continue; }
                            }
                            decimal dv;
                            try { dv = decimal.Round((decimal)col.F[i] * scale); } catch (OverflowException) { dv = 0; }
                            if (phys == ParquetTypes.INT64) { long v = (long)dv; page.Int64(v); if (v < lmin) lmin = v; if (v > lmax) lmax = v; hasStats = true; }
                            else page.Bytes(BigEndian16(dv), 0, 16);
                        }
                        break;
                    }
                default:
                    for (int i = 0; i < n; i++) { if (col.IsNull(i)) continue; page.Utf8(col.S[i]); }
                    break;
            }
            if (hasStats)
            {
                ByteBuf a = new ByteBuf(8), z = new ByteBuf(8);
                if (t.Kind == Kind.Double) { a.Double(dmin); z.Double(dmax); }
                else if (phys == ParquetTypes.INT32) { a.Int32((int)lmin); z.Int32((int)lmax); }
                else { a.Int64(lmin); z.Int64(lmax); }
                ch.Min = Trim(a); ch.Max = Trim(z);
            }
            ch.DataRel = 0;
            WritePage(output, 0, page, n, codec, 0, ch);
            ch.Encodings.AddRange(new[] { 0, 3 });
            ch.Bytes = Trim(output);
            return ch;
        }

        static byte[] BigEndian16(decimal d)
        {
            int[] bits = decimal.GetBits(d);   // 96-bit magnitude + sign
            bool neg = (bits[3] & unchecked((int)0x80000000)) != 0;
            byte[] mag = new byte[16];
            for (int k = 0; k < 12; k++) mag[15 - k] = (byte)(bits[k / 4] >> (8 * (k % 4)));
            if (neg)
            {
                int carry = 1;
                for (int k = 15; k >= 0; k--) { int v = (~mag[k] & 0xff) + carry; mag[k] = (byte)v; carry = v >> 8; }
            }
            return mag;
        }

        static byte[] Trim(ByteBuf b) { byte[] r = new byte[b.N]; Buffer.BlockCopy(b.B, 0, r, 0, b.N); return r; }

        // pageType 0 = data v1, 2 = dictionary. encoding = value encoding.
        static void WritePage(ByteBuf output, int pageType, ByteBuf body, int count, int codec, int encoding, EncodedChunk ch)
        {
            byte[] comp = Codec.Compress(codec, body.B, body.N);
            ThriftWriter h = new ThriftWriter();
            h.I32(1, pageType).I32(2, body.N).I32(3, comp.Length);
            if (pageType == 0) h.Begin(5).I32(1, count).I32(2, encoding).I32(3, 3).I32(4, 3).End();
            else h.Begin(7).I32(1, count).I32(2, encoding).End();
            h.StructEnd();
            byte[] hb = h.ToArray();
            output.Bytes(hb, 0, hb.Length); output.Bytes(comp, 0, comp.Length);
            ch.Uncompressed += hb.Length + body.N;
        }

        // ---- append (single thread, in order) ----
        public void Append(EncodedRowGroup g)
        {
            long at = fs.Position;
            long[] starts = new long[g.Chunks.Count];
            for (int c = 0; c < g.Chunks.Count; c++) { starts[c] = fs.Position; fs.Write(g.Chunks[c].Bytes, 0, g.Chunks[c].Bytes.Length); }
            groups.Add(new KeyValuePair<EncodedRowGroup, long[]>(g, starts));
            Rows += g.Rows;
        }

        public void Close()
        {
            ThriftWriter w = new ThriftWriter();
            w.I32(1, 1);
            w.ListBegin(2, schema.Count + 1, 12);
            w.BeginElem().Str(4, "schema").I32(5, schema.Count).End();
            for (int c = 0; c < schema.Count; c++)
            {
                DataType t = schema[c].Type.Kind == Kind.Null ? DataType.Varchar : schema[c].Type;
                int phys = ParquetTypes.Physical(t);
                w.BeginElem().I32(1, phys);
                if (phys == ParquetTypes.FIXED) w.I32(2, 16);
                w.I32(3, 1).Str(4, names[c]);
                switch (t.Kind)
                {
                    case Kind.String: w.I32(6, 0).Begin(10).Begin(1).End().End(); break;
                    case Kind.Date: w.I32(6, 6).Begin(10).Begin(6).End().End(); break;
                    case Kind.Timestamp: w.I32(6, 10).Begin(10).Begin(8).Bool(1, false).Begin(2).Begin(2).End().End().End().End(); break;
                    case Kind.Decimal: w.I32(6, 5).I32(7, t.Scale).I32(8, t.Precision).Begin(10).Begin(5).I32(1, t.Scale).I32(2, t.Precision).End().End(); break;
                    case Kind.Int:
                        if (t.Bits == 8) w.I32(6, 15); else if (t.Bits == 16) w.I32(6, 16);
                        if (t.Bits < 64) w.Begin(10).Begin(10).Byte8(1, t.Bits).Bool(2, true).End().End();
                        break;
                }
                w.End();
            }
            w.I64(3, Rows);
            w.ListBegin(4, groups.Count, 12);
            foreach (KeyValuePair<EncodedRowGroup, long[]> kv in groups)
            {
                EncodedRowGroup g = kv.Key; long total = 0;
                w.BeginElem();
                w.ListBegin(1, g.Chunks.Count, 12);
                for (int c = 0; c < g.Chunks.Count; c++)
                {
                    EncodedChunk ch = g.Chunks[c]; long start = kv.Value[c];
                    DataType t = schema[c].Type.Kind == Kind.Null ? DataType.Varchar : schema[c].Type;
                    total += ch.Uncompressed;
                    w.BeginElem().I64(2, start);
                    w.Begin(3).I32(1, ParquetTypes.Physical(t));
                    w.ListBegin(2, ch.Encodings.Count, 5); foreach (int e in ch.Encodings) w.I32Elem(e);
                    w.ListBegin(3, 1, 8).StrElem(names[c]);
                    w.I32(4, codec).I64(5, ch.Values).I64(6, ch.Uncompressed).I64(7, ch.Bytes.Length).I64(9, start + ch.DataRel);
                    if (ch.DictRel >= 0) w.I64(11, start + ch.DictRel);
                    w.Begin(12).I64(3, ch.Nulls);
                    if (ch.Min != null) { w.Bin(5, ch.Max).Bin(6, ch.Min); }
                    w.End();
                    w.End();   // meta_data
                    w.End();   // column chunk
                }
                w.I64(2, total).I64(3, g.Rows);
                w.End();
            }
            w.Str(6, "data-noodler native engine");
            w.StructEnd();
            byte[] meta = w.ToArray();
            fs.Write(meta, 0, meta.Length);
            fs.Write(BitConverter.GetBytes(meta.Length), 0, 4);
            fs.Write(Encoding.ASCII.GetBytes("PAR1"), 0, 4);
            fs.Flush(true);
            fs.Dispose();
            closed = true;
        }
        bool closed;
        public void Dispose() { if (!closed) { try { fs.Dispose(); } catch { } } }
    }
}
