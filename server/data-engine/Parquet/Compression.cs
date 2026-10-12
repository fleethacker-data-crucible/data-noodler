// Parquet page compression with nothing but the .NET Framework:
//   SNAPPY (written by default; hand-written codec), GZIP (System.IO.Compression), UNCOMPRESSED.
//   ZSTD / LZ4 / BROTLI are rejected with a clear message (re-import the source to rewrite the data).
using System;
using System.IO;
using System.IO.Compression;

namespace NativeDataEngine
{
    public static class Codec
    {
        public const int Uncompressed = 0, Snappy = 1, Gzip = 2, Lzo = 3, Brotli = 4, Lz4 = 5, Zstd = 6, Lz4Raw = 7;

        public static string Name(int c)
        {
            switch (c) { case 0: return "UNCOMPRESSED"; case 1: return "SNAPPY"; case 2: return "GZIP"; case 3: return "LZO"; case 4: return "BROTLI"; case 5: return "LZ4"; case 6: return "ZSTD"; case 7: return "LZ4_RAW"; }
            return "codec " + c;
        }
        public static int Parse(string s)
        {
            switch ((s ?? "snappy").ToLowerInvariant()) { case "none": case "uncompressed": return Uncompressed; case "gzip": return Gzip; default: return Snappy; }
        }

        public static byte[] Compress(int codec, byte[] data, int len)
        {
            switch (codec)
            {
                case Uncompressed: { if (len == data.Length) return data; byte[] r = new byte[len]; Buffer.BlockCopy(data, 0, r, 0, len); return r; }
                case Snappy: return SnappyCodec.Compress(data, len);
                case Gzip:
                    using (MemoryStream ms = new MemoryStream())
                    {
                        using (GZipStream gz = new GZipStream(ms, CompressionLevel.Fastest, true)) gz.Write(data, 0, len);
                        return ms.ToArray();
                    }
            }
            throw new EngineException("PARQUET_UNSUPPORTED_CODEC", "Cannot write " + Name(codec) + " Parquet.");
        }

        // Decompress into a reusable buffer (grown when too small); returns the buffer holding outLen bytes.
        public static byte[] DecompressInto(int codec, byte[] data, int off, int len, int outLen, ref byte[] dst)
        {
            if (codec == Snappy)
            {
                if (dst == null || dst.Length < outLen) dst = new byte[Math.Max(outLen, dst == null ? 0 : dst.Length * 2)];
                SnappyCodec.DecompressTo(data, off, len, dst, outLen);
                return dst;
            }
            if (codec == Uncompressed)
            {
                if (dst == null || dst.Length < len) dst = new byte[Math.Max(len, dst == null ? 0 : dst.Length * 2)];
                Buffer.BlockCopy(data, off, dst, 0, len);
                return dst;
            }
            return Decompress(codec, data, off, len, outLen);
        }

        public static byte[] Decompress(int codec, byte[] data, int off, int len, int outLen)
        {
            switch (codec)
            {
                case Uncompressed: { byte[] r = new byte[len]; Buffer.BlockCopy(data, off, r, 0, len); return r; }
                case Snappy: return SnappyCodec.Decompress(data, off, len, outLen);
                case Gzip:
                    using (MemoryStream src = new MemoryStream(data, off, len))
                    using (GZipStream gz = new GZipStream(src, CompressionMode.Decompress))
                    {
                        byte[] r = new byte[outLen]; int at = 0, n;
                        while (at < outLen && (n = gz.Read(r, at, outLen - at)) > 0) at += n;
                        return r;
                    }
            }
            throw new EngineException("PARQUET_UNSUPPORTED_CODEC", "This Parquet file uses " + Name(codec) +
                " compression, which this engine cannot read (Windows has no built-in " + Name(codec) + "). Re-import the original source, or re-save the file with Snappy or GZIP.");
        }
    }

    public static class SnappyCodec
    {
        public static byte[] Decompress(byte[] s, int off, int len, int expected)
        {
            int p = off; ulong n = 0; int shift = 0;
            while (true) { byte b = s[p++]; n |= (ulong)(b & 0x7f) << shift; if ((b & 0x80) == 0) break; shift += 7; }
            byte[] o = new byte[(int)n];
            DecompressTo(s, off, len, o, (int)n);
            return o;
        }
        // Into o (at least the uncompressed length long); returns the uncompressed length.
        public static int DecompressTo(byte[] s, int off, int len, byte[] o, int expected)
        {
            int end = off + len, p = off;
            ulong n = 0; int shift = 0;
            while (true) { byte b = s[p++]; n |= (ulong)(b & 0x7f) << shift; if ((b & 0x80) == 0) break; shift += 7; }
            if ((int)n > o.Length) throw new EngineException("PARQUET_CORRUPT", "Snappy data is damaged.");
            int d = 0;
            while (p < end)
            {
                int tag = s[p++];
                switch (tag & 3)
                {
                    case 0:
                        {
                            int l = tag >> 2;
                            if (l >= 60) { int bytes = l - 59; l = 0; for (int k = 0; k < bytes; k++) l |= s[p++] << (8 * k); }
                            l++;
                            Buffer.BlockCopy(s, p, o, d, l); p += l; d += l;
                            break;
                        }
                    case 1: { int l = ((tag >> 2) & 7) + 4, offs = ((tag >> 5) << 8) | s[p++]; Copy(o, ref d, offs, l); break; }
                    case 2: { int l = (tag >> 2) + 1, offs = s[p] | (s[p + 1] << 8); p += 2; Copy(o, ref d, offs, l); break; }
                    default: { int l = (tag >> 2) + 1, offs = s[p] | (s[p + 1] << 8) | (s[p + 2] << 16) | (s[p + 3] << 24); p += 4; Copy(o, ref d, offs, l); break; }
                }
            }
            if (d != (int)n) throw new EngineException("PARQUET_CORRUPT", "Snappy data is damaged.");
            return d;
        }
        static void Copy(byte[] o, ref int d, int offs, int l)
        {
            if (offs <= 0 || offs > d) throw new EngineException("PARQUET_CORRUPT", "Snappy data is damaged.");
            int from = d - offs;
            if (offs >= l) { Buffer.BlockCopy(o, from, o, d, l); d += l; return; }
            for (int k = 0; k < l; k++) o[d++] = o[from + k];
        }

        // Greedy LZ77 with a 16K-entry hash table, blocks of 64 KB (the Snappy reference layout).
        public static byte[] Compress(byte[] src, int len)
        {
            byte[] o = new byte[32 + len + len / 6];
            int d = 0;
            ulong v = (ulong)len;
            while (v >= 0x80) { o[d++] = (byte)(v | 0x80); v >>= 7; }
            o[d++] = (byte)v;
            int[] table = new int[1 << 14];
            for (int blk = 0; blk < len; blk += 65536)
            {
                int bend = Math.Min(len, blk + 65536);
                for (int k = 0; k < table.Length; k++) table[k] = -1;
                int lit = blk, p = blk;
                while (p + 4 <= bend)
                {
                    uint cur = (uint)(src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24));
                    int h = (int)((cur * 0x1e35a7bd) >> 18);
                    int cand = table[h]; table[h] = p;
                    if (cand >= blk && p - cand <= 65535 && src[cand] == src[p] && src[cand + 1] == src[p + 1] && src[cand + 2] == src[p + 2] && src[cand + 3] == src[p + 3])
                    {
                        if (p > lit) d = Literal(o, d, src, lit, p - lit);
                        int ml = 4;
                        while (p + ml < bend && src[cand + ml] == src[p + ml]) ml++;
                        int offs = p - cand, rem = ml;
                        while (rem > 0)
                        {
                            int l = Math.Min(rem, 64);
                            if (rem - l > 0 && rem - l < 4) l = rem - 4;
                            if (l >= 4 && l <= 11 && offs < 2048) { o[d++] = (byte)(1 | ((l - 4) << 2) | ((offs >> 8) << 5)); o[d++] = (byte)offs; }
                            else { o[d++] = (byte)(2 | ((l - 1) << 2)); o[d++] = (byte)offs; o[d++] = (byte)(offs >> 8); }
                            rem -= l;
                        }
                        p += ml; lit = p;
                        if (d > o.Length - 80) Array.Resize(ref o, o.Length * 2);
                        continue;
                    }
                    p++;
                }
                if (bend > lit) d = Literal(o, d, src, lit, bend - lit);
                if (d > o.Length - 70000) Array.Resize(ref o, o.Length + 140000);
            }
            Array.Resize(ref o, d);
            return o;
        }
        static int Literal(byte[] o, int d, byte[] src, int at, int l)
        {
            int n = l - 1;
            if (n < 60) o[d++] = (byte)(n << 2);
            else if (n < 256) { o[d++] = 60 << 2; o[d++] = (byte)n; }
            else if (n < 65536) { o[d++] = 61 << 2; o[d++] = (byte)n; o[d++] = (byte)(n >> 8); }
            else { o[d++] = 62 << 2; o[d++] = (byte)n; o[d++] = (byte)(n >> 8); o[d++] = (byte)(n >> 16); }
            Buffer.BlockCopy(src, at, o, d, l);
            return d + l;
        }
    }
}
