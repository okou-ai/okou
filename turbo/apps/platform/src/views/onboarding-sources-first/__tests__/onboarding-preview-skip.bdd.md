# Onboarding preview skip

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-preview-skip.test.tsx](onboarding-preview-skip.test.tsx).

## onboarding-preview-skip-001

Original test `A preview visitor can skip unanswered onboarding on pr-40584-app-okou-app-preview.vm0.worke…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L46).

- **Given** An admin visitor on pr-40584-app-okou-app-preview.vm0.workers.dev has unanswered onboarding.
- **When** The visitor chooses Skip.
- **Then** Onboarding is left for an agent chat; the unanswered industry question is no longer shown.
- **Upstream change** `4e5707de` (#49556) makes My Okou permanent, so skipping now opens the chat at Home (`/`) instead of an `/agents/<id>/chat` route; the upstream row is `A preview visitor can skip unanswered onboarding on $host` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L46)). Rebuild this scenario expecting the message box at `/`.

## onboarding-preview-skip-002

Original test `A preview visitor can skip unanswered onboarding on staging-app-okou-app-preview.vm0.worker…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L46).

- **Given** A non-admin visitor on staging-app-okou-app-preview.vm0.workers.dev has unanswered onboarding.
- **When** The visitor chooses Skip.
- **Then** Onboarding is left for an agent chat; the unanswered industry question is no longer shown.

## onboarding-preview-skip-003

Original test `A preview visitor can skip unanswered onboarding on app-okou-app-preview.vm0.workers.dev`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L46).

- **Given** An admin visitor on app-okou-app-preview.vm0.workers.dev has unanswered onboarding.
- **When** The visitor chooses Skip.
- **Then** Onboarding is left for an agent chat; the unanswered industry question is no longer shown.

## onboarding-preview-skip-004

Original test `A preview visitor can skip unanswered onboarding on pr-40584-app.omby.ai`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L46).

- **Given** An admin visitor on pr-40584-app.omby.ai has unanswered onboarding.
- **When** The visitor chooses Skip.
- **Then** Onboarding is left for an agent chat; the unanswered industry question is no longer shown.

## onboarding-preview-skip-005

Original test `Onboarding does not offer the preview shortcut on app.okou.ai`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L70).

- **Given** A visitor on app.okou.ai has unanswered onboarding.
- **When** The visitor views onboarding.
- **Then** No Skip button is offered, and Continue is disabled.

## onboarding-preview-skip-006

Original test `Onboarding does not offer the preview shortcut on okou.ai`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L70).

- **Given** A visitor on okou.ai has unanswered onboarding.
- **When** The visitor views onboarding.
- **Then** No Skip button is offered, and Continue is disabled.

## onboarding-preview-skip-007

Original test `Onboarding does not offer the preview shortcut on localhost`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L70).

- **Given** A visitor on localhost has unanswered onboarding.
- **When** The visitor views onboarding.
- **Then** No Skip button is offered, and Continue is disabled.

## onboarding-preview-skip-008

Original test `Onboarding does not offer the preview shortcut on 127.0.0.1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L70).

- **Given** A visitor on 127.0.0.1 has unanswered onboarding.
- **When** The visitor views onboarding.
- **Then** No Skip button is offered, and Continue is disabled.

## onboarding-preview-skip-009

Original test `Skipping sources in a preview continues onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L84).

- **Given** A visitor on a preview host is on the onboarding sources step.
- **When** The visitor chooses Skip and then confirms with Skip for now.
- **Then** The visitor proceeds to the onboarding experience step; the sources step remains visible until confirmation.

## onboarding-preview-skip-010

Original test `Skip waits for completion and remains retryable after a failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L109).

- **Given** A visitor on a preview host has unanswered onboarding and the completion request is pending.
- **When** The visitor chooses Skip, the request fails, and the visitor retries after the failure.
- **Then** Skip is busy and disabled while the request is pending, with the visitor remaining on onboarding. After failure, an error is shown and Skip becomes enabled without navigating; a successful retry opens an agent chat.
- **Upstream change** `4e5707de` (#49556) makes My Okou permanent, so the successful retry now opens the chat at Home (`/`) instead of an `/agents/<id>/chat` route; the upstream test is now `Skip waits for completion and remains retryable after a failure` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L109)). Rebuild this scenario expecting the message box at `/` after the retry.

## onboarding-preview-skip-011

Original test `Skipping a preview prompt handoff opens the app without running the prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L166).

- **Given** A visitor on a preview host has a prompt handoff containing “Draft the launch plan” and a redeem code.
- **When** The visitor chooses Skip.
- **Then** The app opens an agent chat with an empty message composer, and the prompt query is removed; the prompt is not run.
- **Upstream change** `4e5707de` (#49556) makes My Okou permanent, so skipping now opens the chat at Home (`/`) instead of an `/agents/<id>/chat` route; the upstream test is now `Skipping a preview prompt handoff opens the app without running the prompt` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-preview-skip.test.tsx#L166)). Rebuild this scenario expecting an empty composer at `/` without the prompt query.
