# Clerk bootstrap

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [clerk-bootstrap.test.ts](clerk-bootstrap.test.ts).

## clerk-bootstrap-001

Original test `Okou production uses its own authentication URLs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/clerk-bootstrap.test.ts#L10).

- **Given** A user opens the Agents page on app.okou.ai.
- **When** Clerk starts.
- **Then** Clerk requests the production key and uses app.okou.ai for its sign-in, sign-up, and post-sign-out URLs.

## clerk-bootstrap-002

Original test `The app shell preserves the OAuth consent form origin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/clerk-bootstrap.test.ts#L29). · **intent review**

- **Given** The app shell's HTML is being used for an OAuth consent form.
- **When** The document's referrer policy is inspected.
- **Then** It is set to strict-origin-when-cross-origin, preserving the origin for cross-origin requests.

## clerk-bootstrap-003

Original test `App-started Clerk keeps browser navigation until a route owns it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/clerk-bootstrap.test.ts#L37).

- **Given** Clerk is started by the app before any app route owns navigation.
- **When** Clerk requests navigation to /sign-in through its push router.
- **Then** The request uses browser navigation to /sign-in, and the app has not installed a Clerk route router.

## clerk-bootstrap-004

Original test `The inline bootstrap owns the Clerk runtime`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/clerk-bootstrap.test.ts#L199).

- **Given** The inline bootstrap runs on app.okou.ai and the Clerk script loads.
- **When** The bootstrap publishes and starts the Clerk runtime.
- **Then** The published runtime contains the Clerk instance and its load promise; Clerk receives app.okou.ai sign-in, sign-up, and post-sign-out URLs.

## clerk-bootstrap-005

Original test `The inline Clerk bootstrap uses the current page sign-in URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/clerk-bootstrap.test.ts#L211).

- **Given** The inline Clerk bootstrap runs on each listed hostname: app.okou.ai, okou.ai, team.app.okou.ai, app.okou.ai.evil.example, and pr-30199-app.omby.ai.
- **When** Clerk runtime startup uses its sign-in URL.
- **Then** Each hostname's sign-in URL uses that same hostname, in the form https://{hostname}/sign-in.

## clerk-bootstrap-006

Original test `The inline bootstrap loads installed UI only for auth routes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/clerk-bootstrap.test.ts#L225).

- **Given** The inline Clerk bootstrap runs on app.okou.ai for app paths /agents, /v1/sign-in, /v1/sign-up, and /v1/sign-invader, or for auth paths /sign-in, /sign-in/tasks/choose-organization, /sign-up, /sign-up/tasks/choose-organization, and /oauth-consent.
- **When** The bootstrap handles the current path.
- **Then** It loads no installed UI script for the listed app and non-auth paths, and loads exactly one installed UI script for each listed auth path.

## clerk-bootstrap-007

Original test `The inline Clerk router delegates only while an app route owns it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/clerk-bootstrap.test.ts#L249).

- **Given** Clerk's inline bootstrap starts before an app route router is available.
- **When** Clerk pushes /sign-in/factor-one, then an app router is installed and Clerk pushes that path and replaces the path with /sign-in.
- **Then** The first push uses browser navigation; after the app router is installed, push and replace are delegated to it and no further browser navigation occurs.
