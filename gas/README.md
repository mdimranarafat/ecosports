# Eco Sports — Google Apps Script Backup System

This backs up Firestore into Google Sheets on a schedule, **without Firebase
Storage** and without a paid Firebase plan beyond what Firestore itself
already needs. It works by having a Google Cloud **service account** (read
only) pull data out of Firestore via the REST API, from inside Apps Script.

## 1. Create the backup spreadsheet

1. Create a new Google Sheet — name it e.g. `Eco Sports — Backups`.
2. Extensions → Apps Script. Delete the default `Code.gs` boilerplate.
3. Create four script files matching this folder: `Code.gs`, `Backup.gs`,
   `Reports.gs` — paste in the contents from this repo's `gas/` folder
   (create files via the `+` next to "Files" in the Apps Script editor;
   the `.gs` extension is implied, don't type it in the file name field).

## 2. Create a read-only service account

1. In the [Google Cloud Console](https://console.cloud.google.com/) for
   your **same project as Firebase** (Firebase projects are GCP projects),
   go to IAM & Admin → Service Accounts → Create Service Account.
2. Name it e.g. `eco-sports-backup-reader`.
3. Grant it the role **Cloud Datastore Viewer** (this covers Firestore in
   Native mode too, and is read-only — it cannot write or delete data).
4. Open the new service account → Keys → Add Key → Create new key → JSON.
   Download the file and keep it private.

## 3. Store credentials in Script Properties

In the Apps Script editor: Project Settings (gear icon) → Script
Properties → Add script property, for each of:

| Property | Value |
|---|---|
| `FIRESTORE_PROJECT_ID` | your Firebase project ID |
| `SERVICE_ACCOUNT_EMAIL` | the `client_email` field from the JSON key |
| `SERVICE_ACCOUNT_KEY` | the `private_key` field from the JSON key, pasted exactly as-is (including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines and newlines) |
| `BACKUP_WEBHOOK_SECRET` | any long random string you generate yourself — used to authorize the optional manual-trigger web URL |

Never commit these values to source control or paste them into frontend
JavaScript — they live only in Script Properties, server-side inside Apps
Script.

## 4. Run it once manually

1. Reload the spreadsheet — you'll see a new **"Eco Sports Backup"** menu.
2. Click **Run Full Backup Now**. The first run will prompt you to
   authorize the script (it needs permission to call external URLs and
   edit the spreadsheet) — approve it.
3. Check that tabs appear for `Bookings`, `Customers`, `Facilities`,
   `PricingRules`, `Offers`, `Expenses`, `DailySummary`, `AuditLogs`, and
   `BackupLogs`, each populated with rows.
4. Click **Generate Daily Report** to populate `DailySummary` for today.

## 5. Automate it

From the same menu:

- **Install Daily Trigger (2:00 AM)** — runs a full backup + generates
  yesterday's daily report automatically every night.
- **Install Weekly Trigger (Sun 2:00 AM)** — an additional weekly full
  backup, useful as a second independent restore point.

You can install both; they're independent and idempotent (safe to re-run).
Use **Remove All Triggers** if you ever need to pause automation.

## 6. (Optional) Manual trigger from the admin panel

1. Deploy → New deployment → type **Web app** → Execute as **Me** →
   Who has access **Anyone**. Copy the deployment URL.
2. The URL, called as `<deployment-url>?token=<BACKUP_WEBHOOK_SECRET>`,
   triggers an on-demand backup and returns `{"ok":true,...}` JSON. Wire a
   button in `admin/settings.html` to fetch this URL if you want an
   in-dashboard "Backup Now" button (not included by default — the Sheets
   menu already covers manual backups without exposing any endpoint).
3. Treat the deployment URL + secret as sensitive: anyone with both can
   trigger a backup (read-only from Firestore's perspective, so this is
   low risk, but keep the secret private regardless).

## How duplicate/failed backups are handled

- **No duplicates:** each sheet's first column is the document's stable ID
  (`bookingId` for bookings, Firestore document ID for everything else).
  Every backup run diffs against IDs already in the sheet — existing rows
  are updated in place, only genuinely new documents are appended.
- **Failed collections don't block others:** `runBackup()` in `Backup.gs`
  wraps each collection in its own try/catch, so one failing collection
  (e.g. a transient network error) still lets every other collection back
  up successfully in the same run.
- **Every run is logged:** `BackupLogs` records the trigger type
  (`manual` / `daily-auto` / `weekly-auto` / `manual-webhook`), duration,
  which collections succeeded, which failed and why, and an overall
  `SUCCESS` / `PARTIAL` / `FAILED` status — so you always have an audit
  trail of the backup system itself, not just the business data.

## Restoring from a backup

These sheets are a read-only mirror for disaster recovery and offline
reporting — Eco Sports' live app never reads from them. To restore into
Firestore after data loss, use the [Firestore CSV/JSON import tooling] or
write a short one-off script using the same service-account credentials
with **write** access temporarily granted (Cloud Datastore User role)
rather than modifying this backup script's read-only scope permanently.
