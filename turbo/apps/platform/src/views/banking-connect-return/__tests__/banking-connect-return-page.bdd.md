# Banking connect return page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [banking-connect-return-page.test.tsx](banking-connect-return-page.test.tsx).

## banking-connect-return-page-001

Original test `A cancelled banking-provider return shows failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/banking-connect-return/__tests__/banking-connect-return-page.test.tsx#L12).

- **Given** A user arrives at the banking connection return page with a cancelled response, code 499, customer ID, and institution ID.
- **When** The return page handles the provider response.
- **Then** It shows “Couldn’t connect Bank account” and “Connection failed,” and the browser path is replaced with `/banking/connect/return/error`.

## banking-connect-return-page-002

Original test `A successful banking-provider return confirms the connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/banking-connect-return/__tests__/banking-connect-return-page.test.tsx#L32).

- **Given** A user arrives at the banking connection return page with a completed response, code 200, customer ID, and institution ID.
- **When** The return page handles the provider response.
- **Then** It shows “Bank account connected” and “Connected,” enables the “Close window” button, and replaces the browser path with `/banking/connect/return/success`.
