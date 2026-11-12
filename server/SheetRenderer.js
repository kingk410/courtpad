/**
 * CourtPad — spreadsheet renderer.
 *
 * All structure and formatting (headers, merges, colors, number formats,
 * conditional formatting, charts) is painted ONCE at game setup with fixed
 * geometry — roster sizes are known, so every table has a reserved block.
 * After that, api_syncGame only writes VALUES: one setValues per table
 * (~10 range writes per sync vs the old system's 30-80 single-cell writes).
 *
 * Column map: A:AB box score + sub-tables, Q.. score chart (floating),
 * AE.. team shot heat maps + zone tables (ShotChart.js).
 */

var HEADERS = ['Team', 'Name', '#', 'FGM', 'FGA', 'FG%', '2PM', '2PA', '2P%',
  '3PM', '3PA', '3P%', 'FTM', 'FTA', 'FT%', 'OREB', 'DREB', 'AST', 'STL',
  'BLK', 'TOV', 'PF', 'PTS', 'CHG', 'DEFL', 'PFD', 'MIN*', '+/-'];
var NCOLS = HEADERS.length; // 28
var HEADER_ROW = 2;
var FIRST_DATA_ROW = 3;
var QUARTER_ROWS = ['Q1', 'Q2', 'Q3', 'Q4', 'OT1', 'OT2', '1H', '2H'];
var QCOL = 5; // quarter/foul tables anchor at column E

// Header band colors, carried over from Livestat's styleStatsSheet.
var BANDS = [
  { cols: [4, 6], color: '#ffe5cc' },   // FG
  { cols: [7, 9], color: '#fff7cc' },   // 2P
  { cols: [10, 12], color: '#e6ffea' }, // 3P
  { cols: [13, 15], color: '#d6eaff' }, // FT
  { cols: [16, 20], color: '#e0f4e0' }, // REB-BLK
  { cols: [21, 22], color: '#f8d7da' }, // TOV/PF
  { cols: [23, 23], color: '#cce0ff' }, // PTS
  { cols: [24, 26], color: '#ead2b8' }, // intangibles
  { cols: [27, 28], color: '#e0e0e0' }  // MIN,+/-
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
  var sub = lastBoxRow + 2;             // sub-tables start (title rows)
  var foulTitle = sub + 12;             // advanced/quarter blocks are 11 rows tall
  var maxFoulRows = Math.max(nA, nB);
  // PLAY STATS block, reserved only when the game was created with a playbook
  // (+4 spare rows for plays added mid-game).
  var playRows = (setup.plays && setup.plays.length) ? setup.plays.length + 4 : 0;
  var playTitle = playRows ? foulTitle + 2 + maxFoulRows + 2 : 0;
  return {
    nA: nA, nB: nB, teamARows: teamARows, teamBRows: teamBRows,
    totalA: totalA, totalB: totalB, lastBoxRow: lastBoxRow,
    subStart: sub, foulTitle: foulTitle, maxFoulRows: maxFoulRows,
    playTitle: playTitle, playRows: playRows,
    lastRow: playRows ? playTitle + 1 + playRows : foulTitle + 2 + maxFoulRows
  };
}

/** Paint the full fixed structure of a new game tab. Called once from setup. */
function createGameSheets_(ss, rec) {
  var setup = rec.setup;
  var geo = geometry_(setup);

  var sheet = ss.insertSheet(rec.tabName);
  sheet.setFrozenRows(HEADER_ROW);

  // Row 1: big score header, filled by every sync.
  sheet.getRange(1, 1).setFontSize(18).setFontWeight('bold');
  sheet.setRowHeight(1, 34);

  // Row 2: column headers with Livestat's band colors and group borders.
  sheet.getRange(HEADER_ROW, 1, 1, NCOLS).setValues([HEADERS])
    .setFontWeight('bold').setHorizontalAlignment('center');
  for (var b = 0; b < BANDS.length; b++) {
    sheet.getRange(HEADER_ROW, BANDS[b].cols[0], 1, BANDS[b].cols[1] - BANDS[b].cols[0] + 1)
      .setBackground(BANDS[b].color);
    sheet.getRange(HEADER_ROW, BANDS[b].cols[0], geo.lastBoxRow - 1, BANDS[b].cols[1] - BANDS[b].cols[0] + 1)
      .setBorder(null, true, null, true, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
  }

  // TEAM TOTAL rows (Livestat purple).
  [geo.totalA, geo.totalB].forEach(function (r) {
    sheet.getRange(r, 1, 1, NCOLS).setBackground('#e6d5ff').setFontWeight('bold');
  });

  // Number formats: percentages as ratios ('0%'), estimated minutes '0.0'.
  [6, 9, 12, 15].forEach(function (c) {
    sheet.getRange(FIRST_DATA_ROW, c, geo.lastBoxRow - HEADER_ROW, 1).setNumberFormat('0%');
  });
  sheet.getRange(FIRST_DATA_ROW, 27, geo.lastBoxRow - HEADER_ROW, 1).setNumberFormat('0.0');
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidths(4, NCOLS - 3, 46);

  // ---- Sub-table frames ----
  var S = geo.subStart;

  // Advanced stats, cols A:C.
  sheet.getRange(S, 1, 1, 3).merge().setValue('ADVANCED STATS')
    .setBackground('#d9c2f0').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange(S + 1, 1, 1, 3).setValues([['Team', 'Stat', 'Value']])
    .setFontWeight('bold').setBackground('#f3eaff');

  // Quarter stats, 11 cols anchored at E.
  sheet.getRange(S, QCOL, 1, 11).merge().setValue('QUARTER STATS')
    .setBackground('#c8e6c9').setFontWeight('bold').setHorizontalAlignment('center');
  for (var t = 0; t < 2; t++) {
    sheet.getRange(S + 1, QCOL + 1 + t * 5, 1, 5).merge()
      .setValue(setup.teams[t].name.toUpperCase())
      .setFontWeight('bold').setBackground('#e8f5e9').setHorizontalAlignment('center');
  }
  sheet.getRange(S + 2, QCOL, 1, 11).setValues(
    [['', 'PTS', 'FG', 'FG%', 'TOV', 'PF', 'PTS', 'FG', 'FG%', 'TOV', 'PF']])
    .setFontWeight('bold').setHorizontalAlignment('center');
  var qData = QUARTER_ROWS.map(function (label) {
    return [label, '', '', '', '', '', '', '', '', '', ''];
  });
  sheet.getRange(S + 3, QCOL, QUARTER_ROWS.length, 11).setValues(qData)
    .setHorizontalAlignment('center');
  // Halves highlighted like Livestat.
  sheet.getRange(S + 3 + 6, QCOL, 2, 11).setBackground('#fff9c4');
  [4, 9].forEach(function (off) { // FG% columns as percents
    sheet.getRange(S + 3, QCOL + off - 1, QUARTER_ROWS.length, 1).setNumberFormat('0%');
  });

  // Foul trouble, 7 cols anchored at E.
  var F = geo.foulTitle;
  sheet.getRange(F, QCOL, 1, 7).merge().setValue('FOUL TROUBLE')
    .setBackground('#f8d7da').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange(F + 1, QCOL, 1, 3).merge().setValue(setup.teams[0].name.toUpperCase())
    .setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange(F + 1, QCOL + 4, 1, 3).merge().setValue(setup.teams[1].name.toUpperCase())
    .setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange(F + 2, QCOL, 1, 7).setValues([['#', 'Name', 'PF', '', '#', 'Name', 'PF']])
    .setFontWeight('bold').setHorizontalAlignment('center');

  // Play stats frame (only when the game has a playbook).
  paintPlayFrame_(sheet, geo);

  addConditionalFormatting_(sheet, geo);
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

  // Shots data tab.
  var shotSheet = ss.insertSheet('Shots_' + rec.tabName);
  shotSheet.getRange(1, 1, 1, 7).setValues(
    [['Team', '#', 'Q', 'Shot', 'Made', 'X', 'Y']]).setFontWeight('bold');
  shotSheet.hideSheet();

  // Delete the default empty sheet on a brand-new spreadsheet.
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1 && s1.getLastRow() === 0) ss.deleteSheet(s1);
}

function paintPlayFrame_(sheet, geo) {
  if (!geo.playRows) return;
  var P = geo.playTitle;
  sheet.getRange(P, QCOL, 1, 6).merge().setValue('PLAY STATS')
    .setBackground('#cfe2ff').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange(P + 1, QCOL, 1, 6).setValues(
    [['Play', 'Calls', 'PTS', 'PPP', 'TOV', 'Score %']])
    .setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange(P + 2, QCOL + 3, geo.playRows, 1).setNumberFormat('0.00');
  sheet.getRange(P + 2, QCOL + 5, geo.playRows, 1).setNumberFormat('0%');
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
  paintPlayFrame_(sheet, geometry_(rec.setup));
}

/** Heat-map gradients + foul-trouble colors, applied once as rules. */
function addConditionalFormatting_(sheet, geo) {
  var rules = [];
  var playerRanges = function (col) {
    return [
      sheet.getRange(geo.teamARows.start, col, geo.teamARows.count, 1),
      sheet.getRange(geo.teamBRows.start, col, geo.teamBRows.count, 1)
    ];
  };
  // Green gradients on counting stats (per column, like Livestat's per-column max).
  [4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 18, 19, 20, 23, 24, 25, 26].forEach(function (col) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue('#ffffff', SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setGradientMaxpoint('#57bb8a')
      .setRanges(playerRanges(col)).build());
  });
  // Red gradients on TOV / PF.
  [21, 22].forEach(function (col) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue('#ffffff', SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setGradientMaxpoint('#e06666')
      .setRanges(playerRanges(col)).build());
  });
  // Foul-trouble PF cells (thresholds from Livestat's Foul.js).
  var F = geo.foulTitle;
  [QCOL + 2, QCOL + 6].forEach(function (col) {
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

/** Values-only repaint of one game tab from the client snapshot. */
function renderSnapshot_(ss, rec, payload) {
  var setup = rec.setup;
  var snap = payload.snapshot;
  var geo = geometry_(setup);
  var sheet = ss.getSheetByName(rec.tabName);
  if (!sheet) throw new Error('Game tab missing: ' + rec.tabName);

  // Score header.
  var tA = setup.teams[0], tB = setup.teams[1];
  sheet.getRange(1, 1).setValue(
    tA.name.toUpperCase() + '  ' + snap.score[tA.code] + '  —  ' +
    snap.score[tB.code] + '  ' + tB.name.toUpperCase() + '     ' + snap.quarterLabel);

  // Box score: one 2D block, rows 3..lastBoxRow x 28 cols.
  var out = [];
  for (var t = 0; t < 2; t++) {
    var team = setup.teams[t];
    var block = snap.teams[t];
    for (var i = 0; i < block.rows.length; i++) {
      out.push(boxRow_(team.name, block.rows[i].name, block.rows[i].num,
        block.rows[i].stats, block.rows[i].min, block.rows[i].pm));
    }
    out.push(boxRow_(team.name, 'TEAM TOTAL', '', block.totals, '', ''));
  }
  sheet.getRange(FIRST_DATA_ROW, 1, out.length, NCOLS).setValues(out);

  // Advanced stats.
  var S = geo.subStart;
  var advOut = [];
  [tA, tB].forEach(function (team) {
    var a = snap.adv[team.code] || { fastbreakPts: 0, secondChancePts: 0, benchPts: 0 };
    advOut.push([team.name, 'Fastbreak Pts', a.fastbreakPts]);
    advOut.push([team.name, '2nd Chance Pts', a.secondChancePts]);
    advOut.push([team.name, 'Bench Pts', a.benchPts]);
  });
  sheet.getRange(S + 2, 1, advOut.length, 3).setValues(advOut);

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
      a ? '#' + a.num : '', a ? a.name : '', a ? a.pf : '', '',
      b ? '#' + b.num : '', b ? b.name : '', b ? b.pf : ''
    ]);
  }
  sheet.getRange(F + 3, QCOL, foulOut.length, 7).setValues(foulOut);

  // Play stats.
  if (geo.playRows && snap.playStats) {
    var P = geo.playTitle;
    var playOut = [];
    for (var pr = 0; pr < geo.playRows; pr++) {
      var p = snap.playStats[pr];
      playOut.push(p
        ? [p.name, p.calls, p.points, p.ppp, p.tovs, p.scoreRate]
        : ['', '', '', '', '', '']);
    }
    sheet.getRange(P + 2, QCOL, playOut.length, 6).setValues(playOut);
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

function boxRow_(teamName, playerName, num, stats, min, pm) {
  return [teamName, playerName, num,
    stats.FGM, stats.FGA, fmtPct_(stats.FGM, stats.FGA),
    stats.TWO_PM, stats.TWO_PA, fmtPct_(stats.TWO_PM, stats.TWO_PA),
    stats.THREE_PM, stats.THREE_PA, fmtPct_(stats.THREE_PM, stats.THREE_PA),
    stats.FTM, stats.FTA, fmtPct_(stats.FTM, stats.FTA),
    stats.OREB, stats.DREB, stats.AST, stats.STL, stats.BLK,
    stats.TOV, stats.PF, stats.PTS, stats.CHG, stats.DEFL, stats.PFD,
    min === '' ? '' : min, pm === '' ? '' : pm];
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
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 1).clearContent();
  if (commands && commands.length) {
    sheet.getRange(2, 1, commands.length, 1).setValues(
      commands.map(function (c) { return [c]; }));
  }
}
