# connector-grant-identity

## connector-grant-identity-001

- Vitest: "notion authorization identity > preserves different authorizations owned by the same provider user"
- Mode: run
- Given: The authenticated owner starts Notion OAuth twice. The provider returns the same user identity but a distinct bot identity for each authorization.
- When: The provider completes each code callback for Notion, and the owner reads GET /api/connector-accounts/connections for it.
- Then: Both callbacks report success. The account list contains two accounts with the same external user ID.

## connector-grant-identity-002

- Vitest: "notion authorization identity > rejects reconnecting a known authorization to a different workspace grant"
- Mode: run
- Given: An authenticated owner has a connected Notion account. A reconnect to that exact account would return the same provider user with a different bot identity.
- When: The owner completes the reconnect callback and reads the connection list.
- Then: The callback reports error. The list contains only the original account ID.

## connector-grant-identity-003

- Vitest: "notion authorization identity > keeps grants independent when their authorization identity is unavailable"
- Mode: run
- Given: The authenticated owner starts Notion OAuth twice. Both callbacks identify the provider user, and neither supplies a bot identity.
- When: The owner completes both authorizations and lists the accounts.
- Then: Both callbacks report success and the list contains two accounts.

## connector-grant-identity-004

- Vitest: "slack authorization identity > preserves different authorizations owned by the same provider user"
- Mode: run
- Given: The authenticated owner starts Slack OAuth twice. The provider returns the same user identity but a distinct team identity for each authorization.
- When: The provider completes each code callback for Slack, and the owner reads GET /api/connector-accounts/connections for it.
- Then: Both callbacks report success. The account list contains two accounts with the same external user ID.

## connector-grant-identity-005

- Vitest: "slack authorization identity > rejects reconnecting a known authorization to a different workspace grant"
- Mode: run
- Given: An authenticated owner has a connected Slack account. A reconnect to that exact account would return the same provider user with a different team identity.
- When: The owner completes the reconnect callback and reads the connection list.
- Then: The callback reports error. The list contains only the original account ID.

## connector-grant-identity-006

- Vitest: "slack authorization identity > keeps grants independent when their authorization identity is unavailable"
- Mode: run
- Given: The authenticated owner starts Slack OAuth twice. Both callbacks identify the provider user, and neither supplies a team identity.
- When: The owner completes both authorizations and lists the accounts.
- Then: Both callbacks report success and the list contains two accounts.

## connector-grant-identity-007

- Vitest: "hubspot authorization identity > preserves different authorizations owned by the same provider user"
- Mode: run
- Given: The authenticated owner starts HubSpot OAuth twice. The provider returns the same user identity but a distinct HubSpot account identity for each authorization.
- When: The provider completes each code callback for HubSpot, and the owner reads GET /api/connector-accounts/connections for it.
- Then: Both callbacks report success. The account list contains two accounts with the same external user ID.

## connector-grant-identity-008

- Vitest: "hubspot authorization identity > rejects reconnecting a known authorization to a different workspace grant"
- Mode: run
- Given: An authenticated owner has a connected HubSpot account. A reconnect to that exact account would return the same provider user with a different HubSpot account identity.
- When: The owner completes the reconnect callback and reads the connection list.
- Then: The callback reports error. The list contains only the original account ID.

## connector-grant-identity-009

- Vitest: "hubspot authorization identity > keeps grants independent when their authorization identity is unavailable"
- Mode: run
- Given: The authenticated owner starts HubSpot OAuth twice. Both callbacks identify the provider user, and neither supplies a HubSpot account identity.
- When: The owner completes both authorizations and lists the accounts.
- Then: Both callbacks report success and the list contains two accounts.
