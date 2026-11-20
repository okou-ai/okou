# Unified chat workspace

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [unified-chat-workspace.test.tsx](unified-chat-workspace.test.tsx).

## unified-chat-workspace-001

Original test `The unified workspace opens the side panel at its share and resizes it from the keyboard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L91).

- **Given** The unified workspace is open with the side panel at its default 55% share of a 1440-pixel workspace.
- **When** The user presses ArrowLeft, End, and then Enter on the side-panel divider.
- **Then** ArrowLeft sets the panel width to 808 pixels, End sets it to 1020 pixels, and Enter restores the default 55% width.

## unified-chat-workspace-002

Original test `Double-clicking the side panel divider restores its default width`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L108).

- **Given** The side panel is open at its default width.
- **When** The user drags its divider to make the panel 540 pixels wide, then double-clicks the divider.
- **Then** The panel is 540 pixels wide after dragging and returns to its default 55% width after the double-click.

## unified-chat-workspace-003

Original test `Panel borrowing folds immediately after the list minimum and restores only after 16px of reversal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L119).

- **Given** The chat list is 300 pixels wide in a 1000-pixel workspace, and the side panel is open.
- **When** The user drags the side-panel divider left until the chat list reaches its minimum, then reverses direction.
- **Then** The chat list narrows to 260 and then 240 pixels, folds to zero on the next pixel, and remains folded through 15 pixels of reversal. At 16 pixels of reversal it reopens at 256 pixels; subsequent movement resizes it, and release ends pointer capture and removes the resize overlay.

## unified-chat-workspace-004

Original test `The chat list folds at its minimum and keeps capture for a hysteretic same-gesture restore`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L162).

- **Given** The chat list is at its default 300-pixel width.
- **When** The user increases its width by keyboard, resets it with a double-click, then drags it to its minimum and reverses direction.
- **Then** The keyboard increases the width to 364 pixels and the double-click restores 300 pixels. During the drag, the list folds at 239 pixels while keeping pointer capture; it remains folded through 15 pixels of reversal and reopens at 256 pixels on the 16th. Releasing at 264 pixels ends capture and removes the resize overlay.

## unified-chat-workspace-005

Original test `The workspace preserves the grab offset and remembers final pointerup widths after a reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L195).

- **Given** The workspace has its default chat list and side panel widths, with no saved pointer-resize widths.
- **When** The user drags the chat-list divider and side-panel divider, hides the chat list, then reloads the workspace and shows the list again.
- **Then** The chat-list drag preserves the initial grab offset and saves the final pointer-release width of 348 pixels; the side panel saves its final release width of 632 pixels. After reload, the panel remains folded and the saved widths are restored when the list is shown.

## unified-chat-workspace-006

Original test `Cancellation and blur preserve the last valid widths and discard stale gesture callbacks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L237).

- **Given** The workspace has its default chat list and side panel widths.
- **When** The user resizes the chat list and cancels the gesture with a different coordinate, then resizes the side panel and blurs the window before reloading.
- **Then** Cancellation preserves the chat list's last valid width of 340 pixels and later pointer movement does not change it. Blur preserves the side panel's last valid width of 600 pixels; stale pointer-up events do not change it. After reload, both widths remain saved, and each resize overlay and pointer capture is cleared on cancellation or blur.

## unified-chat-workspace-007

Original test `Releasing at the viewport origin applies the final coordinate before cleanup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L275).

- **Given** The chat list and side panel are open.
- **When** The user resizes each divider and releases the pointer at the viewport origin.
- **Then** The final release coordinate is applied before cleanup: the chat list becomes 0 pixels wide and the side panel becomes 1020 pixels wide.

## unified-chat-workspace-008

Original test `A folded chat list divider holds at zero for decreasing keys and reopens its remembered width`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L291).

- **Given** The chat list has a remembered width of 364 pixels and is then folded.
- **When** The user presses ArrowLeft and Home on the folded list divider, then presses ArrowRight.
- **Then** ArrowLeft and Home leave the list folded at zero and the Show chat list control remains available. ArrowRight reopens the list at its remembered 364-pixel width.

## unified-chat-workspace-009

Original test `A folded chat list can be dragged open from its persistent divider`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L312).

- **Given** The chat list is folded and its divider remains available.
- **When** The user drags the divider right, moving first to 90 pixels, then 160, 180, and finally 400 pixels before releasing.
- **Then** The list remains folded at 90 pixels, reopens by 160 pixels, reaches 240 pixels at 180, and ends at 320 pixels after release at 400.
