// ============================================================================
// utils.js — shared helpers used across the whole app. Pure functions only.
// ============================================================================

/** "05:30" -> 330 (minutes since midnight). Supports "24:00".."29:59" for overnight display. */
export function timeStrToMinutes(str) {
  const [h, m] = str.split(":").map(Number);
  return h * 60 + m;
}

/** 330 -> "05:30". Wraps values >= 1440 back into 00:00-23:59 for display, tagging next-day. */
export function minutesToTimeStr(mins) {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  const nextDay = mins >= 1440;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${nextDay ? " (+1)" : ""}`;
}

/** Half-open interval overlap test: [aStart,aEnd) intersects [bStart,bEnd). */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** Does a pricing rule's [ruleStart, ruleEnd) window fully cover [start, end)? */
export function rangeContains(ruleStart, ruleEnd, start, end) {
  return ruleStart <= start && end <= ruleEnd;
}

export function getDayOfWeek(dateISO) {
  // dateISO = "YYYY-MM-DD", parsed as local date to avoid TZ off-by-one.
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(y, m - 1, d).getDay(); // 0=Sun..6=Sat
}

/** Combine a local date + minutes-since-midnight into a real Date (handles overnight rollover). */
export function toLocalDate(dateISO, minutes) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(y, m - 1, d, 0, minutes, 0, 0);
}

export function formatCurrency(amount, currency = "BDT") {
  const n = Math.round(amount);
  return `${n.toLocaleString("en-US")} ${currency}`;
}

export function round(value, mode = "nearest10", increment = 10) {
  switch (mode) {
    case "none":
      return value;
    case "down":
      return Math.floor(value);
    case "up":
      return Math.ceil(value);
    case "nearest10":
      return Math.round(value / 10) * 10;
    case "nearest50":
      return Math.round(value / 50) * 50;
    case "nearest100":
      return Math.round(value / 100) * 100;
    case "custom":
      return Math.round(value / increment) * increment;
    default:
      return value;
  }
}

export function isValidPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 15;
}

export function isValidEmail(email) {
  if (!email) return true; // optional field
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDaysISO(dateISO, days) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** Generates ECO-YYYYMMDD-### style human-readable booking IDs (sequence is a best-effort
 * client-side counter — true uniqueness is guaranteed by Firestore doc-ID collision retry
 * inside booking-engine.js, not by this function alone). */
export function generateBookingId(dateISO, sequence) {
  const compact = dateISO.replace(/-/g, "");
  return `ECO-${compact}-${String(sequence).padStart(3, "0")}`;
}

export function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `es-toast es-toast--${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("es-toast--show"));
  setTimeout(() => {
    el.classList.remove("es-toast--show");
    setTimeout(() => el.remove(), 300);
  }, 3500);
}
