# Onboarding prompt connectors

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-prompt-connectors.test.tsx](onboarding-prompt-connectors.test.tsx).

## onboarding-prompt-connectors-001

Original test `A prompt link offers recommended connections and can run without them (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-connectors.test.tsx#L52).

- **Given** A user opens onboarding on desktop from a prompt link. The prompt is prefilled, and the recommended tools are Gmail, Google Drive, Google Calendar, Google Docs, Google Sheets, Google Ads, Notion, and GitHub.
- **When** The user edits the prompt and selects Next without connecting any tools.
- **Then** All eight tools are offered as enabled connection options. The app starts a chat at a /chats/ path with the edited prompt followed by the standard instruction to create a complete document, upload it as an artifact, and include its link.

## onboarding-prompt-connectors-002

Original test `A prompt link offers recommended connections and can run without them (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-connectors.test.tsx#L52).

- **Given** A user opens the onboarding sources page on mobile from a prompt link. The prompt is prefilled, and the recommended tools are Gmail, Google Drive, Google Calendar, Google Docs, Google Sheets, Google Ads, Notion, and GitHub.
- **When** The user edits the prompt and selects Start task without connecting any tools.
- **Then** All eight tools are offered as enabled connection options. The app starts a chat at a /chats/ path with the edited prompt followed by the standard instruction to create a complete document, upload it as an artifact, and include its link.

## onboarding-prompt-connectors-003

Original test `Recommendations offer the OAuth methods available in the current catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-connectors.test.tsx#L99).

- **Given** A user opens onboarding from a prompt link. The current catalog offers Gmail with OAuth and Notion with no authentication methods.
- **When** The onboarding recommendations load.
- **Then** Gmail is offered as an enabled connection, Notion is not offered, and Next remains enabled.

## onboarding-prompt-connectors-004

Original test `A recommended Google Ads connection completes OAuth without losing the edited prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-connectors.test.tsx#L137).

- **Given** A user opens onboarding from a prompt link while Google Ads is recommended and OAuth is available.
- **When** The user edits the prompt to include “using Google Ads” and connects Google Ads through OAuth.
- **Then** Google Ads shows as connected, the OAuth authorization URL is opened, the edited prompt is preserved, Gmail remains available to connect, and Next is enabled.

## onboarding-prompt-connectors-005

Original test `A recommended Notion connection completes OAuth without losing the edited prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-connectors.test.tsx#L137).

- **Given** A user opens onboarding from a prompt link while Notion is recommended and OAuth is available.
- **When** The user edits the prompt to include “using Notion” and connects Notion through OAuth.
- **Then** Notion shows as connected, the OAuth authorization URL is opened, the edited prompt is preserved, Gmail remains available to connect, and Next is enabled.

## onboarding-prompt-connectors-006

Original test `A recommended GitHub connection completes OAuth without losing the edited prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-connectors.test.tsx#L137).

- **Given** A user opens onboarding from a prompt link while GitHub is recommended and OAuth is available.
- **When** The user edits the prompt to include “using GitHub” and connects GitHub through OAuth.
- **Then** GitHub shows as connected, the OAuth authorization URL is opened, the edited prompt is preserved, Gmail remains available to connect, and Next is enabled.
