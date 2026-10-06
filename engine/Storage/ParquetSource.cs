// A logical dataset (one or more Parquet files) as a splittable source: one unit per row group.
// Reads only the columns the query needs (SetNeeded, from Optimizer.Prune); the rest stay empty placeholders.
using System;
using System.Collections.Generic;

namespace NativeDataEngine
{
    public sealed class ParquetSource : Source
    {
        public readonly List<string> Files;
        HashSet<int> needed;   // null = all
        List<int[]> units;     // {file index, row group}
        readonly object gate = new object();

        public ParquetSource(List<string> files)
        {
            if (files.Count == 0) throw new EngineException("DATASET_EMPTY", "No Parquet files to read.");
            Files = files;
            Schema = PqMeta.Open(files[0]).Schema;
        }
        public void SetNeeded(HashSet<int> cols) { needed = cols; }

        public override int Units(ExecCtx ctx)
        {
            lock (gate)
            {
                if (units == null)
                {
                    List<int[]> u = new List<int[]>();
                    for (int f = 0; f < Files.Count; f++)
                    {
                        PqMeta m = PqMeta.Open(Files[f]);
                        for (int g = 0; g < m.RowGroups.Count; g++) u.Add(new[] { f, g });
                    }
                    units = u;
                }
                return units.Count;
            }
        }
        public override long KnownRows(ExecCtx ctx)
        {
            long n = 0;
            foreach (string f in Files) n += PqMeta.Open(f).Rows;
            return n;
        }
        public override IEnumerable<Batch> RunUnit(ExecCtx ctx, int unit)
        {
            Units(ctx);
            int[] u = units[unit];
            PqMeta m = PqMeta.Open(Files[u[0]]);
            List<int> read = new List<int>(); List<int> at = new List<int>();
            List<Field> fs = new List<Field>();
            Column[] outCols = new Column[Schema.Count];
            int rows = (int)m.GroupRows[u[1]];
            for (int c = 0; c < Schema.Count; c++)
            {
                if (needed != null && !needed.Contains(c)) { outCols[c] = Placeholder(Schema[c].Type, rows); continue; }
                int src = -1;
                for (int k = 0; k < m.Columns.Count; k++) if (string.Equals(m.Columns[k].Name, Schema[c].Name, StringComparison.OrdinalIgnoreCase)) { src = k; break; }
                if (src < 0) { Column nc = new Column(Schema[c].Type, rows); for (int i = 0; i < rows; i++) nc.SetNull(i); outCols[c] = nc; continue; }
                read.Add(src); at.Add(c); fs.Add(new Field(m.Columns[src].Name, m.Columns[src].Type));
            }
            if (read.Count > 0)
            {
                Batch b = ParquetReader.ReadRowGroup(m, u[1], read.ToArray(), new Schema(fs));
                for (int k = 0; k < at.Count; k++)
                {
                    Column c = b.Cols[k]; DataType want = Schema[at[k]].Type;
                    if (!c.Type.SameAs(want) && !(c.Type.UsesI && want.UsesI && c.Type.Kind == want.Kind)) c = Cast.To(c, want, true);
                    outCols[at[k]] = c;
                }
            }
            yield return new Batch(Schema, outCols, rows);
        }
        // Column the query never reads: length only, no data.
        static Column Placeholder(DataType t, int rows)
        {
            Column c = new Column(DataType.Null, 0); c.Type = t; c.Length = rows; c.Nulls = null;
            return c;
        }
    }
}
