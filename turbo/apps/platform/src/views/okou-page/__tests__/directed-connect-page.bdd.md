# Directed connect page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [directed-connect-page.test.tsx](directed-connect-page.test.tsx).

## directed-connect-page-001

Original test `Connect and authorize a manual MCP connector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L435).

- **Given** An agent needs a manual-auth DeepWiki MCP connector, which requires a secret.
- **When** The user connects it and saves the secret.
- **Then** The secret is submitted and the agent receives an empty-permission grant for the connector. DeepWiki is shown as connected.

## directed-connect-page-002

Original test `Let an MCP server discover authentication from a directed connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L515).

- **Given** An agent needs an automatic-auth Discovery MCP connector with no configured fields.
- **When** The user connects and continues through the prompt to check how the server authenticates.
- **Then** The browser opens the server's authorization URL. The agent receives an empty-permission grant and Discovery MCP is shown as connected.

## directed-connect-page-003

Original test `Reconnect the exact manual custom-connector account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L603).

- **Given** The Acme Configured API manual connector already has a saved account with its required secret configured.
- **When** The user reconnects and saves a replacement secret.
- **Then** The replacement secret is submitted for the existing account, and the secret field is identified as required and configured.

## directed-connect-page-004

Original test `Connect and authorize a custom OAuth connector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L676).

- **Given** An agent needs the Acme OAuth custom connector.
- **When** The user connects and continues through the authorization dialog.
- **Then** The browser opens Acme's authorization URL, the agent receives an empty-permission grant, and Acme OAuth is shown as connected with the dialog closed.

## directed-connect-page-005

Original test `Reconnect the exact custom OAuth account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L773). · **intent review**

- **Given** Acme OAuth Reconnect has a saved OAuth account and a second, different account is returned by the authorization start.
- **When** The user reconnects and continues.
- **Then** The browser opens the reconnect authorization URL, and the agent receives an empty-permission grant despite the returned account ID differing from the saved account. The test does not assert which account is ultimately connected.

## directed-connect-page-006

Original test `Preserve existing agent permissions after connecting custom OAuth`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L870).

- **Given** Acme Permissioned OAuth has an agent grant containing the permission messages:send-as-user.
- **When** The user connects the OAuth connector while the existing grant is fetched after authorization starts.
- **Then** The connector is shown as connected, and no agent-grant update is made, preserving the existing permission.

## directed-connect-page-007

Original test `Start public OAuth from a directed connection link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L983).

- **Given** The user opens a directed connection link for public GitHub with an agent ID; GitHub offers one OAuth method.
- **When** The user starts connecting GitHub.
- **Then** The browser opens GitHub's authorization URL, and the OAuth start includes the directed agent ID and requests that the agent be authorized.

## directed-connect-page-008

Original test `Connect a no-auth connector and continue the originating chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1045).

- **Given** The user opens a directed Stripe connection link from a chat, with an agent ID and callback prompt; Stripe requires no authentication.
- **When** The user connects Stripe.
- **Then** Stripe connects once, the originating chat receives the callback prompt, and no visible agent-authorization update is made. No connection dialog remains open.

## directed-connect-page-009

Original test `Complete OpenID and continue the originating chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1126).

- **Given** The user opens a directed Steam connection link from a chat, with an agent ID and callback prompt; Steam uses OpenID.
- **When** The user completes the connection.
- **Then** The browser opens Steam's OpenID authorization URL, Steam is shown as connected, and the originating chat receives the callback prompt.

## directed-connect-page-010

Original test `Show the saved builtin account's configuration_incomplete reason in the connect dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1182).

- **Given** The saved public GitHub API-token account requires reconnection because its setup is incomplete and its API token is missing.
- **When** The user opens the connection dialog.
- **Then** The dialog says “Setup incomplete,” does not say “Connected,” and shows the GitHub token field.

## directed-connect-page-011

Original test `Show the saved builtin account's configuration_invalid reason in the connect dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1182).

- **Given** The saved public GitHub API-token account requires reconnection because its configuration is invalid and its API token is missing.
- **When** The user opens the connection dialog.
- **Then** The dialog says “Account status unavailable,” does not say “Connected,” and shows the GitHub token field.

## directed-connect-page-012

Original test `Reconnect the expired public OAuth account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1261).

- **Given** The saved public GitHub OAuth account has expired, while an alternate API-token method is available.
- **When** The user chooses to reconnect GitHub.
- **Then** The dialog says “Connection expired” and does not show the alternate token field. OAuth reconnect starts for the exact saved account, with the directed agent ID and authorization requested; after that account reconnects, the dialog closes.

## directed-connect-page-013

Original test `Reconnect the exact account and continue the originating chat only after success`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1395).

- **Given** The user opens a reconnect link for the non-default saved Work Axiom API-token account from a chat, with a callback prompt.
- **When** The user enters the token and saves the reconnection.
- **Then** No chat continuation occurs before success. The reconnect request targets the specified account, and the callback prompt is sent only after the account is successfully reconnected.

## directed-connect-page-014

Original test `Connect a manual grant and continue the originating chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1473).

- **Given** The user opens a directed Axiom manual-token connection link from a chat, with an agent ID and callback prompt.
- **When** The user enters a token and saves it while the chat callback is still pending.
- **Then** The token is submitted, Axiom is shown as connected while the dialog remains open, and the originating chat receives the callback prompt. After the callback completes, the dialog closes.
