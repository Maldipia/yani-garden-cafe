# YANI Garden Cafe POS: Order Queue System Implementation

**Author:** Manus AI
**Date:** March 10, 2026

## 1. Executive Summary

This document details the implementation of a robust order queue system for the YANI Garden Cafe Point-of-Sale (POS). The primary goal was to eliminate the Google Apps Script (GAS) concurrency limitation, which caused order processing failures during peak hours. The new architecture replaces the direct, synchronous call from the Vercel API to GAS with a durable queue system built on Supabase and Vercel Functions. This ensures that every order is reliably captured and processed sequentially, enhancing system stability and scalability.

## 2. Problem Statement

The previous architecture involved the Vercel API directly calling a Google Apps Script to record new orders in a Google Sheet. GAS has a hard limit of 30 concurrent executions [1]. During high-traffic periods, this limit was frequently exceeded, causing the `placeOrder` API endpoint to fail and preventing new orders from being recorded. This created a poor customer experience and potential revenue loss.

### Original Architecture

![Original Architecture Diagram](/home/ubuntu/yani-garden-cafe/docs/before_architecture.png)

*Figure 1: The previous architecture, where the Vercel API called Google Apps Script directly, making it vulnerable to concurrency limits.*

## 3. New Architecture & Implementation

To solve this, we introduced an `order_queue` table in Supabase to act as an intermediary buffer. The Vercel API now writes orders to this queue and immediately returns a success response to the customer. A separate, cron-triggered Vercel function (`queue-worker`) processes these orders sequentially, ensuring that calls to GAS are made one at a time.

### New Architecture

![New Architecture Diagram](/home/ubuntu/yani-garden-cafe/docs/after_architecture.png)

*Figure 2: The new, queue-based architecture, which decouples order placement from processing, ensuring reliability and scalability.*

### 3.1. Supabase `order_queue` Table

A new table named `order_queue` was created in the Supabase database. This table captures the order payload and manages its processing state.

**Table Schema:**

| Column          | Type        | Description                                                                                             |
|-----------------|-------------|---------------------------------------------------------------------------------------------------------|
| `id`            | `BIGSERIAL` | Primary key for the queue entry.                                                                        |
| `order_ref`     | `TEXT`      | The customer-facing order reference ID (e.g., YANI-OL-XXXXXX).                                            |
| `order_data`    | `JSONB`     | The complete JSON payload of the order to be sent to Google Apps Script.                                |
| `status`        | `TEXT`      | The current status of the order in the queue: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `DEAD`.      |
| `retry_count`   | `INTEGER`   | The number of times processing has been attempted.                                                      |
| `max_retries`   | `INTEGER`   | The maximum number of retries allowed before moving the order to the `DEAD` state (default: 3).         |
| `created_at`    | `TIMESTAMPTZ` | Timestamp when the order was enqueued.                                                                  |
| `processed_at`  | `TIMESTAMPTZ` | Timestamp when the order was successfully processed.                                                    |
| `next_retry_at` | `TIMESTAMPTZ` | The scheduled time for the next retry attempt, used for exponential backoff.                            |
| `error_message` | `TEXT`      | Stores the last error message if processing failed.                                                     |
| `worker_id`     | `TEXT`      | An identifier for the worker instance that processed the entry, aiding in debugging.                    |

### 3.2. API Modifications

#### `/api/online-order.js`

The `placeOrder` function was modified to no longer call GAS directly. Instead, it now performs a single `INSERT` operation into the `order_queue` table with a `PENDING` status. This makes the API response extremely fast and reliable, as it is no longer dependent on the availability of the downstream GAS service.

#### `/api/queue-worker.js` (New)

This new Vercel serverless function acts as the queue processor. It is configured to run every minute via a Vercel cron job.

**Processing Logic:**
1.  **Claim Orders:** The worker first performs an atomic `UPDATE` to claim a batch of `PENDING` orders (up to `BATCH_SIZE=5`), changing their status to `PROCESSING`. This prevents multiple worker instances from processing the same order.
2.  **Sequential Processing:** It then iterates through the claimed orders one by one.
3.  **Call GAS:** For each order, it calls the Google Apps Script endpoint.
4.  **Update Status:**
    *   On success, the order status is updated to `COMPLETED`.
    *   On failure, the `retry_count` is incremented. If the count is less than `max_retries`, the status is set back to `PENDING` with a `next_retry_at` timestamp calculated using exponential backoff (30s, 2min, 5min). If retries are exhausted, the status is set to `DEAD`.

#### `/api/queue-status.js` (New)

This endpoint provides visibility into the queue's status for both customers and administrators.

*   `getOrderStatus`: Allows a customer to check their order's queue status using their `orderRef`.
*   `getQueueStats`: An admin-only function that provides aggregate statistics on the queue's health (pending, processing, completed, dead counts).
*   `getDeadOrders`: An admin-only function to retrieve orders that have failed processing permanently.
*   `retryDead`: An admin-only function to manually requeue a `DEAD` order.

### 3.3. Admin Dashboard Integration

A **Queue Monitor** panel was added to the admin dashboard (`admin.html`). This panel is only visible to `ADMIN` and `OWNER` roles and provides:

*   **Live Stats:** Real-time counts of pending, processing, completed, and dead orders.
*   **Status Indicator:** A visual dot that is green (healthy), yellow (busy), or red (dead orders present).
*   **Dead Order Management:** A list of dead orders with their error messages and a one-click button to retry them.

## 4. Conclusion

The implementation of the order queue system successfully resolves the critical concurrency issue with Google Apps Script. The new architecture is significantly more resilient, scalable, and provides better visibility into the order processing pipeline. By decoupling the order placement from the processing, the YANI Garden Cafe POS can now handle high volumes of orders without failure, ensuring a smooth and reliable experience for customers.

## 5. References

[1] Google Apps Script. (2026). *Quotas for Google Services*. Retrieved from https://developers.google.com/apps-script/guides/services/quotas
