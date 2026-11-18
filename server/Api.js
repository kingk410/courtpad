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
    // A game tab painted with an older column/table layout is re-framed
    // before values are written in the new positions. A failed attempt
    // fails this sync (the client retries); after 3 tries we stop blocking
    // the game and write values anyway.
    if (rec.layoutVersion !== LAYOUT_VERSION) {
      try {
        retrofitLayout_(ss, rec); // SheetRenderer.js
        rec.layoutVersion = LAYOUT_VERSION;
        delete rec.layoutAttempts;
      } catch (err) {
        rec.layoutAttempts = (rec.layoutAttempts || 0) + 1;
        Logger.log('Layout retrofit failed for ' + rec.tabName + ': ' + err);
        if (rec.layoutAttempts < 3) { saveGameRecord_(rec); throw err; }
        rec.layoutVersion = LAYOUT_VERSION;
      }
    }
    // Older games (no shot chart, or the v1 scatter charts) get the heat
    // maps the first time they sync.
    if (rec.shotChartVersion !== SHOT_CHART_VERSION) retrofitShotHeatmap_(ss, rec); // ShotChart.js
    renderSnapshot_(ss, rec, payload);          // SheetRenderer.js
    applyFinalState_(ss, rec, payload.snapshot);
    writeLogTab_(ss, rec, payload.commands);    // SheetRenderer.js
    writeGraphData_(ss, rec, payload.snapshot); // ChartManager.js
    rec.appliedRevision = payload.revision;
    saveGameRecord_(rec);
    return { ok: true, applied: payload.revision };
  } finally {
    lock.releaseLock();
  }
}

/**
 * One-time sweep: hide every `Log_*` tab in every spreadsheet that holds a
 * registered game (new games create theirs hidden). Runs from the first
 * home-screen load after this shipped; a failure just retries next load.
 */
var LOGS_HIDDEN_PROP = 'migrated:logsHidden';

function hideLogTabsOnce_() {
  var store = PropertiesService.getScriptProperties();
  if (store.getProperty(LOGS_HIDDEN_PROP)) return;
  var props = store.getProperties();
  var seen = {};
  for (var key in props) {
    if (key.indexOf(GAME_PREFIX) !== 0) continue;
    try {
      var ssId = JSON.parse(props[key]).ssId;
      if (!ssId || seen[ssId]) continue;
      seen[ssId] = true;
      SpreadsheetApp.openById(ssId).getSheets().forEach(function (sh) {
        if (sh.getName().indexOf('Log_') === 0 && !sh.isSheetHidden()) {
          try { sh.hideSheet(); } catch (err) { /* only visible sheet left */ }
        }
      });
    } catch (err) { /* spreadsheet gone / corrupt entry — skip */ }
  }
  store.setProperty(LOGS_HIDDEN_PROP, new Date().toISOString());
}

/**
 * Rename a game: its spreadsheet tabs (game sheet, log, hidden graph/shot
 * data tabs) and its registry entry. Returns the updated record. Fails
 * without changing anything if another tab already uses one of the names.
 */
function api_renameGame(token, gameId, newName) {
  requireToken_(token);
  newName = String(newName || '').trim();
  if (!newName) throw new Error('Enter a name.');
  if (newName.length > 80) throw new Error('Name is too long (80 characters max).');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var rec = getGameRecord_(gameId);
    if (newName === rec.tabName) return rec;
    var ss = SpreadsheetApp.openById(rec.ssId);

    // [current name, new name] for every tab that belongs to this game.
    var plan = [
      [rec.tabName, newName],
      [rec.logTabName, 'Log_' + newName],
      [rec.graphTabName, 'GraphData_' + newName],
      ['Shots_' + rec.tabName, 'Shots_' + newName]
    ].map(function (p) {
      return { sheet: p[0] ? ss.getSheetByName(p[0]) : null, to: p[1] };
    });
    var ownIds = plan.filter(function (p) { return p.sheet; })
      .map(function (p) { return p.sheet.getSheetId(); });
    plan.forEach(function (p) {
      var clash = ss.getSheetByName(p.to);
      if (clash && ownIds.indexOf(clash.getSheetId()) === -1) {
        throw new Error('The spreadsheet already has a tab named "' + p.to + '".');
      }
    });

    plan.forEach(function (p) { if (p.sheet) p.sheet.setName(p.to); });
    if (plan[1].sheet) plan[1].sheet.getRange(1, 1).setValue(newName); // log title

    rec.tabName = newName;
    rec.logTabName = 'Log_' + newName;
    rec.graphTabName = 'GraphData_' + newName;
    rec.setup.tabName = newName;
    saveGameRecord_(rec);
    return rec;
  } finally {
    lock.releaseLock();
  }
}

/**
 * A game marked final gets a coloured tab: green for a win (my team is
 * team 0), red for a loss, grey for a tie. Reopening it clears the colour.
 */
function applyFinalState_(ss, rec, snap) {
  var isFinal = !!(snap && snap.final);
  var color = null;
  if (isFinal) {
    var a = snap.score[rec.setup.teams[0].code], b = snap.score[rec.setup.teams[1].code];
    color = a > b ? '#34a853' : a < b ? '#ea4335' : '#9e9e9e';
  }
  rec.final = isFinal;
  if ((rec.tabColor || null) === color) return;
  var sheet = ss.getSheetByName(rec.tabName);
  if (sheet) sheet.setTabColor(color);
  rec.tabColor = color;
}

/** Recent games, newest first, for the resume/picker screen. */
function api_listGames(token) {
  requireToken_(token);
  try { hideLogTabsOnce_(); } catch (err) { Logger.log('Log-tab hide sweep failed: ' + err); }
  var props = PropertiesService.getScriptProperties().getProperties();
  var games = [];
  for (var key in props) {
    if (key.indexOf(GAME_PREFIX) === 0) {
      try {
        var rec = JSON.parse(props[key]);
        games.push({
          gameId: rec.gameId, tabName: rec.tabName, ssUrl: rec.ssUrl,
          createdAt: rec.createdAt, final: !!rec.final, teams: rec.setup.teams.map(function (t) {
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
 * Delete a game everywhere: its tabs in the spreadsheet (game sheet, log,
 * and the hidden graph/shot data tabs that only exist to feed it) and its
 * registry entry. Idempotent — an already-deleted game is a success, so a
 * second device or a retry does not error. Saved rosters, the play list and
 * any report Docs already generated are left alone.
 */
function api_deleteGame(token, gameId) {
  requireToken_(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(gameKey_(gameId));
    if (!raw) return { ok: true, deletedTabs: [], missing: true };
    var rec = JSON.parse(raw);

    var ss = null;
    try { ss = SpreadsheetApp.openById(rec.ssId); }
    catch (err) { Logger.log('Delete: spreadsheet unavailable for ' + rec.tabName + ': ' + err); }

    var deleted = [];
    if (ss) {
      var names = [rec.tabName, rec.logTabName, rec.graphTabName,
        'Shots_' + rec.tabName, rec.shotTabName];
      var doomed = [];
      names.forEach(function (name) {
        var sh = name && ss.getSheetByName(name);
        if (sh) doomed.push(sh);
      });
      // A spreadsheet must keep at least one visible sheet.
      var doomedIds = doomed.map(function (sh) { return sh.getSheetId(); });
      var survivors = ss.getSheets().filter(function (sh) {
        return doomedIds.indexOf(sh.getSheetId()) === -1 && !sh.isSheetHidden();
      });
      if (doomed.length && !survivors.length) ss.insertSheet();
      doomed.forEach(function (sh) {
        deleted.push(sh.getName());
        ss.deleteSheet(sh);
      });
    }

    props.deleteProperty(gameKey_(gameId));
    return { ok: true, deletedTabs: deleted, spreadsheetFound: !!ss };
  } finally {
    lock.releaseLock();
  }
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
