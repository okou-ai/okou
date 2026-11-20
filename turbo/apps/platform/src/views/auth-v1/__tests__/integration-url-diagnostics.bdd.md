# Integration url diagnostics

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integration-url-diagnostics.test.tsx](integration-url-diagnostics.test.tsx).

## integration-url-diagnostics-001

Original test `/settings/agentphone redacts actual auth diagnostics while keeping signed browser navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L50).

- **Given** A signed-out user opens `/settings/agentphone` with signed phone and agent parameters, repeated context values, and a public fragment.
- **When** Authentication diagnostics are produced during the sign-in redirect.
- **Then** Diagnostics omit phone, agent, timestamp, signature, and other fixture secrets, while retaining the repeated public context values; the browser continuation retains the signed URL.

## integration-url-diagnostics-002

Original test `/settings/telegram redacts actual auth diagnostics while keeping signed browser navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L50).

- **Given** A signed-out user opens `/settings/telegram` with signed Telegram parameters, repeated context values, and a public fragment.
- **When** Authentication diagnostics are produced during the sign-in redirect.
- **Then** Diagnostics omit Telegram user, timestamp, signature, and private name values while retaining repeated public context values; the browser continuation retains the signed URL.

## integration-url-diagnostics-003

Original test `/telegram/connect redacts actual auth diagnostics while keeping signed browser navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L50).

- **Given** A signed-out user opens the legacy `/telegram/connect` path with signed Telegram parameters and repeated context values.
- **When** Authentication diagnostics are produced during the sign-in redirect.
- **Then** Diagnostics omit Telegram user, timestamp, signature, and private name values while retaining repeated public context values; the browser continuation retains the signed URL.

## integration-url-diagnostics-004

Original test `/SETTINGS/telegram/ redacts actual auth diagnostics while keeping signed browser navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L50).

- **Given** A signed-out user opens the case-insensitive, trailing-slash path `/SETTINGS/telegram/` with signed Telegram parameters and repeated context values.
- **When** Authentication diagnostics are produced during the sign-in redirect.
- **Then** Diagnostics omit Telegram user, timestamp, signature, and private name values while retaining repeated public context values; the browser continuation retains the signed URL.

## integration-url-diagnostics-005

Original test `/connectors/slack/callback redacts actual auth diagnostics while keeping signed browser navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L50).

- **Given** A signed-out user opens the Slack OAuth callback path with private code and state values and repeated context values.
- **When** Authentication diagnostics are produced during the sign-in redirect.
- **Then** Diagnostics omit the private code and state while retaining repeated public context values; the browser continuation retains the callback URL.

## integration-url-diagnostics-006

Original test `/connectors/microsoft-365/callback redacts actual auth diagnostics while keeping signed browser navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L50).

- **Given** A signed-out user opens the Microsoft 365 OAuth callback path for Teams with private code and state values and repeated context values.
- **When** Authentication diagnostics are produced during the sign-in redirect.
- **Then** Diagnostics omit the private code and state while retaining repeated public context values; the browser continuation retains the callback URL.

## integration-url-diagnostics-007

Original test `/connectors/github/callback redacts actual auth diagnostics while keeping signed browser navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L50).

- **Given** A signed-out user opens the GitHub OAuth callback path with private code and state values and repeated context values.
- **When** Authentication diagnostics are produced during the sign-in redirect.
- **Then** Diagnostics omit the private code and state while retaining repeated public context values; the browser continuation retains the callback URL.

## integration-url-diagnostics-008

Original test `App redirects redact the emitted redirectUrl diagnostic too`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L69).

- **Given** A signed-out user opens a signed Telegram settings URL with private proof values.
- **When** The app redirects the user to sign-in and emits redirect diagnostics.
- **Then** Diagnostics omit the private proof values, while the browser redirect retains the original signed destination.

## integration-url-diagnostics-009

Original test `/settings/agentphone proofs stay out of PostHog URL, referrer and person properties`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L82).

- **Given** A signed-out user opens `/settings/agentphone` with signed parameters and a public fragment, and PostHog is initialized on the sign-in page.
- **When** PostHog processes an event containing current URL, referrer, attribution, and person-property URLs.
- **Then** Private phone, agent, timestamp, and signature values are absent from the processed event, but the signed browser continuation remains intact. Unrelated URLs and ordinary text are unchanged, and the original event is not mutated.

## integration-url-diagnostics-010

Original test `/settings/telegram proofs stay out of PostHog URL, referrer and person properties`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L82).

- **Given** A signed-out user opens `/settings/telegram` with signed parameters and a public fragment, and PostHog is initialized on the sign-in page.
- **When** PostHog processes an event containing current URL, referrer, attribution, and person-property URLs.
- **Then** Private Telegram user, timestamp, signature, and name values are absent from the processed event, but the signed browser continuation remains intact. Repeated context values and the public fragment are preserved; unrelated URLs and ordinary text are unchanged, and the original event is not mutated.

## integration-url-diagnostics-011

Original test `/telegram/connect proofs stay out of PostHog URL, referrer and person properties`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L82).

- **Given** A signed-out user opens the legacy `/telegram/connect` path with signed parameters and a public fragment, and PostHog is initialized on the sign-in page.
- **When** PostHog processes an event containing current URL, referrer, attribution, and person-property URLs.
- **Then** Private Telegram user, timestamp, signature, and name values are absent from the processed event, but the signed browser continuation remains intact. Repeated context values and the public fragment are preserved; unrelated URLs and ordinary text are unchanged, and the original event is not mutated.

## integration-url-diagnostics-012

Original test `/SETTINGS/telegram/ proofs stay out of PostHog URL, referrer and person properties`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L82).

- **Given** A signed-out user opens `/SETTINGS/telegram/` with signed parameters and a public fragment, and PostHog is initialized on the sign-in page.
- **When** PostHog processes an event containing current URL, referrer, attribution, and person-property URLs.
- **Then** Private Telegram user, timestamp, signature, and name values are absent from the processed event, but the signed browser continuation remains intact. Repeated context values and the public fragment are preserved; unrelated URLs and ordinary text are unchanged, and the original event is not mutated.

## integration-url-diagnostics-013

Original test `/connectors/slack/callback proofs stay out of PostHog URL, referrer and person properties`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L82).

- **Given** A signed-out user opens the Slack OAuth callback path with private code and state values and a public fragment, and PostHog is initialized on the sign-in page.
- **When** PostHog processes an event containing current URL, referrer, attribution, and person-property URLs.
- **Then** The private code and state are absent from the processed event, but the callback URL remains intact as the browser continuation. Repeated context values and the public fragment are preserved; unrelated URLs and ordinary text are unchanged, and the original event is not mutated.

## integration-url-diagnostics-014

Original test `/connectors/microsoft-365/callback proofs stay out of PostHog URL, referrer and person properties`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L82).

- **Given** A signed-out user opens the Microsoft 365 OAuth callback path for Teams with private code and state values and a public fragment, and PostHog is initialized on the sign-in page.
- **When** PostHog processes an event containing current URL, referrer, attribution, and person-property URLs.
- **Then** The private code and state are absent from the processed event, but the callback URL remains intact as the browser continuation. Repeated context values and the public fragment are preserved; unrelated URLs and ordinary text are unchanged, and the original event is not mutated.

## integration-url-diagnostics-015

Original test `/connectors/github/callback proofs stay out of PostHog URL, referrer and person properties`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-url-diagnostics.test.tsx#L82).

- **Given** A signed-out user opens the GitHub OAuth callback path with private code and state values and a public fragment, and PostHog is initialized on the sign-in page.
- **When** PostHog processes an event containing current URL, referrer, attribution, and person-property URLs.
- **Then** The private code and state are absent from the processed event, but the callback URL remains intact as the browser continuation. Repeated context values and the public fragment are preserved; unrelated URLs and ordinary text are unchanged, and the original event is not mutated.
