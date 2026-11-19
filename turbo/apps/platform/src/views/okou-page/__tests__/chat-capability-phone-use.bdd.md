# Chat capability phone use

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-phone-use.test.tsx](chat-capability-phone-use.test.tsx).

## chat-capability-phone-use-001

Original test `Phone Use stays hidden without fetching devices until manually enabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L70).

- **Given** Phone Use is disabled, and a phone device is available.
- **When** The user opens the Connectors menu.
- **Then** Phone controls are hidden, “Connect my computer” is available, and no phone-device request is made.

## chat-capability-phone-use-002

Original test `Show online phones and refresh on reopen (account menu: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L82).

- **Given** Phone Use is enabled, account-menu access is true, and one phone is online while another is offline.
- **When** The user opens Connectors, closes the menu, the online phone becomes offline, and the user reopens Connectors.
- **Then** Initially the online phone is shown and the offline phone is not. Closing the menu does not refresh the list; reopening it fetches again and shows “No phones online.”

## chat-capability-phone-use-003

Original test `Show online phones and refresh on reopen (account menu: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L82).

- **Given** Phone Use is enabled, account-menu access is false, and one phone is online while another is offline.
- **When** The user opens Connectors, closes the menu, the online phone becomes offline, and the user reopens Connectors.
- **Then** Initially the online phone is shown and the offline phone is not. Closing the menu does not refresh the list; reopening it fetches again and shows “No phones online.”

## chat-capability-phone-use-004

Original test `A selected phone stays visible offline so its chat access can be revoked`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L110).

- **Given** A chat already has access granted to a selected phone, which is now offline.
- **When** The user opens Connectors and turns off that phone's chat-access switch.
- **Then** The selected offline phone remains visible and is not disabled; it is labeled “Offline.” Turning off access succeeds, clears the selection, and the menu shows “No phones online.”

## chat-capability-phone-use-005

Original test `A phone-list failure recovers when reopening the menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L143).

- **Given** Phone Use is enabled, but loading the phone list initially fails.
- **When** The user closes and reopens Connectors after the service becomes available.
- **Then** The menu first shows “Could not load phones.” After reopening, it shows the online phone.

## chat-capability-phone-use-006

Original test `Connect my phone explains chat-menu consent and native preparation separately`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L158).

- **Given** Phone Use is enabled and the phone list is empty.
- **When** The user chooses “Connect my phone” and views the dialog.
- **Then** The dialog separately explains “Open Okou iOS Use,” “Enable your phone in this chat,” and “Send your next task.” Pressing Escape closes it and returns focus to Connectors.

## chat-capability-phone-use-007

Original test `Authorize, switch and revoke a phone from this chat (account menu: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L178).

- **Given** Phone Use is enabled, account-menu access is true, and two phones are available in an existing chat.
- **When** The user enables the first phone, switches access to the second phone, then disables the second phone.
- **Then** Each phone can be selected and deselected without being disabled; selecting the second replaces the first selection, and disabling the second clears chat access.

## chat-capability-phone-use-008

Original test `Authorize, switch and revoke a phone from this chat (account menu: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L178).

- **Given** Phone Use is enabled, account-menu access is false, and two phones are available in an existing chat.
- **When** The user enables the first phone, switches access to the second phone, then disables the second phone.
- **Then** Each phone can be selected and deselected without being disabled; selecting the second replaces the first selection, and disabling the second clears chat access.

## chat-capability-phone-use-009

Original test `A new chat saves its selected phone before the first message starts a Run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L234).

- **Given** A new chat has an available phone, and the user selects it for chat access but has not yet sent a message.
- **When** The user closes Connectors and sends “Use my phone.”
- **Then** The phone authorization is saved before the message starts a Run; the authorization request occurs before the chat send.

## chat-capability-phone-use-010

Original test `A failed chat-authorization read recovers when reopening the menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L275).

- **Given** An existing chat has an available phone, but reading its chat authorization initially fails.
- **When** The user closes and reopens Connectors after the authorization service recovers.
- **Then** The phone switch is disabled while the read has failed; after reopening, the switch becomes enabled.

## chat-capability-phone-use-011

Original test `Rejected phone consent preserves the new-chat draft and never starts its Run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L300).

- **Given** A new chat has an available phone, and saving phone consent will be rejected.
- **When** The user selects the phone, enters “Use my phone,” and sends the message.
- **Then** The error “Phone access could not be saved” appears, the draft remains intact, the page stays on the new-chat path, and no Run starts. Reopening Connectors still shows the phone selected.
