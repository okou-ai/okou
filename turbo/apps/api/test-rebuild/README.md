# API test rebuild checkpoint

The frozen main commit is `0797b30b16f1c2dbe0c07fd4fa17a4cd8dabd989`. The upstream comparison through `4629019afe215bc58715c57aed6dbb9f09ee6d11` found no changes under `turbo/apps/api`.

Vitest collected 599 files and 7,453 cases. All 7,453 are in run mode, with zero skips, todos or focused cases. Vitest's independent `list --project=api --filesOnly` output matched the runtime file set exactly. The partial reconciliation checked 65 complete BDD files and 300 cases, including 257 review entries. The other 534 files and 7,153 cases are pending.

`baseline.json` records the Vitest 5.1.1 runtime task tree for the entire `api` project with the repository's setup and config. Collection registers and expands cases without executing test bodies. Entries use the test file's stem and the runtime registration order, including separate IDs for parameter rows with the same full name. A null location means Vitest did not report an entry-file location, which can happen when tests are registered by a separate suite module.

The local collection used Node 26.13.1, the frozen pnpm lockfile, and a disposable, migrated PostgreSQL 19 database with pgvector and UTC. The file scope includes `scripts/register-discord-commands.test.mjs` and lists the five standalone `scripts/*.node-test.mjs` files as exclusions. The Vitest wrapper for the native Runner transport probe is in scope.

## Verify the baseline

Copy the checkpoint collector to the same path in the frozen checkout and install the locked dependencies. Set `DATABASE_URL` to the migrated disposable database. Run runtime collection with `CI=1 node turbo/apps/api/test-rebuild/collect.mjs /tmp/api-baseline.json`. The collector uses the same Vitest API project as the eight CI shards and collects the unsharded union.

## Resume transcription

Use `reconciliation.tsv` to select cases marked `missing`. Keep each ID, the Vitest full name and mode from `baseline.json`. Encode the full name as a JSON string on the `Vitest` line so whitespace and control characters round-trip. Vitest can truncate interpolated titles, and 33 expanded rows share a title with another row in the same file. Preserve the source parameter in the Given when the runtime title is ambiguous. Follow imported `.suite.ts` and `.cases.ts` registrations and their helpers when the entry file delegates. `review` means the scenario is written and its intent needs review.

From the repository root:

```sh
node turbo/apps/api/test-rebuild/reconcile.mjs --partial
node turbo/apps/api/test-rebuild/reconcile.mjs
```

The first command updates checkpoint coverage. The second requires exact coverage of the frozen IDs. Finish that check before the test deletion commit. Keep the pushed transcription checkpoints in order. After strict reconciliation passes, create the separate deletion commit and open the Draft PR.

## Source review

The checks below re-read the indicated BDDs against the test source, shared helpers and contracts where applicable. They covered 22 cases.

| Group              | Cases                                                                                                              | Findings                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API routes         | Desktop update cases 02, 08, 21 and 28, both Auto routing cases, both cron cases and the Runner heartbeat case (9) | The Auto test also asserts creation HTTP 201 and two HTTP 200 readbacks through separate endpoints. The heartbeat omits the required `heldHomeStates` array. The critical-update case checks the supported version marker and the two alternate download paths. The desktop retry window is evaluated when the request answers. |
| API infrastructure | Android unsupported POST, generated Vercel listener, duplicate database URL option (3)                             | The Android test verifies the compatibility gate before route matching. The generated listener checks actual bytes, cookies and stream ordering. The database URL fixture keeps the last duplicate option and appends UTC.                                                                                                      |
| API libraries      | Named SQLSTATE 23503 constraint, Web URL and OAuth origins, concurrent clock scopes, export memory file count (4)  | The SQLSTATE case distinguishes the named dependency from other constraints. The OAuth case checks both computed origins and the canonical redirect. The export case proves rejection and absence of one output file.                                                                                                           |
| Provider protocols | S3 deletion retry, S3 UTF-8 order, WeChat raw media key, WeChat caller timeout (4)                                 | The S3 listing keeps the provider's order. The retry preserves exact provider batch sizes and the remaining keys. WeChat CDN requests carry the query parameter without the bot Authorization header, and the receive operation preserves the caller's timeout reason.                                                          |
| Registration CLI   | Discord partial registration and mismatched receipt (2)                                                            | The tests check the surviving command set through the Discord listing, and only the partial-registration case retains successfully registered replacements.                                                                                                                                                                     |

The source review refined the Auto routing and Runner BDDs to capture the actual endpoints and outcomes. The Vercel cron BDD keeps all 29 ordered path and schedule pairs, including the re-exported X resource cleanup route.

## Follow-up source review

| Group        | Case                                          | Finding                                                                                                                                                            |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Billing      | `billing-concurrency-invoice-publication-001` | A newer cancellation arrives during the first invoice attempt. The first attempt returns 500. Both accepted replays preserve credits and the cancellation flag.    |
| Computer Use | `computer-use-screenshot-completion-002`      | The owner reads the running state during the held upload and again after the response fails. The successful retry exposes PNG dimensions and the exact byte count. |
| Cron         | `cron-compact-chat-thread-snapshots-001`      | The source checks scope through both HTTP and MCP. The MCP response omits the snapshot storage URL.                                                                |
| Runner       | `runner-disk-telemetry-001`                   | All six matching telemetry variants succeed. A mismatched Run ID is rejected, and failure is verified through the Run readback.                                    |
| Voice        | `transcribe-001`                              | The upstream 429 maps to 503 without a charge. The two HTTP 200 retries share one successful provider call and a three-credit settlement.                          |

| Chat case                                 | Finding                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-event-snapshot-001`                 | Same user in another workspace receives 404. The raw snapshot pairs rows with the event cursor and both incompatible cursors receive 410. |
| `chat-events-concurrency-prefetch-001`    | The grace cutoff passes during object metadata lookup. The scenario rechecks live occupancy after both cancellations.                     |
| `chat-events-pi-delegation-001`           | Delegated input returns 201 and the target thread reference. Three distinct target classes are rejected.                                  |
| `feishu-user-deletion-002`                | The shared suite uses Lark-specific status while the display name remains Feishu User.                                                    |
| `discord-gateway-identity-002`            | Signed event identity and stable message identity differ. The original thread projection is verified after rejection.                     |
| `integration-model-recovery-telegram-001` | Thread Auto selection is distinct from global preference. The continued Runner input and 64-byte callback limit are preserved.            |

| `connector-catalog-status-generation-001` | Catalog-only changes preserve the account timestamp and default ID. Reconnection keeps the account ID and supplies the added region. |
| `builtin-mcp-discovery-002` | The selected non-default account is identified before deletion and discovery falls back to the remaining default. |
| `chat-thread-connector-selection.ownership-001` | Current-selection returns 400 and an inaccessible override returns 404. Foreign thread protection and live account rename and deletion are retained. |
| `chat-events-pi-failed-history-002` | Partial output retains the failed generation, and a completion replay preserves the result. |
| `chat-indicators-realtime-001` | Message output uses the message topic, separate from the start and terminal indicator notifications. |
| `image-io-responses-recovery-001` | The balance falls by seven after interruption and by nine total after recovery, with only one provider submission. |
| `webhooks-stripe-credit-purchase-001` | Deduplication is by invoice across distinct signed webhook event IDs. The full post-purchase grant list is identical after replay. |
| `project-run-context-001` | The queued Run uses the latest membership and both mention names while started Runs preserve their prompts. |
| `remote-runtime-invalidation-001` | Thread overrides target one Run and defaults target both. SSH resolution and all four Run statuses are verified separately. |

| `connector-external-code-session-read-002` | Mismatched session ID and token pairs return 404, while a matched superseded pair returns 400. The latest request and replay return one account. |
| `connector-account-default-wakeups-002` | The default is visible after provider failure. Subsequent realtime publication targets the exact owner Run and workspace. |
| `teams-route-ownership-003` | The second terminal reply moves to the new Teams destination while preserving the Okou thread. |
| `feishu-shared-conversation-006` | Replay produces only one Feishu reply. The test checks a matching realtime publication attempt and leaves its count unspecified. |
| `discord-oauth-export-001` | The archive retains first-party contents while excluding raw and hashed authorities and the foreign identity. |
| `artifact-paywall-001` | Delivery stays allowed and displays a banner, while hiding, renaming and downloads each return 402. |
| `browser-admission-002` | Admission waits for the first window. The sibling gets a distinct window within the same provider instance. |
| `execution-storage-url-freshness-001` | Corrected the refresh boundary to 44 hours from the source. The Run spends two minutes queued across that threshold. |
| `proactive-preferences-001` | Feed source flags remain individually editable when Suggestions is paused, and the returned values are read back through the web session. |
| `chat-events-pi-session-001` | The third request uses GPT-6.1 Sol, despite the title. Corrected the BDD to retain the exact model sequence. |
| `chat-events-history-002` | The source observes one generated title and one recommendation revocation across accepted and conflicting deliveries. |
| `chat-thread-pdf-filename-004` | Rejected authentication, selection and body requests produce zero provider calls. |
| `connector-external-code-session-creation-003` | An external-code exchange already in flight completes and replays its sibling account after replacement. A concurrent duplicate gets 400 while exchange is in progress. |
| `connector-device-auth-session-expiration-002` | Device authorization expires at the exact 30-second cutoff. |
| `connector-external-code-session-expiration-002` | An external-code session remains exclusive at 30 minutes and expires one millisecond later. |
| `discord-gateway-auth-002` | The repeated title corresponds to formatted Unicode guild-delete bytes and an authenticated HTTP 403 outcome. |
| `discord-conversation-parity-013` | The provider read error preserves the DM message reference and the absence of private content. |
| `integration-model-recovery-slack-012` | The global default, single recovery Run and native indicator target are independently verified. |
| `runner-app-state-002` | Upload authorization is confined to the claimed host response. The command read omits it, and completion or host stop invalidates the Runner grant. |
| `runners-run-lookups-001` | The non-owner sees 403 while the Run is active and 404 after completion. Only the owner sees the terminal-sync error. |
| `runners-member-instructions-003` | Storage verification races the sender’s edit, and the execution package preserves the earlier sender text. |
