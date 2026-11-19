# Initial locale

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [initial-locale.test.tsx](initial-locale.test.tsx).

## initial-locale-001

Original test `Initial page language: the site cookie takes precedence over b…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/initial-locale.test.tsx#L35).

- **Given** The site locale cookie is v1.fr-FR, while the browser language is ja-JP.
- **When** The user opens the site.
- **Then** The page language is fr-FR, taking precedence over the browser language.

## initial-locale-002

Original test `Initial page language: the first supported browser language fa…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/initial-locale.test.tsx#L35).

- **Given** The site locale cookie is unsupported, and browser languages are sv-SE, de-AT, and ja-JP, in that order.
- **When** The user opens the site.
- **Then** The page language is de-DE, matching the first supported browser language family.

## initial-locale-003

Original test `Initial page language: a Taiwan browser reaches the Traditiona…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/initial-locale.test.tsx#L35).

- **Given** There is no site locale cookie, and the browser language is zh-TW.
- **When** The user opens the site.
- **Then** The page language is zh-Hant, the Traditional Chinese bundle rather than Simplified Chinese.

## initial-locale-004

Original test `Initial page language: English is used when no locale hint is …`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/initial-locale.test.tsx#L35).

- **Given** The site locale cookie has an unsupported version, and browser languages sv-SE and ar-SA are unsupported.
- **When** The user opens the site.
- **Then** The page language defaults to en-US.
