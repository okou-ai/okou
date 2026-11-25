# integrations-slack-upload-init

## integrations-slack-upload-init-001

- Vitest: "POST /api/integrations/slack/upload-file/init > selects each request's installation across users and organizations"
- Mode: run
- Given: Organization A has an installed Slack workspace connected to its admin and to a member of the same organization; organization B's admin has a separate installed and connected Slack workspace; a fourth admin's organization has no Slack installation. Each request uses a newly launched run's agent token, in the order A admin, A member, B admin, uninstalled admin, A admin. Slack issues a per-request upload URL and file ID.
- When: Each run calls `POST /api/integrations/slack/upload-file/init` with its own filename `request-<n>.csv` and length.
- Then: Requests in installed organizations return HTTP 200 with exactly that request's upload URL and file ID; every Slack client they create uses only their own installation's bot token (A for both A users, B for B), and Slack receives exactly one upload URL request with that filename and length. The uninstalled organization's request returns HTTP 404 `NOT_FOUND` without creating a Slack client or requesting an upload URL.

## integrations-slack-upload-init-002

- Vitest: "POST /api/integrations/slack/upload-file/init > returns 401 when no auth token is provided"
- Mode: run
- Given: The caller sends no authorization token.
- When: The caller calls `POST /api/integrations/slack/upload-file/init` with filename `report.pdf` and length 100.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## integrations-slack-upload-init-003

- Vitest: "POST /api/integrations/slack/upload-file/init > returns 403 when sandbox token lacks slack:write"
- Mode: run
- Given: The caller uses a run's sandbox token, which does not carry the `slack:write` capability.
- When: The caller calls `POST /api/integrations/slack/upload-file/init` with filename `report.pdf` and length 100.
- Then: The response is HTTP 403 with an error message mentioning `slack:write`, and Slack is not asked for an upload URL.

## integrations-slack-upload-init-004

- Vitest: "POST /api/integrations/slack/upload-file/init > denies bot upload allocation without the caller's verified Slack binding"
- Mode: run
- Given: An organization admin's organization has the Slack bot installed, but the admin has not connected their own Slack account. The caller uses the admin's run-scoped agent token.
- When: The agent calls `POST /api/integrations/slack/upload-file/init` with filename `private.txt` and length 42.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and Slack is not asked for an upload URL.

## integrations-slack-upload-init-005

- Vitest: "POST /api/integrations/slack/upload-file/init > returns a Slack-issued upload URL and file id on the happy path"
- Mode: run
- Given: An organization admin is connected to the organization's installed Slack workspace and calls with a run-scoped agent token. Slack issues upload URL `https://files.slack.com/upload/v1/abc` with file ID `F-mock-file`.
- When: The agent calls `POST /api/integrations/slack/upload-file/init` with filename `quarterly.csv` and length 4096.
- Then: The response is HTTP 200 with the Slack upload URL and file ID `F-mock-file`, and Slack's upload URL request carries filename `quarterly.csv` and length 4096.

## integrations-slack-upload-init-006

- Vitest: "POST /api/integrations/slack/upload-file/init > rejects large canonical uploads after asset graduation"
- Mode: run
- Given: An organization admin is connected to the organization's installed Slack workspace and calls with a run-scoped agent token.
- When: The agent calls `POST /api/integrations/slack/upload-file/init` with a canonical `legacy-archive.zip` upload of 100 MiB plus one byte to channel `C_LEGACY_DIRECT`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST` and message "File too large (max 100 MB)", and Slack is not asked for an upload URL.

## integrations-slack-upload-init-007

- Vitest: "POST /api/integrations/slack/upload-file/init > forwards Slack platform errors as 400 SLACK_ERROR"
- Mode: run
- Given: An organization admin is connected to the organization's installed Slack workspace and calls with a run-scoped agent token. Slack rejects the upload URL request with `invalid_filename`.
- When: The agent calls `POST /api/integrations/slack/upload-file/init` with filename `../bad.exe` and length 1.
- Then: The response is HTTP 400 with error code `SLACK_ERROR` and a message containing `invalid_filename`.
