// Live memory graph. Global: MemMonitor. Polls /api/mem (server reads the browser's process memory).
//   const m = MemMonitor.mount(el, { everyMs: 250, windowSec: 120 })
//   m.setLimit(bytes, 'DuckDB limit 12 × 0.8 GB')   dashed limit line (null to hide)
//   m.mark('12 engines: Sort')                      labelled marker at the current time
//   m.resetPeak()
// Lines: this tab (renderer process = page + all engine workers), whole browser, system RAM in use.
const MemMonitor = (() => {
  const GB = 2 ** 30;
  const fmt = b => b >= GB ? (b / GB).toFixed(2) + ' GB' : Math.round(b / 2 ** 20) + ' MB';
  const css = (el, v, d) => getComputedStyle(el).getPropertyValue(v).trim() || d;

  function mount(el, { everyMs = 250, windowSec = 120 } = {}) {
    el.innerHTML = `<div class="legend"><span><i style="background:var(--s1)"></i>This tab <b data-v="tab">-</b></span>
      <span><i style="background:var(--s3)"></i>Browser <b data-v="browser">-</b></span>
      <span><i style="background:var(--s4)"></i>System in use <b data-v="sys">-</b></span>
      <span><i style="background:var(--err)"></i><span data-v="limitLbl">Limit</span> <b data-v="limit">-</b></span>
      <span>Peak tab <b data-v="peak">-</b></span><span class="off" data-v="src"></span></div>
      <canvas style="width:100%;height:220px;display:block"></canvas>`;
    const cv = el.querySelector('canvas'), ctx = cv.getContext('2d'), V = k => el.querySelector(`[data-v="${k}"]`);
    const max = Math.ceil(windowSec * 1000 / everyMs);
    let samples = [], marks = [], limit = null, peak = 0, busy = false, sysTotal = 0, timer;

    async function poll() {
      if (busy) return; busy = true;
      try {
        const r = await fetch('/api/mem', { headers: { 'X-DN-Token': window.DN_TOKEN }, cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        sysTotal = j.sysTotal; peak = Math.max(peak, j.tab);
        samples.push({ t: performance.now(), tab: j.tab, browser: j.browser, sys: j.sysTotal - j.sysFree });
        if (samples.length > max) samples.shift();
        V('tab').textContent = fmt(j.tab); V('browser').textContent = fmt(j.browser);
        V('sys').textContent = `${fmt(j.sysTotal - j.sysFree)} / ${fmt(j.sysTotal)}`; V('peak').textContent = fmt(peak);
        V('src').textContent = `(${j.source})`;
      } catch { V('src').textContent = '(no data: is the server running?)'; }
      finally { busy = false; draw(); }
    }

    function draw() {
      const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1;
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const L = 56, R = 8, T = 8, B = 18, pw = w - L - R, ph = h - T - B;
      const now = performance.now(), t0 = now - windowSec * 1000;
      const top = Math.max(GB, limit || 0, ...samples.map(s => Math.max(s.tab, s.browser, s.sys))) * 1.1;
      const x = t => L + (t - t0) / (windowSec * 1000) * pw, y = b => T + ph - b / top * ph;
      const grid = css(el, '--border', '#444'), txt = css(el, '--text-2', '#aaa');
      ctx.font = '11px "Exo 2", system-ui'; ctx.lineWidth = 1;
      const step = top > 16 * GB ? 4 * GB : top > 6 * GB ? 2 * GB : top > 2 * GB ? GB : GB / 4;
      for (let b = 0; b <= top; b += step) {
        ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(L, y(b)); ctx.lineTo(w - R, y(b)); ctx.stroke();
        ctx.fillStyle = txt; ctx.textAlign = 'right'; ctx.fillText(fmt(b), L - 6, y(b) + 4);
      }
      ctx.textAlign = 'left'; ctx.fillText(`last ${windowSec} s`, L, h - 4);
      let lastX = -1e9; // labels only where there is room
      for (const m of marks.filter(m => m.t > t0)) {
        ctx.strokeStyle = grid; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x(m.t), T); ctx.lineTo(x(m.t), T + ph); ctx.stroke();
        ctx.setLineDash([]);
        if (x(m.t) - lastX > ctx.measureText(m.text).width + 8) { ctx.fillStyle = txt; ctx.fillText(m.text, x(m.t) + 3, T + 11); lastX = x(m.t); }
      }
      if (!samples.length) { ctx.fillStyle = txt; ctx.textAlign = 'center'; ctx.fillText('Waiting for memory data: restart the server to enable /api/mem', L + pw / 2, T + ph / 2); ctx.textAlign = 'left'; }
      if (limit) {
        ctx.strokeStyle = css(el, '--err', '#f66'); ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(L, y(limit)); ctx.lineTo(w - R, y(limit)); ctx.stroke(); ctx.setLineDash([]);
      }
      for (const [k, c] of [['sys', '--s4'], ['browser', '--s3'], ['tab', '--s1']]) {
        ctx.strokeStyle = css(el, c, '#39f'); ctx.lineWidth = k === 'tab' ? 2 : 1.5; ctx.beginPath();
        samples.filter(s => s.t >= t0).forEach((s, i) => i ? ctx.lineTo(x(s.t), y(s[k])) : ctx.moveTo(x(s.t), y(s[k])));
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }

    timer = setInterval(poll, everyMs); poll();
    addEventListener('resize', draw);
    return {
      setLimit(bytes, label = 'Limit') { limit = bytes || null; V('limit').textContent = limit ? fmt(limit) : '-'; V('limitLbl').textContent = label; draw(); },
      mark(text) { marks.push({ t: performance.now(), text }); if (marks.length > 200) marks.shift(); },
      resetPeak() { peak = 0; },
      get peak() { return peak; },
      get sysTotal() { return sysTotal; },
      stop() { clearInterval(timer); },
    };
  }
  return { mount, fmt };
})();
