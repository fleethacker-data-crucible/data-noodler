// Range Column (billboard.js bar chart). Data: X Axis, Start, End, Split By. Settings: every billboard option for it.
// BBChart (ui/js/widgets/bb-chart.js) turns the rows and settings into the chart; add fixed billboard options in spec.options.
export default function widget(data, ctx) {
  return BBChart.render(data, ctx, {"family":"tuple","type":"bar","tuple":["start","end"]});
}
