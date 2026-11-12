/**
 * CourtPad — printable halftime/final reports, ported from Livestat's
 * Reports.js. Generates a Google Doc from the client snapshot (the client
 * force-flushes a sync first so the spreadsheet matches what's printed).
 */

var REPORT_COLS = ['#', 'Name', 'FG', '2P', '3P', 'FT', 'OR', 'DR', 'REB',
  'PF', 'PTS', 'AST', 'TO', 'ST', 'BK', 'CHG', 'DFL', 'PFD'];
var REPORT_WIDTHS = [22, 75, 34, 34, 34, 34, 22, 22, 26, 22, 26, 24, 22, 22, 22, 24, 24, 24];

function generateReportDoc_(rec, type, payload) {
  var snap = payload.snapshot;
  var setup = rec.setup;
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MM-dd-yyyy HH-mm');
  var doc = DocumentApp.create(rec.tabName + ' - ' + type + ' - ' + stamp);
  var body = doc.getBody();
  body.setMarginTop(36).setMarginBottom(36).setMarginLeft(36).setMarginRight(36);

  var header = body.appendParagraph(
    type + ' Box Score - ' + rec.tabName + ' - ' +
    Utilities.formatDate(now, Session.getScriptTimeZone(), 'MM/dd/yy h:mm a'));
  header.setFontFamily('Arial').setFontSize(11).setBold(true);

  for (var t = 0; t < 2; t++) {
    var team = setup.teams[t];
    var block = snap.teams[t];
    appendTeamBoxScore_(body, team, block, snap.score[team.code]);
  }

  appendQuarterAndAdvanced_(body, setup, snap);
  if (snap.playStats && snap.playStats.length) appendPlayStats_(body, snap.playStats);

  doc.saveAndClose();
  return { url: doc.getUrl(), name: doc.getName() };
}

function appendPlayStats_(body, playStats) {
  var title = body.appendParagraph('PLAY STATS');
  title.setFontFamily('Arial').setFontSize(10).setBold(true).setSpacingBefore(10);
  var rows = [['Play', 'Calls', 'PTS', 'PPP', 'TOV', 'Score %']];
  playStats.forEach(function (p) {
    rows.push([p.name, String(p.calls), String(p.points), p.ppp.toFixed(2),
      String(p.tovs), Math.round(p.scoreRate * 100) + '%']);
  });
  var table = body.appendTable(rows);
  table.setBorderWidth(0.5);
  for (var r = 0; r < rows.length; r++) {
    var row = table.getRow(r);
    for (var c = 0; c < row.getNumCells(); c++) {
      var text = row.getCell(c).editAsText();
      text.setFontFamily('Arial').setFontSize(8);
      if (r === 0) text.setBold(true);
    }
  }
}

function mA_(made, att) { return made + '-' + att; }

function appendTeamBoxScore_(body, team, block, points) {
  var heading = body.appendParagraph(team.name.toUpperCase() + ' - ' + points);
  heading.setFontFamily('Arial').setFontSize(10).setBold(true).setSpacingBefore(10);

  var rows = [REPORT_COLS];
  var used = block.rows.filter(function (r) { return playerHasStats_(r.stats); });
  used.forEach(function (r) {
    var s = r.stats;
    rows.push([String(r.num), r.name || '',
      mA_(s.FGM, s.FGA), mA_(s.TWO_PM, s.TWO_PA), mA_(s.THREE_PM, s.THREE_PA),
      mA_(s.FTM, s.FTA), String(s.OREB), String(s.DREB), String(s.OREB + s.DREB),
      String(s.PF), String(s.PTS), String(s.AST), String(s.TOV), String(s.STL),
      String(s.BLK), String(s.CHG), String(s.DEFL), String(s.PFD)]);
  });
  var tot = block.totals;
  rows.push(['', 'Totals',
    mA_(tot.FGM, tot.FGA), mA_(tot.TWO_PM, tot.TWO_PA), mA_(tot.THREE_PM, tot.THREE_PA),
    mA_(tot.FTM, tot.FTA), String(tot.OREB), String(tot.DREB), String(tot.OREB + tot.DREB),
    String(tot.PF), String(tot.PTS), String(tot.AST), String(tot.TOV), String(tot.STL),
    String(tot.BLK), String(tot.CHG), String(tot.DEFL), String(tot.PFD)]);
  rows.push(['', 'Shooting',
    pctStr_(tot.FGM, tot.FGA), pctStr_(tot.TWO_PM, tot.TWO_PA),
    pctStr_(tot.THREE_PM, tot.THREE_PA), pctStr_(tot.FTM, tot.FTA),
    '', '', '', '', '', '', '', '', '', '', '', '']);

  var table = body.appendTable(rows);
  table.setBorderWidth(0.5);
  styleReportTable_(table, rows.length);
}

function pctStr_(made, att) {
  return att > 0 ? Math.round(100 * made / att) + '%' : '0%';
}

function playerHasStats_(s) {
  for (var k in s) { if (s[k] !== 0) return true; }
  return false;
}

function styleReportTable_(table, numRows) {
  for (var r = 0; r < numRows; r++) {
    var row = table.getRow(r);
    for (var c = 0; c < row.getNumCells(); c++) {
      var cell = row.getCell(c);
      cell.setPaddingTop(1).setPaddingBottom(1).setPaddingLeft(3).setPaddingRight(3);
      var text = cell.editAsText();
      text.setFontFamily('Arial').setFontSize(8);
      if (r === 0) {
        cell.setBackgroundColor('#333333');
        text.setForegroundColor('#ffffff').setBold(true);
      } else if (r >= numRows - 2) {
        text.setBold(true);
      }
      if (r === 0 && c < REPORT_WIDTHS.length) {
        table.setColumnWidth(c, REPORT_WIDTHS[c]);
      }
    }
  }
}

function appendQuarterAndAdvanced_(body, setup, snap) {
  var title = body.appendParagraph('QUARTER BY QUARTER / ADVANCED STATS');
  title.setFontFamily('Arial').setFontSize(10).setBold(true).setSpacingBefore(10);

  for (var t = 0; t < 2; t++) {
    var team = setup.teams[t];
    var q = snap.quarters[team.code] || {};
    var adv = snap.adv[team.code] || { fastbreakPts: 0, secondChancePts: 0, benchPts: 0 };
    var advRows = [['Fastbreak Pts', String(adv.fastbreakPts)],
      ['2nd Chance Pts', String(adv.secondChancePts)],
      ['Bench Pts', String(adv.benchPts)]];

    var labels = ['Q1', 'Q2', 'Q3', 'Q4'];
    for (var ot = 1; ot + 4 <= (snap.maxQuarter || 1); ot++) labels.push('OT' + ot);
    labels.push('1H', '2H');

    var rows = [[team.name.toUpperCase(), 'PTS', 'FG', 'FG%', 'TOV', 'PF', '', 'Advanced', '']];
    labels.forEach(function (label, i) {
      var acc = sumQuarters_(q, label);
      var advCellA = i < advRows.length ? advRows[i][0] : '';
      var advCellB = i < advRows.length ? advRows[i][1] : '';
      rows.push([label, String(acc.PTS), mA_(acc.FGM, acc.FGA),
        pctStr_(acc.FGM, acc.FGA), String(acc.TOV), String(acc.PF), '',
        advCellA, advCellB]);
    });
    var table = body.appendTable(rows);
    table.setBorderWidth(0.5);
    for (var r = 0; r < rows.length; r++) {
      var row = table.getRow(r);
      for (var c = 0; c < row.getNumCells(); c++) {
        var text = row.getCell(c).editAsText();
        text.setFontFamily('Arial').setFontSize(8);
        if (r === 0) text.setBold(true);
      }
    }
  }
}

function sumQuarters_(quarters, label) {
  var qs;
  if (label === '1H') qs = [1, 2];
  else if (label === '2H') qs = [3, 4];
  else if (label.charAt(0) === 'Q') qs = [Number(label.slice(1))];
  else qs = [4 + Number(label.slice(2))];
  var acc = { PTS: 0, FGM: 0, FGA: 0, TOV: 0, PF: 0 };
  qs.forEach(function (qn) {
    var row = quarters[qn];
    if (row) ['PTS', 'FGM', 'FGA', 'TOV', 'PF'].forEach(function (k) { acc[k] += row[k]; });
  });
  return acc;
}
