# Agent chat avatar texture

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [agent-chat-avatar-texture.test.tsx](agent-chat-avatar-texture.test.tsx).

## agent-chat-avatar-texture-001

Original test `Sit the greeting avatar on the frame's bottom edge once a texture is behind it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-chat-avatar-texture.test.tsx#L140). · **intent review**

- **Given** A chat greeting uses a composed avatar with a blue sweater on the greeting surface.
- **When** The greeting avatar is rendered with a texture.
- **Then** The texture is an allowed match and the artwork is scaled so its lower edge aligns with the frame’s bottom edge.

## agent-chat-avatar-texture-002

Original test `Keep an agent that cannot take a texture untextured and centred`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-chat-avatar-texture.test.tsx#L158). · **intent review**

- **Given** A chat greeting uses an uploaded avatar image without composer colors.
- **When** The greeting is rendered.
- **Then** The avatar has no texture or separate artwork and remains the uploaded image.

## agent-chat-avatar-texture-003

Original test `Keep every other avatar surface untextured`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-chat-avatar-texture.test.tsx#L182). · **intent review**

- **Given** A chat greeting uses a composed avatar, and the same avatar appears on other surfaces.
- **When** The chat page is rendered.
- **Then** Surfaces outside the greeting remain untextured and their artwork is not anchored to the bottom edge.
- **Upstream change** `4e5707de` (#49556) retires other agents' chat pages (`/agents/<id>/chat` now redirects to My Okou's chat at `/`) and the sidebar's pinned agent avatars, and removes this upstream test. Retire this scenario; the retained chat greeting avatar is covered by `agent-chat-avatar-texture-006`.

## agent-chat-avatar-texture-004

Original test `Give the organization default agent its own texture`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-chat-avatar-texture.test.tsx#L203). · **intent review**

- **Given** A chat greeting uses the organization’s default agent avatar.
- **When** The greeting is rendered with default-agent texture support.
- **Then** The drawn avatar image is shown with the sole default-agent texture.

## agent-chat-avatar-texture-005

Original test `Draw the organization default agent with the animated Okou avatar once it is on`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-chat-avatar-texture.test.tsx#L229). · **intent review**

- **Given** The organization’s default agent avatar is rendered outside My Okou with the animated-avatar feature enabled.
- **When** The chat greeting is rendered.
- **Then** The default artwork is replaced by the animated Okou avatar.
- **Upstream change** `4e5707de` (#49556) removes the chat greeting outside My Okou (`/agents/<id>/chat` now redirects to `/`, whose greeting always draws Okou's animated avatar) and removes this upstream test. Retire this scenario; the retained animated greeting is covered by `agent-chat-avatar-texture-006` (upstream `Greet with Okou's own animated avatar under My Okou`, [Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/agent-chat-avatar-texture.test.tsx#L21)).

## agent-chat-avatar-texture-006

Original test `Greet with Okou's own animated avatar under My Okou`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-chat-avatar-texture.test.tsx#L250). · **intent review**

- **Given** My Okou is enabled for the organization’s default agent.
- **When** The chat greeting is rendered.
- **Then** The greeting uses Okou’s animated avatar.
