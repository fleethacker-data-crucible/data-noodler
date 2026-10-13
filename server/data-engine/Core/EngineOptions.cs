using System;
using System.Collections.Concurrent;

namespace NativeDataEngine
{
    public sealed class EngineOptions
    {
        public string RootPath;                 // project root: every project path is relative to it
        public string WorkspacePath;            // engine temp/cache folder (inside the root)
        public int MaxWorkers;                  // hard cap 64; actual = min(this, logical cores)
        public int BatchRowCount;               // rows per in-memory batch / Parquet row group
        public long MemoryLimitBytes;           // fixed cap on the engine's memory (0 = none: free RAM above FreeFloorBytes, see MemoryGuard)
        public long FreeFloorBytes;             // free physical RAM always left to the system (default 1 GB)
        public bool SpillToDisk;                // work that does not fit in memory goes to Arrow files under temp\spill (default on)
        public long PartBytes;                  // a part file also closes at this size
        public long PartRows;                   // rows per Parquet part file (global: 2M)
        public int MaxResultRows;               // rows returned to the browser per query
        public string DatasetFormat;            // dataset parts on disk: "arrow" (working format) or "parquet"
        public double ResidentFraction;        // share of the memory budget project datasets may hold in RAM (0 = off)

        public EngineOptions()
        {
            MaxWorkers = 64;
            BatchRowCount = 100000;
            MemoryLimitBytes = 0;
            FreeFloorBytes = 1024L * 1024 * 1024;
            SpillToDisk = true;
            PartBytes = 2L * 1024 * 1024 * 1024;
            PartRows = 2000000;
            MaxResultRows = 200000;
            ResidentFraction = 0.6;
            DatasetFormat = "arrow";
        }
    }

    // Engine log lines, drained by the PowerShell host into the server log.
    public static class EngineLog
    {
        public static readonly ConcurrentQueue<string[]> Lines = new ConcurrentQueue<string[]>();
        public static void Write(string kind, string text)
        {
            Lines.Enqueue(new[] { kind, text });
            string[] dummy;
            while (Lines.Count > 5000) Lines.TryDequeue(out dummy);
        }
        // For PowerShell: next line as "kind|text", or null.
        public static string Next()
        {
            string[] l;
            return Lines.TryDequeue(out l) ? l[0] + "|" + l[1] : null;
        }
    }
}
