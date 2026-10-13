// Keeps the engine from filling system RAM.
//  - Budget (live): what the engine holds now + free physical RAM - MinFree (EngineOptions.FreeFloorBytes, default 1 GB,
//    always left to the system), capped by EngineOptions.MemoryLimitBytes when set (and 1.2 GB in a 32-bit process).
//    Blocking operators (sort, hash join build, hash aggregate, window, in-memory tables) reserve what they hold after
//    allocating it; free RAM under the floor (after a GC) fails with QUERY_OUT_OF_MEMORY, which makes the operator
//    spill to disk (Query/Spill.cs) when spilling is on, instead of paging the machine to death.
//  - Floor: while free physical RAM is under MinFree, parallel readers stop starting new work and the engine's monitor
//    (DataEngine) drops resident datasets, least recently used first.
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

        public const long FreeFloor = 1024L * 1024 * 1024;   // default free physical RAM always left to the system (EngineOptions.FreeFloorBytes)
        public readonly long TotalPhys;
        public long MinFree;   // free RAM kept for the system (changed live by DataEngine.SetMemory)
        private readonly long cap;   // fixed upper limit (0 = none)
        private long reserved;

        public MemoryGuard(EngineOptions o)
        {
            TotalPhys = (long)Status().ullTotalPhys;
            MinFree = o.FreeFloorBytes > 0 ? o.FreeFloorBytes : FreeFloor;
            cap = o.MemoryLimitBytes > 0 ? o.MemoryLimitBytes : 0;
            if (!Environment.Is64BitProcess) cap = cap > 0 ? Math.Min(cap, 1200L * 1024 * 1024) : 1200L * 1024 * 1024;
        }

        private static MEMORYSTATUSEX Status() { MEMORYSTATUSEX m = new MEMORYSTATUSEX(); GlobalMemoryStatusEx(m); return m; }
        public long AvailPhys { get { return (long)Status().ullAvailPhys; } }
        public long Reserved { get { return Interlocked.Read(ref reserved); } }
        public long Managed { get { return GC.GetTotalMemory(false); } }
        // What the engine may hold right now: what it holds + free RAM above the floor (re-read on every call).
        public long Budget { get { long b = Reserved + Math.Max(0, AvailPhys - MinFree); return cap > 0 ? Math.Min(cap, b) : b; } }
        public bool LowRam { get { return AvailPhys < MinFree; } }

        public bool RoomForMore() { return !LowRam && Managed < Budget; }

        bool Over(long held) { return LowRam || (cap > 0 && held > cap); }

        // Reserve bytes held by a blocking operator. Throws when free RAM is under the floor (or the cap is passed).
        public void Reserve(long bytes, string what)
        {
            long now = Interlocked.Add(ref reserved, bytes);
            if (Over(now))
            {
                GC.Collect();
                if (Over(Interlocked.Read(ref reserved)))
                {
                    Interlocked.Add(ref reserved, -bytes);
                    throw new EngineException("QUERY_OUT_OF_MEMORY", what + " needs more memory than the engine may use (" + Mb(Budget) +
                        " budget, " + Mb(AvailPhys) + " free, " + Mb(MinFree) + " kept for the system). Filter or aggregate the data first, or add a LIMIT.", 507);
                }
            }
        }
        public void Release(long bytes) { Interlocked.Add(ref reserved, -bytes); }
        public static string Mb(long b) { return (b / 1048576).ToString("N0") + " MB"; }
    }

    // A reservation that is released when disposed (end of a query or operator).
    public sealed class MemoryLease : IDisposable
    {
        private readonly MemoryGuard g; private long held; private readonly string what; private bool closed;
        public MemoryLease(MemoryGuard g, string what) { this.g = g; this.what = what; }
        // After Dispose, Add does nothing (work still finishing on a worker after its query gave up must not hold memory).
        public void Add(long bytes) { lock (this) { if (closed) return; g.Reserve(bytes, what); held += bytes; } }
        public void Dispose() { lock (this) { closed = true; if (held != 0) { g.Release(held); held = 0; } } }
    }
}
