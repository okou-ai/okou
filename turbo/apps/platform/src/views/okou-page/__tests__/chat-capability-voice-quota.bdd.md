# Chat capability voice quota

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-voice-quota.test.tsx](chat-capability-voice-quota.test.tsx).

## chat-capability-voice-quota-001

Original test `Offer role-aware recovery when voice quota is exhausted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-quota.test.tsx#L111).

- **Given** A free-plan workspace admin has exhausted the voice input quota.
- **When** The admin selects voice input.
- **Then** The app displays the higher-limits message and opens a plan chooser showing both Pro and Team plans.

## chat-capability-voice-quota-002

Original test `Offer a Team upgrade when a Pro admin exhausts voice quota`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-quota.test.tsx#L134).

- **Given** A Pro-plan workspace admin has used 9 of 10 voice requests, and the next transcription response reaches the 10-request quota.
- **When** The admin records and stops a voice draft.
- **Then** The app displays the higher-limits message and opens a plan chooser showing the Team plan.

## chat-capability-voice-quota-003

Original test `Keep a recorded draft after a quota response`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-quota.test.tsx#L171).

- **Given** A Team-plan admin is allowed to start recording, but transcription responds that the daily voice request limit is reached.
- **When** The admin stops recording.
- **Then** The app asks the user to wait for the limit to reset, and a removable voice draft is retained.

## chat-capability-voice-quota-004

Original test `Ask an admin when a member exhausts voice quota`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-quota.test.tsx#L208).

- **Given** A free-plan workspace member has exhausted the voice input quota.
- **When** The member selects voice input.
- **Then** The app tells the member to ask a workspace admin to upgrade, and no plan chooser appears.

## chat-capability-voice-quota-005

Original test `Wait for voice allowance reset on a Team plan`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-quota.test.tsx#L228).

- **Given** A Team-plan workspace admin has exhausted the voice input quota.
- **When** The admin selects voice input.
- **Then** The app asks the user to wait for the limit to reset, and no plan chooser appears.
