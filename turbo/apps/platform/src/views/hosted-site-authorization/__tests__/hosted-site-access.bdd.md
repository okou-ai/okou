# Hosted site access

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [hosted-site-access.test.tsx](hosted-site-access.test.tsx).

## hosted-site-access-001

Original test `signed-out website visitors can sign in without being forced away from the access page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L26).

- **Given** A visitor is signed out and opens the website access page for a protected website path.
- **When** They view the page.
- **Then** The page says “Verify access to this website,” explains that they should sign in with an account that can access the website, and uses that heading as the document title. “Sign in” starts authorization and returns to the original website path; “Back to Okou” links to the home page.

## hosted-site-access-002

Original test `an incomplete authorization can be retried without claiming the signed-in visitor was denied`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L44).

- **Given** A signed-in visitor opens the access page after an incomplete authorization for a protected website path.
- **When** They view the page.
- **Then** The page says “Verify access to this website” and invites them to continue verification with their current account. “Continue” starts authorization for the original path, and “Switch account” is enabled; the page does not claim they were denied access.

## hosted-site-access-003

Original test `expired website sessions offer a fresh authorization for the original path`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L56).

- **Given** A visitor opens the access page after their website session expired, for a website path ending in /report?view=summary.
- **When** They view the page.
- **Then** The page says “Verify your access again,” and that text is also the document title. “Continue” starts a fresh authorization returning to /report?view=summary, and “Switch account” is enabled.

## hosted-site-access-004

Original test `a denied website offers account switching and access guidance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L66).

- **Given** A visitor opens the access page after being denied access to a website.
- **When** They view the page.
- **Then** The page says “You can’t view this website,” and that text is also the document title. “Switch account” is enabled, and the page advises asking the person who shared the link to check access.

## hosted-site-access-005

Original test `dependency failures explain temporary website unavailability`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L78).

- **Given** A visitor opens the access page because a dependency for the website is unavailable.
- **When** They view the page.
- **Then** The page says “This website is temporarily unavailable,” and that text is also the document title.

## hosted-site-access-006

Original test `an invalid recovery target https://demo.okou.app.attacker.example/report cannot become a sign-in destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L94).

- **Given** A signed-out visitor opens an expired-session access page whose recovery target is https://demo.okou.app.attacker.example/report.
- **When** They view the page.
- **Then** The page says “Verify your access again,” and neither displayed link uses the invalid target as its destination; both link to the home page.

## hosted-site-access-007

Original test `an invalid recovery target https://app.okou.ai/ cannot become a sign-in destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L94).

- **Given** A signed-out visitor opens an expired-session access page whose recovery target is https://app.okou.ai/.
- **When** They view the page.
- **Then** The page says “Verify your access again,” and neither displayed link uses the invalid target as its destination; both link to the home page.

## hosted-site-access-008

Original test `an invalid recovery target https://demo.okou.app/\attacker.example/report cannot become a sign-in destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L94).

- **Given** A signed-out visitor opens an expired-session access page whose recovery target is https://demo.okou.app/\attacker.example/report.
- **When** They view the page.
- **Then** The page says “Verify your access again,” and neither displayed link uses the invalid target as its destination; both link to the home page.

## hosted-site-access-009

Original test `an invalid recovery target https://pv-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.okou.app/ cannot become a sign-in destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L94).

- **Given** A signed-out visitor opens the expired-access page with the invalid recovery target `https://pv-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.okou.app/`.
- **When** The page loads.
- **Then** The page offers to verify access again, but neither link uses that target as a sign-in destination; both links point to `/`.

## hosted-site-access-010

Original test `an invalid recovery target https://demo.okou.app/.okou/auth/callback?code=secret cannot become a sign-in destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-access.test.tsx#L94).

- **Given** A signed-out visitor opens the expired-access page with the invalid recovery target `https://demo.okou.app/.okou/auth/callback?code=secret`.
- **When** The page loads.
- **Then** The page offers to verify access again, but neither link uses that target as a sign-in destination; both links point to `/`.
