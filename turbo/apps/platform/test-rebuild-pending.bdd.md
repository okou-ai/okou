# Pending frozen App scenarios

Batch 113 exercised all six IDs at `ba94a6d69d`. 3 remain. [Batch 113 decisions](./test-rebuild-batch-113.tsv) · [Batch 112 audit](./test-rebuild-batch-112.tsv) · [68 independently owned upstream scenarios](./test-rebuild-upstream-pending.bdd.md)

## `src/views/browser-session/__tests__/browser-response-deadlines.test.tsx`

### browser-response-deadlines-006

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-006)

- **Given** A concealed viewer is waiting for a replacement descriptor.
- **When** The member returns after the descriptor deadline while the old response is still outstanding.
- **Then** The replacement page accepts input in its own session.

**Remaining gap.** Recovery with the admitted request still held after concealment and return. Repeat the admitted-before-concealment arm after a descriptor lifetime or visibility change. [Batch 113 observation](../../../test-rebuild-evidence/113/README.md#browser-response-deadlines-006)

**Adjacent observation.** No particular background banner, reconnect count or consumed stale reply is required.

## `src/views/okou-page/__tests__/chat-scroll.test.tsx`

### chat-scroll-017

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-017)

- **Given** A member reads an older message and has a multiline draft.
- **When** Opening the on-screen keyboard reduces the transcript viewport.
- **Then** The original message remains readable and the draft is retained.

**Remaining gap.** Preserving the history message when the visual origin advances. Repeat on a real mobile keyboard or after history-anchor/visual-viewport changes. [Batch 113 observation](../../../test-rebuild-evidence/113/README.md#chat-scroll-017)

**Adjacent observation.** No exact pixel delta, specific device, or prescribed series of three cycles.

## `src/views/okou-page/__tests__/connector-directory.test.tsx`

### connector-directory-010

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.bdd.md#connector-directory-010)

- **Given** The Gmail connector card is focused in the directory.
- **When** The member presses Enter and then closes the directory.
- **Then** One provider window opens and it closes when the directory is dismissed.

**Remaining gap.** Closure of the pending native popup on directory dismissal. Repeat after a change to directory dismissal or popup ownership. [Batch 113 observation](../../../test-rebuild-evidence/113/README.md#connector-directory-010)

**Adjacent observation.** Late callback behavior after dismissal is adjacent and is not an extra acceptance condition.
