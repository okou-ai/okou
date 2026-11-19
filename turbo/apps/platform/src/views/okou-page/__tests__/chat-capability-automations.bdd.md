# Chat capability automations

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-automations.test.tsx](chat-capability-automations.test.tsx).

## chat-capability-automations-001

Original test `Browse an active scheduled workflow and its available controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-automations.test.tsx#L197).

- **Given** A chat thread has an active scheduled workflow named “Active release schedule” configured to run every two hours, with last-run and next-run information.
- **When** The user opens the Automations panel for the thread.
- **Then** The workflow is shown as Active with its two-hour interval and last-run and next-run information. View, Run now, and Edit controls are available.

## chat-capability-automations-002

Original test `Browse a webhook workflow without offering schedule editing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-automations.test.tsx#L209).

- **Given** A chat thread has an active webhook workflow named “Release webhook.”
- **When** The user opens the Automations panel for the thread.
- **Then** The webhook has a View link and a Run now control, but no Edit control.

## chat-capability-automations-003

Original test `Keep official automation management without offering Run now`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-automations.test.tsx#L221).

- **Given** A chat thread has an official scheduled workflow named “Official Morning Brief.”
- **When** The user opens the Automations panel for the thread.
- **Then** The workflow has a View link to its automation management page, but neither Run now nor Edit is offered.

## chat-capability-automations-004

Original test `Refresh the automation list when the thread's automations change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-automations.test.tsx#L236).

- **Given** The Automations panel for a chat thread displays the active “Active release schedule” workflow.
- **When** The thread's automation-change event arrives after a “Release webhook” workflow is added.
- **Then** The panel refreshes to show both the existing schedule and the new webhook.

## chat-capability-automations-005

Original test `An earlier chat automation save preserves a newer editor for Active release schedule`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-automations.test.tsx#L336).

- **Given** The Automations panel contains “Active release schedule” and “Paused digest schedule.” An edit save for the active schedule is pending after its editor is closed, and a newer editor for “Active release schedule” is open with “30 minutes” selected.
- **When** The earlier save completes and returns the saved five-hour schedule.
- **Then** The saved schedule is shown as every five hours, while the newer editor remains open with “30 minutes” selected.

## chat-capability-automations-006

Original test `An earlier chat automation save preserves a newer editor for Paused digest schedule`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-automations.test.tsx#L336).

- **Given** The Automations panel contains “Active release schedule” and “Paused digest schedule.” An edit save for the active schedule is pending after its editor is closed, and a newer editor for “Paused digest schedule” is open with “30 minutes” selected.
- **When** The earlier save completes and returns the saved five-hour schedule.
- **Then** The saved active schedule is shown as every five hours, while the newer editor for the paused schedule remains open with “30 minutes” selected.
