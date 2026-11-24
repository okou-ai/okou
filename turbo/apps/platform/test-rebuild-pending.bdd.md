# Pending frozen App scenarios

Batch 112 reviewed the 83 unique open IDs at `c008af36db`, including all six product decisions. 6 remain. Each entry preserves its frozen owner and links to the original Given/When/Then. The active clauses describe the unrepresented user outcome. [Full decision ledger](./test-rebuild-batch-112.tsv) · [68 independently owned upstream scenarios](./test-rebuild-upstream-pending.bdd.md)

## `src/signals/browser/__tests__/client.test.ts`

### client-003

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-003)

- **Given** A native child attachment is pending on its original parent session.
- **When** The caller cancels the attachment, then the child arrives late.
- **Then** The child is released by the correct parent and the original connection remains usable.

**Remaining gap.** Observe the late detach on its original, still-surviving parent, with a working sibling or connection.

**Adjacent observation.** Cancellation text, version sampling counts and hypothetical cross-member leaks are outside this judgment.

## `src/views/browser-session/__tests__/browser-response-deadlines.test.tsx`

### browser-response-deadlines-006

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-006)

- **Given** A concealed viewer is waiting for a replacement descriptor.
- **When** The member returns after the descriptor deadline while the old response is still outstanding.
- **Then** The replacement page accepts input in its own session.

**Remaining gap.** The concealed control remained locked until the old response was released. A visible pending descriptor has a passing control.

**Adjacent observation.** No particular background banner, reconnect count or consumed stale reply is required.

### browser-response-deadlines-023

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-023)

- **Given** Recovery of the original chat has an outstanding paint.
- **When** The reader switches chats while paused and resumes on the new chat; the old response arrives.
- **Then** The new chat retains its own picture and accepts input on the new page.

**Remaining gap.** The registered cross-chat case uses a held handshake; the tab-paint case stays in one viewer. Exercise this outcome across the two chats.

**Adjacent observation.** Separate ACK counts and disposal notifications have no independent user result.

### browser-response-deadlines-039

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-039)

- **Given** The visible browser receives no native hello.
- **When** Its deadline expires and the member explicitly reconnects before creating a tab.
- **Then** Input stays blocked until reconnect, then one new tab opens in the original window.

**Remaining gap.** The native observation reached the right window. Preserve a repeatable registration for this visible timeout and deliberate recovery.

**Adjacent observation.** Whether the discarded socket receives a late packet is irrelevant.

## `src/views/okou-page/__tests__/chat-scroll.test.tsx`

### chat-scroll-017

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-017)

- **Given** A member reads an older message and has a multiline draft.
- **When** Opening the on-screen keyboard reduces the transcript viewport.
- **Then** The original message remains readable and the draft is retained.

**Remaining gap.** The historical reading anchor left the viewport in the standalone control. The regular tail/draft test does not read history.

**Adjacent observation.** No exact pixel delta, specific device, or prescribed series of three cycles.

## `src/views/okou-page/__tests__/connector-directory.test.tsx`

### connector-directory-010

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.bdd.md#connector-directory-010)

- **Given** The Gmail connector card is focused in the directory.
- **When** The member presses Enter and then closes the directory.
- **Then** One provider window opens and it closes when the directory is dismissed.

**Remaining gap.** The Router popup double closes. Native Escape left the external window alive; repeat with the original Close action.

**Adjacent observation.** Late callback behavior after dismissal is adjacent and is not an extra acceptance condition.
