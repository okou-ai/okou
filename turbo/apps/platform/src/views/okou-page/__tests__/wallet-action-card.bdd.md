# Wallet action card

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [wallet-action-card.test.tsx](wallet-action-card.test.tsx).

## wallet-action-card-001

Original test `a workspace notification completes wallet consent and continues the owning chat once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L113).

- **Given** A chat contains a wallet authorization link, and authorization is initially pending.
- **When** The user opens the link while the wallet-change subscription is attaching; authorization completes before attachment finishes, followed by notifications for other organizations and duplicate notifications for the user's organization.
- **Then** The exact authorization URL is shown. The owning chat receives the continuation message exactly once, and the completed authorization control is disabled.

## wallet-action-card-002

Original test `wallet consent completed before the user's click continues from the current authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L167).

- **Given** A chat contains a wallet authorization link, and authorization is initially pending.
- **When** Authorization completes before the user clicks Continue.
- **Then** No continuation is sent before the click. Clicking Continue sends the continuation once and leaves the Authorized control disabled.

## wallet-action-card-003

Original test `wallet consent notifications queued during attachment still continue the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L186).

- **Given** A chat contains a wallet authorization link, and authorization is initially pending while the wallet-change subscription is attaching.
- **When** Authorization completes before attachment finishes.
- **Then** The chat receives the continuation once, and the Authorized control is disabled.

## wallet-action-card-004

Original test `wallet consent missed during a connection gap is recovered after reattachment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L203).

- **Given** A chat contains a wallet authorization link, and the wallet-change subscription is active while authorization is pending.
- **When** The connection is suspended, authorization completes without a notification, and the connection is restored.
- **Then** The chat receives the continuation once, and the Authorized control is disabled.

## wallet-action-card-005

Original test `a failed consent stops waiting without sending a message even when its notification claims authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L222).

- **Given** A chat contains a wallet authorization link, and authorization is pending.
- **When** The user opens the link and consent fails, despite the notification claiming authorization.
- **Then** Waiting stops, the disabled control says “Authorization not completed,” and no chat message is sent.

## wallet-action-card-006

Original test `a unavailable consent stops waiting without sending a message even when its notification claims authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L222).

- **Given** A chat contains a wallet authorization link, and authorization is pending.
- **When** The user opens the link and consent becomes unavailable, despite the notification claiming authorization.
- **Then** Waiting stops, the disabled control says “Authorization unavailable,” and no chat message is sent.

## wallet-action-card-007

Original test `an authorized wallet card reports continuation success after confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L253).

- **Given** A chat contains an already authorized wallet card and a continuation request is pending.
- **When** The request succeeds after the user confirms continuation.
- **Then** The card reports “Authorized,” and that control is disabled.

## wallet-action-card-008

Original test `an authorized wallet card reports continuation failure after confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L253).

- **Given** A chat contains an already authorized wallet card and a continuation request is pending.
- **When** The request fails after the user confirms continuation.
- **Then** The card reports “Authorized. Your message could not be sent.” and offers a disabled “Continue” control.

## wallet-action-card-009

Original test `a expired authorization cannot continue the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L287).

- **Given** A chat contains an expired wallet authorization.
- **When** The chat is opened.
- **Then** The disabled control says “Authorization expired”; no action links are shown and no continuation message is sent.

## wallet-action-card-010

Original test `a failed authorization cannot continue the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L287).

- **Given** A chat contains a failed wallet authorization.
- **When** The chat is opened.
- **Then** The disabled control says “Authorization not completed”; no action links are shown and no continuation message is sent.

## wallet-action-card-011

Original test `a unavailable authorization cannot continue the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L287).

- **Given** A chat contains an unavailable wallet authorization.
- **When** The chat is opened.
- **Then** The disabled control says “Authorization unavailable”; no action links are shown and no continuation message is sent.

## wallet-action-card-012

Original test `wallet authorization and purchase links show cards with the exact provider destinations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L305).

- **Given** A chat contains a Link authorization URL and a Link purchase-approval URL with query strings, along with surrounding explanatory text.
- **When** The chat is displayed.
- **Then** Two action cards link to the exact respective provider URLs, open in a new tab with safe rel attributes, and show the provider domains while preserving the surrounding text.

## wallet-action-card-013

Original test `read-only wallet consent renders an authorization card with the exact destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L327).

- **Given** A chat contains a Link authorization URL with read-only user-info scope and transaction-read authorization details.
- **When** The chat is displayed.
- **Then** One authorization card links to the exact URL and presents an Authorize action.

## wallet-action-card-014

Original test `wallet follow-up actions keep provider URLs without inferring payment or approval state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L342).

- **Given** A chat contains Link verification, setup, payment-method, identity-verification, and Stripe authentication URLs.
- **When** The chat is displayed.
- **Then** Each exact URL is retained as a “Continue in Link” action with a Continue label. No payment-approved, payment-completed, or paid-successfully status is inferred.

## wallet-action-card-015

Original test `both purchase approval URL formats render review actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L372).

- **Given** A chat contains purchase approval links in both path and query URL formats.
- **When** The chat is displayed.
- **Then** Both exact URLs appear as review actions accessible as “Review purchase.”

## wallet-action-card-016

Original test `wallet cards preserve signed URL suffixes in Markdown, autolinks and bare links`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L398).

- **Given** A chat contains wallet URLs in Markdown links, autolinks, bare links, bold text, and sentence punctuation, with signed suffixes including underscores, tildes, periods, question marks, and semicolons.
- **When** The chat is displayed.
- **Then** Each wallet action preserves its complete intended URL suffix, without truncation or punctuation loss.

## wallet-action-card-017

Original test `ordinary provider links and untrusted wallet lookalikes stay ordinary links`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L432).

- **Given** A chat contains ordinary provider links and lookalike wallet URLs using an untrusted host, embedded credentials, a nonstandard port, or HTTP.
- **When** The chat is displayed.
- **Then** None becomes a wallet action card; each remains an ordinary link to its original URL.

## wallet-action-card-018

Original test `wallet URLs in code and user messages do not become action cards`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L460).

- **Given** A chat contains a wallet approval URL in a user message and wallet URLs inside inline and fenced code in an assistant message.
- **When** The chat is displayed.
- **Then** No action cards are shown, and the fenced code retains the approval URL as code.

## wallet-action-card-019

Original test `purchase approval cards show approval and continuation after notifications and connection gaps`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L483).

- **Given** A chat contains a purchase approval link whose status is pending, and the status later changes to approved and then continued.
- **When** An unrelated-organization notification arrives, then the user's organization notification arrives; later the connection is suspended while status changes to continued and then reconnects.
- **Then** The unrelated notification does not show approval. The matching notification shows “Approved; waiting to continue” and a disabled “Status recorded” control; after reconnection, the card shows “Purchase request continued” and the control remains disabled.

## wallet-action-card-020

Original test `a stopped approval watch shows its terminal status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/wallet-action-card.test.tsx#L525).

- **Given** A purchase approval watch initially reports approved, then reaches stopped status.
- **When** The user opens the chat and the stopped-status notification arrives.
- **Then** The card first shows “Approved; waiting to continue,” then “Automatic waiting has ended,” with the “Status recorded” control disabled in both states.
