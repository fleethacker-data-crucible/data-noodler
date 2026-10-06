using System;
using System.Collections.Generic;

namespace NativeDataEngine
{
    // Growable column: append values, then ToColumn(). Used by readers, aggregates and joins.
    public sealed class ColumnBuilder
    {
        public readonly DataType Type;
        long[] i; double[] f; string[] s; bool[] b; bool[] nulls;
        int n; bool anyNull;

        public ColumnBuilder(DataType t, int capacity)
        {
            Type = t; capacity = Math.Max(4, capacity);
            if (t.UsesI) i = new long[capacity]; else if (t.UsesF) f = new double[capacity]; else if (t.Kind == Kind.String) s = new string[capacity]; else if (t.Kind == Kind.Bool) b = new bool[capacity];
            nulls = new bool[capacity];
        }
        public int Count { get { return n; } }
        void Grow()
        {
            int cap = nulls.Length * 2;
            if (i != null) Array.Resize(ref i, cap); if (f != null) Array.Resize(ref f, cap); if (s != null) Array.Resize(ref s, cap); if (b != null) Array.Resize(ref b, cap);
            Array.Resize(ref nulls, cap);
        }
        public void AddNull() { if (n == nulls.Length) Grow(); nulls[n++] = true; anyNull = true; }
        public void AddLong(long v) { if (n == nulls.Length) Grow(); i[n++] = v; }
        public void AddDouble(double v) { if (n == nulls.Length) Grow(); f[n++] = v; }
        public void AddString(string v) { if (v == null) { AddNull(); return; } if (n == nulls.Length) Grow(); s[n++] = v; }
        public void AddBool(bool v) { if (n == nulls.Length) Grow(); b[n++] = v; }
        public void Add(Column c, int k)
        {
            if (c.IsNull(k) || c.Type.Kind == Kind.Null) { AddNull(); return; }
            if (n == nulls.Length) Grow();
            if (i != null) i[n] = c.I != null ? c.I[k] : (long)c.F[k];
            else if (f != null) f[n] = c.F != null ? c.F[k] : c.I[k];
            else if (s != null) s[n] = c.S != null ? c.S[k] : Values.Text(c, k);
            else if (b != null) b[n] = c.B[k];
            n++;
        }
        public void AddObj(object v)
        {
            if (v == null) { AddNull(); return; }
            if (i != null) AddLong(Convert.ToInt64(v)); else if (f != null) AddDouble(Convert.ToDouble(v)); else if (s != null) AddString(v as string ?? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)); else if (b != null) AddBool((bool)v); else AddNull();
        }
        // A copy of the values so far; the builder stays usable for more Adds.
        public Column ToColumn()
        {
            Column c = new Column(Type, 0);
            c.Length = n;
            if (i != null) { c.I = new long[n]; Array.Copy(i, c.I, n); }
            if (f != null) { c.F = new double[n]; Array.Copy(f, c.F, n); }
            if (s != null) { c.S = new string[n]; Array.Copy(s, c.S, n); }
            if (b != null) { c.B = new bool[n]; Array.Copy(b, c.B, n); }
            if (anyNull || Type.Kind == Kind.Null) { c.Nulls = new bool[n]; Array.Copy(nulls, c.Nulls, n); }
            else c.Nulls = null;
            if (Type.Kind == Kind.Null) for (int k = 0; k < n; k++) c.Nulls[k] = true;
            return c;
        }
        public long Bytes { get { return nulls.Length * 9L + (s != null ? nulls.Length * 32L : 0); } }
    }
}
