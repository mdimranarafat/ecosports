// ============================================================================
// expense-manager.js — business expense CRUD + revenue-minus-expenses math.
// ============================================================================

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { logAudit } from "./reports.js";
import { getCurrentProfile } from "./auth.js";

const EXPENSES_COL = "expenses";

export const DEFAULT_CATEGORIES = ["Rent", "Salary", "Electricity", "Maintenance", "Equipment", "Marketing", "Other"];

export async function addExpense({ category, amount, date, facilityId = null, description = "" }) {
  const profile = getCurrentProfile();
  const payload = {
    category,
    amount: Number(amount),
    date, // "YYYY-MM-DD"
    facilityId,
    description,
    createdBy: profile?.uid || "unknown",
    createdByName: profile?.name || "Unknown",
    createdAt: serverTimestamp(),
  };
  const ref = await addDoc(collection(db, EXPENSES_COL), payload);
  await logAudit({
    action: "expense.added",
    entityType: "expense",
    entityId: ref.id,
    newSummary: `${category}: ${amount} BDT on ${date}`,
    performedBy: profile?.uid,
  });
  return ref.id;
}

export async function updateExpense(expenseId, patch) {
  await updateDoc(doc(db, EXPENSES_COL, expenseId), patch);
  await logAudit({ action: "expense.updated", entityType: "expense", entityId: expenseId, newSummary: JSON.stringify(patch).slice(0, 300) });
}

export async function deleteExpense(expenseId) {
  await deleteDoc(doc(db, EXPENSES_COL, expenseId));
  await logAudit({ action: "expense.deleted", entityType: "expense", entityId: expenseId });
}

/** Inclusive date range query, e.g. listExpenses("2026-08-01", "2026-08-31"). */
export async function listExpenses(startDateISO, endDateISO, facilityId = null) {
  let q = query(
    collection(db, EXPENSES_COL),
    where("date", ">=", startDateISO),
    where("date", "<=", endDateISO),
    orderBy("date", "desc")
  );
  const snap = await getDocs(q);
  let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (facilityId) rows = rows.filter((r) => r.facilityId === facilityId);
  return rows;
}

export function sumExpenses(expenses) {
  return expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
}

export function expensesByCategory(expenses) {
  const map = {};
  for (const e of expenses) {
    map[e.category] = (map[e.category] || 0) + (Number(e.amount) || 0);
  }
  return map;
}

/** revenue - expenses = net profit, used across dashboard.js and reports pages. */
export function computeNetProfit(totalRevenue, totalExpenses) {
  return totalRevenue - totalExpenses;
}
