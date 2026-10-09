// Icons: every inline SVG icon the site uses, in one place (no links, no files to load).
//   Icons.svg(name, cls)  -> '<svg ...>' for an icon below (cls = optional class on the <svg>); 1em square, coloured by
//                            currentColor (size / colour come from the page's CSS)
//   Icons.caret(open, cls) -> expand/collapse arrow: caret-right when shut, caret-down when open (both drawn, CSS shows one:
//                            css/theme.css .dn-caret; open = the span's own "open" class, or an ".open" grandparent / <details open>)
const Icons = (() => {
  // name -> [viewBox size, path]
  const PATHS = {
    'caret-down': [32, 'm24 12l-8 10l-8-10z'],
    'caret-right': [32, 'm12 8l10 8l-10 8z'],
    'x-circle': [24, 'M19.07 19.07c3.9-3.9 3.9-10.24 0-14.14C17.18 3.04 14.67 2 12 2S6.82 3.04 4.93 4.93c-3.9 3.9-3.9 10.24 0 14.14c1.95 1.95 4.51 2.92 7.07 2.92s5.12-.98 7.07-2.92M7.76 14.83L10.59 12L7.76 9.17l1.41-1.41L12 10.59l2.83-2.83l1.41 1.41L13.41 12l2.83 2.83l-1.41 1.41L12 13.41l-2.83 2.83z'],
    'eye': [24, 'M12 19c7.63 0 9.93-6.62 9.95-6.68c.07-.21.07-.43 0-.63c-.02-.07-2.32-6.68-9.95-6.68s-9.93 6.61-9.95 6.67c-.07.21-.07.43 0 .63c.02.07 2.32 6.68 9.95 6.68Zm0-10c1.64 0 3 1.36 3 3s-1.36 3-3 3s-3-1.36-3-3s1.36-3 3-3'],
    'eye-slash': [24, 'M2.05 11.68c-.07.21-.07.43 0 .63c.02.07 2.32 6.68 9.95 6.68c.91 0 1.73-.1 2.49-.26L4.13 8.37c-1.49 1.65-2.06 3.28-2.08 3.31m19.9.64c.07-.21.07-.43 0-.63c-.02-.07-2.32-6.68-9.95-6.68c-1.84 0-3.36.39-4.61.97L2.71 1.29L1.3 2.7l4.32 4.32l3.69 3.69l3.98 3.98l3.33 3.33l4.68 4.68l1.41-1.41l-4.32-4.32c2.61-1.95 3.55-4.61 3.56-4.65M12 9c1.64 0 3 1.36 3 3c0 .46-.11.89-.3 1.29l-3.98-3.98c.39-.19.83-.3 1.29-.3Z'],
  };
  const svg = (name, cls) => { const [box, d] = PATHS[name]; return `<svg${cls ? ` class="${cls}"` : ''} width="1em" height="1em" viewBox="0 0 ${box} ${box}"><path fill="currentColor" d="${d}"/></svg>`; };
  const caret = (open, cls) => `<span class="dn-caret${cls ? ' ' + cls : ''}${open ? ' open' : ''}">${svg('caret-right', 'c-shut')}${svg('caret-down', 'c-open')}</span>`;
  return { PATHS, svg, caret };
})();
