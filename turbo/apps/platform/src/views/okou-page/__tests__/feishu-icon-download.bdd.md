# Feishu icon download

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [feishu-icon-download.test.tsx](feishu-icon-download.test.tsx).

## feishu-icon-download-001

Original test `feishu icon download > click downloads the cross-origin icon with the platform filename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-icon-download.test.tsx#L29).

- **Given** A Feishu bot setup is open and the optional Okou icon is available as a readable PNG.
- **When** The user clicks the icon download link.
- **Then** One PNG download contains the icon bytes and is named okou-feishu-app-icon.png. The user remains on Feishu setup at the Create an Agent app step.

## feishu-icon-download-002

Original test `feishu icon download > Enter downloads the cross-origin icon with the platform filename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-icon-download.test.tsx#L29).

- **Given** A Feishu bot setup is open and the optional Okou icon is available as a readable PNG.
- **When** The user focuses the icon download link and presses Enter.
- **Then** One PNG download contains the icon bytes and is named okou-feishu-app-icon.png. The user remains on Feishu setup at the Create an Agent app step.

## feishu-icon-download-003

Original test `feishu icon download > reports an unreadable icon without navigating away from setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-icon-download.test.tsx#L64).

- **Given** A Feishu bot setup is open, but the optional Okou icon request fails with an unreadable-icon server response.
- **When** The user clicks the icon download link.
- **Then** A “Download failed” message appears, no file is downloaded, and the user remains at the Create an Agent app step on Feishu setup.

## feishu-icon-download-004

Original test `lark icon download > click downloads the cross-origin icon with the platform filename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-icon-download.test.tsx#L29).

- **Given** A Lark bot setup is open and the optional Okou icon is available as a readable PNG.
- **When** The user clicks the icon download link.
- **Then** One PNG download contains the icon bytes and is named okou-lark-app-icon.png. The user remains on Lark setup at the Create an Agent app step.

## feishu-icon-download-005

Original test `lark icon download > Enter downloads the cross-origin icon with the platform filename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-icon-download.test.tsx#L29).

- **Given** A Lark bot setup is open and the optional Okou icon is available as a readable PNG.
- **When** The user focuses the icon download link and presses Enter.
- **Then** One PNG download contains the icon bytes and is named okou-lark-app-icon.png. The user remains on Lark setup at the Create an Agent app step.

## feishu-icon-download-006

Original test `lark icon download > reports an unreadable icon without navigating away from setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-icon-download.test.tsx#L64).

- **Given** A Lark bot setup is open, but the optional Okou icon request fails with an unreadable-icon server response.
- **When** The user clicks the icon download link.
- **Then** A “Download failed” message appears, no file is downloaded, and the user remains at the Create an Agent app step on Lark setup.
