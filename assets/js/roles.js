// ============================================================================
// roles.js — the canonical list of permission keys and the default bundle
// each role starts with. Used when creating new staff accounts in
// admin/staff.html. Actual enforcement always happens per-key (see auth.js
// hasPermission() and firestore.rules hasPerm()) — role is just a preset.
// ============================================================================

export const PERMISSIONS = [
  "dashboard.view",
  "bookings.view",
  "bookings.create",
  "bookings.edit",
  "bookings.cancel",
  "facilities.view",
  "facilities.edit",
  "pricing.manage",
  "offers.manage",
  "customers.view",
  "revenue.view",
  "expenses.manage",
  "reports.export",
  "staff.manage",
  "settings.manage",
  "audit.view",
];

export const ROLE_DEFAULTS = {
  super_admin: Object.fromEntries(PERMISSIONS.map((p) => [p, true])),

  admin: Object.fromEntries(
    PERMISSIONS.map((p) => [p, !["settings.manage"].includes(p)])
  ),

  manager: Object.fromEntries(
    PERMISSIONS.map((p) => [
      p,
      [
        "dashboard.view",
        "bookings.view",
        "bookings.create",
        "bookings.edit",
        "bookings.cancel",
        "facilities.view",
        "customers.view",
        "revenue.view",
        "offers.manage",
        "reports.export",
      ].includes(p),
    ])
  ),

  staff: Object.fromEntries(
    PERMISSIONS.map((p) => [
      p,
      ["dashboard.view", "bookings.view", "bookings.create", "facilities.view", "customers.view"].includes(p),
    ])
  ),
};

export function defaultPermissionsForRole(role) {
  return { ...(ROLE_DEFAULTS[role] || ROLE_DEFAULTS.staff) };
}

export const ROLE_LABELS = {
  super_admin: "Super Admin",
  admin: "Admin",
  manager: "Manager",
  staff: "Staff",
};
