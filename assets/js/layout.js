// ============================================================================
// layout.js — injects the shared public-site header + footer into any page
// that has <div id="es-header-slot"></div> / <div id="es-footer-slot"></div>.
// Kept as plain DOM injection (no build step, no framework) per the "no
// bundler required" requirement — every public page still works if opened
// as a static file. Active nav link is set from data-page on <body>.
// ============================================================================

// ✅ Fixed Relative Paths (Removed leading '/')
const NAV_LINKS = [
  { href: "index.html", label: "Home", page: "home" },
  { href: "facilities.html", label: "Facilities", page: "facilities" },
  { href: "booking.html", label: "Book Now", page: "booking" },
  { href: "offers.html", label: "Offers", page: "offers" },
  { href: "about.html", label: "About", page: "about" },
  { href: "contact.html", label: "Contact", page: "contact" },
];

export function renderHeader() {
  const activePage = document.body.dataset.page;
  const slot = document.getElementById("es-header-slot");
  if (!slot) return;

  const links = NAV_LINKS.map(
    (l) => `<a href="${l.href}" class="${l.page === activePage ? "is-active" : ""}">${l.label}</a>`
  ).join("");

  slot.innerHTML = `
    <header class="es-header">
      <div class="es-container es-header__row">
        <a href="index.html" class="es-logo">ECO <span>SPORTS</span></a>
        <nav class="es-nav" id="es-nav">${links}
          <a href="booking.html" class="es-btn es-btn--primary" style="padding:10px 20px;font-size:0.82rem;">Book Your Slot</a>
        </nav>
        <button class="es-nav__toggle" id="es-nav-toggle" aria-label="Toggle menu">&#9776;</button>
      </div>
    </header>`;

  document.getElementById("es-nav-toggle")?.addEventListener("click", () => {
    document.getElementById("es-nav")?.classList.toggle("is-open");
  });
}

export function renderFooter() {
  const slot = document.getElementById("es-footer-slot");
  if (!slot) return;
  const year = new Date().getFullYear();
  slot.innerHTML = `
    <footer class="es-footer">
      <div class="es-container">
        <div class="es-footer__grid">
          <div>
            <div class="es-logo" style="margin-bottom:12px;">ECO <span>SPORTS</span></div>
            <p>Premium multi-sport turfs, courts, and pool — book your slot in seconds, right in the heart of Chattogram.</p>
          </div>
          <div>
            <h3 style="font-size:0.95rem;">Explore</h3>
            <p><a href="facilities.html">Facilities</a></p>
            <p><a href="offers.html">Offers</a></p>
            <p><a href="booking.html">Book Now</a></p>
          </div>
          <div>
            <h3 style="font-size:0.95rem;">Company</h3>
            <p><a href="about.html">About Us</a></p>
            <p><a href="contact.html">Contact</a></p>
            <p><a href="login.html">Staff Login</a></p>
          </div>
          <div>
            <h3 style="font-size:0.95rem;">Contact</h3>
            <p id="es-footer-phone" class="es-mono">Loading…</p>
            <p id="es-footer-address">Chattogram, Bangladesh</p>
          </div>
        </div>
        <div class="es-footer__bottom">
          <span>&copy; ${year} Eco Sports. All rights reserved.</span>
          <span>Built for athletes, by athletes.</span>
        </div>
      </div>
    </footer>`;

  // ✅ Fixed dynamic import path to relative "./firebase-config.js"
  import("./firebase-config.js").then(async ({ db }) => {
    const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    try {
      const snap = await getDoc(doc(db, "settings", "business"));
      if (snap.exists()) {
        const phoneEl = document.getElementById("es-footer-phone");
        if (phoneEl) phoneEl.textContent = snap.data().phone || "";
      }
    } catch {
      /* settings doc may not exist yet on a fresh project — footer just shows nothing */
    }
  });
}

export function initLayout() {
  renderHeader();
  renderFooter();
}
