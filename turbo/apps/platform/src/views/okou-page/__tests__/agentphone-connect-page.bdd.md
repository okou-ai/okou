# Agentphone connect page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [agentphone-connect-page.test.tsx](agentphone-connect-page.test.tsx).

## agentphone-connect-page-001

Original test `rejects connection links with a malformed signature`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L56).

- **Given** A user opens a phone connection link with a malformed signature.
- **When** The connection page checks the link.
- **Then** It says, “The signature on this link is not valid.” No Connect action is available.

## agentphone-connect-page-002

Original test `connects a signed link without sending brand fields`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L69).

- **Given** A user opens a valid signed SMS connection link.
- **When** They select Connect and the connection succeeds.
- **Then** The page confirms “Phone number connected” and offers Open Messages to sms:+19039853128 and Back to settings to /works. The connection request includes the phone handle, agent ID, timestamp, signature and SMS channel, with no brand fields.

## agentphone-connect-page-003

Original test `shows the existing connection without another Connect action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L120).

- **Given** The phone number in a signed connection link is already connected.
- **When** The user opens the link.
- **Then** The page shows “Phone number connected” and offers no Connect action.

## agentphone-connect-page-004

Original test `offers an explicit switch and sends the confirmed previous number`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L129).

- **Given** A different phone number, +15555550456, is already connected and the user opens a signed link for +15555550123.
- **When** They choose “Switch to +15555550123.”
- **Then** Before confirmation, no connection request has been sent; the page also offers “Keep +15555550456” linking back to /works. After switching, the page confirms the connection and sends the previous number as the replacement number.

## agentphone-connect-page-005

Original test `shows an occupied number before offering a connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L165).

- **Given** The connection-status service reports that the requested number is already in use.
- **When** The user opens the signed connection link.
- **Then** The page says, “Phone number already connected,” and offers no Connect action.

## agentphone-connect-page-006

Original test `keeps the switch confirmation when its signed link expires`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L179).

- **Given** A different phone number, +15555550456, is connected and a signed link offers a switch to +15555550123.
- **When** The user confirms the switch but the connection link has expired.
- **Then** The page alerts that the link is invalid or expired and keeps the “Keep +15555550456” option available.

## agentphone-connect-page-007

Original test `shows a connection-status read failure without a Connect action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L205).

- **Given** The connection-status service rejects the signed link as expired.
- **When** The user opens the phone connection page.
- **Then** The page displays “This connection link has expired.” and offers no Connect action.

## agentphone-connect-page-008

Original test `shows the connected overview and opens the official conversation for +15555550123`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L224).

- **Given** The connected phone handle is +15555550123.
- **When** The user opens the phone connection overview.
- **Then** The overview says “+15555550123 is connected. Send a text message to start chatting with Okou.” Open Messages links to sms:+19039853128, and Back to settings links to /works.

## agentphone-connect-page-009

Original test `shows the connected overview and opens the official conversation for sender@example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L224).

- **Given** The connected phone handle is sender@example.com.
- **When** The user opens the phone connection overview.
- **Then** The overview says “sender@example.com is connected. Send a text message to start chatting with Okou.” Open Messages links to sms:+19039853128, and Back to settings links to /works.

## agentphone-connect-page-010

Original test `opens the shared connection dialog from the unlinked overview and shows completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L248).

- **Given** No phone number is linked, and the user opens the phone connection overview.
- **When** They select Connect, then the connection changes to linked while the dialog is open.
- **Then** The shared connection dialog displays a QR/link with the SMS destination sms:+19039853128?body=12345678. After the connection change, the page shows “Phone number connected” and offers Open Messages to sms:+19039853128.

## agentphone-connect-page-011

Original test `shows when phone connection is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L280).

- **Given** Phone connection is not configured and no number is linked.
- **When** The user opens the phone connection overview.
- **Then** The page says, “Phone connection is currently unavailable.” It offers no Connect action and does offer Back to settings.

## agentphone-connect-page-012

Original test `connects a signed WhatsApp link through its own API and opens WhatsApp`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L300).

- **Given** A user opens a valid signed WhatsApp connection link while WhatsApp integration is enabled and the link status is unlinked.
- **When** They select Connect and the connection succeeds.
- **Then** The page confirms “WhatsApp connected,” offers Open WhatsApp to https://wa.me/19039853128, and sends a WhatsApp-channel request containing the signed-link details.

## agentphone-connect-page-013

Original test `confirms the current WhatsApp number before replacing it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L352).

- **Given** The current WhatsApp number is +4915123456789, and a signed link offers a different number, +15555550123, while WhatsApp integration is enabled.
- **When** The user selects “Switch to +15555550123.”
- **Then** No request is sent before confirmation. After switching, the page confirms “WhatsApp connected” and the request identifies +4915123456789 as the number being replaced.

## agentphone-connect-page-014

Original test `keeps the WhatsApp connection page unavailable when its switch is off`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L403).

- **Given** WhatsApp integration is disabled and a user opens a signed WhatsApp connection link.
- **When** The page loads.
- **Then** It says, “WhatsApp is not configured yet,” and offers no Connect action.

## agentphone-connect-page-015

Original test `offers the existing WhatsApp QR flow from its dedicated settings page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agentphone-connect-page.test.tsx#L415).

- **Given** WhatsApp integration is enabled and no WhatsApp number is linked.
- **When** The user opens the dedicated WhatsApp settings page, activates Connect with the keyboard, then presses Escape in the dialog.
- **Then** A “Connect WhatsApp” dialog opens and offers Open WhatsApp to https://wa.me/19039853128?text=12345678. Escape closes the dialog and returns focus to Connect.
