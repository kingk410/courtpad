/**
 * CourtPad — team shot heat maps.
 *
 * One half-court grid per team, painted straight into cells on the game tab
 * to the right of the score chart (column AE onward): 16 x 15 square cells
 * (~3 ft each), baseline at the top like the iPad court sketch. Each cell
 * shows made/attempts and is colored by FG% (red = cold, yellow = even,
 * green = hot), deeper with more attempts. Empty cells keep a base tone that
 * draws the court: the paint, mid-range, and beyond the 3-point arc.
 *
 * A zone table (Paint / Mid-range / 3PT / All FG) sits above each grid.
 * Structure (merges, widths, borders, fonts) is painted once at setup; every
 * sync writes values + backgrounds (2 range writes per team) — no charts, so
 * nothing to rebuild and nothing that can render blank.
 *
 * Version 1 of this feature used embedded scatter charts over a hidden
 * ShotChart_<game> tab; retrofitShotHeatmap_ removes those and paints the
 * grid the first time an older game syncs. Painting is best-effort: a
 * failure logs and never blocks game setup or a sync.
 */

var SHOT_CHART_VERSION = 2;
var SHOT_COL = 31;           // AE: team A block; team B at SHOT_COL + SHOT_BLOCK_W
var GRID_COLS = 16, GRID_ROWS = 15;
var SHOT_BLOCK_W = GRID_COLS + 1;   // grid + 1 gap column
var SHOT_TABLE_ROWS = 7;     // title, header, 4 zone rows, note — grid starts below
var SHOT_CELL_PX = 28;
var SHOT_ZONES = [['Paint', 'paint'], ['Mid-range', 'mid'], ['3PT', 'three'], ['All FG', 'all']];
var COURT_W = 50, COURT_H = 47;     // half court in feet, same space as the app's SVG
var RIM_X = 25, RIM_Y = 5.25, ARC_R = 19.75;
var ZONE_TONES = { paint: '#fdebd0', mid: '#fff8e1', three: '#e3e8ec' };

/** Shot zone from the event: 3PT by shot type, paint = inside the key. */
function shotZone_(s) {
  if (s.shot === 3) return 'three';
  if (s.x >= 19 && s.x <= 31 && s.y >= 0 && s.y <= 19) return 'paint';
  return 'mid';
}

/** Court zone of a point, by geometry (used for the empty-cell base tones). */
function courtZoneAt_(x, y) {
  var dx = x - RIM_X, dy = y - RIM_Y;
  if (dx * dx + dy * dy > ARC_R * ARC_R) return 'three';
  if (x >= 19 && x <= 31 && y <= 19) return 'paint';
  return 'mid';
}

/** Makes / attempts / points per zone for one team, from located shots. */
function shotZoneSummary_(shots, teamCode) {
  var z = {};
  ['paint', 'mid', 'three', 'all'].forEach(function (k) { z[k] = { m: 0, a: 0, pts: 0 }; });
  (shots || []).forEach(function (s) {
    if (s.team !== teamCode) return;
    var zone = shotZone_(s);
    [z[zone], z.all].forEach(function (acc) {
      acc.a++;
      if (s.made) { acc.m++; acc.pts += s.shot === 3 ? 3 : 2; }
    });
  });
  return z;
}

/** Grid cell [col, row] (0-based) for a shot location. */
function gridCell_(x, y) {
  var c = Math.floor(x / (COURT_W / GRID_COLS));
  var r = Math.floor(y / (COURT_H / GRID_ROWS));
  return [Math.min(GRID_COLS - 1, Math.max(0, c)), Math.min(GRID_ROWS - 1, Math.max(0, r))];
}

/** Per-cell {m, a} counts for one team: grid[row][col]. */
function shotGrid_(shots, teamCode) {
  var grid = [];
  for (var r = 0; r < GRID_ROWS; r++) {
    grid.push([]);
    for (var c = 0; c < GRID_COLS; c++) grid[r].push({ m: 0, a: 0 });
  }
  (shots || []).forEach(function (s) {
    if (s.team !== teamCode) return;
    var cell = gridCell_(s.x, s.y);
    var g = grid[cell[1]][cell[0]];
    g.a++;
    if (s.made) g.m++;
  });
  return grid;
}

function mixRgb_(a, b, t) {
  return [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * t); });
}

function rgbHex_(c) {
  return '#' + c.map(function (v) {
    var h = Math.max(0, Math.min(255, v)).toString(16);
    return h.length < 2 ? '0' + h : h;
  }).join('');
}

/**
 * Heat color for a cell: hue from FG% (red 0% -> yellow 50% -> green 100%),
 * strength from attempts (1 attempt is pale, 5+ is full).
 */
function heatColor_(m, a) {
  var RED = [229, 57, 53], YEL = [253, 216, 53], GRN = [67, 160, 71];
  var p = m / a;
  var hue = p < 0.5 ? mixRgb_(RED, YEL, p / 0.5) : mixRgb_(YEL, GRN, (p - 0.5) / 0.5);
  var strength = Math.min(1, 0.45 + 0.14 * (a - 1));
  return rgbHex_(mixRgb_([255, 255, 255], hue, strength));
}

/** Base tone of every grid cell (court drawing for empty cells). */
function baseTones_() {
  var rows = [];
  for (var r = 0; r < GRID_ROWS; r++) {
    var row = [];
    for (var c = 0; c < GRID_COLS; c++) {
      var x = (c + 0.5) * COURT_W / GRID_COLS;
      var y = (r + 0.5) * COURT_H / GRID_ROWS;
      row.push(ZONE_TONES[courtZoneAt_(x, y)]);
    }
    rows.push(row);
  }
  return rows;
}

function ensureShotColumns_(sheet) {
  var need = SHOT_COL + 2 * SHOT_BLOCK_W + 1;
  var have = sheet.getMaxColumns();
  if (have < need) sheet.insertColumnsAfter(have, need - have);
}

/** Frame for both teams: zone table, grid formatting, court borders, legend. */
function paintShotFrame_(sheet, geo, setup) {
  ensureShotColumns_(sheet);
  var S = geo.subStart;
  var G = S + SHOT_TABLE_ROWS;
  var tones = baseTones_();
  sheet.setRowHeights(G, GRID_ROWS, SHOT_CELL_PX);
  for (var t = 0; t < 2; t++) {
    var c = SHOT_COL + t * SHOT_BLOCK_W;
    sheet.setColumnWidths(c, GRID_COLS, SHOT_CELL_PX);
    sheet.setColumnWidth(c + GRID_COLS, 20);

    // Zone table: 4 columns, each merged over 4 grid columns.
    sheet.getRange(S, c, 1, GRID_COLS).merge()
      .setValue(setup.teams[t].name.toUpperCase() + ' SHOT CHART')
      .setBackground('#ffe0b2').setFontWeight('bold').setHorizontalAlignment('center');
    var headers = ['Zone', 'FG', 'FG%', 'PTS'];
    for (var k = 0; k < 4; k++) {
      sheet.getRange(S + 1, c + k * 4, 1, 4).merge().setValue(headers[k]);
      for (var z = 0; z < SHOT_ZONES.length; z++) {
        sheet.getRange(S + 2 + z, c + k * 4, 1, 4).merge();
      }
    }
    sheet.getRange(S + 1, c, 1, GRID_COLS).setFontWeight('bold')
      .setBackground('#fff3e0').setHorizontalAlignment('center');
    sheet.getRange(S + 2, c, SHOT_ZONES.length, 1).setValues(
      SHOT_ZONES.map(function (zn) { return [zn[0]]; }));
    sheet.getRange(S + 2, c + 4, SHOT_ZONES.length, 12).setHorizontalAlignment('center');
    sheet.getRange(S + 2, c + 8, SHOT_ZONES.length, 4).setNumberFormat('0%');
    sheet.getRange(S + 1 + SHOT_ZONES.length, c, 1, GRID_COLS).setFontWeight('bold');
    sheet.getRange(S + 2 + SHOT_ZONES.length, c, 1, GRID_COLS).merge()
      .setFontColor('#888888').setFontStyle('italic').setFontSize(9);

    // Grid: base tones, small centered text, court borders.
    var grid = sheet.getRange(G, c, GRID_ROWS, GRID_COLS);
    grid.setBackgrounds(tones).setFontSize(8).setFontColor('#333333')
      .setHorizontalAlignment('center').setVerticalAlignment('middle')
      .setBorder(true, true, true, true, false, false, '#455a64', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    // Key: x 19..31 ft, y 0..19 ft -> grid cols 6..9, rows 0..5 (cell ~3.1 ft).
    sheet.getRange(G, c + 6, 6, 4)
      .setBorder(null, true, true, true, false, false, '#455a64', SpreadsheetApp.BorderStyle.SOLID);
    // Rim marker (x 25, y 5.25 -> rows 1, straddling cols 7/8).
    sheet.getRange(G + 1, c + 7, 1, 2).setFontWeight('bold');

    // Legend.
    sheet.getRange(G + GRID_ROWS, c, 1, GRID_COLS).merge()
      .setValue('cell = made/attempts · red = cold, green = hot · grey = beyond the arc, tan = paint')
      .setFontColor('#888888').setFontStyle('italic').setFontSize(9).setHorizontalAlignment('center');
  }
}

/** Setup: paint the heat-map frames for a new game. */
function createShotCharts_(ss, rec, sheet, geo) {
  paintShotFrame_(sheet, geo, rec.setup);
  rec.shotChartVersion = SHOT_CHART_VERSION;
}

/** Remove the v1 scatter charts / hidden tab / 4-column frame, if present. */
function clearShotChartsV1_(ss, rec, sheet, geo) {
  sheet.getCharts().forEach(function (ch) {
    if (ch.getContainerInfo().getAnchorColumn() >= SHOT_COL) sheet.removeChart(ch);
  });
  if (rec.shotTabName) {
    var tab = ss.getSheetByName(rec.shotTabName);
    if (tab) ss.deleteSheet(tab);
    delete rec.shotTabName;
  }
  var old = sheet.getRange(geo.subStart, SHOT_COL, SHOT_TABLE_ROWS, 10);
  old.breakApart();
  old.clearContent();
  old.clearFormat();
}

/**
 * Bring a game onto the current shot-chart layout. Called from api_syncGame
 * when the record's version is behind. The version is recorded before
 * painting so a failed attempt is not retried on every sync.
 */
function retrofitShotHeatmap_(ss, rec) {
  rec.shotChartVersion = SHOT_CHART_VERSION;
  var sheet = ss.getSheetByName(rec.tabName);
  if (!sheet) return;
  try {
    var geo = geometry_(rec.setup);
    clearShotChartsV1_(ss, rec, sheet, geo);
    paintShotFrame_(sheet, geo, rec.setup);
  } catch (err) {
    Logger.log('Shot heat map retrofit failed for ' + rec.tabName + ': ' + err);
  }
}

/** Values-only: zone tables + heat grids (called from renderSnapshot_). */
function writeShotHeatmap_(sheet, geo, setup, snap) {
  var S = geo.subStart;
  var G = S + SHOT_TABLE_ROWS;
  var tones = baseTones_();
  for (var t = 0; t < 2; t++) {
    var c = SHOT_COL + t * SHOT_BLOCK_W;
    var code = setup.teams[t].code;

    // Zone table (merged 4-wide cells: value in the anchor, '' elsewhere).
    var z = shotZoneSummary_(snap.shots, code);
    var out = SHOT_ZONES.map(function (zone) {
      var v = z[zone[1]];
      var row = [];
      [zone[0], v.m + '-' + v.a, fmtPct_(v.m, v.a), v.pts].forEach(function (val) {
        row.push(val, '', '', '');
      });
      return row;
    });
    sheet.getRange(S + 2, c, out.length, GRID_COLS).setValues(out);
    var totals = (snap.teams[t] && snap.teams[t].totals) || {};
    var missing = Math.max(0, (totals.FGA || 0) - z.all.a);
    sheet.getRange(S + 2 + SHOT_ZONES.length, c).setValue(
      missing ? missing + ' FGA without a location' : '');

    // Heat grid.
    var grid = shotGrid_(snap.shots, code);
    var values = [], colors = [];
    for (var r = 0; r < GRID_ROWS; r++) {
      var vrow = [], crow = [];
      for (var k = 0; k < GRID_COLS; k++) {
        var g = grid[r][k];
        vrow.push(g.a ? g.m + '/' + g.a : '');
        crow.push(g.a ? heatColor_(g.m, g.a) : tones[r][k]);
      }
      values.push(vrow);
      colors.push(crow);
    }
    var range = sheet.getRange(G, c, GRID_ROWS, GRID_COLS);
    range.setValues(values);
    range.setBackgrounds(colors);
  }
}
