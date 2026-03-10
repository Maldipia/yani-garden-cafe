# YANI Garden Cafe POS: System Audit & Upgrade Roadmap

**March 10, 2026** | **Manus AI**

---

## 1. Executive Summary

The YANI Garden Cafe POS is a functional but fragile system that has outgrown its initial architecture. Its heavy reliance on Google Apps Script (GAS) for core logic creates significant performance bottlenecks, data synchronization challenges, and security vulnerabilities. The system suffers from slow API response times (5-6 seconds), a lack of critical business features, and a monolithic frontend (`admin.html` is over 3,700 lines) that is difficult to maintain.

This audit identifies **four critical areas for immediate upgrade** and proposes a strategic roadmap to evolve the POS into a robust, scalable, and feature-rich platform. The highest priority is to **eliminate the GAS dependency** and establish Supabase as the single source of truth.

| Priority | Recommendation | Impact | Effort |
|---|---|---|---|
| **1. Critical** | **Phase out Google Apps Script** | High | High |
| **2. Critical** | **Secure Admin Authentication** | High | Medium |
| **3. High** | **Refactor Monolithic Frontend** | Medium | High |
| **4. High** | **Implement Missing Core Features** | High | High |

---

## 2. Key Findings & Recommendations

### 2.1. Architecture: The Google Apps Script Bottleneck

**Finding:** The system is architecturally unsound due to its deep, synchronous dependency on Google Apps Script for critical actions like `getOrders`, `getMenu`, and all menu management. This is the root cause of the system's poor performance, data drift, and recent bugs (e.g., the non-functional cancel button).

> **API response times average 5-6 seconds**, which is unacceptable for a real-time POS system. This is a direct result of waiting for GAS to execute and respond.

**Recommendation: Phase out GAS entirely.**

1.  **Migrate all data from Google Sheets to Supabase:** This includes orders, menu items, and staff PINs. Supabase should become the **single source of truth**.
2.  **Rewrite all API endpoints** (`pos.js`, `online-order.js`) to interact **only** with Supabase. All business logic currently in `Code.gs` (over 3,100 lines) must be ported to the Vercel API layer.
3.  **Decommission the GAS script.** The `callAppsScript` function should be removed from the codebase.

This is the single most important upgrade and will resolve the majority of the system's performance and reliability issues.

### 2.2. Security: Hardcoded PINs & Unprotected Endpoints

**Finding:** Staff PINs (OWNER, ADMIN, CASHIER) are hardcoded directly in the Google Apps Script `Code.gs` file. This is a major security risk, as anyone with access to the script can view all PINs.

> **`Code.gs`, Line 2272:** `const correctPin = getSetting(\'ADMIN_PIN\') || \'1234\';`

Additionally, the cron job endpoint (`/api/queue-worker`) has **no secret validation**, meaning it can be triggered by anyone on the internet, potentially causing a flood of unnecessary GAS executions.

**Recommendation: Secure Admin Authentication & Endpoints.**

1.  **Create a `staff` table in Supabase:** This table should store hashed PINs (using `bcrypt` or a similar standard), roles, and user details. **Never store PINs in plaintext.**
2.  **Implement a proper login API:** The `/api/pos` `verifyUserPin` action should be rewritten to compare a hashed version of the input PIN against the stored hash in the `staff` table.
3.  **Protect the cron job:** The `queue-worker.js` endpoint must check for a `CRON_SECRET` in the `Authorization` header, which should be set as an environment variable in Vercel.

### 2.3. Frontend: Monolithic & Unmaintainable

**Finding:** The `admin.html` file is a 3,700-line monolith containing HTML, CSS, and thousands of lines of vanilla JavaScript. This makes it extremely difficult to debug, maintain, and add new features to. The global state management (e.g., `_statusOverrides`) is a temporary patch for a fundamental architectural flaw.

**Recommendation: Refactor the frontend using a modern framework.**

1.  **Rebuild the admin dashboard** using a modern framework like **React, Vue, or Svelte**. This will enable component-based architecture, proper state management, and a more maintainable codebase.
2.  **Adopt a UI component library** (e.g., Tailwind CSS, Material-UI) to standardize the user interface and improve development speed.
3.  **Split the frontend into logical pages/routes** (e.g., `/dashboard`, `/orders`, `/menu`, `/settings`) instead of a single-page behemoth.

### 2.4. Missing Core POS Features

**Finding:** The POS lacks several features that are standard in modern cafe management systems. This limits its operational efficiency and business value.

**Recommendation: Implement Missing Core Features.**

After addressing the critical architectural and security issues, the following features should be prioritized:

| Feature | Description |
|---|---|
| **Inventory Management** | Track stock levels for menu items and ingredients. Automatically mark items as "Sold Out" on the menu when inventory is depleted. |
| **Sales Analytics & Reporting** | A dedicated dashboard to visualize sales trends, top-selling items, revenue by hour/day, and other key metrics. |
| **Kitchen Display System (KDS) / Printer Integration** | Real-time order display for the kitchen staff or integration with thermal receipt printers (e.g., via Epson ePOS or Star Micronics CloudPRNT). |
| **Customer Loyalty & Discounts** | A system for managing customer points, rewards, and applying percentage or fixed-amount discounts to orders. |

---

## 3. Audit Details

### 3.1. Codebase

*   **Complexity:** High. Over 10,000 lines of code spread across monolithic HTML files and a large GAS script.
*   **Dependencies:** Minimal (Supabase, Node-fetch). No `package.json` indicates a lack of a structured build process.
*   **Error Handling:** Basic `try/catch` blocks are present, but logging is inconsistent and lacks structure.

### 3.2. Infrastructure

*   **Vercel:** Configuration is sound, but cron jobs lack secret protection.
*   **Supabase:** Schema is simple but lacks proper relationships (e.g., foreign keys). Row-Level Security (RLS) is not fully utilized; while `menu_items` is publicly readable, write access to `order_queue` is not properly restricted.
*   **Domains:** The `pos` and `admin` subdomains are not yet configured in DNS, rendering them inactive.

### 3.3. User Experience

*   **Performance:** Very poor due to GAS dependency, with API calls taking 5-6 seconds.
*   **Admin Dashboard:** Functional but cluttered and difficult to navigate. The lack of real-time updates (relying on a 5-second poll) creates a disjointed user experience.
*   **Ordering Flow:** The customer-facing menu is incomplete due to the menu sync issue, leading to a poor customer experience.

---

## 4. Conclusion & Next Steps

The YANI POS system requires a significant architectural overhaul to become a reliable and scalable platform. The immediate priority is to **decouple the system from Google Apps Script** and make Supabase the single source of truth. Concurrently, **securing the admin authentication** process is critical.

Once the foundation is stabilized, a frontend refactor and the implementation of core POS features will unlock the system's true potential and provide significant business value.

**Recommended next step:** Create a new, detailed project plan focused on the **GAS phase-out and Supabase migration**.
