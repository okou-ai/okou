# Chat capability billing recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-billing-recovery.test.tsx](chat-capability-billing-recovery.test.tsx).

## chat-capability-billing-recovery-001

Original test `Direct a workspace member to an admin when billing blocks a run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-billing-recovery.test.tsx#L159).

- **Given** A workspace member has a limited-free plan, no credits, and billing blocks a chat run.
- **When** The blocked chat is opened.
- **Then** The chat asks the member to have a workspace admin upgrade to Pro. No Pro upgrade or credit-purchase options are shown.

## chat-capability-billing-recovery-002

Original test `Let a workspace admin recover from a free-plan billing limit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-billing-recovery.test.tsx#L179).

- **Given** A workspace admin on a limited-free plan has no credits, and billing blocks a chat run for insufficient credits.
- **When** The blocked chat is opened and the admin chooses Upgrade to Pro.
- **Then** The chat offers an upgrade to keep chatting, and checkout starts for the Pro plan.

## chat-capability-billing-recovery-003

Original test `Let a limited-free workspace admin unlock a Pro-only capability`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-billing-recovery.test.tsx#L198).

- **Given** A workspace admin on a limited-free plan has 500 credits, but a chat run is blocked because a capability requires Pro.
- **When** The blocked chat is opened and the admin chooses Upgrade to Pro.
- **Then** The chat offers an upgrade to keep chatting, and checkout starts for the Pro plan.

## chat-capability-billing-recovery-004

Original test `Let a paid workspace admin buy more credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-billing-recovery.test.tsx#L217).

- **Given** A Pro workspace admin has no credits, can buy credits, and a chat run is blocked for insufficient credits.
- **When** The admin selects the $100 credit option, then tries a custom amount of $250, $0, $10,001, and $275 using Enter.
- **Then** The $100 and $250 purchases each open a review showing the selected amount; the requests correspond to 100,000 and 250,000 credits. Values below $1 or above $10,000 are rejected without a purchase request. Pressing Enter for $275 opens a review for $275 and requests 275,000 credits; the URL does not include a custom amount. The error card shows $100, $200, $300, and Custom options, not a purchase dialog by default.

## chat-capability-billing-recovery-005

Original test `Offer a plan upgrade when a limited workspace cannot buy top-ups`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-billing-recovery.test.tsx#L315).

- **Given** A workspace admin on a limited-free plan has no credits, cannot buy top-ups, and a chat run is blocked for insufficient credits.
- **When** The blocked chat is opened.
- **Then** The chat offers an upgrade to Pro to keep chatting. An upgrade option is visible, but $100 and Custom credit-purchase options are not shown.

## chat-capability-billing-recovery-006

Original test `Show that a previously blocked chat can continue after credits return`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-billing-recovery.test.tsx#L335).

- **Given** A Pro workspace member has 25,000 credits and a previously blocked chat run recorded for insufficient credits.
- **When** The chat is opened after credits have returned.
- **Then** The chat says credits are available and have been added, enables the message box, and shows neither a Pro upgrade nor a $100 purchase option.

## chat-capability-billing-recovery-007

Original test `Show a new credit rejection with the current balance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-billing-recovery.test.tsx#L361).

- **Given** A Pro workspace admin initially has 25,000 credits and a chat run recorded as blocked for insufficient credits.
- **When** The billing balance changes to zero and the admin sends another message, which is rejected for insufficient credits.
- **Then** The chat shows that the user is out of credits and no longer says credits are available.

## chat-capability-billing-recovery-008

Original test `Show a first-message credit rejection in a new chat with the current balance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-billing-recovery.test.tsx#L424).

- **Given** A Pro workspace admin starts a new chat while the displayed billing balance is 25,000 credits.
- **When** The balance changes to zero and the admin sends the new chat's first message, which is rejected for insufficient credits.
- **Then** The chat shows that the user is out of credits and does not say credits are available.
