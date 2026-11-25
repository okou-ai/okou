# artifacts.bdd

## artifacts.bdd-001

- Vitest: "GET /api/chat-threads/:threadId/artifacts > keeps each hosted-site publication as a separate immutable artifact"
- Mode: run
- Given: A Pro member with a configured Runner group has sent a chat prompt that launched a Run, and the Run's sandbox environment carries an Okou CLI token. Hosted-site storage accepts uploads.
- When: Using the Run's Okou token, the agent deploys the same site twice via `POST /api/host/deployments/prepare` and `POST /api/host/deployments/:deploymentId/complete`; the member then calls `GET /api/chat-threads/:threadId/artifacts`.
- Then: The first deployment has the site's public slug, deployment version 1 and an alias URL equal to its URL; the second has version 2, the same site ID and alias URL, and a different deployment ID and immutable artifact URL. The thread listing has one Run whose files include both publications, each with its own artifact URL and alias URL.

## artifacts.bdd-002

- Vitest: "hosted artifacts without a supplied cover > publishes an artifact in the catalog and its chat thread"
- Mode: run
- Given: A Pro member with a configured Runner group has sent a chat prompt that launched a Run, and the Run's sandbox environment carries an Okou CLI token. Hosted-site storage accepts uploads.
- When: Using the Run's Okou token, the agent deploys a hosted site without a cover via `POST /api/host/deployments/prepare` and `POST /api/host/deployments/:deploymentId/complete`; the member reads `GET /api/artifacts/catalog` and `GET /api/chat-threads/:threadId/artifacts`, and the Run reports successful completion.
- Then: The completed deployment is `ready` and active. The catalog contains the site as kind `hosted-site` with a null thumbnail, and the thread's Run files include the deployment's artifact URL with its alias URL. The completion webhook returns HTTP 200.
