# Preview bypass cookie

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [preview-bypass-cookie.test.ts](preview-bypass-cookie.test.ts).

## preview-bypass-cookie-001

Original test `A protected preview link creates a secure cookie on its preview host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/preview-bypass-cookie.test.ts#L9). · **intent review**

- **Given** A user opens an HTTPS preview link on pr-123-app.omby.ai containing a preview bypass credential.
- **When** The link is processed to build a cookie.
- **Then** A cookie is produced with the credential, Path=/, a one-hour lifetime, and SameSite=Lax; it is marked Secure.

## preview-bypass-cookie-002

Original test `A preview credential is written for the current preview host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/preview-bypass-cookie.test.ts#L21). · **intent review**

- **Given** A user opens an HTTPS preview link on staging-app.omby.ai with the encoded credential preview%20secret.
- **When** The link is processed and the cookie is written.
- **Then** The write succeeds and the cookie writer receives the credential in its encoded form, with Path=/, a one-hour lifetime, SameSite=Lax, and Secure.

## preview-bypass-cookie-003

Original test `A protected preview link works in local HTTP development`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/preview-bypass-cookie.test.ts#L39). · **intent review**

- **Given** A user opens a local HTTP development link on localhost containing a preview bypass credential.
- **When** The link is processed to build a cookie.
- **Then** A cookie is produced with the credential, Path=/, a one-hour lifetime, and SameSite=Lax, without the Secure attribute.

## preview-bypass-cookie-004

Original test `A preview credential reaches its matching API host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/preview-bypass-cookie.test.ts#L51). · **intent review**

- **Given** A preview credential is available on pr-22085-app.omby.ai, and the API URL is https://pr-22085-api.vm6.ai/api/chat/events.
- **When** The credential is appended to the API URL.
- **Then** The matching API URL receives the bypass credential as a query parameter, decoded as “preview secret”.

## preview-bypass-cookie-005

Original test `A preview credential does not reach a lookalike API host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/preview-bypass-cookie.test.ts#L67). · **intent review**

- **Given** A preview credential is available on pr-22085-app.omby.ai, and the API URL is https://pr-22085-api.vm6.ai.evil.example/api/chat/events.
- **When** The credential is appended to the API URL.
- **Then** The lookalike API host does not receive a bypass credential query parameter.

## preview-bypass-cookie-006

Original test `A preview credential does not reach another preview API host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/preview-bypass-cookie.test.ts#L85). · **intent review**

- **Given** A preview credential is available on pr-22085-app.omby.ai, and the API URL is for preview pr-22086 at pr-22086-api.vm6.ai.
- **When** The credential is appended to the API URL.
- **Then** The other preview API host does not receive a bypass credential query parameter.

## preview-bypass-cookie-007

Original test `A preview credential does not reach the matching WWW host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/preview-bypass-cookie.test.ts#L103). · **intent review**

- **Given** A preview credential is available on pr-22085-app.omby.ai, and the WWW URL is https://pr-22085-www.vm6.ai/connector/success with a stale bypass query parameter.
- **When** The credential is appended to the URL.
- **Then** The matching WWW host has no bypass credential query parameter, including the stale one.
