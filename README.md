# CourtPad

Touch-first basketball stat tracker for iPad, built as a Google Apps Script web
app. Replaces Livestat's typed commands with buttons; live-updates a Google
Sheet (box score, quarter stats, advanced stats, foul trouble, score chart)
that an assistant coach can watch during the game, and prints halftime/final
reports as Google Docs.

- Script project: "CourtPad" (standalone), script ID in `.clasp.json`
- The old Livestat project is untouched; CourtPad writes the same command
  grammar into a hidden `Log_<game>` tab, so every game stays auditable/replayable.

## One-time setup (in a browser, ~1 minute)

1. `clasp open-script` (or open the CourtPad project at script.google.com)
2. In the editor toolbar pick the function `authorize`, press **Run**, and
   accept the permissions prompt (Sheets + Docs access, runs as you).
3. View > Logs (or Executions) shows your **private app URL** — it looks like
   `https://script.google.com/macros/s/…/exec?k=<token>`.
4. Open that URL on the iPad in Safari → Share → **Add to Home Screen**.

Keep the tokened URL private: anyone who has it can enter stats.

## Using it

- **New game**: name the game, pick spreadsheet (reuse last / create new),
  enter both rosters ("number name" per line, or pick a saved roster), tap 5
  starters each, Create. The spreadsheet tab is painted once with all
  formatting; after that only values change.
- **During the game**: tap player → tap action. Follow-up strips offer
  assist / rebound / stolen-from / blocked-whom and are always optional.
  ⚡ Fastbreak arms for the next made shot. 2nd-chance is auto-detected
  (off an OREB) with a force/off override. SUB buttons handle substitutions.
  Tap the court sketch to record shot locations, or Skip.
- **Shot charts**: every game tab carries a shot heat map per team (to the
  right of the box score): a half-court grid of ~3 ft cells, basket at the
  top, each cell showing made/attempts and colored by FG% (red = cold,
  green = hot, deeper with more attempts). Empty cells are tinted to draw the
  court: tan paint, cream mid-range, grey beyond the arc. A Paint /
  Mid-range / 3PT / All FG zone table (FG, FG%, PTS) sits above each grid.
  Shots recorded with Skip count in the box score but not on the chart; the
  note under the table says how many. Games created before shot charts
  existed get them on their next sync.
- **Game clock**: the ▶/⏸ chip next to the quarter button is a play/pause
  clock counting down the quarter. Start it at the opening tip and pause for
  big stoppages (timeouts etc.) — no need to chase every whistle: when a
  quarter ends, its clocked timeline is rescaled to the true quarter length,
  so sloppy pausing self-corrects. Every event is clock-stamped, which makes
  MIN and +/- real. If you never touch the clock, minutes fall back to an
  event-pace estimate (still labeled MIN*). "End Q" resets the clock.
- **Plays**: define your playbook from the home screen (🧩 Plays…, one name
  per line — saved to your account). During a game the plays show as chips
  above the toggles: tap one when you call it, and the engine attributes that
  possession to it — points (including OREB put-backs and and-1 FTs),
  turnovers (incl. charges and opponent steals) — until the possession ends.
  Tap the active play again to call it off (the call is removed entirely).
  Per-play Calls / PTS / PPP / TOV / Score% show live in the Log screen, in a
  PLAY STATS block on the sheet (games created after the playbook exists),
  and in printed reports.
- **Undo** reverses the last event (with Redo); **Log ▸** opens the full event
  list where any event can be deleted — everything recomputes.
- **Menu** → halftime/final report (Google Doc, print with Cmd+P), open
  spreadsheet, force sync.
- **Rename a game**: Rename on the home screen's game row, or Menu → Rename
  game. Renames the game's spreadsheet tabs too.
- **Delete a game**: Delete on the home screen's game row, or Menu → Delete
  game. After a confirmation it removes the game from the app and deletes its
  tabs from the spreadsheet (game sheet, `Log_`, and the hidden `GraphData_` /
  `Shots_` tabs). Report Docs and saved rosters are kept. Not undoable.
- Works through wifi dropouts: every tap is saved locally first; the sheet
  catches up automatically (sync dot: green = synced, amber = pending,
  red = retrying).

## Development

Local layout:

- `shared/Engine.html` — pure-JS stat engine (events → state). No DOM, no
  google.*; also runs in Node.
- `client/` — UI (`Index`, `App`, `Setup`, `Sync`, `Styles`), test harness
  (`TestHarness` + `TestData` real-game fixture).
- `server/` — thin Apps Script layer: `Main` (doGet/token), `Api`
  (sync/setup/load/report endpoints), `SheetRenderer` (batched values-only
  painting), `ChartManager` (score chart), `ShotChart` (team shot heat maps
  + zone tables), `Reports`.

Workflow:

```sh
clasp push                 # upload
clasp create-version "..." # snapshot
clasp update-deployment <deploymentId> -V <n>   # redeploy SAME url
clasp list-deployments
```

Tests (no deploy needed):

```sh
node scratchpad/test-engine.js    # unit tests (see scratchpad path in repo notes)
```

or open `<app url>&page=test` — runs unit checks plus a full replay of a real
game (Menlo vs HMB2) diffing every box-score/quarter/advanced/series number
against what the legacy system rendered. Two DEFL cells are expected
divergences: the old sheet dropped a logged event; the engine counts it.

## Architecture notes

- **Client-authoritative**: the iPad owns the event log; stats recompute from
  scratch on every tap (a full game replays in ~1ms). The server never
  computes stats — it repaints the sheet from the client's snapshot, so undo
  and edits are trivially correct.
- **Sync**: debounced 2.5s (max-wait 10s), one in-flight request, retries with
  backoff; a monotonic revision makes retries/stale arrivals no-ops
  (server skips `revision <= appliedRevision`; LockService serializes).
- **Sheet**: structure/formatting/conditional-format rules/chart created once
  at game setup with fixed geometry; each sync is ~6 `setValues` calls. The
  score-diff chart reads a hidden `GraphData_<game>` tab and is never
  recreated. Shot locations land in a hidden `Shots_<game>` tab; the two
  team shot heat maps are plain cells (16x15 per team from column Z) whose
  values and backgrounds are rewritten per sync — no chart object involved,
  so nothing can render blank. Records carry `shotChartVersion`; a game
  behind the current version is re-framed on its next sync.
- **Recovery**: localStorage survives refresh/crash; if the iPad dies, the
  `Log_<game>` tab is the durable event log — "Open" on another device
  rebuilds the game from it (`api_loadGame` + `Engine.fromLegacyLog`).
