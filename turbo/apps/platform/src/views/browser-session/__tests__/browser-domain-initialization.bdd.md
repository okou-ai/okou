# Browser domain initialization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-domain-initialization.test.tsx](browser-domain-initialization.test.tsx).

## browser-domain-initialization-001

Original test `Both domains settle before input is enabled (Inspector.enable replies first)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L133).

- **Given** The viewer is connecting its Inspector and Page domains, with the Inspector response arriving first.
- **When** The Inspector response arrives while the Page response is still pending, then the Page response arrives.
- **Then** Input stays disabled until both responses arrive, then becomes enabled. The user can enter text that reaches the remote browser.

## browser-domain-initialization-002

Original test `Both domains settle before input is enabled (Page.enable replies first)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L133).

- **Given** The viewer is connecting its Inspector and Page domains, with the Page response arriving first.
- **When** The Page response arrives while the Inspector response is still pending, then the Inspector response arrives.
- **Then** Input stays disabled until both responses arrive, then becomes enabled. The user can enter text that reaches the remote browser.

## browser-domain-initialization-003

Original test `A failed Inspector.enable retires its attachment before a late peer can revive it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L150).

- **Given** The Inspector domain enable request fails while the Page response is held pending.
- **When** The Inspector failure arrives, followed by the late Page response.
- **Then** The browser view is unavailable, the original page attachment is retired, input remains disabled, and no input is sent.

## browser-domain-initialization-004

Original test `A failed Page.enable retires its attachment before a late peer can revive it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L150).

- **Given** The Page domain enable request fails while the Inspector response is held pending.
- **When** The Page failure arrives, followed by the late Inspector response.
- **Then** The browser view is unavailable, the original page attachment is retired, input remains disabled, and no input is sent.

## browser-domain-initialization-005

Original test `Replacing a selection while Inspector.enable is pending cannot retire its successor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L173).

- **Given** The initial tab is selected while the Inspector domain enable request is pending.
- **When** The user selects the “Other” tab before that request responds.
- **Then** The “Other” tab remains selected and usable after the late response; the original attachment is retired, the successor remains attached, and entered text reaches the remote browser.

## browser-domain-initialization-006

Original test `Replacing a selection while Page.enable is pending cannot retire its successor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L173).

- **Given** The initial tab is selected while the Page domain enable request is pending.
- **When** The user selects the “Other” tab before that request responds.
- **Then** The “Other” tab remains selected and usable after the late response; the original attachment is retired, the successor remains attached, and entered text reaches the remote browser.

## browser-domain-initialization-007

Original test `Target loss during Inspector.enable retains the surviving owned tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L192).

- **Given** The first owned tab is selected while Inspector enable is pending, and another owned tab survives.
- **When** The first target is destroyed before the pending response arrives.
- **Then** The surviving owned tab is selected and usable after the late response. The destroyed tab is absent and entered text reaches the remote browser.

## browser-domain-initialization-008

Original test `Target loss during Page.enable retains the surviving owned tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L192).

- **Given** The first owned tab is selected while Page enable is pending, and another owned tab survives.
- **When** The first target is destroyed before the pending response arrives.
- **Then** The surviving owned tab is selected and usable after the late response. The destroyed tab is absent and entered text reaches the remote browser.

## browser-domain-initialization-009

Original test `Window loss during Inspector.enable cannot publish input or expose sibling tabs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L212).

- **Given** Inspector enable is pending for a viewer with two owned tabs and a sibling tab in another window.
- **When** The owned window is removed, then the pending response arrives.
- **Then** The viewer reports “Browser disconnected”; input stays disabled, the sibling tab is not exposed, and no input is sent.

## browser-domain-initialization-010

Original test `Window loss during Page.enable cannot publish input or expose sibling tabs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L212).

- **Given** Page enable is pending for a viewer with two owned tabs and a sibling tab in another window.
- **When** The owned window is removed, then the pending response arrives.
- **Then** The viewer reports “Browser disconnected”; input stays disabled, the sibling tab is not exposed, and no input is sent.

## browser-domain-initialization-011

Original test `Unmounting with Inspector.enable pending closes connections despite a late reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L233).

- **Given** Inspector enable is pending while the viewer is mounted.
- **When** The viewer is unmounted before the response arrives.
- **Then** All connections close despite the late response, and no remote-browser input remains in the document.

## browser-domain-initialization-012

Original test `Unmounting with Page.enable pending closes connections despite a late reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L233).

- **Given** Page enable is pending while the viewer is mounted.
- **When** The viewer is unmounted before the response arrives.
- **Then** All connections close despite the late response, and no remote-browser input remains in the document.

## browser-domain-initialization-013

Original test `A connection-mode change during enabling retains the new mode's session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L251).

- **Given** Inspector enable is pending in the current connection mode.
- **When** The user switches to “Separate image connection” before the response arrives.
- **Then** The new session remains attached after the old response arrives, input is usable, and entered text reaches the remote browser.

## browser-domain-initialization-014

Original test `A lost connection while enabling recovers without reviving the old receipt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L273).

- **Given** Page enable is pending when the browser connection is lost.
- **When** The viewer reconnects and then the old pending response arrives.
- **Then** The viewer recovers with two connections, keeps input usable, and accepts entered text without reviving the old response's session.

## browser-domain-initialization-015

Original test `A silent Inspector.enable retains its original response deadline and recovers once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L290).

- **Given** Inspector enable is pending without a response.
- **When** 31 seconds pass, then one more second passes before the pending response is released.
- **Then** The viewer shows “Reconnecting…” after 31 seconds, recovers after the additional second, and has two connections. Releasing the old response does not prevent input from working.

## browser-domain-initialization-016

Original test `A silent Page.enable retains its original response deadline and recovers once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L290).

- **Given** Page enable is pending without a response.
- **When** 31 seconds pass, then one more second passes before the pending response is released.
- **Then** The viewer shows “Reconnecting…” after 31 seconds, recovers after the additional second, and has two connections. Releasing the old response does not prevent input from working.

## browser-domain-initialization-017

Original test `A terminal Inspector.enable failure is retained when its peer never replies`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L308).

- **Given** Inspector enable fails while the peer Page enable request never responds.
- **When** The Inspector failure arrives, then 31 seconds pass.
- **Then** The browser view is unavailable, the original attachment is retired, input remains disabled, and the connection does not retry.

## browser-domain-initialization-018

Original test `A terminal Page.enable failure is retained when its peer never replies`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L308).

- **Given** Page enable fails while the peer Inspector enable request never responds.
- **When** The Page failure arrives, then 31 seconds pass.
- **Then** The browser view is unavailable, the original attachment is retired, input remains disabled, and the connection does not retry.
