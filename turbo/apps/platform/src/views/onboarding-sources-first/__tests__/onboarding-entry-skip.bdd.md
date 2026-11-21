# Onboarding entry skip

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-entry-skip.test.tsx](onboarding-entry-skip.test.tsx).

## onboarding-entry-skip-001

Original test `Authentication keeps task text separate from the actual onboarding flags`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L26).

- **Given** A user opens onboarding while signed out with task text containing strings that resemble onboarding flags, alongside actual `skipOnboarding=false` and `redeemCode=PRO-ENTRY` parameters.
- **When** Authentication redirects the user to sign in and constructs a return URL.
- **Then** The return URL preserves the task text unchanged and keeps the actual flags as `skipOnboarding=false` and `redeemCode=PRO-ENTRY`.

## onboarding-entry-skip-002

Original test `A skip link redeems, completes and runs its task while cookie delivery survives navigation (eligible: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L102).

- **Given** An administrator needs onboarding and opens a skip link with a task and a redeem code that is accepted.
- **When** The skip link is followed and the onboarding-start event remains pending during navigation.
- **Then** The code is redeemed, onboarding completes, and the task starts in a chat. The event request includes credentials and the bearer token, remains un-aborted during navigation, and the query string is cleared afterward.

## onboarding-entry-skip-003

Original test `A skip link redeems, completes and runs its task while cookie delivery survives navigation (eligible: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L102).

- **Given** An administrator needs onboarding and opens a skip link with a task and a redeem code whose response says it was not redeemed.
- **When** The skip link is followed and the onboarding-start event remains pending during navigation.
- **Then** The task starts in a chat after onboarding completes. The event request includes credentials and the bearer token, remains un-aborted during navigation, and the query string is cleared afterward.

## onboarding-entry-skip-004

Original test `A skip link preserves a hash handoff's task and attachment (admin: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L152).

- **Given** An administrator needs onboarding and opens a skip link containing a hash handoff and a redeem code. The handoff resolves to a task with a text-file attachment.
- **When** The skip link is followed and the handoff is imported.
- **Then** The code is redeemed and the chat starts with the handoff task and the imported `notes.txt` attachment.

## onboarding-entry-skip-005

Original test `A skip link preserves a hash handoff's task and attachment (admin: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L152).

- **Given** A non-administrator needs onboarding and opens a skip link containing a hash handoff and a redeem code. The handoff resolves to a task with a text-file attachment, but code redemption is forbidden for this user.
- **When** The skip link is followed and the handoff is imported.
- **Then** The chat starts with the handoff task and the imported `notes.txt` attachment despite the forbidden redemption response.

## onboarding-entry-skip-006

Original test `A skip link without a task completes onboarding and opens App from /onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L229).

- **Given** A user who needs onboarding opens `/onboarding` with a skip link and redeem code, but no task.
- **When** The skip link is followed and onboarding completes.
- **Then** The App message box appears at an agent chat route.
- **Upstream change** `4e5707de` (#49556) makes My Okou permanent, so App now opens at Home (`/`) instead of an `/agents/<id>/chat` route; the upstream row is `A skip link without a task completes onboarding and opens App from /onboarding` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L229)). Rebuild this scenario expecting the message box at `/`.

## onboarding-entry-skip-007

Original test `A skip link without a task completes onboarding and opens App from /onboarding/ready`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L229).

- **Given** A user who needs onboarding opens `/onboarding/ready` with a skip link and redeem code, but no task.
- **When** The skip link is followed and onboarding completes.
- **Then** The App message box appears at an agent chat route.

## onboarding-entry-skip-008

Original test `The prompt remains editable with skipOnboarding=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L249).

- **Given** A user needs onboarding and opens onboarding with a task and `skipOnboarding=false`.
- **When** The onboarding prompt is displayed.
- **Then** The prompt contains the task text and Next is enabled.

## onboarding-entry-skip-009

Original test `A redemption error offers a manual continuation with the task intact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L262).

- **Given** A user needs onboarding and opens a skip link with a task and a redeem code that returns an invalid-code error.
- **When** The user chooses to continue with onboarding, then submits the prompt after the code can be redeemed.
- **Then** The error is shown, and manual continuation keeps the task editable and the redeem code in the URL. Submitting starts a chat with the original task.

## onboarding-entry-skip-010

Original test `A completion retry retains a redeemed code's grant without consuming it again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L303).

- **Given** A user needs onboarding and opens a skip link with a task and redeem code. Code redemption succeeds, but completing onboarding fails with a server error.
- **When** The user retries after onboarding completion becomes available.
- **Then** The completion error is shown, and retry starts a chat with the original task without redeeming the code again.

## onboarding-entry-skip-011

Original test `A skip entry shows progress until completion succeeds before starting its task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L350).

- **Given** A user needs onboarding and opens a skip link with a task while onboarding completion is pending.
- **When** The user follows the skip link before the completion request succeeds.
- **Then** A workspace-preparation progress status appears and the task does not start yet. After completion succeeds, the task starts in a chat.

## onboarding-entry-skip-012

Original test `An unavailable task resumes ordinary onboarding instead of completing an empty request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-entry-skip.test.tsx#L388).

- **Given** A user needs onboarding and opens a skip link with a hash handoff whose content cannot be found, plus a redeem code.
- **When** The handoff resolution returns not found.
- **Then** Ordinary onboarding resumes at the work-type question instead of completing onboarding with an empty request, and the redeem code remains in the URL.
