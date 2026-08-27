/**
 * Reports.gs — builds a human-readable DailySummary tab from the raw
 * `Bookings` and `Expenses` sheet data that Backup.gs pulls in. This runs
 * AFTER a backup (see Code.gs scheduledDailyBackup) so the numbers reflect
 * the latest Firestore state, and gives the business owner a report they
 * can read directly in Sheets without opening the admin dashboard.
 */

/** Appends/updates one row in DailySummary for the given "YYYY-MM-DD" date. */
function generateDailyReport(dateISO) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const bookingsSheet = ss.getSheetByName("Bookings");
  const expensesSheet = ss.getSheetByName("Expenses");

  const bookings = bookingsSheet ? sheetToObjects_(bookingsSheet) : [];
  const expenses = expensesSheet ? sheetToObjects_(expensesSheet) : [];

  const dayBookings = bookings.filter((b) => b.date === dateISO);
  const dayExpenses = expenses.filter((e) => e.date === dateISO);

  const revenueStatuses = ["confirmed", "completed"];
  const revenue = dayBookings
    .filter((b) => revenueStatuses.indexOf(b.status) !== -1)
    .reduce((sum, b) => sum + (Number(b.finalPrice) || 0), 0);
  const discounts = dayBookings.reduce((sum, b) => sum + (Number(b.discountAmount) || 0), 0);
  const expenseTotal = dayExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const totalExpenseCount = dayExpenses.length;
  const profit = revenue - expenseTotal;

  const statusCounts = { pending: 0, approved: 0, confirmed: 0, completed: 0, cancelled: 0, rejected: 0, no_show: 0 };
  dayBookings.forEach((b) => {
    if (statusCounts[b.status] !== undefined) statusCounts[b.status] += 1;
  });

  let summarySheet = ss.getSheetByName("DailySummary");
  if (!summarySheet) {
    summarySheet = ss.insertSheet("DailySummary");
    summarySheet.appendRow([
      "Date", "Total Bookings", "Pending", "Confirmed", "Completed", "Cancelled",
      "Gross Revenue", "Discounts Given", "Total Expenses", "Expense Entries", "Net Profit", "Generated At",
    ]);
  }

  const rowValues = [
    dateISO,
    dayBookings.length,
    statusCounts.pending,
    statusCounts.confirmed,
    statusCounts.completed,
    statusCounts.cancelled,
    revenue,
    discounts,
    expenseTotal,
    totalExpenseCount,
    profit,
    new Date(),
  ];

  const data = summarySheet.getDataRange().getValues();
  let existingRowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === dateISO) {
      existingRowIndex = i + 1; // 1-indexed
      break;
    }
  }

  if (existingRowIndex > 0) {
    summarySheet.getRange(existingRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    summarySheet.appendRow(rowValues);
  }

  return { date: dateISO, revenue, expenseTotal, profit, totalBookings: dayBookings.length };
}

/** Convenience: regenerate DailySummary for every date present in Bookings. */
function regenerateAllDailyReports() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const bookingsSheet = ss.getSheetByName("Bookings");
  if (!bookingsSheet) return;
  const bookings = sheetToObjects_(bookingsSheet);
  const dates = [...new Set(bookings.map((b) => b.date).filter(Boolean))].sort();
  dates.forEach((d) => generateDailyReport(d));
  SpreadsheetApp.getUi().alert(`Regenerated DailySummary for ${dates.length} date(s).`);
}

/** Helper: turns a sheet with a header row into an array of plain objects. */
function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i]));
    return obj;
  });
}
