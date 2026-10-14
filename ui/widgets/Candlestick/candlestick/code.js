// Candlestick (billboard.js candlestick chart). Data: X Axis, Open, High, Low, Close, Volume (optional), Split By. Settings: every billboard option for it.
// BBChart (ui/js/widgets/bb-chart.js) turns the rows and settings into the chart; add fixed billboard options in spec.options.
export default function widget(data, ctx) {
  return BBChart.render(data, ctx, {"family":"tuple","type":"candlestick","tuple":["open","high","low","close","volume"],"optional":["volume"]});
}
