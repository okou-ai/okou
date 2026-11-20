# Chat composer connector scroll

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-connector-scroll.test.tsx](chat-composer-connector-scroll.test.tsx).

## chat-composer-connector-scroll-001

Original test `Preserve the 12-connector overview position while accounts open alongside it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-scroll.test.tsx#L87).

- **Given** The connector overview lists 12 connectors, including Scroll 7 and Scroll 8.
- **When** I scroll the overview to 180, open Scroll 7's accounts, scroll its panel to 140, close it with Escape, and reopen Scroll 7 and then Scroll 8.
- **Then** The accounts panel starts at scroll position 0 each time. Closing returns focus to Scroll 7, and the overview remains at 180 until I set it to 220; opening Scroll 8 leaves it at 220.

## chat-composer-connector-scroll-002

Original test `Preserve the 30-connector overview position while accounts open alongside it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-scroll.test.tsx#L87).

- **Given** The connector overview lists 30 connectors, including Scroll 7 and Scroll 8.
- **When** I scroll the overview to 180, open Scroll 7's accounts, scroll its panel to 140, close it with Escape, and reopen Scroll 7 and then Scroll 8.
- **Then** The accounts panel starts at scroll position 0 each time. Closing returns focus to Scroll 7, and the overview remains at 180 until I set it to 220; opening Scroll 8 leaves it at 220.

## chat-composer-connector-scroll-003

Original test `Keep connector search focus and reset its scroll position on a new query`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-scroll.test.tsx#L117).

- **Given** The 30-connector overview is scrolled to 180, and Scroll 7's account panel is open.
- **When** I enter “Scroll 2” in connector search.
- **Then** The account panel closes, search retains focus, the results list resets to scroll position 0, and Scroll 2 appears.

## chat-composer-connector-scroll-004

Original test `Start a fresh overview when reopening before the previous popup finishes closing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-scroll.test.tsx#L133).

- **Given** The 30-connector overview is scrolled to 180, and the popup is still visible while its closing animation is held.
- **When** I close the popup and immediately reopen it before the animation finishes.
- **Then** The reopened overview starts at scroll position 0, and connector search receives focus.

## chat-composer-connector-scroll-005

Original test `Keep focus after removing an open connector from a 1-connector overview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-scroll.test.tsx#L156).

- **Given** The overview contains one connector, and that connector's account panel is open.
- **When** The connector is removed from the overview, then restored.
- **Then** On removal, the connector and its panel disappear while focus remains inside the popup, which offers Add connectors. When restored, the connector reappears without reopening its panel.

## chat-composer-connector-scroll-006

Original test `Keep focus after removing an open connector from a 30-connector overview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-scroll.test.tsx#L156).

- **Given** The overview contains 30 connectors, and the seventh connector's account panel is open.
- **When** That connector is removed from the overview, then restored.
- **Then** On removal, the connector and its panel disappear while focus remains inside the popup, which offers Add connectors. When restored, the connector reappears without reopening its panel.
