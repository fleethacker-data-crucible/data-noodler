// D3 v7 API catalog for the D3 Studio code editor (suggestions, hover help, "did you mean" checks). Global: D3Api.
// Source: https://d3js.org/api (every entry, d3 7.9.0). The vendored d3 (ui/js/vendor/d3.min.js) is also read at load:
// any export or method missing here is still suggested (Object.keys(d3), the selection / transition prototypes and a
// fresh instance of each generator / scale), so the editor always matches the library that runs the chart.
//   D3Api.top                    Map name -> description      (d3.<name>)
//   D3Api.methods(type)          Map name -> description      (methods of 'selection', 'linear', 'band', 'axis', 'line', ...)
//   D3Api.typeOfFactory(name)    'linear' | 'band' | 'selection' | ... the type a d3.<name>() call returns (or null)
//   D3Api.allMethods             Map name -> description      (every method of every type: unknown receivers)
//   D3Api.closest(name, list)    the nearest spelling in list (for "did you mean")
const D3Api = (() => {
  const TEXT = `
# d3
Adder|full precision adder
fcumsum|full precision cumulative sum
fsum|full precision sum
bin|new bin generator (histogram)
thresholdFreedmanDiaconis|Freedman-Diaconis binning rule
thresholdScott|Scott's binning rule
thresholdSturges|Sturges' binning formula
bisector|bisect using an accessor or comparator
bisect|binary search in a sorted array
bisectRight|binary search, insert after equal values
bisectLeft|binary search, insert before equal values
bisectCenter|binary search, centred
blur|blur an array of numbers in place
blur2|blur a 2D array in place
blurImage|blur RGBA ImageData in place
group|group an iterable into a nested Map
groups|group an iterable into a nested array
rollup|reduce an iterable into a nested Map
rollups|reduce an iterable into a nested array
index|index an iterable into a nested Map
indexes|index an iterable into a nested array
flatGroup|group into a flat array
flatRollup|reduce into a flat array
groupSort|sort keys by grouped values
InternMap|key-interning Map (dates as keys)
InternSet|value-interning Set
difference|set difference
disjoint|test whether two sets are disjoint
intersection|set intersection
superset|test whether a set is a superset
subset|test whether a set is a subset
union|set union
ascending|ascending comparator
descending|descending comparator
permute|reorder by an index iterable
quickselect|partially reorder numbers
reverse|reverse the order of values
shuffle|randomize order
shuffler|shuffle with a given random source
sort|sort values
count|count valid numbers
min|minimum value
minIndex|index of the minimum
max|maximum value
maxIndex|index of the maximum
least|least element
leastIndex|index of the least element
greatest|greatest element
greatestIndex|index of the greatest element
extent|[min, max]
mode|most common value
sum|sum of numbers
mean|arithmetic mean
median|median (0.5 quantile)
medianIndex|median index
cumsum|cumulative sum
quantile|quantile of numbers
quantileIndex|quantile index
quantileSorted|quantile of a sorted array
rank|rank order
variance|variance
deviation|standard deviation
every|test if all values pass
some|test if any value passes
ticks|nice values across an interval
tickIncrement|tick increment for an interval
tickStep|tick step for an interval
nice|extend an interval to nice ticks
range|array of numbers start..stop by step
cross|Cartesian product
merge|merge iterables into one array
pairs|adjacent pairs
transpose|transpose an array of arrays
zip|transpose arrays
filter|filter values
map|map values
reduce|reduce values
axisTop|top axis (call it on a <g>)
axisRight|right axis (call it on a <g>)
axisBottom|bottom axis (call it on a <g>)
axisLeft|left axis (call it on a <g>)
brush|2D brush behaviour
brushX|horizontal brush
brushY|vertical brush
brushSelection|current brush selection of a node
chord|chord layout
chordDirected|directed chord layout
chordTranspose|transposed chord layout
ribbon|ribbon shape generator
ribbonArrow|arrow ribbon generator
color|parse a CSS colour
rgb|RGB colour
hsl|HSL colour
lab|CIELAB colour
gray|Lab grey
hcl|CIELCh colour
lch|CIELCh colour
cubehelix|Cubehelix colour
contours|contour generator
contourDensity|density contour estimator
Delaunay|Delaunay triangulation
Voronoi|Voronoi diagram
dispatch|custom event dispatcher
drag|drag behaviour
dragDisable|stop native drag and text selection
dragEnable|allow native drag and text selection
csvParse|parse CSV text into objects
csvParseRows|parse CSV text into rows
csvFormat|objects to CSV text
csvFormatBody|objects to CSV without a header
csvFormatRows|rows to CSV text
csvFormatRow|one row to CSV
csvFormatValue|one value to CSV
tsvParse|parse TSV text into objects
tsvParseRows|parse TSV text into rows
tsvFormat|objects to TSV text
tsvFormatBody|objects to TSV without a header
tsvFormatRows|rows to TSV text
tsvFormatRow|one row to TSV
tsvFormatValue|one value to TSV
dsvFormat|parser / formatter for a delimiter
autoType|guess value types of a parsed row
easeLinear|linear easing
easePolyIn|polynomial easing in
easePolyOut|polynomial easing out
easePoly|polynomial easing in-out
easePolyInOut|polynomial easing in-out
easeQuadIn|quadratic easing in
easeQuadOut|quadratic easing out
easeQuad|quadratic easing in-out
easeQuadInOut|quadratic easing in-out
easeCubicIn|cubic easing in
easeCubicOut|cubic easing out
easeCubic|cubic easing in-out
easeCubicInOut|cubic easing in-out
easeSinIn|sine easing in
easeSinOut|sine easing out
easeSin|sine easing in-out
easeSinInOut|sine easing in-out
easeExpIn|exponential easing in
easeExpOut|exponential easing out
easeExp|exponential easing in-out
easeExpInOut|exponential easing in-out
easeCircleIn|circular easing in
easeCircleOut|circular easing out
easeCircle|circular easing in-out
easeCircleInOut|circular easing in-out
easeElasticIn|elastic easing in
easeElastic|elastic easing out
easeElasticOut|elastic easing out
easeElasticInOut|elastic easing in-out
easeBackIn|anticipatory easing in
easeBackOut|anticipatory easing out
easeBack|anticipatory easing in-out
easeBackInOut|anticipatory easing in-out
easeBounceIn|bounce easing in
easeBounce|bounce easing out
easeBounceOut|bounce easing out
easeBounceInOut|bounce easing in-out
blob|fetch a file as a Blob
buffer|fetch a file as an ArrayBuffer
csv|fetch a CSV file
dsv|fetch a delimited file
html|fetch an HTML file
image|fetch an image
json|fetch a JSON file
svg|fetch an SVG file
text|fetch a text file
tsv|fetch a TSV file
xml|fetch an XML file
forceSimulation|force simulation
forceCenter|centering force
forceCollide|collision force
forceLink|link force
forceManyBody|many-body (charge) force
forceX|x-positioning force
forceY|y-positioning force
forceRadial|radial positioning force
format|number formatter, e.g. d3.format(',.2f')
formatPrefix|SI-prefix number formatter
formatSpecifier|parse a format specifier
FormatSpecifier|format specifier object
precisionFixed|decimals for fixed notation
precisionPrefix|decimals for SI-prefix notation
precisionRound|significant digits for rounding
formatLocale|custom number locale
formatDefaultLocale|set the default number locale
geoPath|geographic path generator
geoProjection|custom projection
geoProjectionMutator|configurable projection
geoTransform|geometry transform
geoIdentity|scale / translate / clip planar geometry
geoClipAntimeridian|cut at the antimeridian
geoClipCircle|clip to a small circle
geoClipRectangle|clip to a rectangle
geoAzimuthalEqualArea|azimuthal equal-area projection
geoAzimuthalEquidistant|azimuthal equidistant projection
geoGnomonic|gnomonic projection
geoOrthographic|orthographic projection
geoStereographic|stereographic projection
geoConicConformal|conic conformal projection
geoConicEqualArea|conic equal-area projection
geoConicEquidistant|conic equidistant projection
geoAlbers|Albers equal-area conic projection
geoAlbersUsa|composite Albers projection (US)
geoEquirectangular|equirectangular projection
geoMercator|spherical Mercator projection
geoTransverseMercator|transverse Mercator projection
geoEqualEarth|Equal Earth projection
geoNaturalEarth1|Natural Earth I projection
geoStream|GeoJSON to a stream
geoGraticule|graticule generator
geoGraticule10|default 10 degree graticule
geoCircle|circle generator
geoArea|spherical area
geoBounds|lon / lat bounding box
geoCentroid|spherical centroid
geoDistance|great-arc distance
geoLength|great-arc length
geoInterpolate|interpolate along a great arc
geoContains|test if a point is in a feature
geoRotation|rotation function
hierarchy|root node from hierarchical data
stratify|root node from tabular data (id / parentId)
cluster|dendrogram layout
tree|tidy tree layout
treemap|treemap layout
treemapBinary|treemap tiling: balanced binary
treemapDice|treemap tiling: horizontal row
treemapSlice|treemap tiling: vertical column
treemapSliceDice|treemap tiling: alternate slice / dice
treemapSquarify|treemap tiling: squarified
treemapResquarify|treemap tiling: stable squarified
partition|partition (icicle / sunburst) layout
pack|circle-packing layout
packSiblings|pack an array of circles
packEnclose|smallest enclosing circle
interpolate|interpolate any two values
interpolateNumber|interpolate numbers
interpolateRound|interpolate integers
interpolateString|interpolate strings with numbers
interpolateDate|interpolate dates
interpolateArray|interpolate arrays
interpolateNumberArray|interpolate number arrays
interpolateObject|interpolate objects
interpolateBasis|B-spline through values
interpolateBasisClosed|closed B-spline through values
interpolateDiscrete|discrete interpolator
quantize|uniform samples from an interpolator
piecewise|piecewise interpolator
interpolateRgb|interpolate RGB colours
interpolateRgbBasis|B-spline through colours
interpolateRgbBasisClosed|closed B-spline through colours
interpolateHsl|interpolate HSL colours
interpolateHslLong|interpolate HSL the long way
interpolateLab|interpolate Lab colours
interpolateHcl|interpolate HCL colours
interpolateHclLong|interpolate HCL the long way
interpolateCubehelix|interpolate Cubehelix colours
interpolateCubehelixLong|interpolate Cubehelix the long way
interpolateHue|interpolate a hue angle
interpolateTransformCss|interpolate CSS transforms
interpolateTransformSvg|interpolate SVG transforms
interpolateZoom|zoom-and-pan interpolator
path|path serializer
pathRound|path serializer with fixed precision
polygonArea|area of a polygon
polygonCentroid|centroid of a polygon
polygonHull|convex hull of points
polygonContains|test if a point is in a polygon
polygonLength|perimeter of a polygon
quadtree|quadtree
randomUniform|uniform random numbers
randomInt|uniform random integers
randomNormal|normal random numbers
randomLogNormal|log-normal random numbers
randomBates|Bates random numbers
randomIrwinHall|Irwin-Hall random numbers
randomExponential|exponential random numbers
randomPareto|Pareto random numbers
randomBernoulli|Bernoulli random numbers
randomGeometric|geometric random numbers
randomBinomial|binomial random numbers
randomGamma|gamma random numbers
randomBeta|beta random numbers
randomWeibull|Weibull random numbers
randomCauchy|Cauchy random numbers
randomLogistic|logistic random numbers
randomPoisson|Poisson random numbers
randomLcg|seeded random generator
scaleLinear|linear scale: .domain([min, max]).range([a, b])
scaleIdentity|identity scale
scaleRadial|radial scale
scalePow|power scale
scaleSqrt|square-root scale
scaleLog|logarithmic scale
scaleSymlog|symmetric log scale
scaleTime|time scale (local time): dates on an axis
scaleUtc|time scale (UTC): dates on an axis
scaleSequential|sequential colour scale
scaleSequentialLog|sequential log scale
scaleSequentialPow|sequential power scale
scaleSequentialSqrt|sequential square-root scale
scaleSequentialSymlog|sequential symlog scale
scaleSequentialQuantile|sequential quantile scale
scaleDiverging|diverging colour scale
scaleDivergingLog|diverging log scale
scaleDivergingPow|diverging power scale
scaleDivergingSqrt|diverging square-root scale
scaleDivergingSymlog|diverging symlog scale
scaleQuantize|quantize scale (uniform buckets)
scaleQuantile|quantile scale
scaleThreshold|threshold scale
scaleOrdinal|ordinal scale (categories to values, e.g. colours)
scaleImplicit|ordinal unknown value: implicit domain
scaleBand|band scale (bars): .domain(categories).range([a, b]).padding(0.2)
scalePoint|point scale (categories to points)
tickFormat|tick formatter for an interval
schemeCategory10|10 categorical colours
schemeAccent|8 categorical colours
schemeDark2|8 categorical colours
schemeObservable10|10 categorical colours
schemePaired|12 categorical colours
schemePastel1|9 categorical colours
schemePastel2|8 categorical colours
schemeSet1|9 categorical colours
schemeSet2|8 categorical colours
schemeSet3|12 categorical colours
schemeTableau10|10 categorical colours
interpolateRainbow|rainbow
interpolateSinebow|sinebow
interpolateBrBG|BrBG diverging
interpolatePiYG|PiYG diverging
interpolatePRGn|PRGn diverging
interpolatePuOr|PuOr diverging
interpolateRdBu|RdBu diverging
interpolateRdGy|RdGy diverging
interpolateRdYlBu|RdYlBu diverging
interpolateRdYlGn|RdYlGn diverging
interpolateSpectral|Spectral diverging
schemeBrBG|BrBG scheme
schemePiYG|PiYG scheme
schemePRGn|PRGn scheme
schemePuOr|PuOr scheme
schemeRdBu|RdBu scheme
schemeRdGy|RdGy scheme
schemeRdYlBu|RdYlBu scheme
schemeRdYlGn|RdYlGn scheme
schemeSpectral|Spectral scheme
interpolateBlues|Blues sequential
interpolateGreens|Greens sequential
interpolateGreys|Greys sequential
interpolateOranges|Oranges sequential
interpolatePurples|Purples sequential
interpolateReds|Reds sequential
schemeBlues|Blues scheme
schemeGreens|Greens scheme
schemeGreys|Greys scheme
schemeOranges|Oranges scheme
schemePurples|Purples scheme
schemeReds|Reds scheme
interpolateBuGn|BuGn sequential
interpolateBuPu|BuPu sequential
interpolateCividis|cividis
interpolateCool|cool
interpolateCubehelixDefault|cubehelix
interpolateGnBu|GnBu sequential
interpolateInferno|inferno
interpolateMagma|magma
interpolateOrRd|OrRd sequential
interpolatePlasma|plasma
interpolatePuBu|PuBu sequential
interpolatePuBuGn|PuBuGn sequential
interpolatePuRd|PuRd sequential
interpolateRdPu|RdPu sequential
interpolateTurbo|turbo
interpolateViridis|viridis
interpolateWarm|warm
interpolateYlGn|YlGn sequential
interpolateYlGnBu|YlGnBu sequential
interpolateYlOrBr|YlOrBr sequential
interpolateYlOrRd|YlOrRd sequential
schemeBuGn|BuGn scheme
schemeBuPu|BuPu scheme
schemeGnBu|GnBu scheme
schemeOrRd|OrRd scheme
schemePuBu|PuBu scheme
schemePuBuGn|PuBuGn scheme
schemePuRd|PuRd scheme
schemeRdPu|RdPu scheme
schemeYlGn|YlGn scheme
schemeYlGnBu|YlGnBu scheme
schemeYlOrBr|YlOrBr scheme
schemeYlOrRd|YlOrRd scheme
selection|selection of the document root
select|select one element (or node)
selectAll|select all matching elements
matcher|element-matches-selector test
selector|selector function
selectorAll|selector-all function
window|owner window of a node
style|computed style value of a node
create|create a detached element, e.g. d3.create('svg')
creator|element creator by name
pointer|[x, y] of an event in a node's coordinates
pointers|pointer positions of an event
local|local variable on elements
namespace|qualify a prefixed XML name
namespaces|built-in XML namespaces
arc|arc generator (pie / donut slices)
pie|pie layout: angles for values
line|line generator: .x(d => ...).y(d => ...)
lineRadial|radial line generator
area|area generator: .x().y0().y1()
areaRadial|radial area generator
curveBasis|cubic basis spline
curveBasisClosed|closed cubic basis spline
curveBasisOpen|open cubic basis spline
curveBundle|straightened basis spline
curveBumpX|Bezier, horizontal tangents
curveBumpY|Bezier, vertical tangents
curveCardinal|cardinal spline
curveCardinalClosed|closed cardinal spline
curveCardinalOpen|open cardinal spline
curveCatmullRom|Catmull-Rom spline
curveCatmullRomClosed|closed Catmull-Rom spline
curveCatmullRomOpen|open Catmull-Rom spline
curveLinear|straight lines
curveLinearClosed|closed straight lines
curveMonotoneX|monotone in x (smooth, no overshoot)
curveMonotoneY|monotone in y
curveNatural|natural cubic spline
curveStep|step
curveStepAfter|step after each point
curveStepBefore|step before each point
link|link generator
linkVertical|vertical link generator
linkHorizontal|horizontal link generator
linkRadial|radial link generator
symbol|symbol generator
symbolsFill|symbol types for fill
symbolsStroke|symbol types for stroke
symbolAsterisk|asterisk (stroke)
symbolCircle|circle
symbolCross|cross (fill)
symbolDiamond|diamond (fill)
symbolDiamond2|rotated square (stroke)
symbolPlus|plus (stroke)
symbolSquare|square (fill)
symbolSquare2|square (stroke)
symbolStar|star (fill)
symbolTriangle|triangle (fill)
symbolTriangle2|triangle (stroke)
symbolWye|Y shape (fill)
symbolTimes|X shape (stroke)
symbolX|X shape (stroke)
pointRadial|[x, y] from angle and radius
stack|stack generator (stacked bars / areas)
stackOrderAppearance|earliest series at the bottom
stackOrderAscending|smallest series at the bottom
stackOrderDescending|largest series at the bottom
stackOrderInsideOut|earlier series in the middle
stackOrderNone|given series order
stackOrderReverse|reverse series order
stackOffsetExpand|normalize to 0..1 (100% stacked)
stackOffsetDiverging|positives up, negatives down
stackOffsetNone|zero baseline
stackOffsetSilhouette|centred streamgraph
stackOffsetWiggle|minimal-wiggle streamgraph
timeInterval|custom time interval
timeMillisecond|millisecond interval
timeSecond|second interval
timeMinute|minute interval
timeHour|hour interval
timeDay|day interval
timeWeek|week interval (Sunday)
timeSunday|week interval (Sunday)
timeMonday|week interval (Monday)
timeTuesday|week interval (Tuesday)
timeWednesday|week interval (Wednesday)
timeThursday|week interval (Thursday)
timeFriday|week interval (Friday)
timeSaturday|week interval (Saturday)
timeMonth|month interval
timeYear|year interval
utcMillisecond|UTC millisecond interval
utcSecond|UTC second interval
utcMinute|UTC minute interval
utcHour|UTC hour interval
utcDay|UTC day interval
utcWeek|UTC week interval (Sunday)
utcSunday|UTC week interval (Sunday)
utcMonday|UTC week interval (Monday)
utcTuesday|UTC week interval (Tuesday)
utcWednesday|UTC week interval (Wednesday)
utcThursday|UTC week interval (Thursday)
utcFriday|UTC week interval (Friday)
utcSaturday|UTC week interval (Saturday)
utcMonth|UTC month interval
utcYear|UTC year interval
unixDay|UTC day interval (not month-aligned)
timeMilliseconds|dates every millisecond
timeSeconds|dates every second
timeMinutes|dates every minute
timeHours|dates every hour
timeDays|dates every day
timeWeeks|dates every week
timeSundays|dates every Sunday
timeMondays|dates every Monday
timeTuesdays|dates every Tuesday
timeWednesdays|dates every Wednesday
timeThursdays|dates every Thursday
timeFridays|dates every Friday
timeSaturdays|dates every Saturday
timeMonths|dates every month
timeYears|dates every year
utcMilliseconds|UTC dates every millisecond
utcSeconds|UTC dates every second
utcMinutes|UTC dates every minute
utcHours|UTC dates every hour
utcDays|UTC dates every day
utcWeeks|UTC dates every week
utcSundays|UTC dates every Sunday
utcMondays|UTC dates every Monday
utcTuesdays|UTC dates every Tuesday
utcWednesdays|UTC dates every Wednesday
utcThursdays|UTC dates every Thursday
utcFridays|UTC dates every Friday
utcSaturdays|UTC dates every Saturday
utcMonths|UTC dates every month
utcYears|UTC dates every year
unixDays|UTC dates every day
timeTicks|nice dates across an interval
utcTicks|nice UTC dates across an interval
timeTickInterval|tick interval for dates
utcTickInterval|tick interval for UTC dates
timeFormat|date formatter, e.g. d3.timeFormat('%b %Y')
timeParse|date parser, e.g. d3.timeParse('%Y-%m-%d')
utcFormat|UTC date formatter
utcParse|UTC date parser
isoFormat|ISO 8601 formatter
isoParse|ISO 8601 parser
timeFormatLocale|custom time locale
timeFormatDefaultLocale|set the default time locale
now|current high-resolution time
timer|new timer
timerFlush|run eligible timers now
timeout|one-shot timer
interval|repeating timer
interrupt|interrupt the active transition of a node
transition|transition on the document root
active|active transition of a node
zoom|zoom behaviour
zoomTransform|zoom transform of an element
zoomIdentity|identity zoom transform
ZoomTransform|zoom transform class

# selection
select|select a descendant for each element
selectAll|select all descendants for each element
filter|keep elements matching a filter
merge|merge with another selection
selectChild|select a child for each element
selectChildren|select the children of each element
selection|this selection
attr|get or set an attribute: .attr('fill', d => ...)
classed|add / remove CSS classes
style|get or set a style property
property|get or set a raw property
text|get or set text content
html|get or set inner HTML
append|append a new element and select it
insert|insert a new element and select it
remove|remove the elements
clone|insert clones of the elements
sort|sort elements by data
order|reorder elements to match the selection
raise|move each element to the front
lower|move each element to the back
data|bind data to elements
join|enter / update / exit in one: .join('rect')
enter|enter selection (data without elements)
exit|exit selection (elements without data)
datum|get or set one element's data
on|add / remove an event listener: .on('click', (event, d) => ...)
dispatch|dispatch a custom event
each|call a function for each element
call|call a function with this selection: .call(d3.axisBottom(x))
empty|true if no elements
nodes|array of the elements
node|first element (return svg.node())
size|number of elements
transition|start a transition
interrupt|cancel transitions

# transition
select|select a descendant for each element
selectAll|select all descendants for each element
selectChild|select a child for each element
selectChildren|select the children of each element
selection|the selection of this transition
filter|keep elements matching a filter
merge|merge with another transition
transition|chain a new transition after this one
attr|tween an attribute to a value
attrTween|tween an attribute with an interpolator
style|tween a style property
styleTween|tween a style with an interpolator
text|set text when the transition starts
textTween|tween text with an interpolator
remove|remove elements when it ends
tween|run custom code during the transition
delay|delay in ms
duration|duration in ms
ease|easing function, e.g. d3.easeCubic
easeVarying|easing factory per element
end|promise resolved when it ends
on|listen for start / end / interrupt
each|call a function for each element
call|call a function with this transition
empty|true if no elements
nodes|array of the elements
node|first element
size|number of elements

# axis
scale|set the scale
ticks|tick count / format: .ticks(5) or .ticks(5, 's')
tickArguments|tick arguments
tickValues|explicit tick values
tickFormat|tick label format: .tickFormat(d3.format(','))
tickSize|inner and outer tick size
tickSizeInner|inner tick size (negative = grid lines)
tickSizeOuter|outer tick size (0 = no end ticks)
tickPadding|space between tick and label
offset|pixel offset for crisp edges

# continuous
domain|input domain, e.g. [0, d3.max(data, Y)]
range|output range, e.g. [H - margin.bottom, margin.top]
rangeRound|output range, rounded
clamp|clamp output to the range
unknown|output for unknown input
interpolate|output interpolator
ticks|nice tick values
tickFormat|tick formatter
nice|extend the domain to nice round values
copy|copy the scale
invert|range value back to domain value

# pow
exponent|power exponent
# log
base|logarithm base
# symlog
constant|symlog constant

# sequential
domain|input domain
interpolator|colour interpolator, e.g. d3.interpolateBlues
range|output range
rangeRound|output range, rounded
clamp|clamp output
unknown|output for unknown input
copy|copy the scale
quantiles|quantile thresholds

# quantize
domain|input domain
range|output range
thresholds|computed thresholds
invertExtent|domain extent for a range value
unknown|output for unknown input
quantiles|quantile thresholds
copy|copy the scale

# ordinal
domain|categories
range|values for the categories, e.g. colors
unknown|output for unknown input
copy|copy the scale

# band
domain|categories (one band each)
range|[start, end] in px
rangeRound|[start, end] in px, rounded
round|round band positions
paddingInner|gap between bands (0..1)
paddingOuter|gap at both ends (0..1)
padding|inner and outer padding (0..1)
align|alignment of the bands (0..1)
bandwidth|width of each band (bar width)
step|distance between band starts
copy|copy the scale

# arc
innerRadius|inner radius (donut hole)
outerRadius|outer radius
cornerRadius|rounded corners
startAngle|start angle
endAngle|end angle
padAngle|gap between slices
padRadius|radius for padding
centroid|[x, y] middle of a slice (labels)
context|render to a canvas context
digits|output precision

# pie
value|value accessor
sort|sort comparator for data
sortValues|sort comparator for values
startAngle|overall start angle
endAngle|overall end angle
padAngle|gap between slices

# line
x|x accessor: d => x(X(d))
y|y accessor: d => y(Y(d))
defined|skip points (gaps)
curve|curve, e.g. d3.curveMonotoneX
context|render to a canvas context
digits|output precision

# area
x|x accessor
x0|baseline x
x1|topline x
y|y accessor
y0|baseline y, e.g. y(0)
y1|topline y, e.g. d => y(Y(d))
defined|skip points (gaps)
curve|curve, e.g. d3.curveMonotoneX
context|render to a canvas context
digits|output precision
lineX0|line for the left edge
lineY0|line for the baseline
lineX1|line for the right edge
lineY1|line for the topline

# lineRadial
angle|angle accessor
radius|radius accessor
defined|skip points
curve|curve
context|render to a canvas context

# areaRadial
angle|angle accessor
startAngle|start angle accessor
endAngle|end angle accessor
radius|radius accessor
innerRadius|inner radius accessor
outerRadius|outer radius accessor
defined|skip points
curve|curve
context|render to a canvas context
lineStartAngle|line for the start edge
lineInnerRadius|line for the inner edge
lineEndAngle|line for the end edge
lineOuterRadius|line for the outer edge

# link
source|source accessor
target|target accessor
x|x accessor
y|y accessor
angle|angle accessor (radial)
radius|radius accessor (radial)
context|render to a canvas context
digits|output precision

# symbol
type|symbol type, e.g. d3.symbolCircle
size|area in square px
context|render to a canvas context
digits|output precision

# stack
keys|series keys
value|value accessor
order|series order, e.g. d3.stackOrderNone
offset|baseline, e.g. d3.stackOffsetNone

# bin
value|value accessor
domain|value range to bin
thresholds|bin count or edges

# brush
move|move the brush
clear|clear the brush
extent|brushable area [[x0, y0], [x1, y1]]
filter|which events start brushing
touchable|touch support
keyModifiers|key interaction
handleSize|handle size
on|listen: start / brush / end

# drag
container|coordinate system
filter|which events start a drag
touchable|touch support
subject|dragged thing
clickDistance|click distance threshold
on|listen: start / drag / end

# zoom
transform|set the transform
translateBy|translate by
translateTo|translate to
scaleBy|scale by
scaleTo|scale to
constrain|transform constraint
filter|which events zoom
touchable|touch support
wheelDelta|wheel scaling
extent|viewport extent
scaleExtent|allowed scale range [min, max]
translateExtent|zoomable world extent
clickDistance|click distance threshold
tapDistance|tap distance threshold
duration|zoom transition duration
interpolate|zoom interpolation
on|listen: start / zoom / end

# simulation
restart|restart the timer
stop|stop the timer
tick|advance the simulation
nodes|nodes
alpha|current alpha
alphaMin|minimum alpha
alphaDecay|alpha decay rate
alphaTarget|target alpha
velocityDecay|velocity decay
force|add / remove a force
find|closest node
randomSource|random source
on|listen: tick / end

# force
strength|force strength
radius|radius
iterations|iterations
links|links array
id|node id accessor
distance|link distance
theta|Barnes-Hut accuracy
distanceMin|minimum distance
distanceMax|maximum distance
x|target / centre x
y|target / centre y
initialize|initialize with nodes

# node
ancestors|ancestors
descendants|all descendants
leaves|leaf nodes
find|find a node
path|path to another node
links|parent-child links
sum|sum values up the tree
count|count leaves
sort|sort siblings
each|breadth-first visit
eachAfter|post-order visit
eachBefore|pre-order visit
copy|copy the hierarchy

# stratify
id|id accessor
parentId|parent id accessor
path|path accessor

# layout
size|layout size [width, height]
nodeSize|node size
separation|node separation
tile|treemap tiling, e.g. d3.treemapSquarify
round|round coordinates
padding|padding
paddingInner|padding between siblings
paddingOuter|padding around children
paddingTop|top padding
paddingRight|right padding
paddingBottom|bottom padding
paddingLeft|left padding
radius|radius accessor

# geoPath
area|projected area
bounds|projected bounding box
centroid|projected centroid
digits|output precision
measure|projected length
projection|projection
context|render to a canvas context
pointRadius|point radius

# projection
invert|unproject a point
stream|projection stream
preclip|spherical clipping
postclip|planar clipping
clipAngle|clip circle radius
clipExtent|viewport clip extent
scale|scale factor
translate|translation [x, y]
center|centre [lon, lat]
angle|post-projection rotation
reflectX|reflect x
reflectY|reflect y
rotate|rotation [lambda, phi, gamma]
precision|sampling precision
fitExtent|fit GeoJSON to an extent
fitSize|fit GeoJSON to [width, height]
fitWidth|fit GeoJSON to a width
fitHeight|fit GeoJSON to a height
parallels|standard parallels (conic)

# color
opacity|opacity
rgb|RGB equivalent
copy|copy with changes
brighter|brighter copy
darker|darker copy
displayable|displayable on screen
formatHex|#rrggbb
formatHex8|#rrggbbaa
formatHsl|hsl(...)
formatRgb|rgb(...)
toString|rgb(...)
clamp|clamp to the colour space

# quadtree
x|x accessor
y|y accessor
extent|extent
cover|cover a point
add|add a datum
addAll|add data
remove|remove a datum
removeAll|remove data
copy|copy
root|root node
data|all data
size|number of data
find|closest datum
visit|visit nodes
visitAfter|visit nodes post-order

# delaunay
points|point coordinates
halfedges|halfedges
hull|convex hull indices
triangles|triangles
inedges|inedges
find|closest point
neighbors|neighbours of a point
render|render edges
renderHull|render the hull
renderTriangle|render a triangle
renderPoints|render points
hullPolygon|hull polygon
trianglePolygons|triangles as polygons
trianglePolygon|one triangle polygon
update|update in place
voronoi|Voronoi diagram for bounds [x0, y0, x1, y1]

# voronoi
delaunay|the triangulation
circumcenters|circumcentres
vectors|outer cell directions
contains|test a point in a cell
neighbors|neighbouring cells
render|render the cell mesh
renderBounds|render the bounds
renderCell|render a cell
cellPolygons|cells as polygons
cellPolygon|one cell polygon
update|update in place

# dispatch
on|register a listener
copy|copy the dispatcher
call|dispatch an event
apply|dispatch with an argument array

# timer
restart|restart
stop|stop

# contours
contour|one contour
size|grid size
smooth|smooth contours
thresholds|thresholds
x|x accessor
y|y accessor
weight|weight accessor
cellSize|cell size
bandwidth|bandwidth
contours|density contours

# chord
padAngle|gap between groups
sortGroups|group order
sortSubgroups|subgroup order
sortChords|chord order
source|source accessor
target|target accessor
radius|radius
sourceRadius|source radius
targetRadius|target radius
startAngle|start angle
endAngle|end angle
context|render to a canvas context
headRadius|arrow head radius

# zoomTransform
scale|scale a transform
translate|translate a transform
apply|apply to a point
applyX|apply to an x
applyY|apply to a y
invert|unapply a point
invertX|unapply an x
invertY|unapply a y
rescaleX|rescale an x scale
rescaleY|rescale a y scale
toString|SVG transform string
k|scale factor
x|x translation
y|y translation
`;
  const groups = new Map();
  let cur = null;
  for (const raw of TEXT.split('\n')) {
    const l = raw.trim(); if (!l) continue;
    if (l.startsWith('# ')) { cur = l.slice(2); if (!groups.has(cur)) groups.set(cur, new Map()); continue; }
    const [n, d] = l.split('|'); groups.get(cur).set(n, d || '');
  }
  const top = groups.get('d3');
  // Types: which method groups a value has. Scales share 'continuous'.
  const TYPES = {
    selection: ['selection'], transition: ['transition'], axis: ['axis'],
    linear: ['continuous'], pow: ['continuous', 'pow'], log: ['continuous', 'log'], symlog: ['continuous', 'symlog'], time: ['continuous'], radial: ['continuous'], identity: ['continuous'],
    sequential: ['sequential'], quantize: ['quantize'], ordinal: ['ordinal'], band: ['band'], point: ['band'],
    arc: ['arc'], pie: ['pie'], line: ['line'], area: ['area'], lineRadial: ['lineRadial'], areaRadial: ['areaRadial'], link: ['link'], symbol: ['symbol'], stack: ['stack'],
    bin: ['bin'], brush: ['brush'], drag: ['drag'], zoom: ['zoom'], simulation: ['simulation'], force: ['force'], node: ['node'], stratify: ['stratify'], layout: ['layout'],
    geoPath: ['geoPath'], projection: ['projection'], color: ['color'], quadtree: ['quadtree'], delaunay: ['delaunay'], voronoi: ['voronoi'], dispatch: ['dispatch'], timer: ['timer'],
    contours: ['contours'], chord: ['chord'], zoomTransform: ['zoomTransform'],
  };
  function typeOfFactory(n) {
    if (!n) return null;
    if (/^(select|selectAll|create|selection)$/.test(n)) return 'selection';
    if (n === 'transition') return 'transition';
    if (/^axis/.test(n)) return 'axis';
    if (/^scale(Linear|Time|Utc)$/.test(n)) return n === 'scaleLinear' ? 'linear' : 'time';
    if (/^scale(Pow|Sqrt)$/.test(n)) return 'pow';
    if (n === 'scaleLog') return 'log';
    if (n === 'scaleSymlog') return 'symlog';
    if (n === 'scaleRadial') return 'radial';
    if (n === 'scaleIdentity') return 'identity';
    if (/^scale(Sequential|Diverging)/.test(n)) return 'sequential';
    if (/^scale(Quantize|Quantile|Threshold)$/.test(n)) return 'quantize';
    if (n === 'scaleOrdinal') return 'ordinal';
    if (n === 'scaleBand') return 'band';
    if (n === 'scalePoint') return 'point';
    if (/^(arc|pie|line|area|lineRadial|areaRadial|symbol|stack|bin|drag|zoom|dispatch|stratify|quadtree|chord|chordDirected|chordTranspose)$/.test(n)) return n.startsWith('chord') ? 'chord' : n;
    if (/^(ribbon|ribbonArrow)$/.test(n)) return 'chord';
    if (/^link(Vertical|Horizontal|Radial)?$/.test(n)) return 'link';
    if (/^brush[XY]?$/.test(n)) return 'brush';
    if (n === 'forceSimulation') return 'simulation';
    if (/^force/.test(n)) return 'force';
    if (n === 'hierarchy') return 'node';
    if (/^(tree|treemap|cluster|pack|partition)$/.test(n)) return 'layout';
    if (n === 'geoPath') return 'geoPath';
    if (/^geo/.test(n) && !/^geo(Area|Bounds|Centroid|Distance|Length|Interpolate|Contains|Rotation|Stream|Graticule10|Path|Circle|Graticule)$/.test(n)) return 'projection';
    if (/^(color|rgb|hsl|lab|gray|hcl|lch|cubehelix)$/.test(n)) return 'color';
    if (/^(timer|timeout|interval)$/.test(n)) return 'timer';
    if (/^contour/.test(n)) return 'contours';
    if (/^zoom(Transform|Identity)$/.test(n)) return 'zoomTransform';
    return null;
  }
  // From the library itself: everything it really has (names only, descriptions from the catalog when known).
  const live = new Map();   // type -> Set(method)
  function probe() {
    if (typeof d3 === 'undefined' || live.size) return;
    for (const k of Object.keys(d3)) if (!top.has(k)) top.set(k, typeof d3[k] === 'function' ? 'D3 function' : 'D3 value');
    const add = (type, obj, proto) => { try { const s = live.get(type) || new Set(); for (const k of proto ? Object.getOwnPropertyNames(obj) : Object.keys(obj)) if (k !== 'constructor' && !k.startsWith('_') && typeof obj[k] === 'function') s.add(k); live.set(type, s); } catch {} };
    add('selection', d3.selection.prototype, true); add('transition', d3.transition.prototype, true);
    const inst = { linear: () => d3.scaleLinear(), pow: () => d3.scalePow(), log: () => d3.scaleLog(), symlog: () => d3.scaleSymlog(), time: () => d3.scaleTime(), radial: () => d3.scaleRadial(),
      identity: () => d3.scaleIdentity(), sequential: () => d3.scaleSequential(), quantize: () => d3.scaleQuantize(), ordinal: () => d3.scaleOrdinal(), band: () => d3.scaleBand(), point: () => d3.scalePoint(),
      axis: () => d3.axisBottom(d3.scaleLinear()), arc: () => d3.arc(), pie: () => d3.pie(), line: () => d3.line(), area: () => d3.area(), lineRadial: () => d3.lineRadial(), areaRadial: () => d3.areaRadial(),
      link: () => d3.linkHorizontal(), symbol: () => d3.symbol(), stack: () => d3.stack(), bin: () => d3.bin(), brush: () => d3.brush(), drag: () => d3.drag(), zoom: () => d3.zoom(),
      simulation: () => { const s = d3.forceSimulation(); s.stop(); return s; }, force: () => d3.forceManyBody(), stratify: () => d3.stratify(), layout: () => d3.treemap(),
      geoPath: () => d3.geoPath(), projection: () => d3.geoMercator(), quadtree: () => d3.quadtree(), dispatch: () => d3.dispatch('x'), contours: () => d3.contours(), chord: () => d3.chord() };
    for (const [t, f] of Object.entries(inst)) { try { add(t, f()); } catch {} }
    try { add('node', Object.getPrototypeOf(d3.hierarchy({})), true); } catch {}
    try { add('color', Object.getPrototypeOf(d3.rgb('red')), true); add('color', Object.getPrototypeOf(Object.getPrototypeOf(d3.rgb('red'))), true); } catch {}
    try { add('zoomTransform', Object.getPrototypeOf(d3.zoomIdentity), true); } catch {}
  }
  function methods(type) {
    probe();
    const out = new Map();
    for (const g of TYPES[type] || []) for (const [k, v] of groups.get(g) || []) out.set(k, v);
    for (const k of live.get(type) || []) if (!out.has(k)) out.set(k, '');
    return out;
  }
  let every = null;
  const allMethods = () => { if (every) return every; probe(); every = new Map(); for (const t of Object.keys(TYPES)) for (const [k, v] of methods(t)) if (!every.has(k) || !every.get(k)) every.set(k, v); return every; };
  // Edit distance (swapped letters count as one), for "did you mean".
  function dist(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // swapped letters
    }
    return d[a.length][b.length];
  }
  function closest(name, list) {
    let best = null, bd = Infinity;
    for (const c of list) { const k = dist(name, c); if (k < bd) { bd = k; best = c; } }
    return best && bd <= (name.length <= 2 ? 0 : Math.max(1, Math.floor(name.length / 4))) ? best : null;
  }
  return { get top() { probe(); return top; }, methods, typeOfFactory, get allMethods() { return allMethods(); }, closest, TYPES };
})();
