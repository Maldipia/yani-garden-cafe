# Yani Garden Cafe POS — System Architecture

**Author:** Manus AI
**Date:** March 2, 2026

## 1. Overview

This document outlines the system architecture for the Yani Garden Cafe Point-of-Sale (POS) and ordering system. The system is a serverless web application designed for both customer-facing QR code ordering and internal admin management. It leverages a combination of modern web technologies and Google Workspace for a cost-effective, scalable, and maintainable solution.

The core design philosophy is a **decoupled frontend and backend**, where the user interface is a static web application hosted on Vercel, and the business logic and data persistence are handled by a Google Apps Script web app connected to a Google Sheet database.

## 2. Core Components

The system is composed of three primary components:

| Component | Technology | Role |
|---|---|---|
| **Frontend Application** | HTML, CSS, JavaScript | Provides the user interface for customers (ordering) and staff (admin dashboard). |
| **Backend API** | Google Apps Script | Handles all business logic, data access, and serves as the single source of truth. |
| **Database** | Google Sheets | Stores all system data, including menus, orders, payments, and logs. |

These components are orchestrated and hosted using a combination of Vercel and GitHub.

## 3. Frontend Architecture

The frontend is a set of static HTML pages with client-side JavaScript responsible for rendering the UI and interacting with the backend. It is not a single-page application (SPA) but rather a collection of distinct pages for different functions.

### 3.1. Key Pages

- **`index.html`**: The main customer-facing ordering page. It displays the menu, allows customers to add items to a cart, and places an order for a specific table.
- **`admin.html`**: The internal dashboard for staff and owners. It provides views for live orders, menu management, payment verification, and sales reporting.
- **`login.html`**: A simple PIN-based login page to secure access to the admin dashboard.

### 3.2. Vercel Hosting & Serverless Functions

The entire frontend application is hosted on Vercel. Vercel provides a robust, global CDN for fast delivery of static assets (HTML, CSS, JS, images). The system also utilizes Vercel Serverless Functions to act as a secure proxy between the frontend and the Google Apps Script backend.

- **`/api/pos`**: A proxy that forwards all business logic requests (e.g., `getMenu`, `placeOrder`) from the frontend to the Google Apps Script web app. This is crucial for hiding the Apps Script URL and handling its unique 302 redirect behavior server-side.
- **`/api/upload-image`**: An endpoint that allows authenticated admins to upload menu item photos. It receives a base64-encoded image, commits it directly to the project's GitHub repository, and triggers a new Vercel deployment to make the image live on the CDN.

## 4. Backend Architecture

The entire backend is a single Google Apps Script project deployed as a web app. This web app exposes a single `doPost` endpoint that acts as a JSON-RPC style API.

### 4.1. Google Apps Script (GAS)

The GAS project is organized into several script files:

- **`Code.gs`**: The main file containing the `doPost` entry point, core business logic for orders, menu management, and data access.
- **`PaymentAndReceipts.gs`**: Contains functions related to payment verification, receipt generation, and email notifications.
- **`auth-functions.gs`**: Handles user authentication, PIN verification, and role-based access control.

### 4.2. API Actions

The backend exposes a variety of actions that the frontend can call. The `action` parameter in the JSON payload determines which function is executed.

**Key Actions:**
- `getMenu`, `getMenuAdmin`
- `placeOrder`, `getOrders`, `updateOrderStatus`, `editOrderItems`
- `uploadPayment`, `verifyPayment`, `rejectPayment`, `listPayments`
- `updateMenuItem`, `addMenuItem`, `deleteMenuItem`
- `verifyUserPin`, `verifyAdminPin`

### 4.3. Google Sheets as a Database

The system uses a single Google Sheet as its database, with different sheets (tabs) acting as tables.

**Key Sheets:**
- **`YGC_MENU`**: The master list of all menu items, including prices, categories, and item codes.
- **`ORDERS`**: A record of every order placed, including customer details, status, and totals.
- **`ORDER_ITEMS`**: A detailed log of every item within each order.
- **`PAYMENTS`**: A log of all customer payment submissions, including proof of payment file IDs.
- **`USERS`**: A list of authorized admin users, their roles, and hashed PINs.
- **`SETTINGS`**: Stores global system settings.
- **`LOGS`**: An audit trail of all significant system actions.

## 5. Data Flow & Integrations

### 5.1. Customer Order Flow

1.  Customer scans a QR code, which opens `index.html` with a `table` token in the URL.
2.  The frontend calls the `/api/pos` proxy with the `getMenu` action.
3.  The proxy forwards the request to the GAS backend.
4.  GAS reads the `YGC_MENU` sheet and returns the menu items as JSON.
5.  The frontend renders the menu. The customer adds items to their cart.
6.  The customer clicks "Place Order". The frontend calls `/api/pos` with the `placeOrder` action, sending the cart items and table token.
7.  GAS validates the token, calculates totals, and appends new rows to the `ORDERS` and `ORDER_ITEMS` sheets.
8.  The admin dashboard, which polls `getOrders` every few seconds, automatically displays the new order.

### 5.2. Image Management Flow

1.  An admin opens the Menu Manager in `admin.html` and clicks "Edit" on an item.
2.  They select a new photo and click "Upload Photo".
3.  The frontend sends the item code and the base64-encoded image to the `/api/upload-image` Vercel function.
4.  The function uses the GitHub API (authenticated with a `GITHUB_TOKEN` environment variable) to commit the new image file directly to the `/images` directory in the `main` branch of the GitHub repository.
5.  This commit automatically triggers a new deployment on Vercel.
6.  Once the deployment is live, the new image is available on the Vercel CDN at `/images/{ITEM_CODE}.png`.

### 5.3. GitHub & Vercel Integration

The system relies on a tight integration between GitHub and Vercel:

- **Continuous Deployment**: Every `git push` to the `main` branch of the `Maldipia/yani-garden-cafe` repository automatically triggers a new Vercel deployment.
- **Environment Variables**: Vercel securely stores environment variables like `GITHUB_TOKEN` and `VERCEL_TOKEN` which are used by the serverless functions.

## 6. Security Model

- **Admin Access**: The admin dashboard is protected by a PIN. The frontend hashes the entered PIN and sends it to the backend for verification against the stored hash in the `USERS` sheet.
- **API Proxy**: The Vercel proxy acts as a security layer, hiding the direct URL of the Google Apps Script web app from the public.
- **Role-Based Access Control (RBAC)**: The backend implements a simple RBAC system (`OWNER`, `ADMIN`, `STAFF`) to control access to sensitive actions like editing the menu or deleting orders.
- **No Sensitive Data on Frontend**: All sensitive operations and data validation occur on the backend (Google Apps Script).
