// Engine worker lights (#lights): one per engine worker, green = idle, blue = reading / computing, red = writing.
// Polled every 150 ms while the window is visible; threads outside the pool that are writing light idle slots red.
// Used by Import and Transform (the Benchmark page has its own copy). Needs engine-client.js.
(() => {
  let busy = false;
  setInterval(async () => {
    const host = document.getElementById('lights');
    if (!host || busy || document.hidden) return;
    busy = true;
    try {
      const r = await Engine.call('workers');
      const st = r.states.slice(); let extra = r.writers || 0;
      for (let i = 0; i < st.length && extra > 0; i++) if (st[i] === 0) { st[i] = 2; extra--; }
      if (host.children.length !== st.length) host.innerHTML = st.map((_, i) => `<i title="Worker ${i + 1}"></i>`).join('');
      st.forEach((v, i) => { const c = `l${v}`; if (host.children[i].className !== c) host.children[i].className = c; });
    } catch { host.innerHTML = ''; }
    finally { busy = false; }
  }, 150);
})();
