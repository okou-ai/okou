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

## Message context

Feishu and Lark share the same decoder for incoming messages and conversation
history. Rich-text `post` messages retain their title, text, links, mentions,
and all image/file resources. Repeated references to the same resource within
one message share a download alias. The canonical input keeps both the text and
attachments, and each resource remains downloadable by the receiving run.

History requests use `card_msg_content_type=user_card_content` to retrieve
original card JSON. The default rendered representation can replace assistant
Markdown and artifact links with an image preview. Both original card schemas
are decoded, preserving reply text, Markdown links, button URLs, and resources.
Context follows the Slack format: chronological messages, sender identities,
relative indices, and attachments, with separate thread and recent group context.

The gated integrations store incoming resources in a `files` array. This replaces
the internal ingress payload's singular `file` field; pending payloads from the
previous staff-only version are not dual-read. Persisted canonical launch
contexts already contain a `messageFiles` array and keep their existing format.

## Deployment and compatibility

Migration `1120_lark_bot_platform` adds a non-null `platform` column defaulting
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

## Feishu parity

| Surface                          | Shared behavior                                                                                                                                                                                                              | Lark-specific behavior                                                                                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registration and account entry   | Signed message links retain the installation, sender, chat, timestamp, and signature through login or sign-up; authenticated connection uses the same account-linking endpoint.                                              | Entry returns to `/settings/lark`; the installation determines the provider and organization.                                                                                                                                                                |
| Setup and settings               | Seven-step creation, App ID conflict checks, credentials, callback verification, imported scopes, publication, review guide, agent selection, member connection, disconnect, and admin uninstall.                            | Lark labels, console links, callback path, installation list, and rollout gate. Guide screenshots remain labeled Feishu references.                                                                                                                          |
| OAuth and managed user connector | Signed state, identity and tenant checks, account ownership, reconnect, refresh, credential storage, scope list, and permission defaults.                                                                                    | Lark authorization/API domains, `_lark-<installation-id>` connector identity, and Lark skill text. The protocol adapter and `builtin:feishu@1` permission bundle stay shared.                                                                                |
| Messages and runs                | Event validation and deduplication, `/help`, `/connect`, `/disconnect`, `/switch`, `/model`, direct and group messages, thread routing, history, files, queued continuation, reactions, cancellation, and automatic replies. | Every provider call uses the persisted installation platform; source links open Lark. Internal event-source and callback identifiers remain `feishu`.                                                                                                        |
| Runtime prompt                   | Same user, conversation, file, automatic-reply, explicit-send, and multiple-installation guidance.                                                                                                                           | Current integration, user display name/open ID labels, history/file labels, and command examples identify Lark. Only the current provider's conversation-specific messaging instructions are injected. Global Lark CLI guidance requires the rollout switch. |
| CLI                              | `message send`, `upload-file`, and `download-file`; identical targeting, cards/text, thread replies, installation selection, validation, transfer limits, and output structure.                                              | `okou lark`, Lark API routes and error text, `lark:write`, and a `lark-` default download filename.                                                                                                                                                          |

The API integration suite runs the same scenarios against both providers. UI
settings and account-entry tests also run against both; CLI command tests invoke
each provider through the real command parser. Lark-only tests additionally
cover provider separation and rollout/capability boundaries. These tests use
mocked provider HTTP responses; a real Lark app's scope approval, publication,
and account authorization still require validation against Lark itself.
