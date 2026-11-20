# Integrations wechat

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integrations-wechat.test.tsx](integrations-wechat.test.tsx).

## integrations-wechat-001

Original test `WeChat is hidden with its feature disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L29).

- **Given** The WeChat feature is disabled on the integrations page.
- **When** The page loads.
- **Then** WeChat is not shown.

## integrations-wechat-002

Original test `Connect displays a QR and an expired code can be replaced`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L37).

- **Given** WeChat is disconnected and its first QR connection request succeeds, but that QR code expires.
- **When** The user opens Connect, then retries after the code expires and a new code is available.
- **Then** The dialog shows the scan prompt and expiration message for the first QR code. After retrying, a QR code and verification-code field appear, and the expiration message is gone.

## integrations-wechat-003

Original test `a scan requiring verification keeps the QR and shows a code field`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L86).

- **Given** WeChat is disconnected, and scanning its QR requires verification.
- **When** The user opens Connect.
- **Then** The QR code remains visible, a verification-code field appears, and Verify is disabled until a code is entered.

## integrations-wechat-004

Original test `verification connects the account and disconnect revokes it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L111).

- **Given** WeChat is disconnected and verification with code 123456 connects successfully.
- **When** The user verifies with that code, then disconnects through the card's options.
- **Then** The card shows Connected and the dialog closes after verification. After disconnecting, Connect is enabled again.

## integrations-wechat-005

Original test `keyboard activation and Escape restore focus to Connect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L164).

- **Given** WeChat is disconnected and its QR authorization requires verification.
- **When** The user opens Connect with Enter, then presses Escape.
- **Then** The dialog closes and keyboard focus returns to Connect.

## integrations-wechat-006

Original test `A failed QR request can be restarted by reopening authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L196).

- **Given** WeChat is disconnected and a QR request initially fails with a service-unavailable error, then becomes available.
- **When** The user opens authorization, closes the failed dialog, and reopens Connect.
- **Then** The first dialog shows “Could not connect to WeChat.” Reopening authorization displays the verification-code field.

## integrations-wechat-007

Original test `the connected card identifies its workspace and WeChat account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L235).

- **Given** WeChat is already connected to the Operations workspace as scanner-owner.
- **When** The integrations page loads.
- **Then** The connected card identifies “Operations workspace · scanner-owner.”

## integrations-wechat-008

Original test `a reconnect link identifies owner@example.com before confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L255).

- **Given** A valid WeChat reconnect link is opened by a signed-in user whose email is owner@example.com; the link's account and workspace details are available for review.
- **When** The user presses Enter on Reconnect.
- **Then** Before confirmation, the page identifies owner@example.com, WeChat Workspace, and Workspace Assistant, with no QR code. Reconnect succeeds, the page shows the instruction to return to WeChat and send a message, the reconnect action and QR remain absent, and the token is removed from the URL.
- **Upstream change** `4e5707de` (#49556) always names the default agent with the assistant name, so the reconnect confirmation shows `Okou` instead of the default agent's display name; the upstream test is now `a reconnect link identifies $account before confirmation` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L258)). Rebuild this scenario expecting Okou where it expects Workspace Assistant.

## integrations-wechat-009

Original test `a reconnect link identifies user_wechat_confirm before confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L255).

- **Given** A valid WeChat reconnect link is opened by a signed-in user without an email; the link's account and workspace details are available for review.
- **When** The user presses Enter on Reconnect.
- **Then** Before confirmation, the page identifies user_wechat_confirm, WeChat Workspace, and Workspace Assistant, with no QR code. Reconnect succeeds, the page shows the instruction to return to WeChat and send a message, the reconnect action and QR remain absent, and the token is removed from the URL.

## integrations-wechat-010

Original test `an unavailable reconnect link offers the same QR connection flow on the settings page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L332).

- **Given** A WeChat reconnect link is unavailable, but a new QR connection can succeed.
- **When** The user follows Connect with a new QR code, then connects using verification code 123456.
- **Then** The settings page reports that the link is unavailable and offers no Reconnect action. The new QR flow appears, and successful verification shows the instruction to return to WeChat and send a message.

## integrations-wechat-011

Original test `a rejected reconnect remains unconnected and shows recovery guidance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L383).

- **Given** A WeChat reconnect link initially appears available, but reconnect is rejected because the link has expired; the account remains disconnected.
- **When** The user selects Reconnect.
- **Then** The page shows “This link is unavailable,” does not show the successful-reconnection guidance, and retains the token in the URL.

## integrations-wechat-012

Original test `the WeChat settings page cannot connect with the feature disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L421).

- **Given** The WeChat feature is disabled and the user opens the WeChat settings page with a signed link.
- **When** The page loads.
- **Then** The page says “Connection is not configured yet” and offers no Reconnect action.
