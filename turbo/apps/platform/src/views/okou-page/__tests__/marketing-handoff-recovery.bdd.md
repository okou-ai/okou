# Marketing handoff recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [marketing-handoff-recovery.test.tsx](marketing-handoff-recovery.test.tsx).

## marketing-handoff-recovery-001

Original test `A failed handoff at /prompt (404) keeps the App usable and the draft intact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L61).

- **Given** The user has an existing draft and opens a /prompt handoff link that also contains prompt, model, template, connector, and showcase parameters. Resolving the handoff returns HTTP 404.
- **When** The app attempts to restore the handoff.
- **Then** The app remains usable, the existing draft is unchanged, one restoration notice appears, and all handoff-related query parameters are removed.

## marketing-handoff-recovery-002

Original test `A failed handoff at /prompt (503) keeps the App usable and the draft intact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L61).

- **Given** The user has an existing draft and opens a /prompt handoff link that also contains prompt, model, template, connector, and showcase parameters. Resolving the handoff returns HTTP 503.
- **When** The app attempts to restore the handoff.
- **Then** The app remains usable, the existing draft is unchanged, one restoration notice appears, and all handoff-related query parameters are removed.

## marketing-handoff-recovery-003

Original test `A failed handoff at /onboarding (404) keeps the App usable and the draft intact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L61).

- **Given** The user has an existing draft and opens an /onboarding handoff link that also contains prompt, model, template, connector, and showcase parameters. Resolving the handoff returns HTTP 404.
- **When** The app attempts to restore the handoff.
- **Then** The app remains usable, the existing draft is unchanged, one restoration notice appears, and all handoff-related query parameters are removed.

## marketing-handoff-recovery-004

Original test `A failed handoff at /onboarding (503) keeps the App usable and the draft intact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L61).

- **Given** The user has an existing draft and opens an /onboarding handoff link that also contains prompt, model, template, connector, and showcase parameters. Resolving the handoff returns HTTP 503.
- **When** The app attempts to restore the handoff.
- **Then** The app remains usable, the existing draft is unchanged, one restoration notice appears, and all handoff-related query parameters are removed.

## marketing-handoff-recovery-005

Original test `A failed handoff at /agents/c0000000-0000-4000-a000-000000000001/chat (404) keeps the App usable and the draft intact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L61).

- **Given** The user has an existing draft and opens an agent chat handoff link that also contains prompt, model, template, connector, and showcase parameters. Resolving the handoff returns HTTP 404.
- **When** The app attempts to restore the handoff.
- **Then** The app remains usable, the existing draft is unchanged, one restoration notice appears, and all handoff-related query parameters are removed.

## marketing-handoff-recovery-006

Original test `A failed handoff at /agents/c0000000-0000-4000-a000-000000000001/chat (503) keeps the App usable and the draft intact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L61).

- **Given** The user has an existing draft and opens an agent chat handoff link that also contains prompt, model, template, connector, and showcase parameters. Resolving the handoff returns HTTP 503.
- **When** The app attempts to restore the handoff.
- **Then** The app remains usable, the existing draft is unchanged, one restoration notice appears, and all handoff-related query parameters are removed.

## marketing-handoff-recovery-007

Original test `A network failure restoring a task keeps the App and the existing draft usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L80).

- **Given** The user has an existing draft and opens a /prompt handoff link. Restoring the linked task fails because of a network error.
- **When** The app attempts to restore the handoff.
- **Then** The app remains usable, the existing draft is unchanged, one restoration notice appears, and the handoff-related query parameters are removed.

## marketing-handoff-recovery-008

Original test `An attachment import failure at /prompt preserves the existing draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L94).

- **Given** The user has an existing draft and opens a /prompt handoff link whose task contains an attachment. Importing the attachment returns HTTP 503.
- **When** The app attempts to restore the task.
- **Then** The app remains usable, the existing draft is unchanged, one restoration notice appears, and the handoff-related query parameters are removed.

## marketing-handoff-recovery-009

Original test `An attachment import failure at /agents/c0000000-0000-4000-a000-000000000001/chat preserves the existing draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L94).

- **Given** The user has an existing draft and opens an agent chat handoff link whose task contains an attachment. Importing the attachment returns HTTP 503.
- **When** The app attempts to restore the task.
- **Then** The app remains usable, the existing draft is unchanged, one restoration notice appears, and the handoff-related query parameters are removed.

## marketing-handoff-recovery-010

Original test `An unavailable task resumes ordinary onboarding (admin: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L128).

- **Given** An administrator who needs onboarding opens a handoff link for a task that cannot be found.
- **When** The app attempts to restore the task.
- **Then** Ordinary onboarding resumes at “What kind of work do you do?”, one restoration notice appears, and the handoff parameter is removed.

## marketing-handoff-recovery-011

Original test `An unavailable task resumes ordinary onboarding (admin: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L128).

- **Given** A non-administrator who needs onboarding opens a handoff link for a task that cannot be found.
- **When** The app attempts to restore the task.
- **Then** Ordinary onboarding resumes at “What kind of work do you do?”, one restoration notice appears, and the handoff parameter is removed.

## marketing-handoff-recovery-012

Original test `An unavailable task resumes the saved onboarding step and edited request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L156).

- **Given** The user has entered “Keep my onboarding draft” on the onboarding ready step, then opens a handoff link for a task that cannot be found in a new app instance.
- **When** The app attempts to restore the unavailable task.
- **Then** The saved request text remains in the first-task field, the user returns to /onboarding/ready, and one restoration notice appears.

## marketing-handoff-recovery-013

Original test `An imported attachment that cannot resolve (404) keeps the saved draft and shows one notice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L200).

- **Given** The user opens an agent chat handoff for a saved draft containing an attachment named notes.txt. The attachment URL lookup returns HTTP 404.
- **When** The app attempts to restore the task and resolve the attachment.
- **Then** The existing draft remains unchanged, notes.txt is reported as no longer available and needing re-upload, one notice appears, and the handoff-related query parameters are removed.

## marketing-handoff-recovery-014

Original test `An imported attachment that cannot resolve (503) keeps the saved draft and shows one notice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L200).

- **Given** The user opens an agent chat handoff for a saved draft containing an attachment named notes.txt. The attachment URL lookup returns HTTP 503.
- **When** The app attempts to restore the task and resolve the attachment.
- **Then** The existing draft remains unchanged, one “Attachment storage unavailable” notice appears, and the handoff-related query parameters are removed.

## marketing-handoff-recovery-015

Original test `An imported attachment that cannot resolve (network) keeps the saved draft and shows one notice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L200).

- **Given** The user opens an agent chat handoff for a saved draft containing an attachment named notes.txt. The attachment URL lookup fails at the network level.
- **When** The app attempts to restore the task and resolve the attachment.
- **Then** The existing draft remains unchanged, one restoration notice appears, and the handoff-related query parameters are removed.

## marketing-handoff-recovery-016

Original test `Authentication and upgrade failures (401) keep their existing handling`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L274).

- **Given** The user has an existing draft and opens a /prompt handoff link. Resolving the handoff returns HTTP 401.
- **When** The app attempts to restore the handoff.
- **Then** Page setup rejects with status 401, the handoff parameter remains in the URL, and no restoration notice appears.

## marketing-handoff-recovery-017

Original test `Authentication and upgrade failures (426) keep their existing handling`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L274).

- **Given** The user has an existing draft and opens a /prompt handoff link. Resolving the handoff returns HTTP 426.
- **When** The app attempts to restore the handoff.
- **Then** Page setup rejects with status 426, the handoff parameter remains in the URL, and no restoration notice appears.

## marketing-handoff-recovery-018

Original test `A valid task restores its text and attachments into the agent composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L297).

- **Given** The user opens an agent chat handoff for a valid task containing the text “Prepare the received report” and an importable notes.txt attachment.
- **When** The app restores the task and imports its attachment.
- **Then** The agent composer contains “Prepare the received report,” notes.txt is displayed, and the handoff parameter is removed.
