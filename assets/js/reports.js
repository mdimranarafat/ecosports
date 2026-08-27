// ============================================================================
// reports.js — audit logging (complete) + CSV export (stubs wired in Phase 3
// with real Firestore range queries per report type; see README roadmap).
// ============================================================================

import { db } from "./firebase-config.js";
import { collection, addDoc, getDocs, query, orderBy, limit as fbLimit, where, startAfter } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getCurrentProfile } from "./auth.js";

/**
 * Writes an immutable audit log entry. Called from booking-engine.js,
 * facility-manager.js, pricing/offers/expense managers, and staff.js
 * whenever a state-changing action succeeds.
 */
export async function logAudit({ action, entityType, entityId, previousSummary = null, newSummary = null, performedBy }) {
  const profile = getCurrentProfile();
  try {
    await addDoc(collection(db, "auditLogs"), {
      action,
      entityType,
      entityId,
      previousSummary,
      newSummary,
      performedBy: performedBy || profile?.uid || "public",
      performedByName: profile?.name || (performedBy === "public" ? "Public booking" : "System"),
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    // Never let an audit log failure block the underlying business action —
    // log to console for ops visibility instead.
    console.error("Audit log write failed:", err);
  }
}

/**
 * Paginated audit log fetch for admin/audit-logs.html. Supports a simple
 * "load more" pattern via the returned cursor (last doc snapshot).
 */
export async function listAuditLogs({ pageSize = 50, cursor = null, actionFilter = null, entityTypeFilter = null } = {}) {
  const col = collection(db, "auditLogs");
  const clauses = [orderBy("timestamp", "desc"), fbLimit(pageSize)];
  if (actionFilter) clauses.unshift(where("action", "==", actionFilter));
  if (entityTypeFilter) clauses.unshift(where("entityType", "==", entityTypeFilter));
  if (cursor) clauses.push(startAfter(cursor));
  const snap = await getDocs(query(col, ...clauses));
  return {
    rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
    hasMore: snap.docs.length === pageSize,
  };
}

// ----------------------------------------------------------------------------
// CSV export — implemented generically here so admin/reports.html can call
// exportToCsv(rows, columns) once each report page assembles its own rows
// via the appropriate Firestore range query (built out per-report in Phase 3).
// ----------------------------------------------------------------------------

export function exportToCsv(rows, columns, filename) {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const body = rows
    .map((row) => columns.map((c) => csvEscape(resolveField(row, c.field))).join(","))
    .join("\n");
  const csv = `${header}\n${body}`;

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resolveField(row, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? "" : acc[key]), row);
}

function csvEscape(value) {
  const str = value == null ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Standard column definitions for the Bookings CSV export (see brief §21). */
export const BOOKING_CSV_COLUMNS = [
  { label: "Booking ID", field: "bookingId" },
  { label: "Customer Name", field: "customerName" },
  { label: "Phone", field: "customerPhone" },
  { label: "Facility", field: "facilityName" },
  { label: "Date", field: "date" },
  { label: "Start Time", field: "startLabel" },
  { label: "End Time", field: "endLabel" },
  { label: "Status", field: "status" },
  { label: "Original Price", field: "originalPrice" },
  { label: "Discount", field: "discountAmount" },
  { label: "Final Price", field: "finalPrice" },
  { label: "Paid", field: "paidAmount" },
  { label: "Due", field: "dueAmount" },
  { label: "Payment Method", field: "paymentMethod" },
];
