// Area Line Range (billboard.js area-line-range chart). Data: X Axis, High, Mid (optional), Low, Split By. Settings: every billboard option for it.
// BBChart (ui/js/widgets/bb-chart.js) turns the rows and settings into the chart; add fixed billboard options in spec.options.
export default function widget(data, ctx) {
  return BBChart.render(data, ctx, {"family":"tuple","type":"area-line-range","tuple":["high","mid","low"],"optional":["mid"]});
}
