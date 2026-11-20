# Chat emoji

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-emoji.test.tsx](chat-emoji.test.tsx).

## chat-emoji-001

Original test `Keep the check-mark thread icon Done`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L107).

- **Given** A user opens the thread icon emoji picker.
- **When** They view the available emoji.
- **Then** The check-mark emoji is labeled “Done” and displays ✅.

## chat-emoji-002

Original test `Show frequently used emoji while the full emoji set loads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L119).

- **Given** A user opens the emoji picker while the full emoji data is still loading.
- **When** They view the picker before the data arrives, then after it arrives.
- **Then** “Frequently used” is shown while “Smileys & Emotion” is absent; once loaded, “Smileys & Emotion” and the grinning face 😀 appear.

## chat-emoji-003

Original test `Retain a thread icon when resizing from mobile to desktop`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L142).

- **Given** A mobile user views a thread titled “😀 Emoji planning.”
- **When** They resize the viewport from mobile to desktop.
- **Then** The thread icon remains 😀, the desktop “More actions” control appears, and only one thread title is shown.

## chat-emoji-004

Original test `Change a thread icon before its save finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L160).

- **Given** A mobile user opens the emoji picker for the “Emoji planning” thread while saving the thread rename is delayed.
- **When** They choose the grinning face emoji before the save finishes.
- **Then** The thread icon changes to 😀 while the picker remains open; after the save finishes, the picker closes.

## chat-emoji-005

Original test `Restore chat focus after closing the mobile emoji picker`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L191).

- **Given** A mobile user opens the emoji picker in a chat thread.
- **When** They close the picker using the thread’s change-icon control.
- **Then** The picker closes and focus returns to the chat thread.

## chat-emoji-006

Original test `Keep one focused emoji picker when resizing from mobile to desktop`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L214).

- **Given** A mobile user opens the emoji picker and searches for “eye,” which matches two emoji.
- **When** They resize the viewport from mobile to desktop.
- **Then** Exactly one picker remains open, its search field stays focused with “eye,” both matching emoji remain, and one “Emoji planning” thread title is shown.

## chat-emoji-007

Original test `Keep one focused emoji picker when resizing from desktop to mobile`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L214).

- **Given** A desktop user opens the emoji picker and searches for “eye,” which matches two emoji.
- **When** They resize the viewport from desktop to mobile.
- **Then** Exactly one picker remains open, its search field stays focused with “eye,” both matching emoji remain, and one “Emoji planning” thread title is shown.

## chat-emoji-008

Original test `Choosing an emoji category exits search results`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L248).

- **Given** A user searches the emoji picker for “watermelon” and sees the watermelon result, while “Food & Drink” is not displayed as a section.
- **When** They choose the “Food & Drink” category.
- **Then** The search is cleared, the “Food & Drink” section is displayed, and that category is marked current.

## chat-emoji-009

Original test `Choosing an emoji category updates the category rail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L270).

- **Given** A user opens the emoji picker and the “Frequently used” category is current.
- **When** They choose the “Food & Drink” category.
- **Then** “Food & Drink” becomes current, “Frequently used” is no longer current, its category control points to the displayed section, and the emoji feed scrolls down.

## chat-emoji-010

Original test `Keyboard category navigation preserves search until activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L301).

- **Given** A user searches for “watermelon” and focuses the “Frequently used” category; the “Smileys & Emotion” section is not displayed in search results.
- **When** They press the right arrow, then press Enter.
- **Then** After the arrow, focus moves to “Smileys & Emotion” while the search remains and “Frequently used” remains current. Enter clears the search, displays “Smileys & Emotion,” marks it current, and leaves it focused.

## chat-emoji-011

Original test `The emoji picker names the emoji under the pointer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L332).

- **Given** A user opens the emoji picker, which initially says “Pick an emoji.”
- **When** They move the pointer over the grinning face emoji, then over the watermelon emoji.
- **Then** The picker names the hovered emoji as “:grinning_face:” and then “:watermelon:”; the earlier name disappears.

## chat-emoji-012

Original test `Manual emoji scrolling updates the current category without moving focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L350).

- **Given** A user opens the emoji picker and focuses the “Frequently used” category, which is current.
- **When** They press Space, manually scroll the emoji feed to the next section, and trigger a scroll.
- **Then** “Smileys & Emotion” becomes current and “Frequently used” stops being current, while focus remains on “Frequently used.”
