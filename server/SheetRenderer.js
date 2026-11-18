/**
 * CourtPad — spreadsheet renderer.
 *
 * Structure (headers, merges, number formats, borders, charts) is painted
 * ONCE with fixed geometry — roster sizes are known, so every table has a
 * reserved block. After that, api_syncGame writes values per table, plus the
 * box score's backgrounds and font colors (heat tints, zebra stripes, dimmed
 * did-not-play rows), which are computed here rather than left to
 * conditional formatting so an all-zero column stays white.
 *
 * Column map: A:X box score, Z.. team shot heat maps + zone tables beside
 * it (ShotChart.js). No frozen columns: Sheets can only freeze a column for
 * the whole tab, which also pinned the tables below the box score.
 *
 * Layout below the box score and shot charts (row S = geo.subStart):
 *   S     ADVANCED A:E | QUARTER STATS G:Q | PLAY STATS S:Y
 *   S+12               | FOUL TROUBLE G:O  | score chart at Q
 *
 * LAYOUT_VERSION is stamped on each game record; a game painted with an
 * older layout is wiped and re-framed on its next sync (retrofitLayout_).
 */

var LAYOUT_VERSION = 6;

// Headline numbers first, then shooting (made-attempted in one cell), then
// the rest. No team column: each block ends in a row carrying the team name.
var HEADERS = ['Name', '#', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TOV', 'PF',
  'FG', 'FG%', '2P', '2P%', '3P', '3P%', 'FT', 'FT%',
  'OREB', 'DREB', 'CHG', 'DEFL', 'PFD', 'MIN*', '+/-'];
var NCOLS = HEADERS.length; // 24
// One explicit number format per box-score column (nothing left on Automatic).
var COL_FORMATS = ['@', '@', '0', '0', '0', '0', '0', '0', '0',
  '@', '0%', '@', '0%', '@', '0%', '@', '0%',
  '0', '0', '0', '0', '0', '0.0', '+0;-0;0'];
var HEADER_ROW = 2;
var FIRST_DATA_ROW = 3;
var QUARTER_ROWS = ['Q1', 'Q2', 'Q3', 'Q4', 'OT1', 'OT2', '1H', '2H'];
var ADV_W = 5;      // advanced stats: stat | team A (2 cols) | team B (2 cols)
var QCOL = 7;       // quarter/foul tables anchor at column G
var FOUL_W = 9;     // # | name (2 cols) | PF | gap | # | name (2 cols) | PF
var PLAY_COL = 19;  // play stats anchor at column S (name merged over 2 cols)
var PLAY_NAME_SPAN = 2;
var PLAY_W = PLAY_NAME_SPAN + 5;
var CHART_COL = 17; // score chart anchors at column Q, beside foul trouble
var BANNER_W = 10;  // row-1 scoreboard spans A:J only, so it never gets cut off
var PM_COL = 24;
var FONT = 'Roboto';
var ROW_PX = 28;    // every row below the scoreboard (matches the shot-grid cells)
var STAT_PX = 50;   // stat column width (also the spacer before the shot charts)

// Heat tints: column -> index of the number in the box row that drives it
// (made-attempted cells are tinted by makes).
var GREEN_COLS = [3, 4, 5, 6, 7, 10, 12, 14, 16, 18, 19, 20, 21, 22];
var RED_COLS = [8, 9]; // TOV, PF
var HEAT_GREEN = [87, 187, 138], HEAT_RED = [224, 102, 102];

var TEAM_COLORS = [
  { solid: '#3b82f6', tint: '#dbe7fd' },  // my team (blue, as in the app)
  { solid: '#f97316', tint: '#fde6d3' }   // opponent (orange)
];
var ZEBRA = '#f5f6f8';
var DIM_FONT = '#b4b4b4';
var FRAME = '#cfcfcf';

// Header band colors, carried over from Livestat's styleStatsSheet.
var BANDS = [
  { cols: [1, 2], color: '#eeeeee' },   // Name, #
  { cols: [3, 3], color: '#cce0ff' },   // PTS
  { cols: [4, 7], color: '#e0f4e0' },   // REB-BLK
  { cols: [8, 9], color: '#f8d7da' },   // TOV/PF
  { cols: [10, 11], color: '#ffe5cc' }, // FG
  { cols: [12, 13], color: '#fff7cc' }, // 2P
  { cols: [14, 15], color: '#e6ffea' }, // 3P
  { cols: [16, 17], color: '#d6eaff' }, // FT
  { cols: [18, 19], color: '#e0f4e0' }, // OREB/DREB
  { cols: [20, 22], color: '#ead2b8' }, // intangibles
  { cols: [23, 24], color: '#e0e0e0' }  // MIN,+/-
];

/** Rows-per-team block and overall geometry, all derived from the setup. */
function geometry_(setup) {
  var nA = setup.teams[0].roster.length;
  var nB = setup.teams[1].roster.length;
  var teamARows = { start: FIRST_DATA_ROW, count: nA };
  var teamBRows = { start: FIRST_DATA_ROW + nA + 1, count: nB };
  var totalA = FIRST_DATA_ROW + nA;
  var totalB = FIRST_DATA_ROW + nA + 1 + nB;
  var lastBoxRow = totalB;
  // Shot charts sit beside the box score from the header row down; the
  // sub-tables start below whichever of the two ends lower.
  var shotRow = HEADER_ROW;
  var shotEnd = shotRow + SHOT_TABLE_ROWS + GRID_ROWS; // legend row
  var sub = Math.max(lastBoxRow, shotEnd) + 2;
  var foulTitle = sub + 12;             // the quarter block is 11 rows tall
  var maxFoulRows = Math.max(nA, nB);
  // PLAY STATS sits on the first sub-table row, right of the quarter table.
  // Rows are counted only when the game has a playbook (+4 spare rows for
  // plays added mid-game); the spot itself is always reserved.
  var playRows = (setup.plays && setup.plays.length) ? setup.plays.length + 4 : 0;
  // The score chart goes beside foul trouble, pushed down if the play table
  // is tall enough to reach it.
  var chartRow = Math.max(foulTitle, playRows ? sub + 2 + playRows + 1 : 0);
  return {
    nA: nA, nB: nB, teamARows: teamARows, teamBRows: teamBRows,
    totalA: totalA, totalB: totalB, lastBoxRow: lastBoxRow,
    shotRow: shotRow, subStart: sub, foulTitle: foulTitle, maxFoulRows: maxFoulRows,
    playTitle: sub, playRows: playRows, chartRow: chartRow
  };
}

/** Create a new game's tabs and paint the game tab. Called once from setup. */
function createGameSheets_(ss, rec) {
  var setup = rec.setup;
  var geo = geometry_(setup);

  var sheet = ss.insertSheet(rec.tabName);
  paintGameFrame_(sheet, setup, geo);
  rec.layoutVersion = LAYOUT_VERSION;

  createScoreChart_(ss, rec, sheet, geo); // ChartManager.js
  try {
    createShotCharts_(ss, rec, sheet, geo); // ShotChart.js heat maps (best-effort)
  } catch (err) {
    Logger.log('Shot chart creation failed for ' + rec.tabName + ': ' + err);
  }

  // Log tab (audit trail in the legacy command grammar).
  var logSheet = ss.insertSheet(rec.logTabName);
  logSheet.getRange(1, 1).setValue(rec.tabName).setFontWeight('bold');
  logSheet.setColumnWidth(1, 260);
  logSheet.hideSheet(); // audit trail only — kept out of the tab bar

  // Shots data tab.
  var shotSheet = ss.insertSheet('Shots_' + rec.tabName);
  shotSheet.getRange(1, 1, 1, 7).setValues(
    [['Team', '#', 'Q', 'Shot', 'Made', 'X', 'Y']]).setFontWeight('bold');
  shotSheet.hideSheet();

  // Delete the default empty sheet on a brand-new spreadsheet.
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1 && s1.getLastRow() === 0) ss.deleteSheet(s1);
}

function frame_(range) {
  range.setBorder(true, true, true, true, null, null, FRAME, SpreadsheetApp.BorderStyle.SOLID);
}

/** Row 1: a compact scoreboard in A:J (name | score – score | name   period). */
function paintBanner_(sheet) {
  sheet.setRowHeight(1, 40);
  sheet.getRange(1, 1, 1, BANNER_W).setNumberFormat('@').setFontWeight('bold')
    .setVerticalAlignment('middle').setHorizontalAlignment('center')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(1, 1).setBackground(TEAM_COLORS[0].solid).setFontColor('#ffffff')
    .setFontSize(14).setHorizontalAlignment('right');
  sheet.getRange(1, 2).setBackground(TEAM_COLORS[0].tint).setFontSize(18);
  sheet.getRange(1, 3).setFontColor('#888888').setFontSize(14);
  sheet.getRange(1, 4).setBackground(TEAM_COLORS[1].tint).setFontSize(18);
  sheet.getRange(1, 5, 1, 3).merge().setBackground(TEAM_COLORS[1].solid).setFontColor('#ffffff')
    .setFontSize(14).setHorizontalAlignment('left');
  sheet.getRange(1, 9, 1, 2).merge().setBackground('#263238').setFontColor('#ffffff')
    .setFontSize(13);
}

/**
 * Paint the fixed structure of the game tab's box-score area (everything
 * left of the shot charts): scoreboard, headers, number formats, borders,
 * sub-table frames. Values and box-score colors come from every sync.
 */
function paintGameFrame_(sheet, setup, geo) {
  ensureShotColumns_(sheet);
  // One font, vertically centred, in roomier rows — everywhere on the tab.
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns())
    .setFontFamily(FONT).setVerticalAlignment('middle');
  sheet.setRowHeights(2, sheet.getMaxRows() - 1, ROW_PX);
  sheet.setFrozenRows(HEADER_ROW);
  sheet.setFrozenColumns(0);
  sheet.setHiddenGridlines(true);
  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidths(2, NCOLS, STAT_PX); // through the spacer column

  paintBanner_(sheet);

  // Row 2: column headers with Livestat's band colors and group borders.
  var boxRows = geo.lastBoxRow - HEADER_ROW;
  sheet.getRange(HEADER_ROW, 1, 1, NCOLS).setNumberFormat('@').setValues([HEADERS])
    .setFontWeight('bold').setHorizontalAlignment('center')
    .setBorder(null, null, true, null, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
  for (var b = 0; b < BANDS.length; b++) {
    var w = BANDS[b].cols[1] - BANDS[b].cols[0] + 1;
    sheet.getRange(HEADER_ROW, BANDS[b].cols[0], 1, w).setBackground(BANDS[b].color);
    sheet.getRange(HEADER_ROW, BANDS[b].cols[0], boxRows + 1, w)
      .setBorder(null, true, null, true, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
  }

  // Box rows: an explicit format for every cell, names left, numbers centered.
  var formats = [];
  for (var r = 0; r < boxRows; r++) formats.push(COL_FORMATS);
  var box = sheet.getRange(FIRST_DATA_ROW, 1, boxRows, NCOLS);
  box.setNumberFormats(formats).setHorizontalAlignment('center')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(FIRST_DATA_ROW, 1, boxRows, 1).setHorizontalAlignment('left');
  frame_(sheet.getRange(HEADER_ROW, 1, boxRows + 1, NCOLS));

  // Team rows (the old TEAM TOTAL): bold, in the team's tint.
  [geo.totalA, geo.totalB].forEach(function (row, t) {
    sheet.getRange(row, 1, 1, NCOLS).setFontWeight('bold').setBackground(TEAM_COLORS[t].tint)
      .setBorder(true, null, true, null, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
  });

  // ---- Sub-table frames ----
  var S = geo.subStart;

  // Advanced stats, A:E — one row per stat, one (2-col) column per team.
  sheet.getRange(S, 1, 1, ADV_W).merge().setValue('ADVANCED STATS')
    .setBackground('#d9c2f0').setFontWeight('bold').setHorizontalAlignment('center');
  for (var ar = 1; ar <= 4; ar++) {
    sheet.getRange(S + ar, 2, 1, 2).merge();
    sheet.getRange(S + ar, 4, 1, 2).merge();
  }
  sheet.getRange(S + 1, 1, 1, ADV_W).setNumberFormat('@').setValues(
    [['', setup.teams[0].name, '', setup.teams[1].name, '']])
    .setFontWeight('bold').setBackground('#f3eaff').setHorizontalAlignment('center')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(S + 2, 1, 3, 1).setNumberFormat('@');
  sheet.getRange(S + 2, 2, 3, 4).setNumberFormat('0').setHorizontalAlignment('center');
  frame_(sheet.getRange(S, 1, 5, ADV_W));

  // Quarter stats, 11 cols anchored at QCOL.
  sheet.getRange(S, QCOL, 1, 11).merge().setValue('QUARTER STATS')
    .setBackground('#c8e6c9').setFontWeight('bold').setHorizontalAlignment('center');
  for (var t = 0; t < 2; t++) {
    sheet.getRange(S + 1, QCOL + 1 + t * 5, 1, 5).merge()
      .setNumberFormat('@').setValue(setup.teams[t].name.toUpperCase())
      .setFontWeight('bold').setBackground('#e8f5e9').setHorizontalAlignment('center');
  }
  sheet.getRange(S + 2, QCOL, 1, 11).setNumberFormat('@').setValues(
    [['', 'PTS', 'FG', 'FG%', 'TOV', 'PF', 'PTS', 'FG', 'FG%', 'TOV', 'PF']])
    .setFontWeight('bold').setHorizontalAlignment('center');
  var qFmt = ['@', '0', '@', '0%', '0', '0', '0', '@', '0%', '0', '0'];
  var qFormats = QUARTER_ROWS.map(function () { return qFmt; });
  var qData = QUARTER_ROWS.map(function (label) {
    return [label, '', '', '', '', '', '', '', '', '', ''];
  });
  sheet.getRange(S + 3, QCOL, QUARTER_ROWS.length, 11).setNumberFormats(qFormats)
    .setValues(qData).setHorizontalAlignment('center');
  sheet.getRange(S + 3, QCOL, QUARTER_ROWS.length, 1).setFontWeight('bold');
  // Halves highlighted like Livestat.
  sheet.getRange(S + 3 + 6, QCOL, 2, 11).setBackground('#fff9c4');
  frame_(sheet.getRange(S, QCOL, 3 + QUARTER_ROWS.length, 11));

  // Foul trouble, anchored at QCOL: # | name (2 cols) | PF, per team.
  var F = geo.foulTitle;
  sheet.getRange(F, QCOL, 1, FOUL_W).merge().setValue('FOUL TROUBLE')
    .setBackground('#f8d7da').setFontWeight('bold').setHorizontalAlignment('center');
  [0, 1].forEach(function (ti) {
    var c = QCOL + ti * 5;
    sheet.getRange(F + 1, c, 1, 4).merge().setNumberFormat('@')
      .setValue(setup.teams[ti].name.toUpperCase())
      .setFontWeight('bold').setHorizontalAlignment('center');
    for (var fr = 0; fr <= geo.maxFoulRows; fr++) sheet.getRange(F + 2 + fr, c + 1, 1, 2).merge();
    sheet.getRange(F + 2, c, 1, 4).setNumberFormat('@').setValues([['#', 'Name', '', 'PF']])
      .setFontWeight('bold').setHorizontalAlignment('center');
    sheet.getRange(F + 3, c, geo.maxFoulRows, 3).setNumberFormat('@')
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    sheet.getRange(F + 3, c, geo.maxFoulRows, 1).setHorizontalAlignment('center');
    sheet.getRange(F + 3, c + 3, geo.maxFoulRows, 1).setNumberFormat('0')
      .setHorizontalAlignment('center');
  });
  frame_(sheet.getRange(F, QCOL, 3 + geo.maxFoulRows, FOUL_W));

  // Play stats frame (only when the game has a playbook).
  paintPlayFrame_(sheet, geo);

  addConditionalFormatting_(sheet, geo);
}

/**
 * Bring a game tab painted with an older layout onto the current one: wipe
 * the whole tab (values, formats, merges, rules, sizes), repaint the box
 * score and shot-chart frames, and move the score chart to its new spot.
 * The sync that triggered this then writes the values.
 */
function retrofitLayout_(ss, rec) {
  var sheet = ss.getSheetByName(rec.tabName);
  if (!sheet) return;
  var geo = geometry_(rec.setup);
  var hadV1ShotCharts = rec.shotChartVersion !== SHOT_CHART_VERSION;
  ensureShotColumns_(sheet);
  var all = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
  all.breakApart();
  // Reset every property explicitly: a plain clear() left earlier layouts'
  // fills and number formats behind in columns the new table doesn't cover.
  all.clearContent();
  all.clearFormat();
  all.setBackground(null).setFontColor(null).setFontWeight('normal')
    .setFontStyle('normal').setFontSize(10).setNumberFormat('General')
    .setHorizontalAlignment(null)
    .setBorder(false, false, false, false, false, false);
  sheet.clearConditionalFormatRules();
  sheet.setColumnWidths(1, sheet.getMaxColumns(), STAT_PX);
  SpreadsheetApp.flush();

  paintGameFrame_(sheet, rec.setup, geo);
  paintShotFrame_(sheet, geo, rec.setup); // ShotChart.js
  rec.shotChartVersion = SHOT_CHART_VERSION;
  if (rec.shotTabName) { // hidden data tab of the v1 scatter charts
    var old = ss.getSheetByName(rec.shotTabName);
    if (old) ss.deleteSheet(old);
    delete rec.shotTabName;
  }
  positionScoreChart_(sheet, geo, hadV1ShotCharts); // ChartManager.js
}

function paintPlayFrame_(sheet, geo) {
  if (!geo.playRows) return;
  var P = geo.playTitle;
  sheet.getRange(P, PLAY_COL, 1, PLAY_W).merge().setValue('PLAY STATS')
    .setBackground('#cfe2ff').setFontWeight('bold').setHorizontalAlignment('center');
  for (var r = 0; r <= geo.playRows; r++) {
    sheet.getRange(P + 1 + r, PLAY_COL, 1, PLAY_NAME_SPAN).merge();
  }
  sheet.getRange(P + 1, PLAY_COL, 1, PLAY_W).setNumberFormat('@').setValues(
    [['Play', '', 'Calls', 'PTS', 'PPP', 'TOV', 'Score %']])
    .setFontWeight('bold').setBackground('#e7f0ff').setHorizontalAlignment('center');
  var pFmt = ['@', '@', '0', '0', '0.00', '0', '0%'];
  var pFormats = [];
  for (var i = 0; i < geo.playRows; i++) pFormats.push(pFmt);
  sheet.getRange(P + 2, PLAY_COL, geo.playRows, PLAY_W).setNumberFormats(pFormats)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(P + 2, PLAY_COL + PLAY_NAME_SPAN, geo.playRows, 5).setHorizontalAlignment('center');
  frame_(sheet.getRange(P, PLAY_COL, 2 + geo.playRows, PLAY_W));
}

/**
 * Retrofit the PLAY STATS block onto a game created before a playbook
 * existed: record the plays in the game's setup (fixing its geometry) and
 * paint the frame in the reserved spot. Called from api_syncGame the first
 * time a sync arrives carrying play data for a game with no play block.
 */
function retrofitPlayFrame_(ss, rec, playNames) {
  rec.setup.plays = playNames;
  var sheet = ss.getSheetByName(rec.tabName);
  if (!sheet) return;
  var geo = geometry_(rec.setup);
  paintPlayFrame_(sheet, geo);
  positionScoreChart_(sheet, geo); // a taller play table can push the chart down
}

/**
 * Foul-trouble colors, applied once as rules. (Box-score heat tints are
 * written as plain backgrounds by every sync — see boxColors_.)
 */
function addConditionalFormatting_(sheet, geo) {
  var rules = [];
  // Thresholds from Livestat's Foul.js.
  var F = geo.foulTitle;
  [QCOL + 3, QCOL + 8].forEach(function (col) {
    var range = sheet.getRange(F + 3, col, geo.maxFoulRows, 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThanOrEqualTo(5).setBackground('#b71c1c').setFontColor('#ffffff')
      .setRanges([range]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberEqualTo(4).setBackground('#ef5350').setRanges([range]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberEqualTo(3).setBackground('#ffab91').setRanges([range]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberBetween(1, 2).setBackground('#fff9c4').setRanges([range]).build());
  });
  sheet.setConditionalFormatRules(rules);
}

function fmtPct_(made, att) { return att > 0 ? made / att : 0; }

/** Has this player been in the game at all? (on the floor, minutes, or any stat) */
function hasPlayed_(row) {
  if (row.on || row.min > 0) return true;
  for (var k in row.stats) if (row.stats[k]) return true;
  return false;
}

/**
 * The whole box-score block for one sync: values plus the numbers that drive
 * the heat tints, one entry per sheet row. Within each team, players who
 * have played come first (by number), then the did-not-play rows, then the
 * team row.
 */
function buildBox_(setup, snap, geo) {
  var rows = [];
  for (var t = 0; t < 2; t++) {
    var block = snap.teams[t];
    var played = [], idle = [];
    block.rows.forEach(function (r) { (hasPlayed_(r) ? played : idle).push(r); });
    played.concat(idle).forEach(function (r, i) {
      rows.push({
        kind: hasPlayed_(r) ? 'player' : 'idle', team: t, stripe: i % 2 === 1,
        values: boxRow_(r.name || '', r.num, r.stats, r.min, r.pm),
        heat: heatRow_(r.stats), pm: r.pm
      });
    });
    // Keep the team row on its reserved line even if the snapshot is short.
    var want = t === 0 ? geo.nA : geo.nB;
    for (var pad = block.rows.length; pad < want; pad++) {
      var blank = [];
      for (var c = 0; c < NCOLS; c++) blank.push('');
      rows.push({ kind: 'idle', team: t, stripe: pad % 2 === 1, values: blank, heat: {}, pm: 0 });
    }
    rows.push({
      kind: 'total', team: t,
      values: boxRow_(setup.teams[t].name.toUpperCase(), '', block.totals, '', ''),
      heat: {}, pm: 0
    });
  }
  return rows;
}

function boxRow_(label, num, stats, min, pm) {
  // No attempts -> both cells blank, rather than "0-0" and "0%".
  function ma(m, a) { return a > 0 ? m + '-' + a : ''; }
  function pct(m, a) { return a > 0 ? m / a : ''; }
  return [label, num === '' ? '' : String(num),
    stats.PTS, stats.OREB + stats.DREB, stats.AST, stats.STL, stats.BLK,
    stats.TOV, stats.PF,
    ma(stats.FGM, stats.FGA), pct(stats.FGM, stats.FGA),
    ma(stats.TWO_PM, stats.TWO_PA), pct(stats.TWO_PM, stats.TWO_PA),
    ma(stats.THREE_PM, stats.THREE_PA), pct(stats.THREE_PM, stats.THREE_PA),
    ma(stats.FTM, stats.FTA), pct(stats.FTM, stats.FTA),
    stats.OREB, stats.DREB, stats.CHG, stats.DEFL, stats.PFD,
    min === '' ? '' : min, pm === '' ? '' : pm];
}

/** Column -> number that drives that cell's heat tint. */
function heatRow_(s) {
  return {
    3: s.PTS, 4: s.OREB + s.DREB, 5: s.AST, 6: s.STL, 7: s.BLK, 8: s.TOV, 9: s.PF,
    10: s.FGM, 12: s.TWO_PM, 14: s.THREE_PM, 16: s.FTM,
    18: s.OREB, 19: s.DREB, 20: s.CHG, 21: s.DEFL, 22: s.PFD
  };
}

/** `frac` of the way from a row's base fill toward the full heat colour. */
function tintColor_(baseHex, rgb, frac) {
  var base = [parseInt(baseHex.substr(1, 2), 16), parseInt(baseHex.substr(3, 2), 16),
    parseInt(baseHex.substr(5, 2), 16)];
  return rgbHex_(mixRgb_(base, rgb, Math.max(0, Math.min(1, frac)))); // ShotChart.js
}

/**
 * Backgrounds, font colors and font weights for the box-score block.
 *  - A stat cell is tinted by its share of the column's best (across both
 *    teams' players), blended from the row's own stripe colour so striped
 *    rows stay striped; zeros — and so all-zero columns — are untinted.
 *  - Each team's leader in a column is bold (ties all bold).
 *  - Did-not-play rows are greyed out; +/- is green/red by sign.
 */
function boxColors_(rows) {
  var maxes = {}, leaders = [{}, {}];
  GREEN_COLS.concat(RED_COLS).forEach(function (col) {
    var m = 0;
    rows.forEach(function (r) {
      if (r.kind !== 'player') return;
      var v = r.heat[col] || 0;
      if (v > m) m = v;
      if (v > (leaders[r.team][col] || 0)) leaders[r.team][col] = v;
    });
    maxes[col] = m;
  });
  var bgs = [], fonts = [], weights = [];
  rows.forEach(function (r) {
    var base = r.kind === 'total' ? TEAM_COLORS[r.team].tint : (r.stripe ? ZEBRA : '#ffffff');
    var font = r.kind === 'idle' ? DIM_FONT : '#000000';
    var bg = [], fc = [], fw = [];
    for (var col = 1; col <= NCOLS; col++) {
      bg.push(base); fc.push(font); fw.push(r.kind === 'total' ? 'bold' : 'normal');
    }
    if (r.kind === 'player') {
      GREEN_COLS.forEach(function (col) {
        if (!(r.heat[col] > 0)) return;
        bg[col - 1] = tintColor_(base, HEAT_GREEN, r.heat[col] / maxes[col]);
        if (r.heat[col] === leaders[r.team][col]) fw[col - 1] = 'bold';
      });
      RED_COLS.forEach(function (col) {
        if (r.heat[col] > 0) bg[col - 1] = tintColor_(base, HEAT_RED, r.heat[col] / maxes[col]);
      });
      if (r.pm > 0) fc[PM_COL - 1] = '#188038';
      else if (r.pm < 0) fc[PM_COL - 1] = '#c5221f';
    }
    bgs.push(bg); fonts.push(fc); weights.push(fw);
  });
  return { backgrounds: bgs, fontColors: fonts, fontWeights: weights };
}

/** Repaint one game tab's values (and box-score colors) from the client snapshot. */
function renderSnapshot_(ss, rec, payload) {
  var setup = rec.setup;
  var snap = payload.snapshot;
  var geo = geometry_(setup);
  var sheet = ss.getSheetByName(rec.tabName);
  if (!sheet) throw new Error('Game tab missing: ' + rec.tabName);

  // Scoreboard (A:J; merged cells take the first value of their span).
  var tA = setup.teams[0], tB = setup.teams[1];
  sheet.getRange(1, 1, 1, BANNER_W).setValues([[
    tA.name.toUpperCase() + ' ', String(snap.score[tA.code]), '–',
    String(snap.score[tB.code]), ' ' + tB.name.toUpperCase(), '', '',
    '', snap.final ? 'FINAL' : snap.quarterLabel, '']]);

  // Box score: values, backgrounds and font colors for rows 3..lastBoxRow.
  var rows = buildBox_(setup, snap, geo);
  var colors = boxColors_(rows);
  sheet.getRange(FIRST_DATA_ROW, 1, rows.length, NCOLS)
    .setValues(rows.map(function (r) { return r.values; }))
    .setBackgrounds(colors.backgrounds)
    .setFontColors(colors.fontColors)
    .setFontWeights(colors.fontWeights);

  // Advanced stats.
  var S = geo.subStart;
  var none = { fastbreakPts: 0, secondChancePts: 0, benchPts: 0 };
  var advA = snap.adv[tA.code] || none, advB = snap.adv[tB.code] || none;
  sheet.getRange(S + 2, 1, 3, ADV_W).setValues([
    ['Fastbreak Pts', advA.fastbreakPts, '', advB.fastbreakPts, ''],
    ['2nd Chance Pts', advA.secondChancePts, '', advB.secondChancePts, ''],
    ['Bench Pts', advA.benchPts, '', advB.benchPts, '']]);

  // Quarter table.
  var qOut = [];
  for (var r = 0; r < QUARTER_ROWS.length; r++) {
    var label = QUARTER_ROWS[r];
    var row = [label];
    [tA, tB].forEach(function (team) {
      var q = quarterCells_(snap.quarters[team.code] || {}, label, snap.maxQuarter || 1);
      row = row.concat(q);
    });
    qOut.push(row);
  }
  sheet.getRange(S + 3, QCOL, qOut.length, 11).setValues(qOut);

  // Foul trouble (client sends sorted lists of {num, name, pf}).
  var F = geo.foulTitle;
  var foulOut = [];
  for (var fr = 0; fr < geo.maxFoulRows; fr++) {
    var a = (snap.fouls[tA.code] || [])[fr];
    var b = (snap.fouls[tB.code] || [])[fr];
    foulOut.push([
      a ? '#' + a.num : '', a ? a.name : '', '', a ? a.pf : '', '',
      b ? '#' + b.num : '', b ? b.name : '', '', b ? b.pf : ''
    ]);
  }
  sheet.getRange(F + 3, QCOL, foulOut.length, FOUL_W).setValues(foulOut);

  // Play stats.
  if (geo.playRows && snap.playStats) {
    var P = geo.playTitle;
    var playOut = [];
    for (var pr = 0; pr < geo.playRows; pr++) {
      var p = snap.playStats[pr];
      playOut.push(p
        ? [p.name, '', p.calls, p.points, p.ppp, p.tovs, p.scoreRate]
        : ['', '', '', '', '', '', '']);
    }
    sheet.getRange(P + 2, PLAY_COL, playOut.length, PLAY_W).setValues(playOut);
  }

  // Shot heat maps + zone tables (values/backgrounds only; frame painted
  // at setup or retrofit).
  if (rec.shotChartVersion === SHOT_CHART_VERSION) {
    writeShotHeatmap_(sheet, geo, setup, snap); // ShotChart.js
  }

  // Shots data tab.
  var shotSheet = ss.getSheetByName('Shots_' + rec.tabName);
  if (shotSheet && snap.shots) {
    if (shotSheet.getLastRow() > 1) {
      shotSheet.getRange(2, 1, shotSheet.getLastRow() - 1, 7).clearContent();
    }
    if (snap.shots.length) {
      shotSheet.getRange(2, 1, snap.shots.length, 7).setValues(
        snap.shots.map(function (s) {
          return [s.team, s.num, s.quarter, s.shot, s.made ? 1 : 0, s.x, s.y];
        }));
    }
  }
}

/** One team's 5 quarter-table cells for a row label (Q1..OT2, 1H, 2H). */
function quarterCells_(quarters, label, maxQuarter) {
  function sum(qs) {
    var acc = { PTS: 0, FGM: 0, FGA: 0, TOV: 0, PF: 0 };
    qs.forEach(function (q) {
      var row = quarters[q];
      if (row) ['PTS', 'FGM', 'FGA', 'TOV', 'PF'].forEach(function (k) { acc[k] += row[k]; });
    });
    return acc;
  }
  var qs;
  if (label === '1H') qs = [1, 2];
  else if (label === '2H') qs = [3, 4];
  else if (label.charAt(0) === 'Q') qs = [Number(label.slice(1))];
  else qs = [4 + Number(label.slice(2))]; // OTn -> quarter 4+n
  var isOT = label.charAt(0) === 'O';
  var qNum = qs[0];
  if (isOT && qNum > maxQuarter) return ['', '', '', '', ''];
  var acc = sum(qs);
  if (!isOT && label.charAt(0) === 'Q' && qNum > maxQuarter && acc.PTS === 0 && acc.FGA === 0) {
    return ['', '', '', '', ''];
  }
  return [acc.PTS, acc.FGM + '-' + acc.FGA, fmtPct_(acc.FGM, acc.FGA), acc.TOV, acc.PF];
}

/** Rewrite the Log tab command column: title + full serialized log. */
function writeLogTab_(ss, rec, commands) {
  var sheet = ss.getSheetByName(rec.logTabName);
  if (!sheet) return;
  if (!sheet.isSheetHidden()) {
    try { sheet.hideSheet(); } catch (err) { /* last visible sheet — leave it */ }
  }
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 1).clearContent();
  if (commands && commands.length) {
    sheet.getRange(2, 1, commands.length, 1).setValues(
      commands.map(function (c) { return [c]; }));
  }
}
