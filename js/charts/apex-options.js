// Catalog of ApexCharts options (groups per chart type). Global: ApexOptions.
//   Each group: { name, types?: chart types it applies to (omitted = all), items: [item] }
//   item: [path, label, type, default, extra]   type: 'boolean' | 'number' | 'text' | 'color' | 'select'
//     extra: number -> [min, max, step]; select -> [choices]
// In the Builder a ticked item is written into the spec at its path (with the default); unticked = removed. Ticked items are
// ordinary options of the widget (shown in the Dashboard when "show" is ticked). ApexOptions.groupOf(path) groups any option.
const ApexOptions = (() => {
  const POS = ['top', 'right', 'bottom', 'left'], ALIGN = ['left', 'center', 'right'];
  const AXIS_TYPES = ['line', 'area', 'bar', 'scatter', 'bubble', 'heatmap', 'candlestick', 'boxPlot', 'rangeBar', 'rangeArea'];
  const G = (name, items, types) => ({ name, items: items.map(([path, label, type, def, extra]) => ({ path, label, type, default: def,
    ...(type === 'number' ? { min: extra?.[0] ?? 0, max: extra?.[1] ?? 100, step: extra?.[2] ?? 1 } : {}), ...(type === 'select' ? { choices: extra } : {}) })), types });
  const GROUPS = [
    G('Chart', [
      ['chart.type', 'Chart type', 'select', 'line', ['line', 'area', 'bar', 'pie', 'donut', 'radialBar', 'scatter', 'bubble', 'heatmap', 'candlestick', 'boxPlot', 'radar', 'polarArea', 'rangeBar', 'rangeArea', 'treemap']],
      ['chart.stacked', 'Stacked', 'boolean', false],
      ['chart.stackType', 'Stack type', 'select', 'normal', ['normal', '100%']],
      ['chart.foreColor', 'Text color', 'color', '#c3c2b7'],
      ['chart.background', 'Background', 'color', '#00000000'],
      ['chart.zoom.enabled', 'Zoom', 'boolean', false],
      ['chart.toolbar.show', 'Toolbar', 'boolean', false],
      ['chart.animations.enabled', 'Animations', 'boolean', true],
      ['chart.animations.speed', 'Animation speed (ms)', 'number', 600, [0, 3000, 50]],
      ['chart.dropShadow.enabled', 'Drop shadow', 'boolean', false],
      ['chart.sparkline.enabled', 'Sparkline (no axes / grid)', 'boolean', false],
    ]),
    G('Colors', [
      ['colors.0', 'Series 1', 'color', '#3987e5'], ['colors.1', 'Series 2', 'color', '#d95926'], ['colors.2', 'Series 3', 'color', '#199e70'],
      ['colors.3', 'Series 4', 'color', '#c9a227'], ['colors.4', 'Series 5', 'color', '#9b6bd6'], ['colors.5', 'Series 6', 'color', '#d6529a'],
      ['theme.palette', 'Palette', 'select', 'palette1', ['palette1', 'palette2', 'palette3', 'palette4', 'palette5', 'palette6', 'palette7', 'palette8', 'palette9', 'palette10']],
      ['theme.monochrome.enabled', 'Monochrome', 'boolean', false],
      ['theme.monochrome.color', 'Monochrome color', 'color', '#3987e5'],
      ['theme.monochrome.shadeIntensity', 'Monochrome shade', 'number', 0.65, [0, 1, 0.05]],
    ]),
    G('Title', [
      ['title.text', 'Title', 'text', 'Title'], ['title.align', 'Align', 'select', 'left', ALIGN],
      ['title.style.fontSize', 'Font size', 'text', '14px'], ['title.style.fontWeight', 'Font weight', 'number', 600, [100, 900, 100]],
      ['title.style.color', 'Color', 'color', '#ffffff'], ['title.offsetX', 'Offset X', 'number', 0, [-100, 100]], ['title.offsetY', 'Offset Y', 'number', 0, [-50, 50]],
      ['subtitle.text', 'Subtitle', 'text', 'Subtitle'], ['subtitle.align', 'Subtitle align', 'select', 'left', ALIGN],
      ['subtitle.style.fontSize', 'Subtitle font size', 'text', '12px'], ['subtitle.style.color', 'Subtitle color', 'color', '#8d8b82'],
    ]),
    G('Legend', [
      ['legend.show', 'Show legend', 'boolean', true], ['legend.showForSingleSeries', 'Show for a single series', 'boolean', false],
      ['legend.position', 'Position', 'select', 'bottom', POS], ['legend.horizontalAlign', 'Align', 'select', 'center', ALIGN],
      ['legend.fontSize', 'Font size', 'text', '12px'], ['legend.labels.useSeriesColors', 'Text in series colors', 'boolean', false],
      ['legend.markers.size', 'Marker size', 'number', 6, [0, 20]], ['legend.itemMargin.horizontal', 'Item spacing', 'number', 5, [0, 40]],
      ['legend.offsetY', 'Offset Y', 'number', 0, [-50, 50]],
    ]),
    G('Data labels', [
      ['dataLabels.enabled', 'Show data labels', 'boolean', false], ['dataLabels.style.fontSize', 'Font size', 'text', '12px'],
      ['dataLabels.style.colors.0', 'Color', 'color', '#ffffff'], ['dataLabels.background.enabled', 'Background', 'boolean', false],
      ['dataLabels.background.foreColor', 'Background text color', 'color', '#000000'], ['dataLabels.offsetY', 'Offset Y', 'number', 0, [-40, 40]],
      ['dataLabels.textAnchor', 'Anchor', 'select', 'middle', ['start', 'middle', 'end']],
      ['dataLabels.dropShadow.enabled', 'Text shadow', 'boolean', false],
    ]),
    G('Lines', [
      ['stroke.show', 'Show lines / outlines', 'boolean', true],
      ['stroke.curve', 'Line shape', 'select', 'straight', ['straight', 'smooth', 'monotoneCubic', 'stepline', 'linestep']],
      ['stroke.width', 'Line width', 'number', 2, [0, 12, 0.5]], ['stroke.lineCap', 'Line ends', 'select', 'butt', ['butt', 'square', 'round']],
      ['stroke.dashArray', 'Dash', 'number', 0, [0, 20]], ['stroke.colors.0', 'Line color', 'color', '#3987e5'],
    ], ['line', 'area', 'bar', 'radar', 'scatter', 'bubble', 'rangeArea', 'pie', 'donut', 'polarArea']),
    G('Markers', [
      ['markers.size', 'Point size', 'number', 0, [0, 20]], ['markers.shape', 'Shape', 'select', 'circle', ['circle', 'square', 'rect', 'line', 'cross', 'plus', 'star', 'triangle', 'diamond']],
      ['markers.strokeWidth', 'Outline width', 'number', 2, [0, 8]], ['markers.strokeColors', 'Outline color', 'color', '#242422'],
      ['markers.colors.0', 'Fill color', 'color', '#3987e5'], ['markers.hover.size', 'Hover size', 'number', 6, [0, 20]],
    ], ['line', 'area', 'radar', 'scatter', 'rangeArea']),
    G('Fill', [
      ['fill.type', 'Fill type', 'select', 'solid', ['solid', 'gradient', 'pattern']], ['fill.opacity', 'Opacity', 'number', 1, [0, 1, 0.05]],
      ['fill.gradient.shade', 'Gradient shade', 'select', 'dark', ['light', 'dark']],
      ['fill.gradient.type', 'Gradient direction', 'select', 'vertical', ['horizontal', 'vertical', 'diagonal1', 'diagonal2']],
      ['fill.gradient.shadeIntensity', 'Gradient intensity', 'number', 0.5, [0, 1, 0.05]],
      ['fill.gradient.opacityFrom', 'Gradient opacity from', 'number', 0.6, [0, 1, 0.05]], ['fill.gradient.opacityTo', 'Gradient opacity to', 'number', 0.1, [0, 1, 0.05]],
      ['fill.pattern.style', 'Pattern', 'select', 'verticalLines', ['verticalLines', 'horizontalLines', 'slantedLines', 'squares', 'circles']],
    ]),
    G('Grid', [
      ['grid.show', 'Show grid', 'boolean', true], ['grid.borderColor', 'Grid color', 'color', '#3a3936'], ['grid.strokeDashArray', 'Dash', 'number', 3, [0, 20]],
      ['grid.xaxis.lines.show', 'Vertical lines', 'boolean', false], ['grid.yaxis.lines.show', 'Horizontal lines', 'boolean', true],
      ['grid.row.colors.0', 'Row stripe color', 'color', '#2c2c2a'], ['grid.row.opacity', 'Row stripe opacity', 'number', 0.5, [0, 1, 0.05]],
      ['grid.padding.top', 'Padding top', 'number', 0, [-40, 80]], ['grid.padding.right', 'Padding right', 'number', 10, [-40, 80]],
      ['grid.padding.bottom', 'Padding bottom', 'number', 0, [-40, 80]], ['grid.padding.left', 'Padding left', 'number', 10, [-40, 80]],
    ], AXIS_TYPES),
    G('X axis', [
      ['xaxis.type', 'Axis type', 'select', 'category', ['category', 'datetime', 'numeric']], ['xaxis.title.text', 'Axis title', 'text', 'X axis'],
      ['xaxis.labels.show', 'Labels', 'boolean', true], ['xaxis.labels.rotate', 'Label angle', 'number', -45, [-90, 90, 5]],
      ['xaxis.labels.rotateAlways', 'Always rotate labels', 'boolean', false], ['xaxis.labels.trim', 'Trim long labels', 'boolean', false],
      ['xaxis.labels.style.fontSize', 'Label font size', 'text', '11px'], ['xaxis.labels.style.colors', 'Label color', 'color', '#c3c2b7'],
      ['xaxis.axisBorder.show', 'Bottom border line', 'boolean', true], ['xaxis.axisBorder.color', 'Border color', 'color', '#3a3936'],
      ['xaxis.axisTicks.show', 'Tick marks', 'boolean', true], ['xaxis.axisTicks.color', 'Tick color', 'color', '#3a3936'],
      ['xaxis.tickAmount', 'Number of ticks', 'number', 6, [0, 40]], ['xaxis.position', 'Position', 'select', 'bottom', ['bottom', 'top']],
      ['xaxis.tooltip.enabled', 'Axis tooltip', 'boolean', true], ['xaxis.crosshairs.show', 'Crosshair', 'boolean', true],
    ], AXIS_TYPES),
    G('Y axis', [
      ['yaxis.show', 'Show Y axis', 'boolean', true], ['yaxis.title.text', 'Axis title', 'text', 'Y axis'],
      ['yaxis.labels.show', 'Labels', 'boolean', true], ['yaxis.labels.style.fontSize', 'Label font size', 'text', '11px'], ['yaxis.labels.style.colors', 'Label color', 'color', '#c3c2b7'],
      ['yaxis.axisBorder.show', 'Left border line', 'boolean', true], ['yaxis.axisBorder.color', 'Border color', 'color', '#3a3936'], ['yaxis.axisBorder.width', 'Border width', 'number', 1, [0, 6]],
      ['yaxis.axisTicks.show', 'Tick marks', 'boolean', true], ['yaxis.axisTicks.color', 'Tick color', 'color', '#3a3936'],
      ['yaxis.tickAmount', 'Number of ticks', 'number', 6, [0, 40]], ['yaxis.min', 'Minimum', 'number', 0, [-1e9, 1e9, 1]], ['yaxis.max', 'Maximum', 'number', 100, [-1e9, 1e9, 1]],
      ['yaxis.forceNiceScale', 'Nice round scale', 'boolean', true], ['yaxis.decimalsInFloat', 'Decimals', 'number', 0, [0, 6]],
      ['yaxis.logarithmic', 'Log scale', 'boolean', false], ['yaxis.opposite', 'On the right', 'boolean', false], ['yaxis.reversed', 'Reversed', 'boolean', false],
    ], AXIS_TYPES),
    G('Tooltip', [
      ['tooltip.enabled', 'Tooltips', 'boolean', true], ['tooltip.shared', 'Shared (all series)', 'boolean', true], ['tooltip.intersect', 'Only on a point', 'boolean', false],
      ['tooltip.followCursor', 'Follow the cursor', 'boolean', false], ['tooltip.theme', 'Tooltip theme', 'select', 'dark', ['dark', 'light']],
      ['tooltip.x.show', 'Show the X value', 'boolean', true], ['tooltip.marker.show', 'Show the series marker', 'boolean', true],
    ]),
    G('Hover & select', [
      ['states.hover.filter.type', 'On hover', 'select', 'lighten', ['none', 'lighten', 'darken']],
      ['states.active.filter.type', 'On select', 'select', 'darken', ['none', 'lighten', 'darken']],
    ]),
    G('Bars', [
      ['plotOptions.bar.horizontal', 'Horizontal', 'boolean', false], ['plotOptions.bar.borderRadius', 'Corner radius', 'number', 4, [0, 30]],
      ['plotOptions.bar.borderRadiusApplication', 'Round corners', 'select', 'end', ['end', 'around']], ['plotOptions.bar.columnWidth', 'Column width', 'text', '70%'],
      ['plotOptions.bar.barHeight', 'Bar height (horizontal)', 'text', '70%'], ['plotOptions.bar.distributed', 'One color per bar', 'boolean', false],
      ['plotOptions.bar.dataLabels.position', 'Label position', 'select', 'top', ['top', 'center', 'bottom']],
    ], ['bar', 'rangeBar']),
    G('Area', [['plotOptions.area.fillTo', 'Fill to', 'select', 'origin', ['origin', 'end']]], ['area', 'rangeArea']),
    G('Pie & donut', [
      ['plotOptions.pie.startAngle', 'Start angle', 'number', 0, [-360, 360, 5]], ['plotOptions.pie.endAngle', 'End angle', 'number', 360, [-360, 360, 5]],
      ['plotOptions.pie.expandOnClick', 'Expand slice on click', 'boolean', true], ['plotOptions.pie.customScale', 'Scale', 'number', 1, [0.5, 1.5, 0.05]],
      ['plotOptions.pie.dataLabels.offset', 'Label offset', 'number', 0, [-60, 60]], ['plotOptions.pie.dataLabels.minAngleToShowLabel', 'Smallest labelled slice (deg)', 'number', 10, [0, 90]],
      ['plotOptions.pie.donut.size', 'Hole size', 'text', '65%'], ['plotOptions.pie.donut.labels.show', 'Center labels', 'boolean', false],
      ['plotOptions.pie.donut.labels.total.show', 'Center total', 'boolean', false], ['plotOptions.pie.donut.labels.total.label', 'Total label', 'text', 'Total'],
    ], ['pie', 'donut']),
    G('Radial bar', [
      ['plotOptions.radialBar.startAngle', 'Start angle', 'number', 0, [-360, 360, 5]], ['plotOptions.radialBar.endAngle', 'End angle', 'number', 360, [-360, 360, 5]],
      ['plotOptions.radialBar.hollow.size', 'Hole size', 'text', '50%'], ['plotOptions.radialBar.track.background', 'Track color', 'color', '#44433f'],
      ['plotOptions.radialBar.dataLabels.show', 'Labels', 'boolean', true], ['plotOptions.radialBar.dataLabels.total.show', 'Total', 'boolean', false],
    ], ['radialBar']),
    G('Polar area', [['plotOptions.polarArea.rings.strokeColor', 'Ring color', 'color', '#3a3936'], ['plotOptions.polarArea.spokes.strokeWidth', 'Spoke width', 'number', 1, [0, 6]]], ['polarArea']),
    G('Radar', [['plotOptions.radar.size', 'Size', 'number', 140, [20, 600, 5]], ['plotOptions.radar.polygons.strokeColors', 'Web color', 'color', '#3a3936'],
      ['plotOptions.radar.polygons.fill.colors.0', 'Web fill', 'color', '#00000000']], ['radar']),
    G('Heatmap', [['plotOptions.heatmap.radius', 'Cell corner radius', 'number', 2, [0, 20]], ['plotOptions.heatmap.enableShades', 'Shade by value', 'boolean', true],
      ['plotOptions.heatmap.shadeIntensity', 'Shade intensity', 'number', 0.5, [0, 1, 0.05]], ['plotOptions.heatmap.distributed', 'Shade per row', 'boolean', false]], ['heatmap']),
    G('Treemap', [['plotOptions.treemap.distributed', 'One color per tile', 'boolean', false], ['plotOptions.treemap.enableShades', 'Shade by value', 'boolean', true],
      ['plotOptions.treemap.shadeIntensity', 'Shade intensity', 'number', 0.5, [0, 1, 0.05]]], ['treemap']),
    G('Candlestick', [['plotOptions.candlestick.colors.upward', 'Up color', 'color', '#1baf7a'], ['plotOptions.candlestick.colors.downward', 'Down color', 'color', '#e24c4c'],
      ['plotOptions.candlestick.wick.useFillColor', 'Wick in candle color', 'boolean', true]], ['candlestick']),
    G('Box plot', [['plotOptions.boxPlot.colors.upper', 'Upper box color', 'color', '#3987e5'], ['plotOptions.boxPlot.colors.lower', 'Lower box color', 'color', '#199e70']], ['boxPlot']),
  ];
  const byPath = new Map(GROUPS.flatMap(g => g.items.map(i => [i.path, { group: g.name, item: i }])));
  // Group for any option path: the catalog group, else the nearest catalog group of a parent path, else 'Other'.
  function groupOf(path) {
    if (byPath.has(path)) return byPath.get(path).group;
    const first = path.split('.')[0], sub = path.split('.').slice(0, 2).join('.');
    const hit = GROUPS.find(g => g.items.some(i => i.path.startsWith(sub + '.'))) || GROUPS.find(g => g.items.some(i => i.path.split('.')[0] === first));
    return hit ? hit.name : 'Other';
  }
  const groupsFor = type => GROUPS.filter(g => !g.types || g.types.includes(type || 'line'));
  return { GROUPS, groupsFor, groupOf, item: p => byPath.get(p)?.item };
})();
