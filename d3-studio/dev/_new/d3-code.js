// New chart. Ready made (see Generated above): data, X / Y accessors, W x H, colors, opts, theme.
const margin = { top: 16, right: 16, bottom: 32, left: 48 };

// Scales: data values -> pixels inside the box (the left margin fits the longest Y label).
const y = d3.scaleLinear().domain([0, d3.max(data, Y) || 1]).nice().range([H - margin.bottom, margin.top]);
margin.left = 14 + 7 * d3.max(y.ticks(5).map(y.tickFormat(5)), s => s.length);
const x = d3.scaleBand().domain(data.map(X)).range([margin.left, W - margin.right]).padding(0.2);

// The chart: an svg the size of the box (it scales with its box on the Dashboard).
const svg = d3.create('svg').attr('viewBox', [0, 0, W, H]);

// Grid lines (Settings: opts.grid.y = horizontal, opts.grid.x = vertical).
const grid = g => g.call(g => g.select('.domain').remove()).selectAll('line').attr('stroke', theme.border).attr('stroke-dasharray', '2,3');
if (opts.grid?.y) svg.append('g').attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(W - margin.left - margin.right)).tickFormat('')).call(grid);
if (opts.grid?.x) svg.append('g').attr('transform', `translate(0,${H - margin.bottom})`)
    .call(d3.axisBottom(x).tickSize(-(H - margin.top - margin.bottom)).tickFormat('')).call(grid);

// Axes.
svg.append('g').attr('transform', `translate(0,${H - margin.bottom})`).call(d3.axisBottom(x).tickSizeOuter(0));
svg.append('g').attr('transform', `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(5))
    .call(g => g.select('.domain').remove());

// ---- Your marks (the part each chart changes) ----
// Bars: one per row, from y = 0 up to Y.
svg.append('g').attr('fill', colors[0])
  .selectAll('rect').data(data).join('rect')
    .attr('x', d => x(X(d))).attr('y', d => y(Y(d)))
    .attr('width', x.bandwidth()).attr('height', d => y(0) - y(Y(d)))
    .attr('rx', 2);

return svg.node();
