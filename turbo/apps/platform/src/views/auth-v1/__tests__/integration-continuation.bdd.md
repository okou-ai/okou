# Integration continuation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integration-continuation.test.tsx](integration-continuation.test.tsx).

## integration-continuation-001

Original test `Organization selection preserves the complete supported continuation for Email`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens an Email settings link with signed message context with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-002

Original test `Organization selection preserves the complete supported continuation for AgentPhone`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens an AgentPhone settings link with signed account context and repeated parameters with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-003

Original test `Organization selection preserves the complete supported continuation for Slack OAuth completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a Slack OAuth completion link with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-004

Original test `Organization selection preserves the complete supported continuation for Teams OAuth completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a Teams OAuth completion link with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-005

Original test `Organization selection preserves the complete supported continuation for GitHub OAuth continuation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a GitHub OAuth continuation carrying installation context with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-006

Original test `Organization selection preserves the complete supported continuation for Slack`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a Slack setup link with repeated parameters with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-007

Original test `Organization selection preserves the complete supported continuation for Telegram`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a signed Telegram settings link with user information and repeated parameters with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-008

Original test `Organization selection preserves the complete supported continuation for Telegram with case-insensitive and trai…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a signed Telegram settings link with mixed-case routing and a trailing slash with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-009

Original test `Organization selection preserves the complete supported continuation for legacy Telegram`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a legacy signed Telegram connection link with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-010

Original test `Organization selection preserves the complete supported continuation for Discord`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a pending Discord settings link carrying public server context with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-011

Original test `Organization selection preserves the complete supported continuation for Discord install`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a connected Discord install link carrying public server context with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-012

Original test `Organization selection preserves the complete supported continuation for Teams`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a Teams settings link with conversation context and repeated parameters with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-013

Original test `Organization selection preserves the complete supported continuation for legacy pending Discord callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a legacy pending Discord callback carrying public server context with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-014

Original test `Organization selection preserves the complete supported continuation for legacy failed Discord callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a legacy Discord callback for a cancelled connection with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-015

Original test `Organization selection preserves the complete supported continuation for legacy connected Discord callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L101).

- **Given** A signed-in member has no active organization and opens a legacy connected Discord callback carrying public server context with a public URL fragment.
- **When** The app sends the member to choose an organization and presents the sign-in form for that continuation.
- **Then** Both the browser redirect and sign-in continuation retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-016

Original test `Sign-in and sign-up retain the complete supported continuation for Email`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens an Email settings link with signed message context with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-017

Original test `Sign-in and sign-up retain the complete supported continuation for AgentPhone`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens an AgentPhone settings link with signed account context and repeated parameters with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-018

Original test `Sign-in and sign-up retain the complete supported continuation for Slack OAuth completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a Slack OAuth completion link with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-019

Original test `Sign-in and sign-up retain the complete supported continuation for Teams OAuth completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a Teams OAuth completion link with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-020

Original test `Sign-in and sign-up retain the complete supported continuation for GitHub OAuth continuation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a GitHub OAuth continuation carrying installation context with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-021

Original test `Sign-in and sign-up retain the complete supported continuation for Slack`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a Slack setup link with repeated parameters with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-022

Original test `Sign-in and sign-up retain the complete supported continuation for Telegram`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a signed Telegram settings link with user information and repeated parameters with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-023

Original test `Sign-in and sign-up retain the complete supported continuation for Telegram with case-insensitive and trai…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a signed Telegram settings link with mixed-case routing and a trailing slash with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-024

Original test `Sign-in and sign-up retain the complete supported continuation for legacy Telegram`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a legacy signed Telegram connection link with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-025

Original test `Sign-in and sign-up retain the complete supported continuation for Discord`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a pending Discord settings link carrying public server context with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-026

Original test `Sign-in and sign-up retain the complete supported continuation for Discord install`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a connected Discord install link carrying public server context with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-027

Original test `Sign-in and sign-up retain the complete supported continuation for Teams`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a Teams settings link with conversation context and repeated parameters with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-028

Original test `Sign-in and sign-up retain the complete supported continuation for legacy pending Discord callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a legacy pending Discord callback carrying public server context with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-029

Original test `Sign-in and sign-up retain the complete supported continuation for legacy failed Discord callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a legacy Discord callback for a cancelled connection with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-030

Original test `Sign-in and sign-up retain the complete supported continuation for legacy connected Discord callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L133).

- **Given** A signed-out visitor opens a legacy connected Discord callback carrying public server context with a public URL fragment.
- **When** The visitor is directed to sign in and then follows the sign-up link.
- **Then** Both forms retain the original destination, all supported parameters in repeated-value order, and the public fragment.

## integration-continuation-031

Original test `Organization selection does not add a new return flow for /works`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L162).

- **Given** A signed-in member has no active organization.
- **When** The member opens /works.
- **Then** The organization selector opens without a dedicated return URL for that entry.

## integration-continuation-032

Original test `Organization selection does not add a new return flow for /works?discord=unknown`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L162).

- **Given** A signed-in member has no active organization.
- **When** The member opens /works with an unrecognized Discord status.
- **Then** The organization selector opens without a dedicated return URL for that entry.

## integration-continuation-033

Original test `Organization selection does not add a new return flow for /agents`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L162).

- **Given** A signed-in member has no active organization.
- **When** The member opens /agents.
- **Then** The organization selector opens without a dedicated return URL for that entry.

## integration-continuation-034

Original test `Discord proof is consumed before auth from /settings/discord?status=pending (signed in: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L188).

- **Given** A signed-out visitor opens a current Discord settings callback carrying a one-time approval proof.
- **When** The app consumes the approval during entry and directs the visitor to sign in.
- **Then** The return destination retains supported public callback context. The proof is absent from the redirect URL, browser storage, and logs.

## integration-continuation-035

Original test `Discord proof is consumed before auth from /works?discord=pending (signed in: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L188).

- **Given** A signed-out visitor opens a legacy Discord callback from Works carrying a one-time approval proof.
- **When** The app consumes the approval during entry and directs the visitor to sign in.
- **Then** The return destination retains supported public callback context. The proof is absent from the redirect URL, browser storage, and logs.

## integration-continuation-036

Original test `Discord proof is consumed before auth from /settings/discord?status=pending (signed in: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L188).

- **Given** The user is signed in and opens `/settings/discord?status=pending` with Discord approval data in the URL fragment.
- **When** The page processes the return before completing authentication routing.
- **Then** The user is routed to organization selection with the original settings path and guild ID as the continuation; the approval proof is absent from the URL, logs, and browser storage.

## integration-continuation-037

Original test `Discord proof is consumed before auth from /works?discord=pending (signed in: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L188).

- **Given** The user is signed in and opens `/works?discord=pending` with Discord approval data in the URL fragment.
- **When** The page processes the return before completing authentication routing.
- **Then** The user is routed to organization selection with the legacy works path and guild ID as the continuation; the approval proof is absent from the URL, logs, and browser storage.

## integration-continuation-038

Original test `A sanitized Discord return after login or actor change reports interrupted approval`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L225).

- **Given** A replacement user opens a sanitized pending Discord return after login or an actor change, and the Discord status reports an available but unconnected account.
- **When** The return page handles the pending authorization.
- **Then** It shows “Connection failed” and “This authorization was interrupted or refreshed,” provides a “Back to settings” link to `/works`, and clears the URL fragment.

## integration-continuation-039

Original test `An untrusted integration-looking return cannot bypass allowed-origin auth`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/integration-continuation.test.tsx#L263).

- **Given** A signed-out user reaches organization selection with a redirect URL pointing to an untrusted external host and an integration-looking Telegram path.
- **When** The auth page processes that redirect.
- **Then** The sign-in redirect is restricted to `https://app.okou.ai`; the untrusted destination is not used.
