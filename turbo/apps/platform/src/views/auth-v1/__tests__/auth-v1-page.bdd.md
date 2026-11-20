# Auth v1 page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [auth-v1-page.test.tsx](auth-v1-page.test.tsx).

## auth-v1-page-001

Original test `An unavailable invitation link still opens Clerk signup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L21).

- **Given** A signed-out user opens a sign-up page with an invitation code whose referral link is unavailable.
- **When** The invitation lookup returns 404.
- **Then** Clerk signup still opens and the page title is “Sign up | Okou”.

## auth-v1-page-002

Original test `Invitation links persist a signed host-only cookie and preserve the signup return`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L35).

- **Given** A signed-out user opens sign-up with invitation code A7K2P9 and a return URL of https://app.okou.ai/onboarding?source=friend, followed by #start.
- **When** The invitation lookup succeeds and returns a signed visit token.
- **Then** The code is looked up in lowercase, a signed host-only cookie is written for 30 days with Path=/, SameSite=Lax, and Secure, and the signup return URL is preserved. The referral query is removed while the redirect query and #start remain.

## auth-v1-page-003

Original test `An invitation survives Clerk steps and is consumed after the authenticated registered result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L61).

- **Given** A signed-out user starts signup with an invitation whose lookup returns a signed visit token; Clerk proceeds to email verification, then the user returns as authenticated with registration status registered.
- **When** The user navigates through the verification step and returns in a new authenticated document on the same app origin.
- **Then** The invitation cookie remains through the Clerk step, the registration request receives the signed token, and the cookie is consumed after the registered result.

## auth-v1-page-004

Original test `An invitation survives Clerk steps and is consumed after the authenticated ineligible result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L61).

- **Given** A signed-out user starts signup with an invitation whose lookup returns a signed visit token; Clerk proceeds to email verification, then the user returns as authenticated with registration status ineligible.
- **When** The user navigates through the verification step and returns in a new authenticated document on the same app origin.
- **Then** The invitation cookie remains through the Clerk step, the registration request receives the signed token, and the cookie is consumed after the ineligible result.

## auth-v1-page-005

Original test `The hosted sign-in form renders with Google One Tap on the base route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L137).

- **Given** A signed-out user visits the base sign-in route with reduced-motion preference off.
- **When** The hosted auth page loads.
- **Then** A Clerk sign-in form and Google One Tap render with sign-in and sign-up URLs set to /sign-in and /sign-up and both forced to return to https://app.okou.ai. The Okou wordmark, “Sign in | Okou” title, and hidden bootstrap skeleton are present, and the Clerk UI resource is requested.

## auth-v1-page-006

Original test `Nested sign-in task paths stay on the hosted sign-in form`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L170).

- **Given** A signed-out user visits /sign-in/tasks/choose-organization.
- **When** The hosted auth page loads on this nested task route.
- **Then** The hosted sign-in form remains at /sign-in, Google One Tap is absent, and the title is “Sign in | Okou”.

## auth-v1-page-007

Original test `Clerk sign-in steps use app history and keep every query value`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L178).

- **Given** A signed-out user is on /sign-in?screen=identifier#start.
- **When** Clerk navigates to /sign-in/factor-one?strategy=password&strategy=passkey#challenge, then the user goes back in browser history.
- **Then** The sign-in step uses app history without assigning a new document; both strategy values and the challenge hash are retained. Back restores /sign-in with ?screen=identifier and #start, and the sign-in form remains visible during the step.

## auth-v1-page-008

Original test `Clerk navigation to a non-Auth V1 path loads a new document`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L205).

- **Given** A signed-out user is on /sign-in.
- **When** Clerk navigates to the non-hosted-auth path /sign-in-token.
- **Then** The browser is assigned https://app.okou.ai/sign-in-token to load a new document, while the current document remains at /sign-in.

## auth-v1-page-009

Original test `Clerk cross-origin navigation stays browser-owned`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L218).

- **Given** A signed-out user is on /sign-in.
- **When** Clerk navigates to https://www.okou.ai/sign-in?locale=ja-JP.
- **Then** Navigation remains browser-owned and assigns that exact cross-origin URL; the current document remains at /sign-in.

## auth-v1-page-010

Original test `The hosted sign-up form renders with an allowed redirect URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L233).

- **Given** A signed-out user opens sign-up with the allowed presentation onboarding redirect URL.
- **When** The hosted auth page loads.
- **Then** A path-routed Clerk signup form uses /sign-up and the allowed URL as both fallback and forced redirect, with no configured signup URL. Its sign-in URL is /sign-in with the same redirect. Google One Tap is absent, the title is “Sign up | Okou”, and Clerk provider configuration labels the action “Sign up” with app sign-in and signup URLs.

## auth-v1-page-011

Original test `A trusted Okou destination brands the hosted sign-in`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L270).

- **Given** A signed-out user opens sign-in with trusted redirect https://app.okou.ai/_/skeleton and reduced-motion preference off.
- **When** The hosted auth page loads.
- **Then** The sign-in form and Google One Tap use that trusted forced redirect, and the sign-up URL retains it as a redirect query. The title is “Sign in | Okou” and the Okou brand link points to /.

## auth-v1-page-012

Original test `Okou auth intent survives Clerk moving the redirect into the hash`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L293).

- **Given** A signed-out user opens sign-up with redirect intent https://app.okou.ai/onboarding?source=auth-switch inside the URL hash.
- **When** The hosted auth page loads.
- **Then** The sign-in URL preserves the encoded redirect intent, the signup form forces that redirect, the title is “Sign up | Okou”, and the Okou brand link points to /.

## auth-v1-page-013

Original test `An untrusted redirect URL returns to the default app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L308).

- **Given** A signed-out user opens sign-in with untrusted redirect https://app.okou.ai.evil.example/sign-in.
- **When** The hosted auth page loads.
- **Then** The sign-in form forces the default app destination https://app.okou.ai instead of the untrusted URL.

## auth-v1-page-014

Original test `Default sign-up redirects do not propagate acquisition parameters`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L321).

- **Given** A signed-out user opens /sign-up/verify-email-address with acquisition parameters gclid and utm_campaign and a hash-based verification step.
- **When** The hosted auth page loads without an explicit redirect URL.
- **Then** The forced signup redirect is the default https://app.okou.ai/onboarding and does not include the acquisition parameters.

## auth-v1-page-015

Original test `Sign-up redirects to sibling origins of the current host are kept`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L332).

- **Given** A signed-out user on app.okou.ai opens signup with redirect https://www.okou.ai/connector/success?vm0_theme=light.
- **When** The hosted auth page loads on the verification-address path.
- **Then** The forced signup redirect retains the sibling-origin URL and its query value.

## auth-v1-page-016

Original test `Sign-up redirects to other environments fall back to onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L343).

- **Given** A signed-out user opens signup with redirect https://staging-www.omby.ai/connector/success.
- **When** The hosted auth page loads on the verification-address path.
- **Then** The forced signup redirect falls back to https://app.okou.ai/onboarding.

## auth-v1-page-017

Original test `Hosted auth reaches the brand home and the theme toggle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-page.test.tsx#L353).

- **Given** A signed-out user visits /sign-up/continue with reduced-motion preference off.
- **When** The hosted auth page loads.
- **Then** The Okou wordmark links to the brand home, has no crossorigin attribute, and the theme toggle is visible.
