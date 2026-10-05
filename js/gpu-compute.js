// Column maths on the GPU with WebGPU (built into Chrome/Edge, nothing to install). Global: GpuCompute.
// Columns are uploaded once as typed arrays and stay on the GPU; each operation runs a compute shader
// and reads back a small array of partial results that JavaScript adds up.
//
// Precision: WebGPU has no 64-bit floats. sumF32 is approximate. For exact money maths, upload values
// as integer cents (Int32Array) and use sumI32 / groupI32: the GPU adds small integer partials that
// cannot overflow, and JavaScript adds those exactly (safe up to 2^53).
const GpuCompute = (() => {
  const WG = 256;          // threads per workgroup
  const MAX_WG = 65535;    // workgroups per dispatch (one dimension)
  const I32_MAX = 2147483647;
  let device, info;
  const cols = new Map();  // name -> { buf, n }
  const pipes = new Map();

  // Every shader: struct P { n, per, g, t }  n = rows, per = rows per thread, g = groups, t = threshold
  const HEAD = `struct P { n: u32, per: u32, g: u32, t: f32 };`;
  const SHADERS = {
    // Workgroup sum of f32 -> one f32 per workgroup.
    sumF32: `${HEAD}
      @group(0) @binding(0) var<storage, read> x: array<f32>;
      @group(0) @binding(1) var<storage, read_write> out: array<f32>;
      @group(0) @binding(2) var<uniform> p: P;
      var<workgroup> sh: array<f32, ${WG}>;
      @compute @workgroup_size(${WG}) fn main(@builtin(local_invocation_id) l: vec3<u32>, @builtin(workgroup_id) w: vec3<u32>) {
        let base = w.x * ${WG}u * p.per + l.x;
        var s: f32 = 0.0;
        for (var k = 0u; k < p.per; k++) { let i = base + k * ${WG}u; if (i < p.n) { s += x[i]; } }
        sh[l.x] = s; workgroupBarrier();
        for (var st = ${WG / 2}u; st > 0u; st >>= 1u) { if (l.x < st) { sh[l.x] += sh[l.x + st]; } workgroupBarrier(); }
        if (l.x == 0u) { out[w.x] = sh[0]; }
      }`,
    // Per-thread sum of i32 (per rows each, chosen so it cannot overflow) -> one i32 per thread.
    sumI32: `${HEAD}
      @group(0) @binding(0) var<storage, read> x: array<i32>;
      @group(0) @binding(1) var<storage, read_write> out: array<i32>;
      @group(0) @binding(2) var<uniform> p: P;
      @compute @workgroup_size(${WG}) fn main(@builtin(local_invocation_id) l: vec3<u32>, @builtin(workgroup_id) w: vec3<u32>) {
        let base = w.x * ${WG}u * p.per + l.x;
        var s: i32 = 0;
        for (var k = 0u; k < p.per; k++) { let i = base + k * ${WG}u; if (i < p.n) { s += x[i]; } }
        out[w.x * ${WG}u + l.x] = s;
      }`,
    // Group sums and counts (up to 64 groups) per workgroup -> [sums(g), counts(g)] per workgroup.
    groupI32: `${HEAD}
      @group(0) @binding(0) var<storage, read> x: array<i32>;
      @group(0) @binding(1) var<storage, read> gi: array<i32>;
      @group(0) @binding(2) var<storage, read_write> out: array<i32>;
      @group(0) @binding(3) var<uniform> p: P;
      var<workgroup> s: array<atomic<i32>, 128>;
      @compute @workgroup_size(${WG}) fn main(@builtin(local_invocation_id) l: vec3<u32>, @builtin(workgroup_id) w: vec3<u32>) {
        if (l.x < 128u) { atomicStore(&s[l.x], 0); }
        workgroupBarrier();
        let base = w.x * ${WG}u * p.per + l.x;
        for (var k = 0u; k < p.per; k++) {
          let i = base + k * ${WG}u;
          if (i < p.n) { let g = u32(gi[i]); atomicAdd(&s[g], x[i]); atomicAdd(&s[64u + g], 1); }
        }
        workgroupBarrier();
        if (l.x < p.g) { out[w.x * p.g * 2u + l.x] = atomicLoad(&s[l.x]); out[w.x * p.g * 2u + p.g + l.x] = atomicLoad(&s[64u + l.x]); }
      }`,
    // Count of x > t per workgroup.
    countGt: `${HEAD}
      @group(0) @binding(0) var<storage, read> x: array<f32>;
      @group(0) @binding(1) var<storage, read_write> out: array<u32>;
      @group(0) @binding(2) var<uniform> p: P;
      var<workgroup> sh: array<u32, ${WG}>;
      @compute @workgroup_size(${WG}) fn main(@builtin(local_invocation_id) l: vec3<u32>, @builtin(workgroup_id) w: vec3<u32>) {
        let base = w.x * ${WG}u * p.per + l.x;
        var c: u32 = 0u;
        for (var k = 0u; k < p.per; k++) { let i = base + k * ${WG}u; if (i < p.n && x[i] > p.t) { c += 1u; } }
        sh[l.x] = c; workgroupBarrier();
        for (var st = ${WG / 2}u; st > 0u; st >>= 1u) { if (l.x < st) { sh[l.x] += sh[l.x + st]; } workgroupBarrier(); }
        if (l.x == 0u) { out[w.x] = sh[0]; }
      }`,
  };

  const pipe = name => {
    if (!pipes.has(name)) pipes.set(name, device.createComputePipeline({
      layout: 'auto', compute: { module: device.createShaderModule({ code: SHADERS[name] }), entryPoint: 'main' },
    }));
    return pipes.get(name);
  };
  const col = name => { const c = cols.get(name); if (!c) throw new Error(`GPU column '${name}' not uploaded`); return c; };
  // Rows per thread: at least `min`, and enough that the dispatch fits in MAX_WG workgroups.
  const perFor = (n, min = 1) => Math.max(min, Math.ceil(n / (WG * MAX_WG)));

  // One dispatch. inputs = GPU buffers, outLen = 32-bit values to read back, Out = typed array class.
  async function run(name, inputs, n, per, outLen, Out, g = 0, t = 0) {
    const wgs = Math.ceil(n / (WG * per));
    if (wgs > MAX_WG) throw new Error(`too many rows for one dispatch (${n})`);
    const uni = new ArrayBuffer(16), dv = new DataView(uni);
    dv.setUint32(0, n, true); dv.setUint32(4, per, true); dv.setUint32(8, g, true); dv.setFloat32(12, t, true);
    const ub = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(ub, 0, uni);
    const size = Math.max(4, outLen(wgs) * 4);
    const out = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const p = pipe(name);
    const bind = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [
      ...inputs.map((b, i) => ({ binding: i, resource: { buffer: b } })),
      { binding: inputs.length, resource: { buffer: out } },
      { binding: inputs.length + 1, resource: { buffer: ub } },
    ] });
    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(p); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(wgs); pass.end();
    enc.copyBufferToBuffer(out, 0, read, 0, size);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const res = new Out(read.getMappedRange().slice(0));
    read.unmap(); read.destroy(); out.destroy(); ub.destroy();
    return res;
  }
  const timed = async fn => { const t0 = performance.now(); const r = await fn(); return { ...r, ms: performance.now() - t0 }; };

  return {
    // Returns { vendor, architecture, description, maxBuffer } or throws why WebGPU is unavailable.
    async init() {
      if (device) return info;
      if (!navigator.gpu) throw new Error('WebGPU is not available in this browser (navigator.gpu missing; may be disabled by policy).');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No GPU adapter (WebGPU blocked, or no supported GPU/driver).');
      const L = adapter.limits;
      device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize } });
      const a = adapter.info || {};
      info = { vendor: a.vendor || '?', architecture: a.architecture || '', description: a.description || '', maxBuffer: Math.min(L.maxStorageBufferBindingSize, L.maxBufferSize) };
      return info;
    },
    get info() { return info; },

    // Copy a typed array (Float32Array / Int32Array) to the GPU under a name. Returns { ms }.
    async upload(name, arr) {
      if (arr.byteLength > info.maxBuffer) throw new Error(`${name}: ${(arr.byteLength / 1048576).toFixed(0)} MB is over the GPU buffer limit (${(info.maxBuffer / 1048576).toFixed(0)} MB)`);
      const t0 = performance.now();
      cols.get(name)?.buf.destroy();
      const buf = device.createBuffer({ size: Math.ceil(arr.byteLength / 4) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, arr);
      await device.queue.onSubmittedWorkDone();
      cols.set(name, { buf, n: arr.length });
      return { ms: performance.now() - t0 };
    },
    drop(name) { cols.get(name)?.buf.destroy(); cols.delete(name); },

    // Approximate sum of an f32 column (32-bit float maths). { value, ms }
    sumF32: name => timed(async () => {
      const c = col(name), r = await run('sumF32', [c.buf], c.n, perFor(c.n, 16), w => w, Float32Array);
      let s = 0; for (const v of r) s += v; return { value: s };
    }),
    // Exact sum of an i32 column. maxAbs = largest |value| (sets rows per thread so nothing overflows). { value, ms }
    sumI32: (name, maxAbs) => timed(async () => {
      const c = col(name), per = perFor(c.n, Math.max(1, Math.min(64, Math.floor(I32_MAX / Math.max(1, maxAbs)))));
      if (per * maxAbs > I32_MAX) throw new Error('values too large for exact GPU sum');
      const r = await run('sumI32', [c.buf], c.n, per, w => w * WG, Int32Array);
      let s = 0; for (const v of r) s += v; return { value: s };
    }),
    // Exact per-group sums and counts. groups = i32 column of 0..G-1 (G <= 64). { sums: [], counts: [], ms }
    groupI32: (name, groupName, G, maxAbs) => timed(async () => {
      if (G > 64) throw new Error('GPU group-by supports up to 64 groups');
      const c = col(name), gc = col(groupName);
      const per = Math.max(1, Math.min(16, Math.floor(I32_MAX / (WG * Math.max(1, maxAbs)))));
      if (perFor(c.n, per) !== per) throw new Error('too many rows for exact GPU group-by in one dispatch');
      const r = await run('groupI32', [c.buf, gc.buf], c.n, per, w => w * G * 2, Int32Array, G);
      const sums = Array(G).fill(0), counts = Array(G).fill(0);
      for (let w = 0; w < r.length; w += G * 2) for (let k = 0; k < G; k++) { sums[k] += r[w + k]; counts[k] += r[w + G + k]; }
      return { sums, counts };
    }),
    // Count of f32 values > t. { value, ms }
    countGreater: (name, t) => timed(async () => {
      const c = col(name), r = await run('countGt', [c.buf], c.n, perFor(c.n, 16), w => w, Uint32Array, 0, t);
      let s = 0; for (const v of r) s += v; return { value: s };
    }),
  };
})();
