// One compiled engine, many worker threads: min(MaxWorkers (64), logical cores).
// Only leaf work runs here (read a row group, encode a row group, partial aggregate); coordinators never block a worker.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;

namespace NativeDataEngine
{
    public sealed class WorkItem
    {
        public readonly string Id;
        public readonly Action Action;
        public WorkItem(string id, Action action) { Id = id; Action = action; }
    }

    // Result of one submitted work item.
    public sealed class Work<T>
    {
        private readonly ManualResetEventSlim done = new ManualResetEventSlim(false);
        private T value; private Exception error;
        internal void Set(T v) { value = v; done.Set(); }
        internal void Fail(Exception e) { error = e; done.Set(); }
        public bool IsDone { get { return done.IsSet; } }
        public T Wait(CancellationToken ct)
        {
            done.Wait(ct);
            if (error != null) throw new AggregateException(error);
            return value;
        }
    }

    public sealed class WorkerPool : IDisposable
    {
        private readonly BlockingCollection<WorkItem> queue;
        private readonly List<Thread> threads;
        private volatile bool disposed;
        private int busy;
        [ThreadStatic] private static bool onWorker;   // true on pool threads: nested parallel work runs inline (no deadlock)
        public static bool OnWorker { get { return onWorker; } }

        public int WorkerCount { get { return threads.Count; } }
        public int Busy { get { return busy; } }
        public int Queued { get { return queue.Count; } }

        public WorkerPool(int workerCount)
        {
            if (workerCount < 1) throw new ArgumentOutOfRangeException("workerCount");
            queue = new BlockingCollection<WorkItem>(new ConcurrentQueue<WorkItem>());
            threads = new List<Thread>(workerCount);
            for (int i = 0; i < workerCount; i++)
            {
                Thread t = new Thread(Loop);
                t.IsBackground = true;
                t.Name = "DataWorker-" + i;
                threads.Add(t);
                t.Start();
            }
        }

        public void Enqueue(WorkItem item)
        {
            if (disposed) throw new ObjectDisposedException("WorkerPool");
            queue.Add(item);
        }

        public Work<T> Submit<T>(Func<T> fn)
        {
            Work<T> w = new Work<T>();
            Enqueue(new WorkItem(null, () =>
            {
                try { w.Set(fn()); }
                catch (Exception e) { w.Fail(e); }
            }));
            return w;
        }

        private void Loop()
        {
            onWorker = true;
            foreach (WorkItem item in queue.GetConsumingEnumerable())
            {
                Interlocked.Increment(ref busy);
                try { item.Action(); }
                catch (Exception e) { EngineLog.Write("err", "Worker: " + e.Message); }
                finally { Interlocked.Decrement(ref busy); }
            }
        }

        // Runs fn(0..count-1) on the pool, at most maxParallel at a time, and hands back results in order
        // (deterministic regardless of worker count). Bounded: never more than maxParallel results waiting.
        public IEnumerable<T> Ordered<T>(int count, int maxParallel, Func<int, T> fn, CancellationToken ct, MemoryGuard mem)
        {
            if (maxParallel < 1) maxParallel = 1;
            if (onWorker)
            {
                // Already on a worker (nested parallel work): run here, in order. Waiting on the pool from a
                // worker could deadlock when every worker is waiting.
                for (int k = 0; k < count; k++) { ct.ThrowIfCancellationRequested(); yield return fn(k); }
                yield break;
            }
            // Abandoned early (LIMIT, error, cancel): items already running finish in the background.
            Queue<Work<T>> inflight = new Queue<Work<T>>();
            int next = 0;
            while (next < count || inflight.Count > 0)
            {
                while (next < count && inflight.Count < maxParallel)
                {
                    ct.ThrowIfCancellationRequested();
                    if (mem != null && inflight.Count > 0 && !mem.RoomForMore()) break;   // RAM is short: let running work finish first
                    int k = next++;
                    inflight.Enqueue(Submit(() => fn(k)));
                }
                yield return inflight.Dequeue().Wait(ct);
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            queue.CompleteAdding();
            foreach (Thread t in threads) t.Join(2000);
        }
    }
}
