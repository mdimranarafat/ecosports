// ============================================================================
// csv-export.js — date-range presets + per-report-type row builders. Actual
// CSV encoding (escaping, blob download) lives in reports.js:exportToCsv();
// this module is only responsible for "what data goes in the file."
// ============================================================================

import { db } from "./firebase-config.js";
import { collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { exportToCsv, BOOKING_CSV_COLUMNS } from "./reports.js";
import { minutesToTimeStr } from "./utils.js";
import { listExpenses } from "./expense-manager.js";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDaysISO(dateISO, days) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Resolves a named preset ("today"|"yesterday"|"thisWeek"|"lastWeek"|"thisMonth"|"lastMonth") to {start,end}. */
export function resolveDateRangePreset(preset, customStart = null, customEnd = null) {
  const today = todayISO();
  const now = new Date();
  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = addDaysISO(today, -1);
      return { start: y, end: y };
    }
    case "thisWeek":
      return { start: addDaysISO(today, -now.getDay()), end: today };
    case "lastWeek": {
      const thisWeekStart = addDaysISO(today, -now.getDay());
      return { start: addDaysISO(thisWeekStart, -7), end: addDaysISO(thisWeekStart, -1) };
    }
    case "thisMonth":
      return { start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`, end: today };
    case "lastMonth": {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevEnd = addDaysISO(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`, -1);
      return { start: `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-01`, end: prevEnd };
    }
    case "custom":
    default:
      return { start: customStart || today, end: customEnd || today };
  }
}

async function fetchBookings(start, end) {
  const snap = await getDocs(
    query(collection(db, "bookings"), where("date", ">=", start), where("date", "<=", end), orderBy("date"))
  );
  return snap.docs.map((d) => {
    const b = { id: d.id, ...d.data() };
    b.startLabel = minutesToTimeStr(b.startMinutes);
    b.endLabel = minutesToTimeStr(b.endMinutes);
    return b;
  });
}

export async function exportBookingsCsv(preset, customStart, customEnd) {
  const { start, end } = resolveDateRangePreset(preset, customStart, customEnd);
  const rows = await fetchBookings(start, end);
  exportToCsv(rows, BOOKING_CSV_COLUMNS, `eco-sports-bookings-${start}_to_${end}`);
}

export async function exportRevenueCsv(preset, customStart, customEnd) {
  const { start, end } = resolveDateRangePreset(preset, customStart, customEnd);
  const rows = await fetchBookings(start, end);
  const revenueRows = rows.filter((r) => ["confirmed", "completed"].includes(r.status));
  const columns = [
    { label: "Date", field: "date" },
    { label: "Booking ID", field: "bookingId" },
    { label: "Facility", field: "facilityName" },
    { label: "Original Price", field: "originalPrice" },
    { label: "Discount", field: "discountAmount" },
    { label: "Final Price", field: "finalPrice" },
    { label: "Payment Method", field: "paymentMethod" },
    { label: "Payment Status", field: "paymentStatus" },
  ];
  exportToCsv(revenueRows, columns, `eco-sports-revenue-${start}_to_${end}`);
}

export async function exportCustomersCsv() {
  const snap = await getDocs(query(collection(db, "customers"), orderBy("lastBookingAt", "desc")));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const columns = [
    { label: "Customer ID", field: "customerId" },
    { label: "Name", field: "name" },
    { label: "Phone", field: "phone" },
    { label: "Email", field: "email" },
    { label: "Total Bookings", field: "totalBookings" },
    { label: "Completed", field: "completedBookings" },
    { label: "Cancelled", field: "cancelledBookings" },
    { label: "Total Spending", field: "totalSpending" },
    { label: "Outstanding Due", field: "outstandingDue" },
  ];
  exportToCsv(rows, columns, "eco-sports-customers");
}

export async function exportExpensesCsv(preset, customStart, customEnd) {
  const { start, end } = resolveDateRangePreset(preset, customStart, customEnd);
  const rows = await listExpenses(start, end);
  const columns = [
    { label: "Date", field: "date" },
    { label: "Category", field: "category" },
    { label: "Amount", field: "amount" },
    { label: "Facility", field: "facilityId" },
    { label: "Description", field: "description" },
    { label: "Created By", field: "createdByName" },
  ];
  exportToCsv(rows, columns, `eco-sports-expenses-${start}_to_${end}`);
}

export async function exportFacilityPerformanceCsv(preset, customStart, customEnd, facilities) {
  const { start, end } = resolveDateRangePreset(preset, customStart, customEnd);
  const { computeFacilityPerformance } = await import("./analytics.js");
  const rows = await computeFacilityPerformance(start, end, facilities);
  const columns = [
    { label: "Facility", field: "name" },
    { label: "Bookings", field: "bookings" },
    { label: "Revenue", field: "revenue" },
    { label: "Avg Duration (min)", field: "avgDurationMinutes" },
    { label: "Utilization %", field: "utilizationPct" },
    { label: "Peak Hour", field: "peakHour" },
  ];
  exportToCsv(rows, columns, `eco-sports-facility-performance-${start}_to_${end}`);
}

export async function exportPaymentReportCsv(preset, customStart, customEnd) {
  const { start, end } = resolveDateRangePreset(preset, customStart, customEnd);
  const rows = await fetchBookings(start, end);
  const columns = [
    { label: "Date", field: "date" },
    { label: "Booking ID", field: "bookingId" },
    { label: "Customer", field: "customerName" },
    { label: "Final Price", field: "finalPrice" },
    { label: "Paid", field: "paidAmount" },
    { label: "Due", field: "dueAmount" },
    { label: "Payment Status", field: "paymentStatus" },
    { label: "Payment Method", field: "paymentMethod" },
  ];
  exportToCsv(rows, columns, `eco-sports-payments-${start}_to_${end}`);
}
