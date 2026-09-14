# Lark bot integration

Lark uses the Feishu bot implementation for setup, OAuth account linking,
message ingestion, threaded replies, commands, file transfer, and managed
user connectors. Provider selection is stored on the installation; credentials,
API requests, OAuth endpoints, and deep links always use that provider.

- UI: `/settings/lark`, with the same seven-step setup and review guide as Feishu.
- OAuth app callback: `/integrations/lark/callback`. The catalog connector's
  `/connectors/lark/callback` route remains independent.
- Management and native messaging/file APIs: `/api/integrations/lark/*`.
  Native commands require `lark:write`; a `feishu:write` token cannot call them.
- CLI: `okou lark message send`, `okou lark upload-file`, and
  `okou lark download-file`, with the same options as Feishu.
- Gate: `_larkIntegration`, disabled by default and scoped to the organization.
  It controls settings and issuance of the `lark:write` token capability for
  members. Installed bot callbacks, OAuth, queued launch, and provider requests
  also check the installation owner's feature context.

The wizard uses the existing Feishu console screenshots as labeled reference
images. All actions link to the Lark developer console.

## Deployment and compatibility

Migration `1117_lark_bot_platform` adds a non-null `platform` column defaulting
existing and legacy-created installations to `feishu`. Existing tables, event
source values, queue/context shapes, callback URLs, and the App ID uniqueness
constraint are retained. Feishu callers keep their existing routes and payloads.
Lark's separate routes return 404 on an older API instead of falling back to
Feishu credential selection.

Keep Lark disabled until the migration, API, app, and CLI release are available
and older API readers are out of service. After creating Lark installations,
rollback must retain a Lark-aware API: older releases do not filter the shared
installation table by provider. This PR does not change production rollback
floors or enable the feature in a live organization.
