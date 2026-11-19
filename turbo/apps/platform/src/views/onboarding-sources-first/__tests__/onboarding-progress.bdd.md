# Onboarding progress

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-progress.test.tsx](onboarding-progress.test.tsx).

## onboarding-progress-001

Original test `Reopening / resumes the saved step and still allows Back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L61).

- **Given** Onboarding is incomplete and the browser has saved progress at the sources step. The user reopens the home route with a redeem code.
- **When** The app loads and the user goes Back, then Continue.
- **Then** The app resumes at “Connect a work tool,” preserves the redeem code, goes Back to the work-type step, and returns to the sources step after Continue.

## onboarding-progress-002

Original test `Reopening /onboarding resumes the saved step and still allows Back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L61).

- **Given** Onboarding is incomplete and the browser has saved progress at the sources step. The user reopens the onboarding route with a redeem code.
- **When** The app loads and the user goes Back, then Continue.
- **Then** The app resumes at “Connect a work tool,” preserves the redeem code, goes Back to the work-type step, and returns to the sources step after Continue.

## onboarding-progress-003

Original test `A clean browser resumes the server draft and its saved step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L95).

- **Given** The browser has no saved draft, and the server returns a draft at the ready step with a first-task request saved from another device.
- **When** The user opens onboarding.
- **Then** The app resumes at “Let’s start your first task” and restores “Restore this task from my other device” in the first-task field.

## onboarding-progress-004

Original test `The first server save imports both browser draft keys before clearing them`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L127).

- **Given** Onboarding is incomplete, browser storage contains a ready-step draft with “Draft my launch plan,” and the server has no draft.
- **When** The user opens onboarding and the first server save occurs.
- **Then** The app displays “Draft my launch plan,” saves it with the ready step and no prior revision, and clears both browser draft keys after the save.

## onboarding-progress-005

Original test `A rollback to an older API still resumes the browser draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L161).

- **Given** Onboarding is incomplete, browser storage contains a ready-step draft with “Draft my launch plan,” and the older server API returns 404 for draft retrieval.
- **When** The user opens onboarding.
- **Then** The app resumes at “Let’s start your first task” and restores “Draft my launch plan.”

## onboarding-progress-006

Original test `An explicit step URL takes precedence over saved progress`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L179).

- **Given** Onboarding is incomplete and browser storage contains progress at the ready step.
- **When** The user opens the explicit sources-step URL.
- **Then** The app displays “Connect a work tool” and remains on the sources-step URL, taking precedence over the saved ready step.

## onboarding-progress-007

Original test `Resuming a later step preserves progress without a connected source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L197).

- **Given** Onboarding is incomplete, browser storage contains ready-step progress with “Draft my launch plan,” and no source is connected.
- **When** The user opens onboarding.
- **Then** The app resumes at the ready step, shows the saved request, and enables “Start my first task.”

## onboarding-progress-008

Original test `A saved team step must belong to the current flow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L225).

- **Given** Onboarding is incomplete, the user is not an admin, a Gmail source is connected, and browser storage saves the team step.
- **When** The user opens onboarding.
- **Then** The saved step is rejected as outside the current flow; the app opens the experience step, “How would you like to start with Okou?”

## onboarding-progress-009

Original test `A saved team step must belong to the current flow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L225).

- **Given** Onboarding is incomplete, the user is an admin, a Gmail source is connected, and browser storage saves the team step.
- **When** The user opens onboarding.
- **Then** The saved step is rejected as outside the current flow; the app opens the experience step, “How would you like to start with Okou?”

## onboarding-progress-010

Original test `A saved skills step must belong to the current flow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L225).

- **Given** Onboarding is incomplete, the user is an admin, a Gmail source is connected, and browser storage saves the skills step.
- **When** The user opens onboarding.
- **Then** The saved step is rejected as outside the current flow; the app opens the experience step, “How would you like to start with Okou?”

## onboarding-progress-011

Original test `Unusable progress starts at the first step: {"orgId":"org_other","userId":"test-user-123","step":"sources"}`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L253).

- **Given** Onboarding is incomplete and saved progress is for organization “org_other” rather than the current organization.
- **When** The user opens onboarding.
- **Then** The unusable progress is ignored, and the app starts at the work-type step on the onboarding route.

## onboarding-progress-012

Original test `Unusable progress starts at the first step: {"orgId":"org_default","userId":"another-user","step":"sources"}`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L253).

- **Given** Onboarding is incomplete and saved progress is for user “another-user” rather than the current user.
- **When** The user opens onboarding.
- **Then** The unusable progress is ignored, and the app starts at the work-type step on the onboarding route.

## onboarding-progress-013

Original test `Unusable progress starts at the first step: {"orgId":"org_default","userId":"test-user-123","step":"unknown-step"}`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L253).

- **Given** Onboarding is incomplete and browser storage contains an unknown saved step.
- **When** The user opens onboarding.
- **Then** The unusable progress is ignored, and the app starts at the work-type step on the onboarding route.

## onboarding-progress-014

Original test `Reopening / after server-side completion opens chat instead of saved progress`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L275).

- **Given** The server considers onboarding complete and browser storage contains ready-step progress. The user reopens the home route.
- **When** The app loads.
- **Then** The app displays the chat message textbox instead of reopening saved onboarding progress.

## onboarding-progress-015

Original test `Reopening /onboarding after server-side completion opens chat instead of saved progress`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L275).

- **Given** The server considers onboarding complete and browser storage contains ready-step progress. The user reopens the onboarding route.
- **When** The app loads.
- **Then** The app displays the chat message textbox instead of reopening saved onboarding progress.

## onboarding-progress-016

Original test `A failed completion keeps the ready step and edited request available for retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx#L288).

- **Given** Onboarding is incomplete, a Gmail source is connected, and browser storage contains a ready-step request, “Draft my launch plan.” The completion request fails with a server error.
- **When** The user starts the first task.
- **Then** The app shows “Could not finish onboarding,” remains on the ready step with the edited request available, and enables “Start my first task” for retry.
