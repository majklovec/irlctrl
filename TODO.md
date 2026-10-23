- rename the project from Belabox Duo to IRLCTRL
- vzdy pri zmene page at se zepta backendu

Your request to make the Belabox Duo CSS "fully responsive" is a great step forward. The project's current stylesheet (`frontend/css/style.css`) is a solid starting point, but it lacks a systematic approach to breakpoints and fluid layouts. By borrowing proven patterns from modern CSS libraries, you can create a robust, mobile-first interface without a heavy framework.

### 🔍 Current State of the CSS

The existing `style.css` (360 lines) already uses CSS variables for theming and includes a few `@media` queries at `640px` and `900px`. However, it does not implement a flexible grid system, fluid typography, or container-based responsiveness. The layout relies on Flexbox for the header and GridStack for dashboards, which is a good foundation to build upon.

### 📚 Responsive Libraries to Draw Inspiration From

Rather than adopting a massive framework like Bootstrap, you can borrow specific techniques from lightweight, modern libraries:

*   **Pico.css**: A minimalist, semantic framework. It provides a **12-column flexbox grid** with breakpoints identical to Bootstrap's (e.g., `768px`, `1024px`, `1216px`) and focuses on making native HTML elements responsive by default.
*   **Bulma**: A pure CSS, Flexbox-based framework with **5 well-defined breakpoints** (mobile <769px, tablet ≥769px, desktop ≥1024px, widescreen ≥1216px, fullhd ≥1408px). It offers responsive mixins and a straightforward column system.
*   **Skeleton**: An ultra-light boilerplate (around 400 lines of CSS) that styles raw HTML elements and provides a **simple responsive grid**. It is ideal if you want to keep the footprint minimal.
*   **Bare-mod**: A modern, 2026-focused framework that uses **intrinsic layouts and fluid typography** to create responsive designs with **zero media queries**. This is a great source of inspiration for a future-proof approach.

### 🛠️ Implementation Plan for Full Responsiveness

Here is a concrete plan to upgrade the CSS, drawing inspiration from these libraries.

#### 1. Adopt a Mobile-First Breakpoint System (Bulma/Pico Style)

Define a consistent set of breakpoints using CSS custom properties (or simply use `min-width` media queries). This ensures a predictable scaling across all devices.

```css
/* Add to :root */
--bp-sm: 576px;
--bp-md: 768px;
--bp-lg: 1024px;
--bp-xl: 1216px;

/* Example usage (mobile-first) */
/* Base styles for mobile */
.card { padding: 1rem; }

@media (min-width: 768px) {
  .card { padding: 1.5rem; }
}

@media (min-width: 1024px) {
  .card { padding: 2rem; }
}
```

#### 2. Implement a Flexible Grid System (Pico/Bulma Inspiration)

Introduce a lightweight grid utility (e.g., `.row` and `.col-*` classes) to replace ad-hoc Flexbox or fixed-width layouts. This is especially useful for forms, card lists, and the setup wizard.

```css
/* A minimalist 12-column flexbox grid */
.row {
  display: flex;
  flex-wrap: wrap;
  margin-left: -0.5rem;
  margin-right: -0.5rem;
}

[class*="col-"] {
  padding-left: 0.5rem;
  padding-right: 0.5rem;
  width: 100%; /* Mobile: full width by default */
}

@media (min-width: 768px) {
  .col-md-6 { flex: 0 0 50%; max-width: 50%; }
  .col-md-4 { flex: 0 0 33.333%; max-width: 33.333%; }
}

@media (min-width: 1024px) {
  .col-lg-3 { flex: 0 0 25%; max-width: 25%; }
}
```

**Usage:** `<div class="row"><div class="col-md-6 col-lg-3">...</div>...</div>`

#### 3. Introduce Fluid Typography with `clamp()` (Bare-mod Inspiration)

Replace fixed `px` or `rem` font sizes with fluid values that scale smoothly between a minimum and maximum size, eliminating the need for typography-related media queries.

```css
h1 { font-size: clamp(1.8rem, 4vw + 1rem, 3rem); }
h2 { font-size: clamp(1.5rem, 3vw + 1rem, 2.5rem); }
body { font-size: clamp(0.95rem, 2vw + 0.8rem, 1.1rem); }
```

#### 4. Leverage CSS Grid for Page-Level Layouts

For structural elements like the header, settings page, or dashboard toolbar, use CSS Grid to create adaptive layouts with `grid-template-columns: repeat(auto-fit, minmax(...))`.

```css
/* Example: A responsive settings form */
.settings-form {
  display: grid;
  grid-template-columns: 1fr; /* Mobile */
  gap: 1rem;
}

@media (min-width: 768px) {
  .settings-form {
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  }
}
```

#### 5. Add Container Queries for Modular Components

Since Belabox Duo uses a module system, container queries allow components (e.g., `.mod-encoder`, `.dash-card`) to respond to their own container's width, not just the viewport.

```css
.mod-card {
  container-type: inline-size;
}

@container (min-width: 400px) {
  .mod-card .mod-title {
    font-size: 1.2rem;
  }
  .mod-card .mod-actions {
    display: flex;
    gap: 0.5rem;
  }
}
```

#### 6. Enhance Existing Media Queries (Skeleton Simplicity)

Review the current `@media` rules and add missing breakpoints for smaller devices. For instance, ensure the header navigation and wizard steps stack vertically on screens narrower than `480px`.

```css
/* Add to existing media queries */
@media (max-width: 480px) {
  header {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .main-nav {
    flex-direction: column;
    width: 100%;
  }
  .wiz-step {
    flex-direction: column;
    align-items: flex-start;
  }
}
```

### ✅ Recommended Integration Steps

1.  **Do not replace the entire CSS file at once.** Introduce the new grid, typography, and container-query rules incrementally.
2.  **Start with the grid.** Replace fixed-width containers in HTML templates (`frontend/*.html`) with the new `.row` and `.col-*` classes.
3.  **Adopt fluid typography globally.** Update heading and body font sizes in `:root` and element selectors.
4.  **Test on real devices.** Use browser dev tools to emulate various screen sizes (320px, 375px, 768px, 1024px, 1440px) to verify the layout.
5.  **Consider adding a lightweight reset.** Skeleton includes a Normalize.css reset, which can help eliminate cross-browser inconsistencies.

By systematically applying these patterns, your Belabox Duo UI will become fully responsive, scalable, and maintainable, all while keeping the bundle size minimal.