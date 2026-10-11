// Parquet reader: flat schemas (nested columns are skipped), data pages v1 + v2, dictionary pages,
// PLAIN / RLE / RLE_DICTIONARY / DELTA_* / BYTE_STREAM_SPLIT, Snappy / GZIP / none. Reads only the columns asked for.
// Unsupported features fail clearly (PARQUET_UNSUPPORTED_*) instead of returning wrong values.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace NativeDataEngine
{
    public sealed class PqColumn
    {
        public string Name; public int Leaf; public int Physical; public int TypeLength; public DataType Type;
        public int MaxDef; public int Converted = -1; public TStruct Logical; public int Scale; public bool TsMillis, TsNanos;
    }

    public sealed class PqMeta
    {
        public string Path; public long Size; public DateTime Modified;
        public long Rows; public List<PqColumn> Columns = new List<PqColumn>(); public Schema Schema;
        public List<TStruct> RowGroups = new List<TStruct>(); public List<long> GroupRows = new List<long>();
        public string CreatedBy;

        static readonly ConcurrentDictionary<string, PqMeta> cache = new ConcurrentDictionary<string, PqMeta>(StringComparer.OrdinalIgnoreCase);

        public static PqMeta Open(string path)
        {
            FileInfo fi = new FileInfo(path);
            if (!fi.Exists) throw new EngineException("FILE_NOT_FOUND", "Parquet file not found: " + System.IO.Path.GetFileName(path), 404);
            PqMeta m;
            if (cache.TryGetValue(path, out m) && m.Size == fi.Length && m.Modified == fi.LastWriteTimeUtc) return m;
            m = Read(path, fi);
            cache[path] = m;
            if (cache.Count > 4000) cache.Clear();
            return m;
        }
        public static void Forget(string pathPrefix)
        {
            foreach (string k in cache.Keys) if (k.StartsWith(pathPrefix, StringComparison.OrdinalIgnoreCase)) { PqMeta x; cache.TryRemove(k, out x); }
        }

        static PqMeta Read(string path, FileInfo fi)
        {
            PqMeta m = new PqMeta(); m.Path = path; m.Size = fi.Length; m.Modified = fi.LastWriteTimeUtc;
            using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (fs.Length < 12) throw Bad(path);
                byte[] tail = new byte[8];
                fs.Seek(-8, SeekOrigin.End); Fill(fs, tail, 8);
                if (Encoding.ASCII.GetString(tail, 4, 4) != "PAR1") throw Bad(path);
                int len = BitConverter.ToInt32(tail, 0);
                if (len <= 0 || len > fs.Length - 8) throw Bad(path);
                byte[] meta = new byte[len];
                fs.Seek(-8 - len, SeekOrigin.End); Fill(fs, meta, len);
                TStruct fm = new ThriftReader(meta, 0).Struct();
                m.Rows = fm.L(3, 0);
                m.CreatedBy = fm.S(6);
                List<object> schema = fm.Lst(2);
                if (schema == null || schema.Count == 0) throw Bad(path);
                // Walk the schema tree; keep top-level primitive leaves, skip nested groups.
                int pos = 1, leaf = 0;
                int rootChildren = (int)((TStruct)schema[0]).L(5, schema.Count - 1);
                List<Field> fields = new List<Field>();
                for (int c = 0; c < rootChildren && pos < schema.Count; c++)
                {
                    TStruct e = (TStruct)schema[pos];
                    if (e.Has(5) && e.L(5, 0) > 0) { int leaves = CountLeaves(schema, ref pos); leaf += leaves; continue; }   // nested: skipped
                    pos++;
                    int rep = (int)e.L(3, 0);
                    if (rep == 2) { leaf++; continue; }   // repeated primitive: skipped
                    PqColumn col = new PqColumn();
                    col.Name = e.S(4); col.Leaf = leaf++; col.Physical = (int)e.L(1, -1); col.TypeLength = (int)e.L(2, 0);
                    col.MaxDef = rep == 1 ? 1 : 0; col.Converted = (int)e.L(6, -1); col.Logical = e.St(10); col.Scale = (int)e.L(7, 0);
                    col.Type = MapType(col, e);
                    m.Columns.Add(col); fields.Add(new Field(col.Name, col.Type));
                }
                m.Schema = new Schema(fields);
                List<object> rgs = fm.Lst(4) ?? new List<object>();
                foreach (object o in rgs) { TStruct rg = (TStruct)o; m.RowGroups.Add(rg); m.GroupRows.Add(rg.L(3, 0)); }
            }
            return m;
        }
        static int CountLeaves(List<object> schema, ref int pos)
        {
            TStruct e = (TStruct)schema[pos++];
            int kids = (int)e.L(5, 0);
            if (kids == 0) return 1;
            int n = 0;
            for (int k = 0; k < kids; k++) n += CountLeaves(schema, ref pos);
            return n;
        }
        static EngineException Bad(string path) { return new EngineException("PARQUET_CORRUPT", "Not a valid Parquet file: " + System.IO.Path.GetFileName(path)); }
        public static void Fill(Stream s, byte[] b, int n) { int at = 0, r; while (at < n && (r = s.Read(b, at, n - at)) > 0) at += r; if (at < n) throw new EngineException("PARQUET_CORRUPT", "Parquet file is truncated."); }

        static DataType MapType(PqColumn c, TStruct e)
        {
            TStruct lt = c.Logical;
            int conv = c.Converted;
            if (lt != null)
            {
                if (lt.Has(1) || lt.Has(4) || lt.Has(12)) return DataType.Varchar;
                if (lt.Has(6)) return DataType.Date;
                if (lt.Has(5)) { TStruct d = lt.St(5); c.Scale = (int)d.L(1, 0); return DecimalOf((int)d.L(2, 18), c.Scale); }
                if (lt.Has(8)) { TStruct u = lt.St(8).St(2); if (u != null) { c.TsMillis = u.Has(1); c.TsNanos = u.Has(3); } return DataType.Timestamp; }
                if (lt.Has(10))
                {
                    TStruct it = lt.St(10); int bits = (int)it.L(1, 32); bool signed = it.B(2, true);
                    if (!signed) bits = Math.Min(64, bits * 2);
                    return bits <= 8 ? DataType.TinyInt : bits <= 16 ? DataType.SmallInt : bits <= 32 ? DataType.Integer : DataType.BigInt;
                }
                if (lt.Has(14)) return DataType.Varchar;
                if (lt.Has(7)) return DataType.BigInt;   // TIME: microseconds/millis as a number
            }
            switch (conv)
            {
                case 0: case 4: case 19: return DataType.Varchar;
                case 5: c.Scale = (int)e.L(7, 0); return DecimalOf((int)e.L(8, 18), c.Scale);
                case 6: return DataType.Date;
                case 9: c.TsMillis = true; return DataType.Timestamp;
                case 10: return DataType.Timestamp;
                case 15: return DataType.TinyInt;
                case 16: case 11: return DataType.SmallInt;
                case 17: case 12: return DataType.Integer;
                case 13: case 14: case 18: return DataType.BigInt;
            }
            switch (c.Physical)
            {
                case ParquetTypes.BOOLEAN: return DataType.Bool;
                case ParquetTypes.INT32: return DataType.Integer;
                case ParquetTypes.INT64: return DataType.BigInt;
                case ParquetTypes.INT96: c.TsNanos = true; return DataType.Timestamp;
                case ParquetTypes.FLOAT: case ParquetTypes.DOUBLE: return DataType.Double;
                default: return DataType.Varchar;
            }
        }
        static DataType DecimalOf(int p, int s) { p = Math.Max(1, Math.Min(38, p)); s = Math.Max(0, Math.Min(p, s)); return DataType.Decimal(p, s); }
    }

    public static class ParquetReader
    {
        // Reads the given columns of one row group as a batch (schema = those columns).
        public static Batch ReadRowGroup(PqMeta m, int rg, int[] cols, Schema outSchema)
        {
            TStruct g = m.RowGroups[rg];
            int rows = (int)g.L(3, 0);
            List<object> chunks = g.Lst(1);
            Column[] outCols = new Column[cols.Length];
            using (FileStream fs = new FileStream(m.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16))
            {
                for (int k = 0; k < cols.Length; k++)
                {
                    PqColumn c = m.Columns[cols[k]];
                    TStruct cc = (TStruct)chunks[c.Leaf];
                    TStruct md = cc.St(3);
                    if (md == null) throw new EngineException("PARQUET_UNSUPPORTED", "Column chunks in separate files are not supported.");
                    long start = md.Has(11) && md.L(11, 0) > 0 ? Math.Min(md.L(11, 0), md.L(9, 0)) : md.L(9, 0);
                    long len = md.L(7, 0);
                    int codec = (int)md.L(4, 0);
                    long values = md.L(5, 0);
                    if (tChunk == null || tChunk.Length < len) tChunk = new byte[Math.Max(len, tChunk == null ? 0 : tChunk.Length * 2)];
                    byte[] buf = tChunk;
                    fs.Seek(start, SeekOrigin.Begin);
                    PqMeta.Fill(fs, buf, (int)len);
                    outCols[k] = ReadChunk(c, buf, (int)len, codec, values, rows);
                }
            }
            return new Batch(outSchema, outCols, rows);
        }

        // Per-thread reusable buffers: the chunk bytes, decompressed pages, definition levels, dictionary indices.
        // Reusing them keeps large short-lived arrays off the large-object heap (fewer full GCs, better scaling).
        [ThreadStatic] static byte[] tChunk, tPage;
        [ThreadStatic] static int[] tDef, tIdx;
        static int[] Ints(ref int[] b, int n) { if (b == null || b.Length < n) b = new int[Math.Max(n, b == null ? 0 : b.Length * 2)]; return b; }

        static Column ReadChunk(PqColumn c, byte[] buf, int bufLen, int codec, long totalValues, int rows)
        {
            Column col = new Column(c.Type, rows);
            object dict = null; int dictCount = 0;
            int pos = 0, row = 0;
            while (row < rows && pos < bufLen)
            {
                ThriftReader tr = new ThriftReader(buf, pos);
                TStruct h = tr.Struct();
                pos = tr.Position;
                int type = (int)h.L(1, 0), usize = (int)h.L(2, 0), csize = (int)h.L(3, 0);
                if (type == 2)
                {
                    TStruct dh = h.St(7);
                    dictCount = (int)dh.L(1, 0);
                    byte[] d = Codec.Decompress(codec, buf, pos, csize, usize);
                    int p = 0;
                    dict = Plain(c, d, ref p, dictCount);
                    pos += csize; continue;
                }
                if (type != 0 && type != 3) { pos += csize; continue; }   // index pages etc.
                int n, enc; byte[] data; int dp = 0, dataEnd; int[] def = null; int nonNull;
                if (type == 0)
                {
                    TStruct ph = h.St(5); n = (int)ph.L(1, 0); enc = (int)ph.L(2, 0);
                    if (codec == Codec.Uncompressed) { data = buf; dp = pos; dataEnd = pos + csize; }
                    else { data = Codec.DecompressInto(codec, buf, pos, csize, usize, ref tPage); dataEnd = usize; }
                    if (c.MaxDef > 0)
                    {
                        int l = BitConverter.ToInt32(data, dp); def = Ints(ref tDef, n);
                        Rle.Decode(data, dp + 4, dp + 4 + l, 1, def, n); dp += 4 + l;
                    }
                }
                else
                {
                    TStruct ph = h.St(8); n = (int)ph.L(1, 0); enc = (int)ph.L(4, 0);
                    int dl = (int)ph.L(5, 0), rl = (int)ph.L(6, 0); bool compressed = ph.B(7, true);
                    if (c.MaxDef > 0) { def = Ints(ref tDef, n); Rle.Decode(buf, pos + rl, pos + rl + dl, 1, def, n); }
                    int vstart = pos + rl + dl, vlen = csize - rl - dl;
                    if (compressed && codec != 0) { data = Codec.DecompressInto(codec, buf, vstart, vlen, usize - rl - dl, ref tPage); dp = 0; dataEnd = usize - rl - dl; }
                    else { data = buf; dp = vstart; dataEnd = vstart + vlen; }
                }
                pos += csize;
                nonNull = 0;
                if (def == null) nonNull = n; else for (int i = 0; i < n; i++) if (def[i] == c.MaxDef) nonNull++;
                if (nonNull == n) def = null;   // no nulls in this page: values go straight in
                if (enc == 2 || enc == 8)
                {
                    if (dict == null) throw new EngineException("PARQUET_CORRUPT", "Dictionary page missing.");
                    int w = data[dp++];
                    int[] idx = Ints(ref tIdx, nonNull);
                    Rle.Decode(data, dp, dataEnd, w, idx, nonNull);
                    if (def == null && row + n <= rows && DictDirect(dict, idx, nonNull, dictCount, col, row)) { row += n; continue; }
                    Scatter(c, col, FromDict(dict, idx, nonNull, dictCount), def, n, row, rows);
                }
                else if (enc == 0 && def == null && row + n <= rows && PlainDirect(c, data, dp, nonNull, col, row)) { }
                else Scatter(c, col, Decode(c, enc, data, dp, nonNull), def, n, row, rows);
                row += n;
            }
            if (row < rows) for (int i = row; i < rows; i++) col.SetNull(i);
            return col;
        }
        static byte[] Sub(byte[] b, int off, int len) { byte[] r = new byte[len]; Buffer.BlockCopy(b, off, r, 0, len); return r; }

        // No nulls: dictionary values straight into the column.
        static bool DictDirect(object dict, int[] idx, int n, int dc, Column col, int row)
        {
            long[] dl = dict as long[]; if (dl != null && col.I != null) { for (int i = 0; i < n; i++) col.I[row + i] = dl[Check(idx[i], dc)]; return true; }
            double[] dd = dict as double[]; if (dd != null && col.F != null) { for (int i = 0; i < n; i++) col.F[row + i] = dd[Check(idx[i], dc)]; return true; }
            string[] ds = dict as string[]; if (ds != null && col.S != null) { for (int i = 0; i < n; i++) col.S[row + i] = ds[Check(idx[i], dc)]; return true; }
            return false;
        }
        // No nulls, PLAIN, no unit conversion: decode straight into the column (no temporary array).
        static bool PlainDirect(PqColumn c, byte[] d, int p, int n, Column col, int row)
        {
            bool plainInt = c.Type.Kind == Kind.Int || c.Type.Kind == Kind.Date || (c.Type.Kind == Kind.Timestamp && !c.TsMillis && !c.TsNanos);
            bool unsigned = c.Converted == 11 || c.Converted == 12 || c.Converted == 13 || (c.Logical != null && c.Logical.Has(10) && !c.Logical.St(10).B(2, true));
            if (c.Physical == ParquetTypes.INT64 && plainInt && col.I != null) { Buffer.BlockCopy(d, p, col.I, row * 8, n * 8); return true; }
            if (c.Physical == ParquetTypes.INT32 && plainInt && !unsigned && col.I != null) { long[] o = col.I; for (int i = 0; i < n; i++) o[row + i] = BitConverter.ToInt32(d, p + 4 * i); return true; }
            if (c.Physical == ParquetTypes.DOUBLE && col.F != null) { Buffer.BlockCopy(d, p, col.F, row * 8, n * 8); return true; }
            if (c.Physical == ParquetTypes.INT64 && c.Type.Kind == Kind.Decimal && col.F != null) { double s = Math.Pow(10, c.Scale); double[] o = col.F; for (int i = 0; i < n; i++) o[row + i] = BitConverter.ToInt64(d, p + 8 * i) / s; return true; }
            if (c.Physical == ParquetTypes.BYTE_ARRAY && c.Type.Kind == Kind.String && col.S != null)
            {
                string[] o = col.S; TextIntern ti = new TextIntern();   // repeated values: one string each
                for (int i = 0; i < n; i++) { int l = BitConverter.ToInt32(d, p); p += 4; o[row + i] = ti.Get(d, p, l); p += l; }
                return true;
            }
            return false;
        }

        static object FromDict(object dict, int[] idx, int n, int dc)
        {
            long[] dl = dict as long[]; if (dl != null) { long[] r = new long[n]; for (int i = 0; i < n; i++) r[i] = dl[Check(idx[i], dc)]; return r; }
            double[] dd = dict as double[]; if (dd != null) { double[] r = new double[n]; for (int i = 0; i < n; i++) r[i] = dd[Check(idx[i], dc)]; return r; }
            string[] ds = dict as string[]; if (ds != null) { string[] r = new string[n]; for (int i = 0; i < n; i++) r[i] = ds[Check(idx[i], dc)]; return r; }
            bool[] db = (bool[])dict; { bool[] r = new bool[n]; for (int i = 0; i < n; i++) r[i] = db[Check(idx[i], dc)]; return r; }
        }
        static int Check(int i, int n) { if (i < 0 || i >= n) throw new EngineException("PARQUET_CORRUPT", "Dictionary index out of range."); return i; }

        static object Decode(PqColumn c, int enc, byte[] d, int p, int n)
        {
            switch (enc)
            {
                case 0: return Plain(c, d, ref p, n);
                case 3:
                    if (c.Physical != ParquetTypes.BOOLEAN) break;
                    {
                        int l = BitConverter.ToInt32(d, p); int[] v = new int[n]; Rle.Decode(d, p + 4, p + 4 + l, 1, v, n);
                        bool[] r = new bool[n]; for (int i = 0; i < n; i++) r[i] = v[i] != 0; return r;
                    }
                case 5:
                    {
                        long[] v = new long[n]; Delta.BinaryPacked(d, p, v, n);
                        return Convert(c, v);
                    }
                case 6: if (c.Physical == ParquetTypes.BYTE_ARRAY) { string[] s = new string[n]; Delta.LengthByteArray(d, p, s, n); return s; } break;
                case 7: if (c.Physical == ParquetTypes.BYTE_ARRAY) { string[] s = new string[n]; Delta.ByteArray(d, p, s, n); return s; } break;
                case 9:
                    {
                        int w = c.Physical == ParquetTypes.FLOAT || c.Physical == ParquetTypes.INT32 ? 4 : 8;
                        byte[] t = new byte[n * w];
                        for (int i = 0; i < n; i++) for (int k = 0; k < w; k++) t[i * w + k] = d[p + k * n + i];
                        int q = 0; return Plain(c, t, ref q, n);
                    }
            }
            throw new EngineException("PARQUET_UNSUPPORTED_ENCODING", "Parquet encoding " + enc + " is not supported for column \"" + c.Name + "\".");
        }
        static object Convert(PqColumn c, long[] v)
        {
            if (c.Type.Kind == Kind.Decimal) { double s = Math.Pow(10, c.Scale); double[] r = new double[v.Length]; for (int i = 0; i < v.Length; i++) r[i] = v[i] / s; return r; }
            if (c.Type.Kind == Kind.Timestamp) { for (int i = 0; i < v.Length; i++) v[i] = c.TsMillis ? v[i] * 1000 : c.TsNanos ? Cast.FloorDiv(v[i], 1000) : v[i]; }
            if (c.Type.Kind == Kind.Double) { double[] r = new double[v.Length]; for (int i = 0; i < v.Length; i++) r[i] = v[i]; return r; }
            return v;
        }

        // PLAIN -> long[] (ints, dates, timestamps), double[] (floats, decimals), string[] or bool[].
        static object Plain(PqColumn c, byte[] d, ref int p, int n)
        {
            switch (c.Physical)
            {
                case ParquetTypes.BOOLEAN: { bool[] r = new bool[n]; for (int i = 0; i < n; i++) r[i] = (d[p + (i >> 3)] >> (i & 7) & 1) != 0; p += (n + 7) / 8; return r; }
                case ParquetTypes.INT32:
                    {
                        long[] r = new long[n];
                        bool unsigned = c.Converted == 11 || c.Converted == 12 || c.Converted == 13 || (c.Logical != null && c.Logical.Has(10) && !c.Logical.St(10).B(2, true));
                        for (int i = 0; i < n; i++) { int v = BitConverter.ToInt32(d, p); r[i] = unsigned ? (long)(uint)v : v; p += 4; }
                        return Convert(c, r);
                    }
                case ParquetTypes.INT64: { long[] r = new long[n]; for (int i = 0; i < n; i++) { r[i] = BitConverter.ToInt64(d, p); p += 8; } return Convert(c, r); }
                case ParquetTypes.INT96:
                    {
                        long[] r = new long[n];
                        for (int i = 0; i < n; i++)
                        {
                            long nanos = BitConverter.ToInt64(d, p); int julian = BitConverter.ToInt32(d, p + 8); p += 12;
                            r[i] = (julian - 2440588L) * 86400000000L + nanos / 1000;
                        }
                        return r;
                    }
                case ParquetTypes.FLOAT: { double[] r = new double[n]; for (int i = 0; i < n; i++) { r[i] = BitConverter.ToSingle(d, p); p += 4; } return r; }
                case ParquetTypes.DOUBLE: { double[] r = new double[n]; for (int i = 0; i < n; i++) { r[i] = BitConverter.ToDouble(d, p); p += 8; } return r; }
                case ParquetTypes.BYTE_ARRAY:
                    {
                        if (c.Type.Kind == Kind.Decimal)
                        {
                            double[] r = new double[n];
                            for (int i = 0; i < n; i++) { int l = BitConverter.ToInt32(d, p); p += 4; r[i] = BigEndianDecimal(d, p, l, c.Scale); p += l; }
                            return r;
                        }
                        string[] s = new string[n]; TextIntern ti = new TextIntern();
                        for (int i = 0; i < n; i++) { int l = BitConverter.ToInt32(d, p); p += 4; s[i] = ti.Get(d, p, l); p += l; }
                        return s;
                    }
                case ParquetTypes.FIXED:
                    {
                        int l = c.TypeLength;
                        if (c.Type.Kind == Kind.Decimal) { double[] r = new double[n]; for (int i = 0; i < n; i++) { r[i] = BigEndianDecimal(d, p, l, c.Scale); p += l; } return r; }
                        string[] s = new string[n];
                        bool uuid = c.Logical != null && c.Logical.Has(14);
                        for (int i = 0; i < n; i++)
                        {
                            StringBuilder sb = new StringBuilder(l * 2);
                            for (int k = 0; k < l; k++) { if (uuid && (k == 4 || k == 6 || k == 8 || k == 10)) sb.Append('-'); sb.Append(d[p + k].ToString("x2")); }
                            s[i] = sb.ToString(); p += l;
                        }
                        return s;
                    }
            }
            throw new EngineException("PARQUET_UNSUPPORTED_TYPE", "Parquet type " + c.Physical + " is not supported (column \"" + c.Name + "\").");
        }
        static double BigEndianDecimal(byte[] d, int p, int l, int scale)
        {
            if (l == 0) return 0;
            bool neg = (d[p] & 0x80) != 0; double v = 0;
            for (int k = 0; k < l; k++) v = v * 256 + (neg ? (byte)~d[p + k] : d[p + k]);
            if (neg) v = -(v + 1);
            return v / Math.Pow(10, scale);
        }

        static void Scatter(PqColumn c, Column col, object vals, int[] def, int n, int row, int rows)
        {
            long[] li = vals as long[]; double[] df = vals as double[]; string[] s = vals as string[]; bool[] b = vals as bool[];
            int k = 0;
            for (int i = 0; i < n && row + i < rows; i++)
            {
                int r = row + i;
                if (def != null && def[i] != c.MaxDef) { col.SetNull(r); continue; }
                if (col.I != null) col.I[r] = li != null ? li[k] : (long)df[k];
                else if (col.F != null) col.F[r] = df != null ? df[k] : li[k];
                else if (col.S != null) col.S[r] = s != null ? s[k] : (li != null ? li[k].ToString() : df != null ? Values.Num(df[k]) : (b[k] ? "true" : "false"));
                else if (col.B != null) col.B[r] = b != null ? b[k] : li[k] != 0;
                k++;
            }
        }
    }
}
