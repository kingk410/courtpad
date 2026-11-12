/**
 * CourtPad — google.script.run API surface.
 *
 * The client is authoritative for all stats: it sends full snapshots and the
 * server only paints them into the spreadsheet (SheetRenderer). Games are
 * registered in ScriptProperties under 'game:<gameId>'; saved rosters under
 * 'roster:<team name>'.
 */

var GAME_PREFIX = 'game:';
var ROSTER_PREFIX = 'roster:';

function gameKey_(gameId) { return GAME_PREFIX + gameId; }

function getGameRecord_(gameId) {
  var raw = PropertiesService.getScriptProperties().getProperty(gameKey_(gameId));
  if (!raw) throw new Error('Unknown game: ' + gameId);
  return JSON.parse(raw);
}

function saveGameRecord_(rec) {
  PropertiesService.getScriptProperties()
    .setProperty(gameKey_(rec.gameId), JSON.stringify(rec));
}

/**
 * Create a new game: spreadsheet (reused or new), painted game tab, log tab,
 * hidden graph-data tab, score chart, shot heat maps. Returns the registry record.
 */
function api_setupGame(token, req) {
  requireToken_(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss;
    if (req.spreadsheetId) {
      ss = SpreadsheetApp.openById(req.spreadsheetId);
    } else {
      ss = SpreadsheetApp.create(req.spreadsheetName || 'Basketball Gamelog');
    }

    var setup = req.setup;
    var tabName = uniqueTabName_(ss, setup.tabName || 'Game');
    setup.tabName = tabName;

    var gameId = Utilities.getUuid();
    var rec = {
      gameId: gameId,
      ssId: ss.getId(),
      ssUrl: ss.getUrl(),
      tabName: tabName,
      logTabName: 'Log_' + tabName,
      graphTabName: 'GraphData_' + tabName,
      setup: setup,
      appliedRevision: 0,
      createdAt: new Date().toISOString()
    };

    createGameSheets_(ss, rec);   // SheetRenderer.js: paints structure once
    saveGameRecord_(rec);
    saveRostersFromSetup_(setup);

    return rec;
  } finally {
    lock.releaseLock();
  }
}

function uniqueTabName_(ss, base) {
  var name = base, n = 2;
  while (ss.getSheetByName(name) || ss.getSheetByName('Log_' + name)) {
    name = base + ' (' + n++ + ')';
  }
  return name;
}

/**
 * Sync endpoint — the hot path. Receives the full truth for one game:
 *   {gameId, revision, commands: [...], snapshot: {...}}
 * and repaints the sheet with batched writes. Monotonic revision makes
 * retries and stale/out-of-order arrivals no-ops.
 */
function api_syncGame(token, payload) {
  requireToken_(token);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };
  try {
    var rec = getGameRecord_(payload.gameId);
    if (payload.revision <= rec.appliedRevision) {
      return { ok: true, applied: rec.appliedRevision, skipped: true };
    }
    var ss = SpreadsheetApp.openById(rec.ssId);
    // Older games have no PLAY STATS block reserved; add one the first time
    // play data shows up for them — and re-frame if more plays appear than
    // the reserved rows can hold.
    var snapPlays = payload.snapshot && payload.snapshot.playStats;
    if (snapPlays && snapPlays.length) {
      var reserved = (rec.setup.plays && rec.setup.plays.length)
        ? rec.setup.plays.length + 4 : 0;
      if (!reserved || snapPlays.length > reserved) {
        retrofitPlayFrame_(ss, rec, snapPlays.map(function (p) { return p.name; }));
      }
    }
    // Older games (no shot chart, or the v1 scatter charts) get the heat
    // maps the first time they sync.
    if (rec.shotChartVersion !== SHOT_CHART_VERSION) retrofitShotHeatmap_(ss, rec); // ShotChart.js
    renderSnapshot_(ss, rec, payload);          // SheetRenderer.js
    writeLogTab_(ss, rec, payload.commands);    // SheetRenderer.js
    writeGraphData_(ss, rec, payload.snapshot); // ChartManager.js
    rec.appliedRevision = payload.revision;
    saveGameRecord_(rec);
    return { ok: true, applied: payload.revision };
  } finally {
    lock.releaseLock();
  }
}

/** Recent games, newest first, for the resume/picker screen. */
function api_listGames(token) {
  requireToken_(token);
  var props = PropertiesService.getScriptProperties().getProperties();
  var games = [];
  for (var key in props) {
    if (key.indexOf(GAME_PREFIX) === 0) {
      try {
        var rec = JSON.parse(props[key]);
        games.push({
          gameId: rec.gameId, tabName: rec.tabName, ssUrl: rec.ssUrl,
          createdAt: rec.createdAt, teams: rec.setup.teams.map(function (t) {
            return { code: t.code, name: t.name };
          })
        });
      } catch (err) { /* skip corrupt entries */ }
    }
  }
  games.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  return games.slice(0, 20);
}

/**
 * Disaster recovery / open-on-another-device: rebuild a game's event list
 * from its Log tab commands. The client re-parses with Engine.fromLegacyLog.
 */
function api_loadGame(token, gameId) {
  requireToken_(token);
  var rec = getGameRecord_(gameId);
  var ss = SpreadsheetApp.openById(rec.ssId);
  var logSheet = ss.getSheetByName(rec.logTabName);
  var commands = [];
  if (logSheet) {
    var lastRow = logSheet.getLastRow();
    if (lastRow >= 2) {
      var values = logSheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < values.length; i++) {
        var v = String(values[i][0]).trim();
        if (v) commands.push(v);
      }
    }
  }
  return { record: rec, commands: commands };
}

/** The team's play list (names only) — shown as in-game buttons. */
function api_getPlays(token) {
  requireToken_(token);
  var raw = PropertiesService.getScriptProperties().getProperty('playlist');
  try { return raw ? JSON.parse(raw) : []; } catch (err) { return []; }
}

function api_savePlays(token, plays) {
  requireToken_(token);
  PropertiesService.getScriptProperties()
    .setProperty('playlist', JSON.stringify(plays || []));
  return { ok: true };
}

/** Saved rosters, keyed by team name, for prefilling the new-game wizard. */
function api_getRosters(token) {
  requireToken_(token);
  var props = PropertiesService.getScriptProperties().getProperties();
  var rosters = [];
  for (var key in props) {
    if (key.indexOf(ROSTER_PREFIX) === 0) {
      try { rosters.push(JSON.parse(props[key])); } catch (err) { }
    }
  }
  return rosters;
}

function saveRostersFromSetup_(setup) {
  var props = PropertiesService.getScriptProperties();
  for (var i = 0; i < setup.teams.length; i++) {
    var t = setup.teams[i];
    props.setProperty(ROSTER_PREFIX + t.name, JSON.stringify({
      name: t.name, code: t.code, roster: t.roster, starters: t.starters
    }));
  }
}

/**
 * Printable report (Google Doc), generated from the client's snapshot —
 * a forced flush runs first client-side so the sheet matches. Reports.js.
 */
function api_generateReport(token, gameId, type, payload) {
  requireToken_(token);
  var rec = getGameRecord_(gameId);
  return generateReportDoc_(rec, type, payload);
}
