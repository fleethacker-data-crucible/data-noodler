// Parquet value/level encodings: RLE/bit-packed hybrid, PLAIN, DELTA_BINARY_PACKED, DELTA_LENGTH_BYTE_ARRAY,
// DELTA_BYTE_ARRAY, BYTE_STREAM_SPLIT (decode), and the growable byte buffer used by the writer.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace NativeDataEngine
{
    public sealed class ByteBuf
    {
        public byte[] B; public int N;
        public ByteBuf(int cap) { B = new byte[Math.Max(16, cap)]; }
        public void Need(int k) { if (N + k > B.Length) Array.Resize(ref B, Math.Max(B.Length * 2, N + k)); }
        public void Byte(int v) { Need(1); B[N++] = (byte)v; }
        public void Int32(int v) { Need(4); B[N++] = (byte)v; B[N++] = (byte)(v >> 8); B[N++] = (byte)(v >> 16); B[N++] = (byte)(v >> 24); }
        public void Int64(long v) { Need(8); for (int k = 0; k < 8; k++) B[N++] = (byte)(v >> (8 * k)); }
        public void Double(double v) { Int64(BitConverter.DoubleToInt64Bits(v)); }
        public void Bytes(byte[] b, int off, int len) { Need(len); Buffer.BlockCopy(b, off, B, N, len); N += len; }
        public void Varint(ulong v) { while (v >= 0x80) { Byte((int)(v & 0x7f) | 0x80); v >>= 7; } Byte((int)v); }
        public void Utf8(string s) { int len = Encoding.UTF8.GetByteCount(s); Int32(len); Need(len); Encoding.UTF8.GetBytes(s, 0, s.Length, B, N); N += len; }
    }

    public static class Rle
    {
        public static int BitWidth(long max) { int w = 0; while (max > 0) { w++; max >>= 1; } return w; }

        // RLE / bit-packed hybrid. Runs of 8+ equal values become RLE runs; the rest is bit-packed in groups of 8.
        public static void Encode(ByteBuf o, int[] v, int n, int w)
        {
            int byteW = (w + 7) / 8, i = 0;
            while (i < n)
            {
                int run = 1; while (i + run < n && v[i + run] == v[i]) run++;
                if (run >= 8 || w == 0)
                {
                    o.Varint((ulong)run << 1);
                    for (int k = 0; k < byteW; k++) o.Byte(v[i] >> (8 * k));
                    i += run; continue;
                }
                int start = i, groups = 0;
                while (i < n && groups < 63)
                {
                    i += 8; groups++;
                    if (i < n) { int r = 1; while (i + r < n && r < 8 && v[i + r] == v[i]) r++; if (r >= 8) break; }
                }
                o.Varint(((ulong)groups << 1) | 1);
                int total = groups * 8; o.Need(groups * w);
                ulong acc = 0; int bits = 0;
                for (int k = 0; k < total; k++)
                {
                    int x = start + k < n ? v[start + k] : 0;
                    acc |= (ulong)(uint)x << bits; bits += w;
                    while (bits >= 8) { o.B[o.N++] = (byte)acc; acc >>= 8; bits -= 8; }
                }
                if (bits > 0) o.B[o.N++] = (byte)acc;
                if (i > n) i = n;
            }
        }

        // Decodes count values from buf[pos..end) into dst.
        public static void Decode(byte[] buf, int pos, int end, int w, int[] dst, int count)
        {
            int d = 0, byteW = (w + 7) / 8;
            while (d < count)
            {
                if (pos >= end) { while (d < count) dst[d++] = 0; return; }
                ulong h = 0; int shift = 0;
                while (true) { byte b = buf[pos++]; h |= (ulong)(b & 0x7f) << shift; if ((b & 0x80) == 0) break; shift += 7; }
                if ((h & 1) == 0)
                {
                    int run = (int)(h >> 1), val = 0;
                    for (int k = 0; k < byteW; k++) val |= buf[pos++] << (8 * k);
                    for (int k = 0; k < run && d < count; k++) dst[d++] = val;
                }
                else
                {
                    int total = (int)(h >> 1) * 8; ulong acc = 0; int bits = 0; uint mask = w == 32 ? 0xffffffffu : (1u << w) - 1;
                    for (int k = 0; k < total; k++)
                    {
                        while (bits < w) { acc |= (ulong)(pos < end ? buf[pos] : 0) << bits; pos++; bits += 8; }
                        int x = (int)((uint)acc & mask); acc >>= w; bits -= w;
                        if (d < count) dst[d++] = x;
                    }
                }
            }
        }
    }

    public static class Delta
    {
        static ulong Uv(byte[] b, ref int p) { ulong r = 0; int s = 0; while (true) { byte x = b[p++]; r |= (ulong)(x & 0x7f) << s; if ((x & 0x80) == 0) return r; s += 7; } }
        static long Zz(byte[] b, ref int p) { ulong v = Uv(b, ref p); return (long)(v >> 1) ^ -(long)(v & 1); }

        // DELTA_BINARY_PACKED -> count values; returns the position after the data.
        public static int BinaryPacked(byte[] b, int p, long[] dst, int count)
        {
            int block = (int)Uv(b, ref p), mini = (int)Uv(b, ref p), total = (int)Uv(b, ref p);
            long first = Zz(b, ref p);
            int per = block / Math.Max(1, mini), d = 0;
            if (count > 0 && total > 0) dst[d++] = first;
            long last = first; int got = 1;
            while (got < total)
            {
                long minDelta = Zz(b, ref p);
                byte[] widths = new byte[mini]; for (int k = 0; k < mini; k++) widths[k] = b[p++];
                for (int m = 0; m < mini && got < total; m++)
                {
                    int w = widths[m]; ulong acc = 0; int bits = 0;
                    for (int k = 0; k < per; k++)
                    {
                        ulong x = 0;
                        if (w > 0)
                        {
                            int need = w; int shift = 0;
                            while (need > 0)
                            {
                                if (bits == 0) { acc = b[p++]; bits = 8; }
                                int take = Math.Min(need, bits);
                                x |= (acc & ((1UL << take) - 1)) << shift;
                                acc >>= take; bits -= take; need -= take; shift += take;
                            }
                        }
                        if (got < total) { last = last + minDelta + (long)x; if (d < count) dst[d++] = last; got++; }
                    }
                    // skip unused bytes of this miniblock
                }
            }
            return p;
        }

        public static int LengthByteArray(byte[] b, int p, string[] dst, int count)
        {
            long[] lens = new long[count];
            p = BinaryPacked(b, p, lens, count);
            for (int i = 0; i < count; i++) { int l = (int)lens[i]; dst[i] = Encoding.UTF8.GetString(b, p, l); p += l; }
            return p;
        }

        public static int ByteArray(byte[] b, int p, string[] dst, int count)
        {
            long[] pre = new long[count], suf = new long[count];
            p = BinaryPacked(b, p, pre, count);
            p = BinaryPacked(b, p, suf, count);
            byte[] prev = new byte[0];
            for (int i = 0; i < count; i++)
            {
                byte[] cur = new byte[pre[i] + suf[i]];
                Buffer.BlockCopy(prev, 0, cur, 0, (int)pre[i]);
                Buffer.BlockCopy(b, p, cur, (int)pre[i], (int)suf[i]); p += (int)suf[i];
                dst[i] = Encoding.UTF8.GetString(cur); prev = cur;
            }
            return p;
        }
    }
}
