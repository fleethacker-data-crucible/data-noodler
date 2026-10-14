// Multi Gauge (billboard.js gauge chart). Data: Name, Value. Settings: every billboard option for it.
// BBChart (ui/js/widgets/bb-chart.js) turns the rows and settings into the chart; add fixed billboard options in spec.options.
export default function widget(data, ctx) {
  return BBChart.render(data, ctx, {"family":"arc","type":"gauge","options":{"gauge":{"type":"multi"}}});
}
