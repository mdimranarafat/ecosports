// ============================================================================
// dashboard.js — controller for admin/dashboard.html (and reused subset for
// manager/dashboard.html). Pulls from analytics.js + expense-manager.js and
// renders Chart.js charts. Kept separate from analytics.js so analytics.js
// stays a pure/data module usable from reports.html and CSV export too.
// ============================================================================

import { computeDaySummary, computeGrowthComparisons, computeFacilityPerformance, computeRangeRevenue } from "./analytics.js";
import { listExpenses, sumExpenses, computeNetProfit } from "./expense-manager.js";
import { getActiveFacilities } from "./facility-manager.js";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDaysISO(dateISO, days) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Loads everything the dashboard needs in parallel and returns a single
 * plain-object payload the page's render functions can consume — keeps
 * dashboard.html's inline script tiny and declarative.
 */
export async function loadDashboardData() {
  const today = todayISO();
  const weekAgo = addDaysISO(today, -6);
  const monthAgo = addDaysISO(today, -29);

  const [todaySummary, todayExpenses, growth, facilities, weekRevenueSeries] = await Promise.all([
    computeDaySummary(today),
    listExpenses(today, today),
    computeGrowthComparisons(),
    getActiveFacilities(),
    computeDailyRevenueSeries(weekAgo, today),
  ]);

  const todayExpenseTotal = sumExpenses(todayExpenses);
  const facilityPerf = await computeFacilityPerformance(monthAgo, today, facilities);

  return {
    today: {
      ...todaySummary,
      expenses: todayExpenseTotal,
      profit: computeNetProfit(todaySummary.revenue, todayExpenseTotal),
    },
    growth,
    facilityPerf: facilityPerf.sort((a, b) => b.revenue - a.revenue),
    weekRevenueSeries,
    mostBookedFacility: facilityPerf.slice().sort((a, b) => b.bookings - a.bookings)[0] || null,
  };
}

/** Day-by-day revenue for the last N days — feeds the "Revenue over time" line chart. */
export async function computeDailyRevenueSeries(startISO, endISO) {
  const cursor = [];
  let d = startISO;
  while (d <= endISO) {
    cursor.push(d);
    d = addDaysISO(d, 1);
  }
  const results = await Promise.all(cursor.map((date) => computeRangeRevenue(date, date)));
  return cursor.map((date, i) => ({ date, revenue: results[i].revenue, bookings: results[i].totalBookings }));
}

/** Thin Chart.js wrapper so dashboard.html only needs canvas IDs + data, no Chart.js API knowledge. */
export function renderRevenueLineChart(canvasId, series) {
  // eslint-disable-next-line no-undef
  return new Chart(document.getElementById(canvasId), {
    type: "line",
    data: {
      labels: series.map((s) => s.date.slice(5)), // MM-DD
      datasets: [
        {
          label: "Revenue (BDT)",
          data: series.map((s) => s.revenue),
          borderColor: "#1f8a5f",
          backgroundColor: "rgba(31,138,95,0.12)",
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });
}

export function renderFacilityBarChart(canvasId, facilityPerf) {
  // eslint-disable-next-line no-undef
  return new Chart(document.getElementById(canvasId), {
    type: "bar",
    data: {
      labels: facilityPerf.map((f) => f.name),
      datasets: [{ label: "Revenue (BDT)", data: facilityPerf.map((f) => f.revenue), backgroundColor: "#1f8a5f" }],
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });
}

export function renderBookingStatusDonut(canvasId, today) {
  // eslint-disable-next-line no-undef
  return new Chart(document.getElementById(canvasId), {
    type: "doughnut",
    data: {
      labels: ["Pending", "Confirmed", "Completed", "Cancelled"],
      datasets: [
        {
          data: [today.pendingBookings, today.confirmedBookings, today.completedBookings, today.cancelledBookings],
          backgroundColor: ["#e6a817", "#2f7cd6", "#1f8a5f", "#d64545"],
        },
      ],
    },
    options: { responsive: true },
  });
}
