// Minimal PowerPoint writer: one 16:9 slide with one full-slide picture. No libraries (store-only ZIP).
// Global: Pptx.
//   const blob = Pptx.imageSlide(pngBytes)   (Uint8Array of a PNG) -> Blob (.pptx)
const Pptx = (() => {
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  // files: [[name, Uint8Array]] -> Blob (ZIP, stored, no compression).
  function zip(files) {
    const enc = new TextEncoder(), parts = [], dir = [];
    let off = 0;
    for (const [name, data] of files) {
      const n = enc.encode(name), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, n.length, true);
      parts.push(h, n, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
      dir.push(c, n);
      off += 30 + n.length + data.length;
    }
    const size = dir.reduce((s, p) => s + p.byteLength, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...dir, e], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  }

  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const rels = list => X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}${type}" Target="${target}"/>`).join('') + '</Relationships>';
  const CT = 'application/vnd.openxmlformats-officedocument.';
  const tree = inner => `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:spTree></p:cSld>`;
  const W = 12192000, H = 6858000;   // 13.333 x 7.5 in (16:9)
  const clr = (n, v) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  const THEME = X + `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Data Noodler"><a:themeElements>` +
    `<a:clrScheme name="DN">${clr('dk1', '000000')}${clr('lt1', 'FFFFFF')}${clr('dk2', '1A1A19')}${clr('lt2', 'F4F4F2')}${clr('accent1', '3987E5')}${clr('accent2', 'D95926')}${clr('accent3', '199E70')}${clr('accent4', 'C9A227')}${clr('accent5', '9B6BD6')}${clr('accent6', 'D6529A')}${clr('hlink', '3987E5')}${clr('folHlink', '9B6BD6')}</a:clrScheme>` +
    `<a:fontScheme name="DN"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="DN"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst>` +
    `<a:lnStyleLst>${'<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

  function imageSlide(png) {
    const enc = s => new TextEncoder().encode(s);
    const files = [
      ['[Content_Types].xml', X + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
        `<Override PartName="/ppt/presentation.xml" ContentType="${CT}presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}presentationml.slideMaster+xml"/>` +
        `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="${CT}presentationml.slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="${CT}theme+xml"/></Types>`],
      ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
      ['ppt/presentation.xml', X + `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="${H}" cy="${W}"/></p:presentation>`],
      ['ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'theme', 'theme/theme1.xml']])],
      ['ppt/slideMasters/slideMaster1.xml', X + `<p:sldMaster ${NS}>${tree('')}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`],
      ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']])],
      ['ppt/slideLayouts/slideLayout1.xml', X + `<p:sldLayout ${NS} type="blank" preserve="1">${tree('').replace('<p:cSld>', '<p:cSld name="Blank">')}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
      ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])],
      ['ppt/slides/slide1.xml', X + `<p:sld ${NS}>${tree(`<p:pic><p:nvPicPr><p:cNvPr id="2" name="Dashboard"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`],
      ['ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', '../media/image1.png']])],
      ['ppt/theme/theme1.xml', THEME],
    ].map(([n, s]) => [n, enc(s)]);
    files.push(['ppt/media/image1.png', png]);
    return zip(files);
  }
  return { imageSlide };
})();
