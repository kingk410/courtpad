/**
 * CourtPad — web app entry point.
 *
 * The published /exec URL serves the iPad UI. Access is guarded by a random
 * token in the URL (?k=...): the first ever request mints the token and shows
 * it; every later request (and every google.script.run call) must present it.
 * Keep the tokened URL private — it's the only credential.
 */

var TOKEN_PROP = 'COURTPAD_TOKEN';

/**
 * One-time setup: run this once from the Apps Script editor (Run > authorize)
 * and accept the permissions prompt. That grants the script its Sheets/Docs
 * access; after that the web app URL works. Also prints your private app URL.
 */
function authorize() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty(TOKEN_PROP);
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty(TOKEN_PROP, token);
  }
  var url = ScriptApp.getService().getUrl();
  Logger.log('Authorized. Your private CourtPad URL:');
  Logger.log((url || '<deploy the web app first>') + '?k=' + token);
  return 'ok';
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty(TOKEN_PROP);

  if (!token) {
    // First run: mint the access token and hand the user their private URL.
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty(TOKEN_PROP, token);
    var url = ScriptApp.getService().getUrl() + '?k=' + token;
    return HtmlService.createHtmlOutput(
      '<div style="font-family:-apple-system,sans-serif;padding:2em;max-width:36em">' +
      '<h2>CourtPad is set up</h2>' +
      '<p>Your private app link (bookmark this / Add to Home Screen):</p>' +
      '<p><a href="' + url + '">' + url + '</a></p>' +
      '<p>Anyone with this link can enter stats, so keep it to yourself.</p></div>')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  if (params.k !== token) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:-apple-system,sans-serif;padding:2em">' +
      '<h2>CourtPad</h2><p>This link is missing its access key. ' +
      'Open the app from your bookmarked link (the one ending in <code>?k=…</code>).</p></div>');
  }

  var page = params.page === 'test' ? 'client/TestHarness' : 'client/Index';
  var tpl = HtmlService.createTemplateFromFile(page);
  tpl.token = token;
  // Note: HtmlService only permits the 'viewport' meta tag here; the Apple
  // PWA tags live in the HTML head of Index.html instead.
  return tpl.evaluate()
    .setTitle('CourtPad')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Template helper: inline another file's content (CSS/JS-in-HTML pattern). */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Throws unless the client-supplied token matches. Every api_* calls this. */
function requireToken_(token) {
  var stored = PropertiesService.getScriptProperties().getProperty(TOKEN_PROP);
  if (!stored || token !== stored) throw new Error('Invalid access token');
}
