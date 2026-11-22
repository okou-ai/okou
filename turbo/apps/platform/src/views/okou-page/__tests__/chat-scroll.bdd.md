# Chat scroll

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-scroll.test.tsx](chat-scroll.test.tsx).

## chat-scroll-001

Original test `Restore history once after a narrow automation sidebar reveals the transcript`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L606).

- **Given** The reader is in history at a narrow viewport, with a message anchored at the current reading position.
- **When** They open and close Automations, revealing the transcript.
- **Then** After the reveal, the anchored message returns to the same screen position with exactly one scroll adjustment.

## chat-scroll-002

Original test `Restore tail once after a narrow automation sidebar reveals the transcript`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L606).

- **Given** The reader is at the transcript tail at a narrow viewport.
- **When** They open and close Automations, revealing the transcript.
- **Then** After the reveal, the anchored message returns to the same screen position with exactly one scroll adjustment.

## chat-scroll-003

Original test `Restore history after tail once after a narrow automation sidebar reveals the transcript`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L606).

- **Given** The reader has moved from the tail into history at a narrow viewport, with a message anchored at that live reading position.
- **When** They open and close Automations, revealing the transcript.
- **Then** After the reveal, the anchored message returns to the same screen position with exactly one scroll adjustment.

## chat-scroll-004

Original test `Keep the wide transcript in place without reveal compensation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L651).

- **Given** The transcript is at a wide viewport with a visible reading anchor.
- **When** The reader opens and closes Automations.
- **Then** The transcript stays at its original scroll position and the anchor stays put, with no reveal scroll adjustment.

## chat-scroll-005

Original test `Keep the pre-hide anchor when incoming messages arrive behind automations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L670).

- **Given** The reader is in history with a message anchored before opening Automations.
- **When** A new completed reply arrives while the transcript is hidden, and the reader closes Automations.
- **Then** The original message remains at the same screen position after reveal, with one scroll adjustment.

## chat-scroll-006

Original test `Hand the retained primary transcript restore to the new Router page when the chat list opens a side conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L697).

- **Given** The reader is in history on the primary conversation at a narrow viewport, and Automations covers the transcript.
- **When** They Alt-click a side conversation in the chat list, opening it alongside the primary conversation and dismissing Automations.
- **Then** The primary conversation remains at its route with the side conversation selected in the sidebar query, and the empty side conversation shows capability discovery. The original reading anchor is restored; subsequent image growth and incoming replies preserve its screen position without returning to the tail.

## chat-scroll-007

Original test `Keep a fresh live history capture after tail when incoming messages arrive while hidden`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L796).

- **Given** The reader reaches the tail, then changes the live scroll offset to 275 before opening Automations at a narrow viewport.
- **When** A new completed reply arrives while the transcript is hidden, and the reader closes Automations.
- **Then** The transcript restores to scroll offset 275 and the same message remains at the same screen position.

## chat-scroll-008

Original test `Keep the captured oldest message when automations closes during incoming Mermaid image preparation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L830).

- **Given** The reader reaches the tail, changes the live scroll offset to 275, and opens Automations at a narrow viewport.
- **When** A new reply containing a Mermaid diagram begins asynchronous image preparation, and the reader closes Automations before preparation finishes.
- **Then** The oldest message at the captured reading position remains at the same screen position while preparation is pending and after the diagram image is ready; the reader is not forced to the tail.

## chat-scroll-009

Original test `A pointer press on the rendered scrollbar thumb takes over before the final reveal frame`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L936). · **intent review**

- **Given** The reader has opened Automations at a narrow viewport, then closed it and is waiting for the transcript reveal to finish.
- **When** They drag the rendered scrollbar thumb before the final reveal frame, choosing one tenth of the scroll range.
- **Then** The chosen scroll position remains in place and the pending reveal does not adjust scrolling.

## chat-scroll-010

Original test `Reopening automations cancels the first reveal and restores only the final close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1037).

- **Given** The reader has closed Automations and the transcript's reveal restoration is pending.
- **When** They reopen Automations before restoration completes, then close it again.
- **Then** Reopening cancels the first restoration; after the final close, the original reading anchor is restored with one scroll adjustment.

## chat-scroll-011

Original test `Reader wheel input takes over before the narrow sidebar reveal finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1069).

- **Given** The reader has closed Automations at a narrow viewport and restoration is pending.
- **When** They send wheel input, then scroll to offset 125.
- **Then** The reader's offset remains 125 and pending restoration makes no scroll adjustment.

## chat-scroll-012

Original test `Reader touchmove input takes over before the narrow sidebar reveal finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1069).

- **Given** The reader has closed Automations at a narrow viewport and restoration is pending.
- **When** They send touch-move input, then scroll to offset 125.
- **Then** The reader's offset remains 125 and pending restoration makes no scroll adjustment.

## chat-scroll-013

Original test `Reader pointerdown input takes over before the narrow sidebar reveal finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1069).

- **Given** The reader has closed Automations at a narrow viewport and restoration is pending.
- **When** They press a pointer on the transcript, then scroll to offset 125.
- **Then** The reader's offset remains 125 and pending restoration makes no scroll adjustment.

## chat-scroll-014

Original test `Reader keydown input takes over before the narrow sidebar reveal finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1069).

- **Given** The reader has closed Automations at a narrow viewport and restoration is pending.
- **When** They press Page Down, then scroll to offset 125.
- **Then** The reader's offset remains 125 and pending restoration makes no scroll adjustment.

## chat-scroll-015

Original test `A reader jump to the latest message wins over pending sidebar restoration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1097).

- **Given** The reader has closed Automations at a narrow viewport and restoration is pending.
- **When** They choose Scroll to bottom.
- **Then** The transcript stays at the bottom and pending restoration makes no scroll adjustment.

## chat-scroll-016

Original test `Keep tail through PWA keyboard cycles`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1116).

- **Given** The reader is at the transcript tail in standalone PWA mode with a multiline draft in the composer.
- **When** They focus the composer through three keyboard-viewport shrink, pan, and restore cycles, then resize the layout viewport.
- **Then** The transcript remains at the tail throughout, and the focused composer retains both draft lines through the keyboard cycles.

## chat-scroll-017

Original test `Keep history through PWA keyboard cycles`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1116).

- **Given** The reader is in history in standalone PWA mode with a multiline draft in the composer.
- **When** They focus the composer through three keyboard-viewport shrink, pan, and restore cycles, then resize the layout viewport.
- **Then** The same message remains at the same reading position throughout, and the focused composer retains both draft lines through the keyboard cycles.

## chat-scroll-018

Original test `Keep tail when opening and closing capabilities in a completed conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1218).

- **Given** The reader is at the tail of a completed conversation with an empty composer.
- **When** They open Research from the Add menu, then close the capability tray.
- **Then** The transcript remains at the tail while the tray reduces its viewport height by 120 pixels and after it closes; the composer remains empty and the conversation route does not change.

## chat-scroll-019

Original test `Keep history when opening and closing capabilities in a stopped conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1218).

- **Given** The reader is in history in a stopped conversation with an empty composer.
- **When** They open Research from the Add menu, then close the capability tray.
- **Then** The same message remains at the same reading position while the tray reduces its viewport height by 120 pixels and after it closes; the composer remains empty and the conversation route does not change.

## chat-scroll-020

Original test `Preserve the visible message as content grows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1296).

- **Given** The reader is in history with a visible message anchored in the transcript.
- **When** A late-loaded image above the messages increases content height by 75 pixels.
- **Then** The anchored message remains at the same screen position.

## chat-scroll-021

Original test `Keep expanded work history and its duration visible after the run completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1400).

- **Given** The reader has expanded work history during a run and scrolled up to read an earlier message.
- **When** The run completes.
- **Then** The work item “Checked the first rollout stage,” the expanded state, and “Worked for 1 min” remain visible. The first previously visible message stays at the same vertical position after completion. [#49605](https://github.com/okou-ai/okou/pull/49605).

## chat-scroll-022

Original test `Follow new messages while reading the latest reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1409).

- **Given** The reader is at the tail of a conversation with five completed turns.
- **When** A sixth completed reply arrives.
- **Then** The new reply is visible, the transcript stays at the tail, and Scroll to bottom is absent.
- **Upstream change** Use seven completed turns before the arriving reply under the compact tail. [#49882](https://github.com/okou-ai/okou/pull/49882).

## chat-scroll-023

Original test `Preserve the reading position when new messages are added`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1433).

- **Given** The reader is in history with a visible message anchored in the transcript.
- **When** Two completed replies arrive in succession.
- **Then** Both new replies become visible while the original anchor remains at the same screen position.
- **Upstream change** Use seven completed turns and preserve the anchor while replies eight and nine arrive. [#49882](https://github.com/okou-ai/okou/pull/49882).

## chat-scroll-024

Original test `Loading older messages preserves the reading position`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1474).

- **Given** The reader is near the top of a loaded history window, and the sixth question is not yet displayed.
- **When** Older messages load as the reader scrolls.
- **Then** The sixth question becomes visible and the previously visible anchor stays at the same screen position.
- **Upstream change** With nine turns, question three is initially outside the compact tail. Loading it preserves the existing anchor. [#49882](https://github.com/okou-ai/okou/pull/49882).

## chat-scroll-025

Original test `Load earlier messages once scrolling stops near the top`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1501).

- **Given** The reader is viewing the latest history window, with earlier groups not yet loaded.
- **When** They scroll near the top, away from it, and stop near the top again.
- **Then** The sixth question loads once and the original visible anchor stays at the same screen position; the fourth question remains absent.
- **Upstream change** After the reader settles near the top, question three becomes visible and question one remains absent. [#49882](https://github.com/okou-ai/okou/pull/49882).

## chat-scroll-026

Original test `Load earlier messages while the latest ones do not fill the viewport`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1530).

- **Given** The reader opens a conversation whose six-message initial window is shorter than a 1500-pixel viewport.
- **When** The conversation loads.
- **Then** Earlier history loads automatically until “History question 5” is displayed.
- **Upstream change** With nine turns and a 1500-pixel viewport, the latest answer is nine and automatic loading reveals question two. [#49882](https://github.com/okou-ai/okou/pull/49882).

## chat-scroll-027

Original test `Show the prompt and full work duration of the oldest visible answer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1544).

- **Given** The conversation's oldest visible answer belongs to a run whose prompt is “Review the release checklist” and whose work took one minute.
- **When** The reader views the latest history window.
- **Then** The answer “The release checklist is complete,” its prompt, and “Worked for 1 min” are displayed, while the older “History question 1” is not.
