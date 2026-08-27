// ============================================================================
// admin-layout.js — renders the sidebar + topbar shell shared by every
// admin/*.html and manager/dashboard.html page. Nav items are filtered by
// the signed-in user's permissions so managers/staff only ever see links
// they're actually allowed to use (defense in depth — Firestore rules are
// the real enforcement, this is just UX).
// ============================================================================

import { getCurrentProfile, requireAuth, logout } from "./auth.js";
import { ROLE_LABELS } from "./roles.js";

const NAV_SECTIONS = [
  {
    label: "Overview",
    links: [{ href: "/admin/dashboard.html", label: "Dashboard", page: "dashboard", perm: "dashboard.view" }],
  },
  {
    label: "Operations",
    links: [
      { href: "/admin/bookings.html", label: "Bookings", page: "bookings", perm: "bookings.view" },
      { href: "/admin/calendar.html", label: "Calendar", page: "calendar", perm: "bookings.view" },
      { href: "/admin/facilities.html", label: "Facilities", page: "facilities", perm: "facilities.view" },
      { href: "/admin/customers.html", label: "Customers", page: "customers", perm: "customers.view" },
    ],
  },
  {
    label: "Revenue",
    links: [
      { href: "/admin/pricing.html", label: "Pricing Rules", page: "pricing", perm: "pricing.manage" },
      { href: "/admin/offers.html", label: "Offers", page: "offers", perm: "offers.manage" },
      { href: "/admin/revenue.html", label: "Revenue & Growth", page: "revenue", perm: "revenue.view" },
      { href: "/admin/expenses.html", label: "Expenses", page: "expenses", perm: "expenses.manage" },
      { href: "/admin/reports.html", label: "Reports & CSV", page: "reports", perm: "reports.export" },
    ],
  },
  {
    label: "System",
    links: [
      { href: "/admin/staff.html", label: "Staff & Roles", page: "staff", perm: "staff.manage" },
      { href: "/admin/audit-logs.html", label: "Audit Logs", page: "audit-logs", perm: "audit.view" },
      { href: "/admin/settings.html", label: "Settings", page: "settings", perm: "settings.manage" },
    ],
  },
];

const ICONS = {
  dashboard: "▦", bookings: "▤", calendar: "▥", facilities: "◆", customers: "◈",
  pricing: "৳", offers: "◎", revenue: "△", expenses: "▽", reports: "⇩",
  staff: "◉", "audit-logs": "☰", settings: "⚙",
};

/**
 * Call at the top of every admin page's module script:
 *   const { user, profile } = await initAdminLayout({ activePage: "bookings", permission: "bookings.view" });
 * Handles the auth guard, renders the shell into #es-admin-shell, and
 * returns the signed-in user + profile for the page's own logic.
 */
export async function initAdminLayout({ activePage, permission = null } = {}) {
  const { user, profile } = await requireAuth({ permission });
  renderShell(activePage, profile);
  return { user, profile };
}

function hasPerm(profile, key) {
  if (!key) return true;
  if (profile.role === "super_admin") return true;
  return profile.permissions?.[key] === true;
}

function renderShell(activePage, profile) {
  const root = document.getElementById("es-admin-shell");
  if (!root) return;

  const sections = NAV_SECTIONS.map((section) => {
    const links = section.links.filter((l) => hasPerm(profile, l.perm));
    if (!links.length) return "";
    return `
      <div class="es-sidebar__section-label">${section.label}</div>
      ${links
        .map(
          (l) => `<a class="es-sidebar__link ${l.page === activePage ? "is-active" : ""}" href="${l.href}">
            <span aria-hidden="true">${ICONS[l.page] || "•"}</span> ${l.label}
          </a>`
        )
        .join("")}`;
  }).join("");

  const initials = (profile.name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  const bodyHTML = root.innerHTML; // the page's own <main> content, written before this call
  root.innerHTML = `
    <div class="es-sidebar-backdrop" id="es-sidebar-backdrop"></div>
    <aside class="es-sidebar" id="es-sidebar">
      <div class="es-sidebar__logo">ECO <span>SPORTS</span></div>
      ${sections}
      <div class="es-sidebar__user">
        <div class="es-sidebar__avatar">${initials}</div>
        <div class="es-sidebar__user-meta">
          <div class="es-sidebar__user-name">${profile.name || "Staff"}</div>
          <div class="es-sidebar__user-role">${ROLE_LABELS[profile.role] || profile.role}</div>
        </div>
        <button class="es-icon-btn" id="es-logout-btn" title="Sign out" style="margin-left:auto;">⏻</button>
      </div>
    </aside>
    <main class="es-main">
      <div class="es-topbar">
        <button class="es-menu-toggle" id="es-menu-toggle">&#9776;</button>
        <div id="es-admin-body-slot"></div>
      </div>
    </main>`;

  document.getElementById("es-admin-body-slot").innerHTML = bodyHTML;

  document.getElementById("es-logout-btn").addEventListener("click", async () => {
    await logout();
    window.location.href = "/login.html";
  });

  const sidebar = document.getElementById("es-sidebar");
  const backdrop = document.getElementById("es-sidebar-backdrop");
  document.getElementById("es-menu-toggle").addEventListener("click", () => {
    sidebar.classList.toggle("is-open");
    backdrop.classList.toggle("is-open");
  });
  backdrop.addEventListener("click", () => {
    sidebar.classList.remove("is-open");
    backdrop.classList.remove("is-open");
  });
}

export function showToast(msg, kind = "success") {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "es-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `es-toast es-toast--show es-toast--${kind}`;
  setTimeout(() => (t.className = "es-toast"), 3200);
}
