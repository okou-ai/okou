# Chat capability computer use

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-computer-use.test.tsx](chat-capability-computer-use.test.tsx).

## chat-capability-computer-use-001

Original test `Submit a new chat without opening or fetching resource and account lists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L220).

- **Given** The user is on a new chat.
- **When** They submit a message without opening the resource menu.
- **Then** The message is sent, and no resource or account lists are requested.

## chat-capability-computer-use-002

Original test `Submit a existing chat without opening or fetching resource and account lists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L220).

- **Given** The user is in an existing chat.
- **When** They submit a message without opening the resource menu.
- **Then** The message is sent, and no resource or account lists are requested.

## chat-capability-computer-use-003

Original test `Submit a queued message without opening or fetching resource and account lists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L220).

- **Given** The user is in an existing chat with an active run and a queued message.
- **When** They submit another message without opening the resource menu.
- **Then** The message is queued, and no resource or account lists are requested.

## chat-capability-computer-use-004

Original test `Let the server apply the cloud browser default for an untouched new chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L262).

- **Given** The server provides a cloud browser default and the user has not changed Computer Use settings in a new chat.
- **When** They submit a message.
- **Then** The request omits both cloud browser and computer host choices, leaving the default to the server; the submitted prompt appears in the chat.

## chat-capability-computer-use-005

Original test `Start a new chat with Cloud browser disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L276).

- **Given** The user starts a new chat with Cloud browser enabled and no local computers available.
- **When** They disable Cloud browser and submit a message.
- **Then** The request contains cloud browser disabled and no computer host selected.

## chat-capability-computer-use-006

Original test `Use the saved Cloud browser default for an untouched new chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L309).

- **Given** The user's saved Cloud browser default is disabled and they have not changed Computer Use settings in a new chat.
- **When** They submit a message.
- **Then** The request omits both cloud browser and computer host choices, leaving the saved default untouched.

## chat-capability-computer-use-007

Original test `Start a new chat with a selected local computer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L335).

- **Given** A new chat offers the online local computer Studio Mac.
- **When** The user selects Studio Mac, then its listing disappears before they submit a message.
- **Then** Studio Mac remains selected in the draft despite no longer being listed, Cloud browser is disabled, and the submission includes Studio Mac's host ID and cloud browser disabled.

## chat-capability-computer-use-008

Original test `Discover computers that are available for Computer Use`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L391).

- **Given** Computer Use lists Studio Mac as online and Travel Mac as offline.
- **When** The user opens the Computer Use menu, selects Studio Mac, then Travel Mac becomes online and they reopen the menu.
- **Then** Only Studio Mac is initially listed and selectable; Travel Mac is absent. Studio Mac can be selected, and after reopening the menu Travel Mac appears unselected.

## chat-capability-computer-use-009

Original test `Guide users to the compatible Computer Use app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L453).

- **Given** The user is on an Apple silicon Mac and opens the Computer Use setup guide.
- **When** They follow the guide through its Continue steps and finish.
- **Then** The guide offers a macOS download link for the ARM64 disk image in a new tab, explains the Apple silicon and macOS 14-or-newer requirement, advances through access and chat setup, and closes with the guide query removed.

## chat-capability-computer-use-010

Original test `Explain Computer Use incompatibility on an Intel Mac`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L488).

- **Given** The user is on an Intel Mac and opens the Computer Use setup guide.
- **When** They inspect the guide's compatibility and download options.
- **Then** The Apple silicon requirement is disabled, the guide says Intel Macs are unsupported, and no macOS download link is offered.

## chat-capability-computer-use-011

Original test `Save and retain an existing chat's Computer Use host before sending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L568).

- **Given** An existing chat has no Computer Use host selected and Cloud browser disabled; Studio Mac is available.
- **When** The user connects Studio Mac and sends a message.
- **Then** The host choice is saved before the message is sent, and Studio Mac remains selected afterward.

## chat-capability-computer-use-012

Original test `Save an existing chat's Computer Use disconnection before sending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-computer-use.test.tsx#L585).

- **Given** An existing chat has Studio Mac connected and Cloud browser disabled.
- **When** The user disconnects Studio Mac and sends a message.
- **Then** The disconnection is saved before the message is sent; the send omits both the computer host and cloud browser choices.
