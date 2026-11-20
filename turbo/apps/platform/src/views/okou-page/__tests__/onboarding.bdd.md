# Onboarding

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding.test.tsx](onboarding.test.tsx).

## onboarding-001

Original test `A new user keeps prompt and connector context through onboarding (My Okou=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/onboarding.test.tsx#L19).

- **Given** A new user needs onboarding and arrives with a prompt, GitHub connector context, and a presentation source parameter; My Okou is disabled.
- **When** They open the home page.
- **Then** The onboarding page appears with the prompt prefilled, and the URL retains the prompt, connector, and source context.
- **Upstream change** `4e5707de` (#49556) removes the My Okou feature switch, so My Okou can no longer be disabled; the onboarding redirect and preserved context are unchanged, and the upstream test is now `A new user keeps prompt and connector context through onboarding` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/onboarding.test.tsx#L18)). Rebuild this scenario without the My Okou condition.

## onboarding-002

Original test `A new user keeps prompt and connector context through onboarding (My Okou=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/onboarding.test.tsx#L19).

- **Given** A new user needs onboarding and arrives with a prompt, GitHub connector context, and a presentation source parameter; My Okou is enabled.
- **When** They open the home page.
- **Then** The onboarding page appears with the prompt prefilled, and the URL retains the prompt, connector, and source context.

## onboarding-003

Original test `A Slack success return remains visible before onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/onboarding.test.tsx#L44).

- **Given** A new user needs onboarding and returns from Slack authorization with a successful connection status and workspace name.
- **When** They open the Slack settings return URL.
- **Then** The Slack-connected heading remains visible, and the page does not redirect to onboarding.

## onboarding-004

Original test `A Slack connection page remains visible before onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/onboarding.test.tsx#L59).

- **Given** A new user needs onboarding and opens Slack settings for a workspace where Slack is not connected and the user is not an admin.
- **When** The Slack connection page loads.
- **Then** The “Connect to Slack” heading remains visible, and the page does not redirect to onboarding.

## onboarding-005

Original test `An unsuccessful Slack return remains visible before onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/onboarding.test.tsx#L80).

- **Given** A new user needs onboarding and returns from Slack authorization with access denied.
- **When** They open the Slack settings return URL.
- **Then** The authorization-not-completed message is visible, and the URL resolves to the Slack settings path rather than onboarding.
