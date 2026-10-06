// Keeps the engine from filling system RAM.
//  - Budget: min(EngineOptions.MemoryLimitBytes, MemoryFraction of physical RAM). Blocking operators (sort, hash join
//    build, hash aggregate, window, in-memory tables) reserve what they hold; going over the budget fails the query with
//    QUERY_OUT_OF_MEMORY instead of paging the machine to death.
//  - Floor: when free physical RAM drops below MinFreeBytes, parallel readers stop starting new work until it recovers.
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace NativeDataEngine
{
    public sealed class MemoryGuard
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private class MEMORYSTATUSEX
        {
            public uint dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
            public uint dwMemoryLoad;
            public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX buffer);

        public readonly long TotalPhys;
        public readonly long Budget;
        public readonly long MinFree;
        private long reserved;

        public MemoryGuard(EngineOptions o)
        {
            TotalPhys = (long)Status().ullTotalPhys;
            long byFraction = (long)(TotalPhys * Math.Max(0.1, Math.Min(0.9, o.MemoryFraction)));
            Budget = o.MemoryLimitBytes > 0 ? Math.Min(o.MemoryLimitBytes, byFraction) : byFraction;
            if (!Environment.Is64BitProcess) Budget = Math.Min(Budget, 1200L * 1024 * 1024);
            MinFree = Math.Max(512L * 1024 * 1024, TotalPhys / 10);
        }

        private static MEMORYSTATUSEX Status() { MEMORYSTATUSEX m = new MEMORYSTATUSEX(); GlobalMemoryStatusEx(m); return m; }
        public long AvailPhys { get { return (long)Status().ullAvailPhys; } }
        public long Reserved { get { return Interlocked.Read(ref reserved); } }
        public long Managed { get { return GC.GetTotalMemory(false); } }

        public bool RoomForMore() { return AvailPhys > MinFree && Managed < Budget; }

        public void WaitForRoom(CancellationToken ct)
        {
            for (int i = 0; i < 300 && !RoomForMore(); i++)
            {
                ct.ThrowIfCancellationRequested();
                if (i == 10) GC.Collect();
                Thread.Sleep(100);
            }
        }

        // Reserve bytes held by a blocking operator. Throws when the budget or free RAM would be exceeded.
        public void Reserve(long bytes, string what)
        {
            long now = Interlocked.Add(ref reserved, bytes);
            if (now > Budget || AvailPhys < MinFree / 2)
            {
                if (AvailPhys < MinFree) { GC.Collect(); }
                if (Interlocked.Read(ref reserved) > Budget || AvailPhys < MinFree / 2)
                {
                    Interlocked.Add(ref reserved, -bytes);
                    throw new EngineException("QUERY_OUT_OF_MEMORY", what + " needs more memory than the engine may use (" + Mb(Budget) +
                        " budget, " + Mb(AvailPhys) + " free). Filter or aggregate the data first, or add a LIMIT.", 507);
                }
            }
        }
        public void Release(long bytes) { Interlocked.Add(ref reserved, -bytes); }
        public static string Mb(long b) { return (b / 1048576).ToString("N0") + " MB"; }
    }

    // A reservation that is released when disposed (end of a query or operator).
    public sealed class MemoryLease : IDisposable
    {
        private readonly MemoryGuard g; private long held; private readonly string what;
        public MemoryLease(MemoryGuard g, string what) { this.g = g; this.what = what; }
        public void Add(long bytes) { g.Reserve(bytes, what); held += bytes; }
        public void Dispose() { if (held != 0) { g.Release(held); held = 0; } }
    }
}
