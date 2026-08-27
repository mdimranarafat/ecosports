/**
 * Code.gs — Eco Sports Firestore → Google Sheets Backup System
 * ============================================================================
 * Entry points only. Actual Firestore reads + Sheet writes live in
 * Backup.gs; report generation lives in Reports.gs. This file wires up:
 *   - onOpen()            custom Sheets menu for manual runs
 *   - doGet(e)             lightweight webhook so the admin panel's
 *                          "Run Backup Now" button (Settings page, future
 *                          enhancement) can trigger a backup on demand
 *   - installTriggers()    one-time setup for daily/weekly automatic backup
 *
 * REQUIRED SCRIPT PROPERTIES (File > Project Settings > Script Properties):
 *   FIRESTORE_PROJECT_ID   your Firebase project ID
 *   SERVICE_ACCOUNT_EMAIL  the backup service account's email
 *   SERVICE_ACCOUNT_KEY    the service account's PEM private key (multi-line,
 *                          paste exactly as it appears in the downloaded JSON,
 *                          including -----BEGIN/END PRIVATE KEY----- lines)
 *   BACKUP_WEBHOOK_SECRET  a long random string you choose — required as a
 *                          `?token=` query param on doGet() so the manual
 *                          trigger endpoint can't be called by strangers
 *
 * See gas/README.md for full step-by-step setup instructions.
 */

/** Collections backed up, and the Sheet tab + document-ID field each maps to. */
const BACKUP_COLLECTIONS = [
  { collection: "bookings", sheet: "Bookings", idField: "bookingId" },
  { collection: "customers", sheet: "Customers", idField: "customerId" },
  { collection: "facilities", sheet: "Facilities", idField: "id" },
  { collection: "pricingRules", sheet: "PricingRules", idField: "id" },
  { collection: "offers", sheet: "Offers", idField: "id" },
  { collection: "expenses", sheet: "Expenses", idField: "id" },
  { collection: "dailyAnalytics", sheet: "DailySummary", idField: "id" },
  { collection: "auditLogs", sheet: "AuditLogs", idField: "id" },
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Eco Sports Backup")
    .addItem("Run Full Backup Now", "runManualBackup")
    .addItem("Generate Daily Report", "generateDailyReportMenuAction")
    .addSeparator()
    .addItem("Install Daily Trigger (2:00 AM)", "installDailyTrigger")
    .addItem("Install Weekly Trigger (Sun 2:00 AM)", "installWeeklyTrigger")
    .addItem("Remove All Triggers", "removeAllTriggers")
    .addToUi();
}

/** Menu action: run backup for every collection, show a completion alert. */
function runManualBackup() {
  const result = runBackup(BACKUP_COLLECTIONS, "manual");
  SpreadsheetApp.getUi().alert(
    `Backup complete.\nSucceeded: ${result.succeeded.join(", ") || "none"}\nFailed: ${result.failed.join(", ") || "none"}`
  );
}

function generateDailyReportMenuAction() {
  const dateISO = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  generateDailyReport(dateISO);
  SpreadsheetApp.getUi().alert(`Daily report generated for ${dateISO}.`);
}

/**
 * Web app endpoint (Deploy > New deployment > Web app, execute as "Me",
 * access "Anyone"). Lets the Eco Sports admin panel trigger an on-demand
 * backup by fetching this URL with a valid `token`. Never exposes the
 * service account key or any Firestore data in the response — success/fail
 * only.
 */
function doGet(e) {
  const secret = PropertiesService.getScriptProperties().getProperty("BACKUP_WEBHOOK_SECRET");
  const token = e && e.parameter ? e.parameter.token : null;

  if (!secret || token !== secret) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "unauthorized" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const result = runBackup(BACKUP_COLLECTIONS, "manual-webhook");
    return ContentService.createTextOutput(JSON.stringify({ ok: true, result }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function installDailyTrigger() {
  removeTriggersFor_("scheduledDailyBackup");
  ScriptApp.newTrigger("scheduledDailyBackup").timeBased().everyDays(1).atHour(2).create();
  SpreadsheetApp.getUi().alert("Daily backup trigger installed for ~2:00 AM (script timezone).");
}

function installWeeklyTrigger() {
  removeTriggersFor_("scheduledWeeklyBackup");
  ScriptApp.newTrigger("scheduledWeeklyBackup").timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).create();
  SpreadsheetApp.getUi().alert("Weekly backup trigger installed for Sundays ~2:00 AM.");
}

function removeAllTriggers() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  SpreadsheetApp.getUi().alert("All triggers removed.");
}

function removeTriggersFor_(handlerName) {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === handlerName)
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

/** Called automatically by the daily time-driven trigger. */
function scheduledDailyBackup() {
  runBackup(BACKUP_COLLECTIONS, "daily-auto");
  const yesterday = Utilities.formatDate(new Date(Date.now() - 86400000), Session.getScriptTimeZone(), "yyyy-MM-dd");
  generateDailyReport(yesterday);
}

/** Called automatically by the weekly time-driven trigger. */
function scheduledWeeklyBackup() {
  runBackup(BACKUP_COLLECTIONS, "weekly-auto");
}
