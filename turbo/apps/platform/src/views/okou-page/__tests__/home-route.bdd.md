# Home route

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [home-route.test.tsx](home-route.test.tsx).

## home-route-001

Original test `Home opens the current organization's default agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/home-route.test.tsx#L57).

- **Given** The current organization has a default agent, and another agent is also available.
- **When** The user opens the home page.
- **Then** Home navigates to the current organization's default agent chat, and the page title includes that agent's name.

## home-route-002

Original test `Home preserves a prompt handoff (My Okou=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/home-route.test.tsx#L79).

- **Given** A prompt handoff for “Draft a launch plan” is present, and the My Okou feature is disabled.
- **When** The user opens Home.
- **Then** The prompt appears in the message composer, and the URL navigates to the current organization's default agent chat.
- **Upstream change** `4e5707de` (#49556) makes My Okou permanent, so Home keeps a prompt handoff at `/` instead of forwarding it to the default agent's `/agents/<id>/chat` route, and removes this upstream test. Retire this scenario; prefilling the prompt on Home remains covered by home-route-003.

## home-route-003

Original test `Home preserves a prompt handoff (My Okou=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/home-route.test.tsx#L79).

- **Given** A prompt handoff for “Draft a launch plan” is present, and the My Okou feature is enabled.
- **When** The user opens Home.
- **Then** The prompt appears in the message composer, and the URL remains at /.
- **Upstream change** `4e5707de` (#49556) removes the My Okou feature switch and makes this behavior permanent; the upstream test is now `Home preserves a prompt handoff` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/home-route.test.tsx#L78)). Rebuild this scenario without any My Okou switch setup, expecting the prompt in the composer and the URL to stay at `/`.
