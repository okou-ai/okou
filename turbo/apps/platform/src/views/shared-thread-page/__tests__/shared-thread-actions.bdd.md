# Shared thread actions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-thread-actions.test.tsx](shared-thread-actions.test.tsx).

## shared-thread-actions-001

Original test `An unavailable shared conversation uses the same access page (403)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-actions.test.tsx#L21).

- **Given** A visitor opens a shared conversation that returns HTTP 403.
- **When** The shared conversation page loads.
- **Then** The page says “You can’t view this chat,” explains it may be private or no longer available, and shows a sign-in link.

## shared-thread-actions-002

Original test `An unavailable shared conversation uses the same access page (404)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-actions.test.tsx#L21).

- **Given** A visitor opens a shared conversation that returns HTTP 404.
- **When** The shared conversation page loads.
- **Then** The page says “You can’t view this chat,” explains it may be private or no longer available, and shows a sign-in link.

## shared-thread-actions-003

Original test `A visitor can continue a shared idea in Platform`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-actions.test.tsx#L71).

- **Given** A signed-out visitor views a shared conversation on app.okou.ai.
- **When** They view the option to continue the shared idea in Platform.
- **Then** “Try it yourself” links to the app root with the shared conversation path in its prompt parameter. Sign-in and sign-up links point to their respective pages and redirect to that handoff URL.

## shared-thread-actions-004

Original test `A signed-in viewer is not asked to sign in or sign up`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-actions.test.tsx#L109).

- **Given** A signed-in viewer opens a shared conversation on app.okou.ai.
- **When** They view the option to continue the shared idea.
- **Then** “Try it yourself” remains available, but no sign-in or sign-up links are shown.

## shared-thread-actions-005

Original test `A visitor can copy complete public message content`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-actions.test.tsx#L131).

- **Given** A visitor views a public conversation with one user message and three assistant messages, including plain text and formatted text.
- **When** They copy the user message and then the assistant response.
- **Then** The clipboard receives the complete user message, then all three assistant messages joined in order with blank lines between them. A “Copied!” confirmation appears after copying.

## shared-thread-actions-006

Original test `A visitor can copy the public conversation link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-actions.test.tsx#L204).

- **Given** A visitor views a public conversation on app.okou.ai.
- **When** They open Share and choose Copy link.
- **Then** The clipboard receives the conversation’s full app.okou.ai share URL, and the button confirms “Copied.”

## shared-thread-actions-007

Original test `The creator can manage visibility after reopening a shared conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-actions.test.tsx#L231).

- **Given** The signed-in creator reopens a shared conversation whose visibility is limited to the original workspace.
- **When** They open Share, copy the link, choose Only me, and then choose Anyone with the link while the private update and permission refresh are pending.
- **Then** The original workspace option is initially selected and the share URL can be copied. During the update, no option is selected, all choices remain enabled, and the radio group is busy. During refresh, the workspace option remains visible and the group remains busy without a loading-permissions status. After refresh, Anyone with the link is selected and the group is no longer busy.

## shared-thread-actions-008

Original test `An unavailable conversation permission read keeps access unknown`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-actions.test.tsx#L308).

- **Given** The signed-in creator opens Share, but the permission read fails with HTTP 500.
- **When** The permission controls load.
- **Then** An unable-to-load-permissions message appears; all three access choices are unchecked and disabled, and Copy link is absent.

## shared-thread-actions-009

Original test `A signed-in recipient can copy the shared link without access controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-actions.test.tsx#L336).

- **Given** A signed-in recipient views a shared conversation whose permission read returns HTTP 404.
- **When** They open Share and copy the link.
- **Then** Copy link is available and copies the conversation’s full share URL, while access controls are not shown.
