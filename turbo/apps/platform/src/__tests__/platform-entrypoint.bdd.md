# Platform entrypoint

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [platform-entrypoint.test.ts](platform-entrypoint.test.ts).

## platform-entrypoint-001

Original test `platform entrypoint > does not start with an aborted root signal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L29).

- **Given** The app has an aborted root signal with a “Page stopped” AbortError.
- **When** The platform entrypoint is started.
- **Then** It throws that same abort reason, does not initialize Sentry, and leaves the root empty.

## platform-entrypoint-002

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Chrome 138 on desktop, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-003

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 Chromium/138.0.0.0 Safari/537.36`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Chromium 138 on desktop, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-004

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Edge 138 on desktop, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-005

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36 OPR/123.0.0.0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Opera 123 on desktop with a Chrome 138 user-agent token, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-006

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 (Linux; Android 14) Chrome/148.0.0.0 Mobile Safari/537.36`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Chrome 148 on Android 14 mobile, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-007

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 (Linux; Android 14; wv) Chrome/148.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Chrome 148 on Android 14 in a webview with a WeChat token, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-008

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Firefox 128 on desktop Linux, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-009

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Firefox 128 on Android mobile, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-010

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 (Macintosh) Version/18.2 Safari/605.1.15`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Safari 18.2 on macOS, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-011

Original test `platform entrypoint > starts at the supported browser boundary: Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) CriOS/111.0 Mobile/15E148 Safari/604.1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L54).

- **Given** The browser identifies itself as Chrome 111 on iOS 18.2, at the supported browser boundary.
- **When** The platform entrypoint starts.
- **Then** The application starts, Sentry initializes once, and no browser-upgrade heading is shown.

## platform-entrypoint-012

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 Chrome/137.0.0.0 Safari/537…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Chrome 137 on desktop, below the supported version.
- **When** The platform entrypoint starts.
- **Then** It shows “Update Chrome to continue” with a link to https://www.google.com/chrome/ and does not initialize Sentry.

## platform-entrypoint-013

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 Chromium/137.0.0.0 Safari/5…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Chromium 137 on desktop, below the supported version.
- **When** The platform entrypoint starts.
- **Then** It shows “Update Chromium to continue” with a link to https://www.chromium.org/getting-involved/download-chromium/ and does not initialize Sentry.

## platform-entrypoint-014

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 Chrome/137.0.0.0 Safari/537…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Edge 137 on desktop, below the supported version.
- **When** The platform entrypoint starts.
- **Then** It shows “Update Edge to continue” with a link to https://www.microsoft.com/edge/download and does not initialize Sentry.

## platform-entrypoint-015

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 (Android 14) Chrome/147.0.0…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Edge 147 on Android 14, below the supported version.
- **When** The platform entrypoint starts.
- **Then** It shows “Update Edge to continue” with a link to https://www.microsoft.com/edge/download and does not initialize Sentry.

## platform-entrypoint-016

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 Chrome/137.0.0.0 Safari/537…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Opera 123 with a Chrome 137 user-agent token.
- **When** The platform entrypoint starts.
- **Then** It shows “Use a supported browser to continue” with a link to https://www.google.com/chrome/ and does not initialize Sentry.

## platform-entrypoint-017

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 (Android 14) Chrome/147.0.0…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Samsung Browser 30 on Android 14 with a Chrome 147 token.
- **When** The platform entrypoint starts.
- **Then** It shows “Use a supported browser to continue” with a link to https://www.google.com/chrome/ and does not initialize Sentry.

## platform-entrypoint-018

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 (Linux; Android 14; wv) Chr…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as a Chrome 142 Android webview with a WeChat token.
- **When** The platform entrypoint starts.
- **Then** It shows “Use a supported browser to continue” with a link to https://www.google.com/chrome/ and does not initialize Sentry.

## platform-entrypoint-019

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 (Android 14) Chrome/147.0.0…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Chrome 147 on Android 14 mobile, below the supported version.
- **When** The platform entrypoint starts.
- **Then** It shows “Update Chrome to continue” with a link to https://www.google.com/chrome/ and does not initialize Sentry.

## platform-entrypoint-020

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 (X11; Linux x86_64; rv:127.…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Firefox 127 on desktop Linux, below the supported version.
- **When** The platform entrypoint starts.
- **Then** It shows “Update Firefox to continue” with a link to https://www.mozilla.org/firefox/new/ and does not initialize Sentry.

## platform-entrypoint-021

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 (Macintosh) Version/18.1 Sa…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Safari 18.1 on macOS, below the supported version.
- **When** The platform entrypoint starts.
- **Then** It shows “Update Safari to continue” with a link to https://support.apple.com/safari and does not initialize Sentry.

## platform-entrypoint-022

Original test `platform entrypoint > shows accurate upgrade guidance: Mozilla/5.0 (iPhone; CPU iPhone OS 18_1…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L127).

- **Given** The browser identifies itself as Chrome 150 on iOS 18.1.
- **When** The platform entrypoint starts.
- **Then** It shows “Update iOS to continue” with a link to https://support.apple.com/HT204204 and does not initialize Sentry.

## platform-entrypoint-023

Original test `platform entrypoint > strips Discord approval fragments synchronously before analytics initialize`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L141).

- **Given** The current URL contains a Discord approval fragment and the query ?discord=pending.
- **When** The platform entrypoint starts and analytics initialize.
- **Then** The fragment is removed synchronously, and every analytics initialization sees https://app.okou.ai/works?discord=pending without the approval data.

## platform-entrypoint-024

Original test `platform entrypoint > shows browser guidance before bootstrap when SharedWorker is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/platform-entrypoint.test.ts#L171).

- **Given** The browser is Chrome 148 on Android 14, but SharedWorker is unavailable.
- **When** The platform entrypoint starts.
- **Then** Before bootstrap, it shows “Use a supported browser to continue” with a link to https://www.google.com/chrome/. Sentry is neither initialized nor sent any reports.
