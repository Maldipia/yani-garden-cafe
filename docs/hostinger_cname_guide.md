# How to Add CNAME Records in Hostinger for Vercel

**Author:** Manus AI
**Date:** March 10, 2026

This guide provides step-by-step instructions for adding the necessary CNAME records to your `yanigardencafe.com` domain in Hostinger's hPanel. This will connect your `pos` and `admin` subdomains to your Vercel projects.

---

### Step 1: Log in to Hostinger and Navigate to DNS Editor

1.  Log in to your Hostinger account at **[hpanel.hostinger.com](https://hpanel.hostinger.com)**.
2.  In the main dashboard, click on **Domains** in the top menu.
3.  Find `yanigardencafe.com` in your list of domains and click the **Manage** button next to it.
4.  On the left sidebar, click on **DNS / Nameservers**.

This will take you to the DNS Zone Editor for your domain.

![Hostinger DNS Overview](/home/ubuntu/yani-garden-cafe/docs/hostinger-guide/step-dns-overview.png)
*Figure 1: The DNS / Nameservers section in Hostinger's hPanel.*

---

### Step 2: Add the CNAME Records

In the **Manage DNS records** section, you will add two new `CNAME` records. You will use the form at the top of the records list.

#### Add the `pos` Subdomain:

1.  **Type:** Select `CNAME` from the dropdown.
2.  **Name:** Enter `pos` (Hostinger automatically adds `yanigardencafe.com` for you).
3.  **Points to:** Enter `cname.vercel-dns.com.` (include the trailing dot).
4.  **TTL:** Leave the default value (usually `14400`).
5.  Click **Add Record**.

#### Add the `admin` Subdomain:

1.  **Type:** Select `CNAME` from the dropdown.
2.  **Name:** Enter `admin`.
3.  **Points to:** Enter `cname.vercel-dns.com.` (include the trailing dot).
4.  **TTL:** Leave the default value.
5.  Click **Add Record**.

![Hostinger CNAME Form](/home/ubuntu/yani-garden-cafe/docs/hostinger-guide/step-cname-form.jpg)
*Figure 2: The form for adding a new DNS record. Make sure to select CNAME as the type.*

---

### Step 3: Verify the Records

After adding both records, they will appear in your DNS records list. It should look similar to the image below, with entries for `pos` and `admin` pointing to Vercel's CNAME address.

![Hostinger DNS Records List](/home/ubuntu/yani-garden-cafe/docs/hostinger-guide/step-dns-records-list.jpg)
*Figure 3: Your DNS records list after adding the two CNAME records.*

---

### Step 4: Wait for Propagation

DNS changes can take anywhere from **5 minutes to a few hours** to propagate across the internet. Once propagation is complete, Vercel will automatically issue SSL certificates for your subdomains, and they will be live at:

*   `https://pos.yanigardencafe.com`
*   `https://admin.yanigardencafe.com`

No further action is needed. If the sites are not working after 4-6 hours, please let me know.
