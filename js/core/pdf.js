// Minimal PDF writer: one page holding one full-page JPEG. No libraries.
// Global: Pdf.
//   const blob = Pdf.imagePage(jpegBytes, widthPx, heightPx)   (Uint8Array of a JPEG) -> Blob (.pdf)
//   The page is the picture's size at 96 dpi (1 px = 0.75 pt).
const Pdf = (() => {
  function imagePage(jpg, w, h) {
    const enc = new TextEncoder(), W = +(w * 0.75).toFixed(2), H = +(h * 0.75).toFixed(2);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, '\nendstream'],
    ];
    const parts = [], offs = [];
    let len = 0;
    const add = p => { const b = typeof p === 'string' ? enc.encode(p) : p; parts.push(b); len += b.length; };
    add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'.replace(/[\x80-\xFF]/g, '~'));
    objs.forEach((o, i) => { offs.push(len); add(`${i + 1} 0 obj\n`); (Array.isArray(o) ? o : [o]).forEach(add); add('\nendobj\n'); });
    const xref = len;
    add(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`);
    add(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }
  return { imagePage };
})();
