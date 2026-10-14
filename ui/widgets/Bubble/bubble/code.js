// Bubble (billboard.js bubble chart). Data: X Axis, Size / Y, Split By. Settings: every billboard option for it.
// BBChart (ui/js/widgets/bb-chart.js) turns the rows and settings into the chart; add fixed billboard options in spec.options.
export default function widget(data, ctx) {
  return BBChart.render(data, ctx, {"family":"xy","type":"bubble","options":{"bubble":{"maxR":50}}});
}
