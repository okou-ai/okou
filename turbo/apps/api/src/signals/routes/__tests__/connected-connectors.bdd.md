# connected-connectors

## connected-connectors-001

- Vitest: "lists saved BentoML accounts"
- Mode: run
- Given: An authenticated workspace member has added a BentoML API-token account with an endpoint.
- When: The member sends GET /api/connectors/connected.
- Then: HTTP 200 includes exactly one built-in brief identified as bentoml.

## connected-connectors-002

- Vitest: "requires authentication and an organization"
- Mode: run
- Given: One caller is unauthenticated and another is authenticated without an organization.
- When: Each caller sends GET /api/connectors/connected.
- Then: Both receive HTTP 401.

## connected-connectors-003

- Vitest: "reads the owning member's saved directory with a real PAT credential"
- Mode: run
- Given: A member initially has no connected accounts and receives a real PAT through the CLI device approval and exchange flow. After token issuance the member saves a GitLab account and a no-auth custom connection.
- When: The caller sends GET /api/connectors/connected using the PAT while a separate browser session represents another user.
- Then: The request returns HTTP 200 with Cache-Control no-store and exactly the built-in GitLab brief and the custom definition brief, including their display metadata and no account secrets.

## connected-connectors-004

- Vitest: "reads the owning member's saved directory with a real Run credential"
- Mode: run
- Given: A member initially has no saved accounts and starts a dispatched run. After the run receives its credential, the member saves a GitLab account and a no-auth custom connection.
- When: The caller sends GET /api/connectors/connected with the run credential, diagnoses both targets within that run and repeats directory lookup with the sandbox credential alone.
- Then: The request returns HTTP 200 with Cache-Control no-store and exactly the built-in GitLab brief and the custom definition brief, including their display metadata and no account secrets. Each HTTP 200 diagnostic reports target-unavailable with reason not-admitted. The sandbox-only request returns HTTP 403 FORBIDDEN.

## connected-connectors-005

- Vitest: "returns only saved connector briefs, independently of account defaults and other owners"
- Mode: run
- Given: An authenticated admin initially has no saved connections. The admin creates a no-auth custom definition, connects it and adds two GitLab token accounts.
- When: The admin reads GET /api/connectors/connected before and after connecting, renames the second GitLab account and makes it default. A different member of that organization and the same user in a different organization read the directory. The owner deletes each GitLab account in turn and rechecks.
- Then: All directory reads return HTTP 200. The initial no-store response has both lists empty and the definition alone adds no brief. Saved connections produce one GitLab brief and one custom brief. Renaming, changing the default and deleting only one GitLab account leave the same briefs. The two other user/organization combinations see both lists empty and deleting the last GitLab account removes its brief.
