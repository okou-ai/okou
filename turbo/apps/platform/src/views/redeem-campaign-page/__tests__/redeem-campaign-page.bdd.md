# Redeem campaign page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [redeem-campaign-page.test.tsx](redeem-campaign-page.test.tsx).

## redeem-campaign-page-001

Original test `A billing outage shows a temporary redemption error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/redeem-campaign-page/__tests__/redeem-campaign-page.test.tsx#L23).

- **Given** A user opens the campaign redemption page while billing is temporarily unavailable.
- **When** The redemption page loads.
- **Then** It shows Billing is temporarily unavailable and explains that the payment system is unavailable; no Redeem credits link is shown.

## redeem-campaign-page-002

Original test `A non-admin cannot redeem workspace campaign credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/redeem-campaign-page/__tests__/redeem-campaign-page.test.tsx#L48).

- **Given** A non-admin opens the workspace campaign redemption page and is told admin access is required.
- **When** The redemption page loads.
- **Then** It says only organization admins can redeem campaign credits for Default Org and advises asking an org admin to open the link; no Redeem credits link is shown.

## redeem-campaign-page-003

Original test `A processing redemption confirms payment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/redeem-campaign-page/__tests__/redeem-campaign-page.test.tsx#L75).

- **Given** A campaign redemption is processing for Default Org.
- **When** The recipient opens the redemption page.
- **Then** The page confirms Payment received and says the credits are being applied, usually within a few seconds.

## redeem-campaign-page-004

Original test `A ready credit campaign links to checkout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/redeem-campaign-page/__tests__/redeem-campaign-page.test.tsx#L92).

- **Given** A credit campaign is ready and has a checkout destination.
- **When** The recipient opens the redemption page.
- **Then** The page prompts Claim your credits, explains checkout will add them to Default Org's balance, and links Redeem credits to the provided checkout URL.

## redeem-campaign-page-005

Original test `A Stripe success return confirms credits immediately`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/redeem-campaign-page/__tests__/redeem-campaign-page.test.tsx#L113).

- **Given** A recipient returns to the campaign redemption page with the Stripe success parameter.
- **When** The success page loads.
- **Then** It shows Payment successful and says the credits are on their way to Default Org, directing the recipient to the dashboard to see the balance.
