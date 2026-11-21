# Connectors auth methods

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-auth-methods.test.tsx](connectors-auth-methods.test.tsx).

## connectors-auth-methods-001

Original test `Connect a builtin Automatic method resolving to none`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L164).

- **Given** A public connector offers a built-in Automatic method that resolves without authorization.
- **When** I choose Connect and skip naming the new account.
- **Then** The account connects without requesting an OAuth receipt or opening an authorization page, and the connector is shown as used by the Default agent.

## connectors-auth-methods-002

Original test `Connect a builtin Automatic method resolving to oauth`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L164).

- **Given** A public connector offers a built-in Automatic method that resolves to OAuth authorization.
- **When** I choose Connect and skip naming the new account.
- **Then** The authorization page opens, and after authorization the connector is shown as used by the Default agent.

## connectors-auth-methods-003

Original test `Show Mercury disclosures before connecting an account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L292).

- **Given** The Mercury connector is listed in the public catalog.
- **When** I view its catalog card and open its connection dialog.
- **Then** Both show a Mercury link to https://mercury.com and the disclosure that Mercury is not an FDIC-insured bank and that banking services are provided through Choice Financial Group and Column N.A., Members FDIC.

## connectors-auth-methods-004

Original test `Add an AWS account through external-code authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L335).

- **Given** No AWS account is connected and a Research Agent is available.
- **When** I start AWS sign-in, open the provider sign-in page, enter an authorization code, and complete the flow.
- **Then** The dialog notes that the temporary AWS connector expires after up to 12 hours. The AWS account connects, can be left unnamed, and is shown as used by the Research Agent.

## connectors-auth-methods-005

Original test `Add an account through OpenID`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L417).

- **Given** A public Partner Steam connector offers an OpenID method and two agents are available.
- **When** I connect the account and skip naming it after authorization.
- **Then** The catalog icon is displayed, the OpenID authorization page opens, and the connected connector is shown as used by two agents.

## connectors-auth-methods-006

Original test `Choose a credential-free method`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L500).

- **Given** Public Stripe offers both OAuth and a credential-free public-catalog method.
- **When** I open its connection dialog and enable the public catalog method.
- **Then** The dialog describes the public catalog and enabling its data. The connector connects using the credential-free method.

## connectors-auth-methods-007

Original test `Authorize visible agents only for the first manual account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L544).

- **Given** No Public Axiom account is connected, and Nova and Research Agent are available.
- **When** I add a manual-token account, revoke Nova's access, then add a second manual-token account from account management.
- **Then** The first account initially authorizes the visible agents; the second does not reauthorize Nova. After adding it, only Research Agent has access, and Nova remains unauthorized.

## connectors-auth-methods-008

Original test `Connect through device authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L663).

- **Given** Base44 offers device authorization and two agents are available.
- **When** I start connection, open the provider approval page, and the authorization completes.
- **Then** A device code is shown in a single approval dialog. The account connects and, after skipping its name, Base44 is shown as used by two agents.

## connectors-auth-methods-009

Original test `Reject device-auth completion when account setup is configuration_invalid`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L751).

- **Given** Base44 offers device authorization, but the completed account requires additional configuration.
- **When** I complete device authorization and inspect the connection result.
- **Then** An alert says the account needs additional setup and directs me to review its connector settings and try again. No account-naming dialog appears, and Research is not authorized.

## connectors-auth-methods-010

Original test `Reject external-code completion when account setup is configuration_invalid`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L751).

- **Given** AWS offers external-code authorization, but the completed account requires additional configuration.
- **When** I enter the external code and complete the connection.
- **Then** An alert says the account needs additional setup and directs me to review its connector settings and try again. No account-naming dialog appears, and Research is not authorized.

## connectors-auth-methods-011

Original test `Enable a connector that needs no credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L867).

- **Given** Public Stripe requires no credentials, and Nova and Research Agent are available.
- **When** I connect the connector and skip naming the account.
- **Then** Public Stripe is enabled successfully, shows as connected and used by two agents, and no browser window is opened.

## connectors-auth-methods-012

Original test `Follow provider-authored external-code instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L925).

- **Given** PlayStation's external-code method provides provider-authored instructions with a PlayStation link.
- **When** I start PlayStation sign-in.
- **Then** The dialog shows the provider instruction link, an Open PlayStation sign-in action, and a code field.

## connectors-auth-methods-013

Original test `Complete OAuth only after the current attempt succeeds`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L974).

- **Given** Public Stripe offers OAuth and device authorization, and no Stripe account is connected.
- **When** I start OAuth, close the authorization window before the current attempt completes, then start another attempt and complete that one.
- **Then** The first attempt does not connect the account or authorize Research, and the connection action becomes available again. Only after the second attempt succeeds does the dialog close, Stripe show as connected, and access show as used by two agents.

## connectors-auth-methods-014

Original test `Save a name for the exact newly added manual account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L1175).

- **Given** A newly added manual Ahrefs account is awaiting a name.
- **When** I enter “Work” and save the name.
- **Then** The exact newly added account is renamed to “Work,” and its naming dialog closes.

## connectors-auth-methods-015

Original test `Keep the new account name after a failed save and close on retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L1189).

- **Given** A newly added manual Ahrefs account is awaiting a name.
- **When** I enter “ Work ”, attempt to save, then retry after the first save fails.
- **Then** The failed save displays “Rename failed” and keeps the entered text and dialog open. The retry saves the trimmed name “Work” for that account and closes the dialog.

## connectors-auth-methods-016

Original test `Keep a replacement account name prompt when an earlier save completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L1220).

- **Given** A first Ahrefs account name save is pending, and I have skipped its prompt and opened a second account's naming prompt with the draft “Second account draft.”
- **When** The first save completes while the second prompt is open.
- **Then** The first account is named “First account”; the second prompt remains open with its draft unchanged, and its Save action becomes enabled.

## connectors-auth-methods-017

Original test `Submit a chosen device-authorization start option`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L1275).

- **Given** Stripe device authorization requires choosing a Mode, with Test and Live options, and polling will fail with an unavailable error.
- **When** I select Live and start connecting.
- **Then** Connection is disabled before a choice and enabled after selecting Live. The start request uses Live, and the user sees “Stripe device authorization is unavailable.”

## connectors-auth-methods-018

Original test `Start provider sign-in from catalog metadata`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L1365).

- **Given** Notion's catalog metadata identifies its single OAuth method, and an authorization window is available.
- **When** I connect Notion.
- **Then** Sign-in starts for Notion with the app callback target, opens one authorization window, and leaves no Notion dialog open.

## connectors-auth-methods-019

Original test `Submit credentials only for the chosen manual method`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L1417).

- **Given** Public Axiom offers two manual methods with separate credential fields.
- **When** I enter credentials for both methods and save the second method.
- **Then** The connection uses the API-key method and submits only its API-key value; Public Axiom is connected.

## connectors-auth-methods-020

Original test `A personal connection authorizes the default Okou even when the agent list omits it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L1542).

- **Given** I connect Public Axiom in personal mode, and the visible agent list omits the default Okou.
- **When** I complete the personal connection.
- **Then** The default Okou is authorized and Public Axiom is shown as connected.

## connectors-auth-methods-021

Original test `A personal connection authorizes only the default scope while keeping legacy grants separate`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L1552).

- **Given** I connect Public Axiom in personal mode while legacy grants exist.
- **When** I inspect access and revoke the Okou grant.
- **Then** Only the default Okou is authorized by the personal connection. Revoking its grant leaves the workspace-access section visible, and legacy grants remain separate.
