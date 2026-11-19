# Org invoices tab

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [org-invoices-tab.test.tsx](org-invoices-tab.test.tsx).

## org-invoices-tab-001

Original test `Open an individual invoice from invoice history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-invoices-tab.test.tsx#L81). · **intent review**

- **Given** The user is viewing invoice history containing a paid March 2026 invoice.
- **When** They open that invoice from its download link.
- **Then** The link points to the hosted invoice and opens in a new tab. The test verifies the link contract but does not assert what happens after opening; review intent.
