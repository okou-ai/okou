# Integration uninstall lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integration-uninstall-lifecycle.test.tsx](integration-uninstall-lifecycle.test.tsx).

## integration-uninstall-lifecycle-001

Original test `slack uninstall keeps confirmation while pending and recovers after failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-uninstall-lifecycle.test.tsx#L18).

- **Given** Slack is installed and connected, and the user opens the uninstall confirmation dialog.
- **When** The user confirms uninstall while the request is pending, then the request fails with a forbidden response and the user retries successfully.
- **Then** While pending, Cancel and Uninstalling are disabled, and Escape does not close the dialog. After failure, the error “Uninstall unavailable” appears and Uninstall is enabled again. The successful retry changes the card to offer installation and closes the dialog.

## integration-uninstall-lifecycle-002

Original test `teams uninstall keeps confirmation while pending and recovers after failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-uninstall-lifecycle.test.tsx#L18).

- **Given** Microsoft Teams is installed, and the user opens the uninstall confirmation dialog.
- **When** The user confirms uninstall while the request is pending, then the request fails with a forbidden response and the user retries successfully.
- **Then** While pending, Cancel and Uninstalling are disabled, and Escape does not close the dialog. After failure, the error “Uninstall unavailable” appears and Uninstall is enabled again. The successful retry changes the card to offer installation and closes the dialog.
