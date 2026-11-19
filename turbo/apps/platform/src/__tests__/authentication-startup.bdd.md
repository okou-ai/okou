# Authentication startup

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [authentication-startup.test.tsx](authentication-startup.test.tsx).

## authentication-startup-001

Original test `Authentication is ready before Platform content becomes interactive`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L66).

- **Given** Authentication is still loading when a user opens the Agents page.
- **When** The page starts and authentication later finishes.
- **Then** The startup skeleton is visible while the Agents heading and links are unavailable. After authentication, the skeleton is hidden and the Agents heading and links appear without a sign-in form.

## authentication-startup-002

Original test `The SharedWorker owns realtime`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L91). · **intent review**

- **Given** A user opens the Agents page with realtime using a SharedWorker.
- **When** The page becomes ready.
- **Then** The realtime transport records a subscription for the current user’s connector-permission updates and one authentication token request.

## authentication-startup-003

Original test `Foreground presence follows tab visibility without stopping realtime`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L111).

- **Given** A signed-in user is viewing the Agents page in a visible tab, with foreground presence active and realtime subscribed.
- **When** The tab becomes hidden and then visible again.
- **Then** Presence leaves while hidden and rejoins when visible; the realtime subscription remains active throughout.

## authentication-startup-004

Original test `setupPage does not report cancelled authentication startup as ready`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L149).

- **Given** Authentication is pending while setupPage is starting the Agents page.
- **When** The page's parent lifetime is cancelled before authentication finishes.
- **Then** setupPage rejects with the cancellation reason, and neither the Agents heading nor startup skeleton remains.

## authentication-startup-005

Original test `startPage does not report cancelled authentication startup as ready`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L149).

- **Given** Authentication is pending while startPage is starting the Agents page.
- **When** The page's parent lifetime is cancelled before authentication finishes.
- **Then** startPage rejects with the cancellation reason, and neither the Agents heading nor startup skeleton remains.

## authentication-startup-006

Original test `setupPage preserves a custom parent cancellation reason`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L179).

- **Given** setupPage is starting the Agents page with a parent lifetime that has a custom cancellation reason.
- **When** Startup observes that the parent lifetime is already cancelled.
- **Then** setupPage rejects with that exact custom reason and leaves no startup skeleton or Agents heading.

## authentication-startup-007

Original test `startPage preserves a custom parent cancellation reason`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L179).

- **Given** startPage is starting the Agents page with a parent lifetime that has a custom cancellation reason.
- **When** Startup observes that the parent lifetime is already cancelled.
- **Then** startPage rejects with that exact custom reason and leaves no startup skeleton or Agents heading.

## authentication-startup-008

Original test `Cancelled locale startup does not adopt a replacement lifetime`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L205).

- **Given** startPage is loading the French locale when its page lifetime is cancelled and replaced by a new lifetime.
- **When** The suspended locale request completes.
- **Then** Startup rejects with the original lifetime's cancellation reason; the replacement lifetime remains active, the locale request is aborted, and no skeleton or Agents heading remains.

## authentication-startup-009

Original test `setupPage cancels a child app without disposing the case document or external mocks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L241).

- **Given** setupPage is loading the French locale in a child app runtime.
- **When** The child app is cancelled and locale loading completes, then a fresh child app starts.
- **Then** The cancelled startup rejects with its cancellation reason and aborts the locale request; the fresh startup still displays the Agents page, without disposing the case document or external mocks.

## authentication-startup-010

Original test `startPage cancels a child app without disposing the case document or external mocks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L241).

- **Given** startPage is loading the French locale in a child app runtime.
- **When** The child app is cancelled and locale loading completes, then a fresh child app starts.
- **Then** The cancelled startup rejects with its cancellation reason and aborts the locale request; the fresh startup still displays the Agents page, without disposing the case document or external mocks.

## authentication-startup-011

Original test `Authentication startup is reused without a duplicate load`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L284).

- **Given** Clerk has already begun loading before the user opens the Agents page.
- **When** The page starts and authentication finishes loading.
- **Then** The Agents page appears using the existing Clerk startup, with exactly one Clerk load and no duplicate resource request or UI request.

## authentication-startup-012

Original test `A Clerk core failure reports the error without initializing an auth form`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L310).

- **Given** Clerk's core resource is unavailable while a user opens the sign-in page without an authenticated user.
- **When** The page starts.
- **Then** The page reports the Clerk error, shows an alert with “Oops! Something went sideways,” hides the startup skeleton, and does not initialize the sign-in form or call Clerk load.

## authentication-startup-013

Original test `Startup onboarding follows the current account and workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L341).

- **Given** The user opens the Agents page while onboarding status is being fetched, and the current workspace becomes org_current before that response completes.
- **When** The onboarding response says onboarding is needed but the account has an organization.
- **Then** The Agents page appears, identity is requested once, and the onboarding prompt does not appear.

## authentication-startup-014

Original test `Okou production uses production authentication`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L383).

- **Given** A user opens the sign-in page on app.okou.ai.
- **When** Authentication starts.
- **Then** Clerk requests the production key, loads with the app.okou.ai sign-in and sign-up URLs, requests the installed UI script, and displays the sign-in form.

## authentication-startup-015

Original test `Authorized preview hosts use preview authentication`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L403).

- **Given** A user opens the sign-in page on the authorized preview host pr-30199-app.omby.ai.
- **When** Authentication starts.
- **Then** The sign-in form appears and Clerk requests the preview key.

## authentication-startup-016

Original test `Okou lookalike host okou.ai.evil.example does not use production authentication`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L417).

- **Given** A user opens the sign-in page on the lookalike host okou.ai.evil.example.
- **When** Authentication starts.
- **Then** The sign-in form appears and Clerk requests the preview key rather than the production key.

## authentication-startup-017

Original test `Okou lookalike host app.okou.ai.evil.example does not use production authentication`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L417).

- **Given** A user opens the sign-in page on the lookalike host app.okou.ai.evil.example.
- **When** Authentication starts.
- **Then** The sign-in form appears and Clerk requests the preview key rather than the production key.

## authentication-startup-018

Original test `Workspace switching navigates home when the active organization changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/authentication-startup.test.tsx#L434).

- **Given** A user is viewing the Agents page with an active organization.
- **When** The active organization changes to Beta.
- **Then** The browser navigates to the home path (/).
