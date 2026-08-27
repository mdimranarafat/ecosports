/**
 * Backup.gs — pulls documents from Cloud Firestore via the Firestore REST
 * API (read-only service account, no Firebase Storage involved anywhere)
 * and writes them into organized tabs in this bound Google Sheet.
 *
 * AUTH STRATEGY
 * We authenticate as a Google Cloud service account using a hand-rolled
 * JWT → OAuth2 token exchange (Utilities.computeRsaSha256Signature), so no
 * external library is required. The service account only needs the
 * "Cloud Datastore Viewer" (or "Firebase Rules System" is NOT needed —
 * just Datastore/Firestore Viewer) IAM role — it can read but never write
 * Firestore, so a leaked Sheet can't be used to tamper with live data.
 *
 * DEDUPE STRATEGY
 * Each sheet's first column is the document's stable ID (bookingId,
 * customerId, etc). Before appending, we build a Set of IDs already
 * present in the sheet and skip any row whose ID is already there, then
 * update changed rows in place rather than re-appending — so re-running a
 * backup (daily, weekly, or manual) never creates duplicate rows and a
 * failed run can always be safely retried.
 */

const FIRESTORE_HOST = "https://firestore.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore.readonly";

/** Orchestrates a full backup run across every configured collection. */
function runBackup(collections, trigger) {
  const startedAt = new Date();
  const succeeded = [];
  const failed = [];
  const accessToken = getFirestoreAccessToken_();

  collections.forEach((cfg) => {
    try {
      const docs = fetchAllDocuments_(cfg.collection, accessToken);
      const rows = docs.map(flattenFirestoreDoc_);
      writeRowsToSheet_(cfg.sheet, rows, cfg.idField);
      succeeded.push(cfg.collection);
    } catch (err) {
      failed.push(`${cfg.collection} (${err.message || err})`);
      Logger.log(`Backup failed for ${cfg.collection}: ${err}`);
    }
  });

  logBackupRun_({ trigger, startedAt, finishedAt: new Date(), succeeded, failed });
  return { succeeded, failed };
}

// ---------------------------------------------------------------------------
// AUTH — JWT-signed service account → short-lived OAuth2 access token
// ---------------------------------------------------------------------------
function getFirestoreAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const email = props.getProperty("SERVICE_ACCOUNT_EMAIL");
  const key = props.getProperty("SERVICE_ACCOUNT_KEY");
  if (!email || !key) {
    throw new Error("Missing SERVICE_ACCOUNT_EMAIL / SERVICE_ACCOUNT_KEY script properties. See gas/README.md.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: email,
    scope: FIRESTORE_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const encode = (obj) => Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, "");
  const unsigned = `${encode(header)}.${encode(claimSet)}`;
  const signatureBytes = Utilities.computeRsaSha256Signature(unsigned, key);
  const signature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, "");
  const jwt = `${unsigned}.${signature}`;

  const response = UrlFetchApp.fetch(TOKEN_URL, {
    method: "post",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });

  const parsed = JSON.parse(response.getContentText());
  if (!parsed.access_token) {
    throw new Error("Failed to obtain Firestore access token: " + response.getContentText());
  }
  return parsed.access_token;
}

// ---------------------------------------------------------------------------
// FIRESTORE REST — paginated document listing
// ---------------------------------------------------------------------------
function fetchAllDocuments_(collectionId, accessToken) {
  const projectId = PropertiesService.getScriptProperties().getProperty("FIRESTORE_PROJECT_ID");
  if (!projectId) throw new Error("Missing FIRESTORE_PROJECT_ID script property.");

  let documents = [];
  let pageToken = null;

  do {
    let url = `${FIRESTORE_HOST}/projects/${projectId}/databases/(default)/documents/${collectionId}?pageSize=300`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { Authorization: `Bearer ${accessToken}` },
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      throw new Error(`Firestore API ${code} for ${collectionId}: ${response.getContentText()}`);
    }

    const body = JSON.parse(response.getContentText());
    documents = documents.concat(body.documents || []);
    pageToken = body.nextPageToken || null;
  } while (pageToken);

  return documents;
}

/** Converts a Firestore REST document ({fields: {k: {stringValue|...}}}) into a flat plain object. */
function flattenFirestoreDoc_(doc) {
  const id = doc.name.split("/").pop();
  const out = { id };
  const fields = doc.fields || {};
  Object.keys(fields).forEach((key) => {
    out[key] = coerceFirestoreValue_(fields[key]);
  });
  return out;
}

function coerceFirestoreValue_(value) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.nullValue !== undefined) return "";
  if (value.mapValue !== undefined) {
    const obj = {};
    const mapFields = value.mapValue.fields || {};
    Object.keys(mapFields).forEach((k) => (obj[k] = coerceFirestoreValue_(mapFields[k])));
    return JSON.stringify(obj);
  }
  if (value.arrayValue !== undefined) {
    return (value.arrayValue.values || []).map(coerceFirestoreValue_).join("; ");
  }
  return "";
}

// ---------------------------------------------------------------------------
// SHEET WRITES — dedupe by ID column, update-in-place or append
// ---------------------------------------------------------------------------
function writeRowsToSheet_(sheetName, rows, idField) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  if (rows.length === 0) return;

  // Union of all keys across rows becomes the header — Firestore documents
  // in the same collection can have slightly different fields over time.
  const headerSet = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => headerSet.add(k)));
  const idKey = rows[0][idField] !== undefined ? idField : "id";
  const headers = [idKey, ...[...headerSet].filter((h) => h !== idKey)];

  const existingData = sheet.getDataRange().getValues();
  const hasHeader = existingData.length > 0 && existingData[0][0] === idKey;

  if (!hasHeader) {
    sheet.clear();
    sheet.appendRow(headers);
  }

  const currentHeader = sheet.getRange(1, 1, 1, sheet.getLastColumn() || headers.length).getValues()[0];
  const idColIndex = 0; // idKey is always column A by construction above

  const existingRows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues() : [];
  const idToRowNumber = {};
  existingRows.forEach((row, i) => {
    if (row[idColIndex]) idToRowNumber[row[idColIndex]] = i + 2; // +2: header row + 1-indexing
  });

  const toAppend = [];
  rows.forEach((r) => {
    const rowArray = headers.map((h) => (r[h] !== undefined ? r[h] : ""));
    const id = r[idKey];
    if (id && idToRowNumber[id]) {
      // Update existing row in place (data may have changed since last backup).
      sheet.getRange(idToRowNumber[id], 1, 1, rowArray.length).setValues([rowArray]);
    } else {
      toAppend.push(rowArray);
    }
  });

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, headers.length).setValues(toAppend);
  }
}

// ---------------------------------------------------------------------------
// BACKUP LOGGING
// ---------------------------------------------------------------------------
function logBackupRun_({ trigger, startedAt, finishedAt, succeeded, failed }) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("BackupLogs");
  if (!sheet) {
    sheet = ss.insertSheet("BackupLogs");
    sheet.appendRow(["Timestamp", "Trigger", "Duration (s)", "Succeeded Collections", "Failed Collections", "Status"]);
  }
  const durationSec = Math.round((finishedAt - startedAt) / 1000);
  const status = failed.length === 0 ? "SUCCESS" : succeeded.length === 0 ? "FAILED" : "PARTIAL";
  sheet.appendRow([finishedAt, trigger, durationSec, succeeded.join(", "), failed.join(", "), status]);
}
