# marketing-reward-events

## marketing-reward-events-001

- Vitest: "cron recovers a retained source after configuration returns and retries its exact identity without forwarding credentials"
- Mode: run
- Given: A member connects GitHub through OAuth at 2026-01-01T08:00Z while Marketing reward event delivery is not configured. Delivery is then configured. The Marketing receiver answers successive deliveries with a network error, a wrong digest, a wrong environment, a wrong event ID, HTTP 409, a 307 redirect to an untrusted host, and finally a correct receipt.
- When: The cron caller requests `GET /api/cron/process-background-jobs` with the cron secret seven times, then twice more concurrently.
- Then: No event is sent before delivery is configured. The seven cron runs deliver seven events with the service bearer secret, all identical: version 1, environment `development`, type `connector.oauth-authorized`, the OAuth time, org, user, connection ID and builtin `github` connector, without credentials. The redirect is not followed, and the two later runs send nothing more.

## marketing-reward-events-002

- Vitest: "records custom OAuth connection identity without publishing its provider credentials"
- Mode: run
- Given: Marketing reward event delivery is configured, and a member creates a custom HTTP connector with OAuth (client secret and token URL at a public host).
- When: The member completes the custom connector's OAuth authorization and callback.
- Then: The Marketing receiver gets exactly one event with the member's org and user and connector `{ kind: "custom", customConnectorId }`, which matches the OAuth event schema with no provider credentials.

## marketing-reward-events-003

- Vitest: "does not publish manual credentials or a declined OAuth authorization as an OAuth fact"
- Mode: run
- Given: Marketing reward event delivery is configured.
- When: A member connects OpenAI with a manual API key, then starts GitHub OAuth and the provider callback returns `error=access_denied`.
- Then: The Marketing receiver gets no events.

## marketing-reward-events-004

- Vitest: "publishes immutable iMessage owner facts through repeated requests, switching and source deletion"
- Mode: run
- Given: Marketing reward event delivery is configured and AgentPhone is set up. At 2026-01-01T08:00Z a member holds a verified connect proof for a phone handle.
- When: The member connects iMessage twice with `POST /api/integrations/agentphone/link` using the proof, tries a second handle without replacement (expect 409), connects it twice with `replacePhoneHandle`, unlinks with `DELETE /api/integrations/agentphone/link`, and reads the link status.
- Then: The two first connects publish exactly one event: version 2, type `imessage.identity-linked`, environment `development`, the time, org, user and a link ID. The non-replacing connect returns HTTP 409 and the unlink returns HTTP 204 with status `linked` false. In total two events are published; the switched one has a different event ID and link ID and the same org and user.

## marketing-reward-events-005

- Vitest: "a rejected OAuth source does not prevent another owner's Slack publication"
- Mode: run
- Given: Marketing reward event delivery is configured. The Marketing receiver rejects version-1 events for member A with HTTP 409 and accepts all others. Member B is an organization admin.
- When: Member A connects GitHub through OAuth, then member B installs Slack for their workspace.
- Then: Member A's single `connector.oauth-authorized` GitHub event is not resent during B's install. B's install publishes one version-1 `connector.oauth-authorized` event for builtin `slack` and exactly one version-2 `slack.oauth-authorized` event with B's org, user and Slack workspace ID.

## marketing-reward-events-006

- Vitest: "publishes an anonymous Slack installation only after administrator authorization binds its organization"
- Mode: run
- Given: A Slack workspace was installed anonymously before any organization owned it, and Marketing reward event delivery is configured. An organization admin binds their Slack user in that workspace.
- When: The admin connects their Slack user, then completes the Slack installation authorization for the workspace, reads the Slack integration status, and connects the Slack user again.
- Then: No `slack.oauth-authorized` event is published after the first binding. After the admin authorization the status shows `isInstalled` true and exactly one version-2 `slack.oauth-authorized` event with the admin's org, user and workspace ID is published. Reconnecting the Slack user publishes no additional one.
