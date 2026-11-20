# Activity runner attribution

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [activity-runner-attribution.test.tsx](activity-runner-attribution.test.tsx).

## activity-runner-attribution-001

Original test `Runner diagnostics identify the exact environment used for an activity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-runner-attribution.test.tsx#L124).

- **Given** Three completed activities have runner diagnostics: Claude Code on prod-1.aws.vm3.ai with version 0.168.14, runner ID b0000000-0000-4000-a000-000000000001, and generation 7; Codex on prod-2.aws.vm3.ai with version 0.168.14, runner ID b0000000-0000-4000-a000-000000000002, and generation 8; and pi on prod-3.aws.vm3.ai.
- **When** The user views each activity's runner diagnostics in sequence.
- **Then** Each activity shows its own hostname and framework, and the first two also show their version, runner ID, and generation. The previous activity's hostname is no longer shown after navigating to the next one.

## activity-runner-attribution-002

Original test `Runner diagnostics display each persisted startup path`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-runner-attribution.test.tsx#L194).

- **Given** Four completed activities have persisted startup paths: sandbox, home, cold, and blank.
- **When** The user views each activity's runner diagnostics in sequence.
- **Then** The Startup card shows Sandbox reuse with “The sandbox and its workspace were reused,” Home reuse with “A fresh sandbox restored a cached home directory,” Cold start with “A fresh sandbox and workspace were prepared,” and Blank start with “A prepared sandbox started with a fresh home directory.”

## activity-runner-attribution-003

Original test `Runner metadata remains visible when the startup path is unreported`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-runner-attribution.test.tsx#L257).

- **Given** A completed activity has runner hostname available-runner and no reported startup path.
- **When** The user opens its runner diagnostics.
- **Then** The hostname is visible, and the Startup card shows Unknown.

## activity-runner-attribution-004

Original test `The persisted startup path is visible before completion metadata is saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-runner-attribution.test.tsx#L275).

- **Given** A running activity has runner hostname running-runner and persisted startup path home.
- **When** The user opens its runner diagnostics before completion metadata is saved.
- **Then** The hostname and Home reuse startup path are visible.

## activity-runner-attribution-005

Original test `Runner diagnostics do not carry over while the next activity's request is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-runner-attribution.test.tsx#L295).

- **Given** The current completed activity has startup path blank and hostname blank-runner; the next completed activity has startup path cold and hostname cold-runner.
- **When** The user navigates to the next activity while its runner details are still loading, then the request completes.
- **Then** The prior activity's Blank start label and blank-runner hostname are absent while the next request is pending. Once it completes, cold-runner and Cold start appear.
