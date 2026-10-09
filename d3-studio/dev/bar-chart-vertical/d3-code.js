// Bar chart. data = rows ({ x, y }: d.x = X Axis, d.y = Y Axis), el = the box, W x H = its size in px, colors = the 8 chart colours.
const margin = { top: 12, right: 12, bottom: 28, left: 44 };
const x = d3.scaleBand().domain(data.map(d => d.x)).range([margin.left, W - margin.right]).padding(0.2);
const y = d3.scaleLinear().domain([0, d3.max(data, d => d.y) || 1]).nice().range([H - margin.bottom, margin.top]);

const svg = d3.create('svg').attr('viewBox', [0, 0, W, H]);
// Dotted grid lines, each switched on / off in the widget settings (Settings: opts.grid.y = horizontal, opts.grid.x = vertical).
const dotted = g => g.call(g => g.select('.domain').remove()).selectAll('line').attr('stroke', theme.muted).attr('stroke-opacity', 0.6).attr('stroke-dasharray', '2,3');
if (opts.grid?.y) svg.append('g').attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(W - margin.left - margin.right)).tickFormat('')).call(dotted);
if (opts.grid?.x) svg.append('g').attr('transform', `translate(0,${H - margin.bottom})`)
    .call(d3.axisBottom(x).tickSize(-(H - margin.top - margin.bottom)).tickFormat('')).call(dotted);
svg.append('g').selectAll('rect').data(data).join('rect')
    .attr('x', d => x(d.x)).attr('y', d => y(d.y))
    .attr('width', x.bandwidth()).attr('height', d => y(0) - y(d.y))
    .attr('rx', 2).attr('fill', (d, i) => colors[0]);
svg.append('g').attr('transform', `translate(0,${H - margin.bottom})`).call(d3.axisBottom(x).tickSizeOuter(0));
svg.append('g').attr('transform', `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(5))
    .call(g => g.select('.domain').remove());
return svg.node();
