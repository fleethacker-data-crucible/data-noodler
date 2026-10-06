// Thrift compact protocol: just enough to read and write Parquet metadata.
// Read side is generic: a struct becomes Dictionary<short, object> (long / bool / byte[] / double / List<object> / struct).
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace NativeDataEngine
{
    public sealed class TStruct : Dictionary<short, object>
    {
        public long L(short f, long def) { object v; return TryGetValue(f, out v) && v is long ? (long)v : def; }
        public bool Has(short f) { return ContainsKey(f); }
        public string S(short f) { object v; return TryGetValue(f, out v) && v is byte[] ? Encoding.UTF8.GetString((byte[])v) : null; }
        public byte[] Bin(short f) { object v; return TryGetValue(f, out v) ? v as byte[] : null; }
        public TStruct St(short f) { object v; return TryGetValue(f, out v) ? v as TStruct : null; }
        public List<object> Lst(short f) { object v; return TryGetValue(f, out v) ? v as List<object> : null; }
        public bool B(short f, bool def) { object v; return TryGetValue(f, out v) && v is bool ? (bool)v : def; }
    }

    public sealed class ThriftReader
    {
        readonly byte[] buf; int pos;
        public ThriftReader(byte[] b, int start) { buf = b; pos = start; }
        public int Position { get { return pos; } }

        byte Byte() { if (pos >= buf.Length) throw Corrupt(); return buf[pos++]; }
        static EngineException Corrupt() { return new EngineException("PARQUET_CORRUPT", "Parquet metadata is damaged or not a Parquet file."); }
        ulong Varint() { ulong r = 0; int shift = 0; while (true) { byte b = Byte(); r |= (ulong)(b & 0x7f) << shift; if ((b & 0x80) == 0) return r; shift += 7; if (shift > 63) throw Corrupt(); } }
        long Zig() { ulong v = Varint(); return (long)(v >> 1) ^ -(long)(v & 1); }

        public TStruct Struct()
        {
            TStruct s = new TStruct(); short last = 0;
            while (true)
            {
                byte h = Byte();
                if (h == 0) return s;
                int type = h & 0x0f, delta = h >> 4;
                short id = delta != 0 ? (short)(last + delta) : (short)Zig();
                last = id;
                s[id] = Value(type);
            }
        }
        object Value(int type)
        {
            switch (type)
            {
                case 1: return true;
                case 2: return false;
                case 3: return (long)(sbyte)Byte();
                case 4: case 5: case 6: return Zig();
                case 7: { double d = BitConverter.ToDouble(buf, pos); pos += 8; return d; }
                case 8: { int n = (int)Varint(); if (n < 0 || pos + n > buf.Length) throw Corrupt(); byte[] b = new byte[n]; Buffer.BlockCopy(buf, pos, b, 0, n); pos += n; return b; }
                case 9: case 10:
                    {
                        byte h = Byte(); int n = h >> 4, et = h & 0x0f;
                        if (n == 15) n = (int)Varint();
                        List<object> l = new List<object>(n);
                        for (int i = 0; i < n; i++) l.Add(et == 1 || et == 2 ? (object)(Byte() == 1) : Value(et));
                        return l;
                    }
                case 11:
                    {
                        int n = (int)Varint(); if (n == 0) return new List<object>();
                        byte kv = Byte(); List<object> l = new List<object>();
                        for (int i = 0; i < n; i++) { l.Add(Value(kv >> 4)); l.Add(Value(kv & 0x0f)); }
                        return l;
                    }
                case 12: return Struct();
            }
            throw Corrupt();
        }
    }

    public sealed class ThriftWriter
    {
        readonly MemoryStream ms = new MemoryStream();
        readonly Stack<short> lastIds = new Stack<short>();
        short last;

        public byte[] ToArray() { return ms.ToArray(); }
        void Byte(int b) { ms.WriteByte((byte)b); }
        void Varint(ulong v) { while (v >= 0x80) { Byte((int)(v & 0x7f) | 0x80); v >>= 7; } Byte((int)v); }
        void Zig(long v) { Varint((ulong)((v << 1) ^ (v >> 63))); }
        void Header(short id, int type)
        {
            int d = id - last;
            if (d > 0 && d <= 15) Byte((d << 4) | type); else { Byte(type); Zig(id); }
            last = id;
        }
        public ThriftWriter Byte8(short id, int v) { Header(id, 3); Byte(v); return this; }
        public ThriftWriter I32(short id, long v) { Header(id, 5); Zig(v); return this; }
        public ThriftWriter I64(short id, long v) { Header(id, 6); Zig(v); return this; }
        public ThriftWriter Bool(short id, bool v) { Header(id, v ? 1 : 2); return this; }
        public ThriftWriter Bin(short id, byte[] v) { Header(id, 8); Varint((ulong)v.Length); ms.Write(v, 0, v.Length); return this; }
        public ThriftWriter Str(short id, string v) { return Bin(id, Encoding.UTF8.GetBytes(v)); }
        public ThriftWriter Begin(short id) { Header(id, 12); lastIds.Push(last); last = 0; return this; }
        public ThriftWriter End() { Byte(0); last = lastIds.Count > 0 ? lastIds.Pop() : (short)0; return this; }
        // List of structs: call ListBegin, then for each element BeginElem ... End.
        public ThriftWriter ListBegin(short id, int count, int elemType)
        {
            Header(id, 9);
            if (count < 15) Byte((count << 4) | elemType); else { Byte(0xf0 | elemType); Varint((ulong)count); }
            return this;
        }
        public ThriftWriter BeginElem() { lastIds.Push(last); last = 0; return this; }
        public ThriftWriter I32Elem(long v) { Zig(v); return this; }
        public ThriftWriter StrElem(string v) { byte[] b = Encoding.UTF8.GetBytes(v); Varint((ulong)b.Length); ms.Write(b, 0, b.Length); return this; }
        public ThriftWriter StructEnd() { Byte(0); return this; }   // end of the top-level struct
    }
}
