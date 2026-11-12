/**
 * CourtPad — score-differential chart.
 *
 * The embedded line chart is created ONCE at setup over a fixed range of the
 * hidden GraphData tab; every sync just rewrites that tab's values, so the
 * chart follows automatically (the old system deleted and recreated the chart
 * on every event — its single biggest latency cost).
 *
 * GraphData columns: Event | Score Diff | Q2 | Q3 | Q4 | OT1 | OT2 | OT3
 * Quarter breaks are drawn Livestat-style: a marker series with two points at
 * x±0.001 spanning past the data range renders as a vertical line.
 */

var GRAPH_COLS = 8;
var GRAPH_MAX_ROWS = 400; // ~150 scoring events + markers, with headroom
var MARKER_LABELS = ['Q2', 'Q3', 'Q4', 'OT1', 'OT2', 'OT3'];

function createScoreChart_(ss, rec, gameSheet, geo) {
  var graph = ss.insertSheet(rec.graphTabName);
  graph.getRange(1, 1, 1, GRAPH_COLS).setValues(
    [['Event', 'Score Diff', 'Q2', 'Q3', 'Q4', 'OT1', 'OT2', 'OT3']]);
  graph.hideSheet();

  var seriesOpts = {
    0: { color: '#4285f4', lineWidth: 2, pointSize: 4 }
  };
  for (var i = 1; i <= MARKER_LABELS.length; i++) {
    seriesOpts[i] = { color: '#888888', lineWidth: 1, lineDashStyle: [6, 3], pointSize: 0 };
  }

  var chart = gameSheet.newChart()
    .asLineChart()
    .addRange(graph.getRange(1, 1, GRAPH_MAX_ROWS, GRAPH_COLS))
    .setNumHeaders(1)
    .setOption('title', 'Score Differential (' + rec.setup.teams[0].name + ')')
    .setOption('legend', { position: 'none' })
    .setOption('hAxis', { title: 'Scoring Event #' })
    .setOption('vAxis', { title: 'Score Differential' })
    .setOption('interpolateNulls', false)
    .setOption('series', seriesOpts)
    .setPosition(geo.subStart, 17, 0, 0)
    .setOption('width', 640)
    .setOption('height', 400)
    .build();
  gameSheet.insertChart(chart);
}

function writeGraphData_(ss, rec, snap) {
  var graph = ss.getSheetByName(rec.graphTabName);
  if (!graph) return;

  var series = snap.series || [];
  var marks = snap.quarterMarks || [];

  var minY = 0, maxY = 0;
  series.forEach(function (p) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  var pad = Math.max(10, (maxY - minY) / 2);
  var spanLow = minY - pad, spanHigh = maxY + pad;

  function blankRow() {
    var r = [];
    for (var i = 0; i < GRAPH_COLS; i++) r.push('');
    return r;
  }

  var rows = [];
  var start = blankRow(); start[0] = 0; start[1] = 0;
  rows.push(start);
  series.forEach(function (p) {
    var r = blankRow(); r[0] = p.x; r[1] = p.y;
    rows.push(r);
  });
  marks.forEach(function (x, i) {
    if (i >= MARKER_LABELS.length) return;
    var lo = blankRow(); lo[0] = x - 0.001; lo[2 + i] = spanLow;
    var hi = blankRow(); hi[0] = x + 0.001; hi[2 + i] = spanHigh;
    rows.push(lo, hi);
  });
  rows.sort(function (a, b) { return a[0] - b[0]; });

  var lastRow = graph.getLastRow();
  if (lastRow > 1) graph.getRange(2, 1, lastRow - 1, GRAPH_COLS).clearContent();
  if (rows.length) {
    graph.getRange(2, 1, Math.min(rows.length, GRAPH_MAX_ROWS - 1), GRAPH_COLS)
      .setValues(rows.slice(0, GRAPH_MAX_ROWS - 1));
  }
}
