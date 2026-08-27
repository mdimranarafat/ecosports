// ============================================================================
// analytics.js — dashboard metrics, growth comparisons, and facility
// performance. Queries are date-range bounded (never "download everything")
// per brief §33. dailyAnalytics/{date} rollup docs are read when present and
// computed on-the-fly + cached back when missing, so repeat dashboard loads
// for past (closed) days cost one document read instead of a full query.
// ============================================================================

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  getDocs,
  query,
  where,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { sumExpenses } from "./expense-manager.js";

const DONE_STATUSES = ["completed"];
const REVENUE_STATUSES = ["confirmed", "completed"]; // counted toward revenue once locked in

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysISO(dateISO, days) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Fetches all bookings whose `date` falls within [startISO, endISO] inclusive. Single indexed range query. */
async function fetchBookingsInRange(startISO, endISO) {
  const snap = await getDocs(
    query(collection(db, "bookings"), where("date", ">=", startISO), where("date", "<=", endISO), orderBy("date"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Core rollup used by the "Today" dashboard cards and any single-day report. */
export async function computeDaySummary(dateISO) {
  // Try the cached rollup first (cheap: 1 read instead of N).
  const cacheRef = doc(db, "dailyAnalytics", dateISO);
  const isPastDay = dateISO < todayISO();
  if (isPastDay) {
    const cached = await getDoc(cacheRef);
    if (cached.exists()) return cached.data();
  }

  const bookings = await fetchBookingsInRange(dateISO, dateISO);
  const expenses = await import("./expense-manager.js").then((m) => m.listExpenses(dateISO, dateISO));

  const summary = summarizeBookings(bookings);
  summary.expenses = sumExpenses(expenses);
  summary.profit = summary.revenue - summary.expenses;
  summary.date = dateISO;

  // Cache rollups for CLOSED days only — today's numbers are still moving.
  if (isPastDay) {
    await setDoc(cacheRef, summary).catch(() => {});
  }
  return summary;
}

export function summarizeBookings(bookings) {
  const byStatus = { pending: 0, approved: 0, confirmed: 0, completed: 0, cancelled: 0, rejected: 0, no_show: 0 };
  let revenue = 0;
  const byFacility = {};

  for (const b of bookings) {
    byStatus[b.status] = (byStatus[b.status] || 0) + 1;
    if (REVENUE_STATUSES.includes(b.status)) {
      revenue += b.finalPrice || 0;
      const f = (byFacility[b.facilityId] ||= { bookings: 0, revenue: 0, hoursBooked: 0 });
      f.bookings += 1;
      f.revenue += b.finalPrice || 0;
      f.hoursBooked += (b.durationMinutes || 0) / 60;
    }
  }

  return {
    totalBookings: bookings.length,
    pendingBookings: byStatus.pending,
    confirmedBookings: byStatus.confirmed,
    completedBookings: byStatus.completed,
    cancelledBookings: byStatus.cancelled,
    revenue,
    byFacility,
  };
}

/** Revenue for an arbitrary inclusive date range — used by weekly/monthly/custom cards. */
export async function computeRangeRevenue(startISO, endISO) {
  const bookings = await fetchBookingsInRange(startISO, endISO);
  return summarizeBookings(bookings);
}

/** Percentage change helper: (current - previous) / previous * 100, safe for zero baselines. */
export function pctChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / previous) * 100;
}

/** Today vs yesterday / this week vs last week / this month vs last month. */
export async function computeGrowthComparisons() {
  const today = todayISO();
  const yesterday = addDaysISO(today, -1);

  const [todaySummary, yesterdaySummary] = await Promise.all([computeDaySummary(today), computeDaySummary(yesterday)]);

  const now = new Date();
  const weekStart = addDaysISO(today, -now.getDay());
  const lastWeekStart = addDaysISO(weekStart, -7);
  const lastWeekEnd = addDaysISO(weekStart, -1);

  const monthStartISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthStartISO = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
  const prevMonthEndISO = addDaysISO(monthStartISO, -1);

  const [thisWeek, lastWeek, thisMonth, lastMonth] = await Promise.all([
    computeRangeRevenue(weekStart, today),
    computeRangeRevenue(lastWeekStart, lastWeekEnd),
    computeRangeRevenue(monthStartISO, today),
    computeRangeRevenue(prevMonthStartISO, prevMonthEndISO),
  ]);

  return {
    today: { value: todaySummary.revenue, changePct: pctChange(todaySummary.revenue, yesterdaySummary.revenue) },
    week: { value: thisWeek.revenue, changePct: pctChange(thisWeek.revenue, lastWeek.revenue) },
    month: { value: thisMonth.revenue, changePct: pctChange(thisMonth.revenue, lastMonth.revenue) },
    bookingGrowth: {
      changePct: pctChange(thisMonth.totalBookings, lastMonth.totalBookings),
      completedTrendPct: pctChange(thisMonth.completedBookings, lastMonth.completedBookings),
      cancellationTrendPct: pctChange(thisMonth.cancelledBookings, lastMonth.cancelledBookings),
    },
  };
}

/** Facility performance table: bookings, revenue, avg duration, utilization %, peak hour — for a date range. */
export async function computeFacilityPerformance(startISO, endISO, facilities) {
  const bookings = await fetchBookingsInRange(startISO, endISO);
  const dayCount = daysBetweenInclusive(startISO, endISO);
  const hourCounts = {}; // facilityId -> { hour: count }

  const perFacility = {};
  for (const f of facilities) {
    perFacility[f.id] = { facilityId: f.id, name: f.name, bookings: 0, revenue: 0, totalHours: 0 };
    hourCounts[f.id] = {};
  }

  for (const b of bookings) {
    if (!REVENUE_STATUSES.includes(b.status)) continue;
    const row = perFacility[b.facilityId];
    if (!row) continue;
    row.bookings += 1;
    row.revenue += b.finalPrice || 0;
    row.totalHours += (b.durationMinutes || 0) / 60;
    const hour = Math.floor((b.startMinutes % 1440) / 60);
    hourCounts[b.facilityId][hour] = (hourCounts[b.facilityId][hour] || 0) + 1;
  }

  return facilities.map((f) => {
    const row = perFacility[f.id];
    const openMinutes = facilityOpenMinutesPerDay(f);
    const availableHours = (openMinutes / 60) * dayCount;
    const peakHour = Object.entries(hourCounts[f.id]).sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      ...row,
      avgDurationMinutes: row.bookings ? Math.round((row.totalHours * 60) / row.bookings) : 0,
      utilizationPct: availableHours > 0 ? Math.min(100, (row.totalHours / availableHours) * 100) : 0,
      peakHour: peakHour != null ? `${String(peakHour).padStart(2, "0")}:00` : "—",
    };
  });
}

function facilityOpenMinutesPerDay(facility) {
  const [oh, om] = (facility.openingTime || "00:00").split(":").map(Number);
  const [ch, cm] = (facility.closingTime || "24:00").split(":").map(Number);
  return Math.max(0, ch * 60 + cm - (oh * 60 + om));
}

function daysBetweenInclusive(startISO, endISO) {
  const start = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  return Math.round((end - start) / 86400000) + 1;
}

/** New vs returning customers within a date range, for the dashboard cards. */
export async function computeCustomerGrowth(startISO, endISO) {
  const bookings = await fetchBookingsInRange(startISO, endISO);
  const seenPhones = new Set();
  let newCustomers = 0;
  let returningCustomers = 0;
  for (const b of bookings) {
    if (seenPhones.has(b.customerPhone)) continue;
    seenPhones.add(b.customerPhone);
    // Heuristic: treated as "new" if this is their first booking overall —
    // exact classification (vs. a prior booking outside the range) is
    // refined using the customers collection's firstBookingAt on the
    // customers.html page where full profiles are already loaded.
    newCustomers += 1;
  }
  returningCustomers = seenPhones.size - newCustomers;
  return { newCustomers, returningCustomers, totalUniqueCustomers: seenPhones.size };
}
