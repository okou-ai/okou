# integrations-slack-upload-complete

## integrations-slack-upload-complete-001

- Vitest: "POST /api/integrations/slack/upload-file/complete > delivers canonical bytes and replays a shared receipt with provider size 42"
- Mode: run
- Given: A run-scoped agent token belongs to an organization admin whose organization has the Slack bot installed and who shares channel `C123` with the bot. The agent has initialized a canonical 42-byte `report.csv` upload for `C123` and stored the matching bytes. Slack allocates file `F-MATERIALIZED` with an upload URL on `files.slack.com`, its upload host accepts the bytes, and Slack file info reports the file shared in `C123` with provider size 42.
- When: The agent calls `POST /api/integrations/slack/upload-file/deliver` twice with the asset ID and operation ID.
- Then: Both calls return HTTP 200 with the asset ID, the canonical URL and a `delivered` receipt for `F-MATERIALIZED` with its Slack permalink. The Slack upload host receives the 42 stored bytes exactly once and Slack upload completion is called exactly once.

## integrations-slack-upload-complete-002

- Vitest: "POST /api/integrations/slack/upload-file/complete > delivers canonical bytes and replays a shared receipt with provider size 35"
- Mode: run
- Given: A run-scoped agent token belongs to an organization admin whose organization has the Slack bot installed and who shares channel `C123` with the bot. The agent has initialized a canonical 42-byte `report.csv` upload for `C123` and stored the matching bytes. Slack allocates file `F-MATERIALIZED` with an upload URL on `files.slack.com`, its upload host accepts the bytes, and Slack file info reports the file shared in `C123` with a different provider size of 35.
- When: The agent calls `POST /api/integrations/slack/upload-file/deliver` twice with the asset ID and operation ID.
- Then: Both calls return HTTP 200 with the asset ID, the canonical URL and a `delivered` receipt for `F-MATERIALIZED` with its Slack permalink. The Slack upload host receives the 42 stored bytes exactly once and Slack upload completion is called exactly once.

## integrations-slack-upload-complete-003

- Vitest: "POST /api/integrations/slack/upload-file/complete > retries rejected bytes without finalizing the empty reservation"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes in an organization with the Slack bot installed. The Slack upload host rejects the first byte upload with HTTP 403 and accepts the next one, and Slack file info reports the file shared in `C123`.
- When: The agent calls `POST /api/integrations/slack/upload-file/deliver` twice for the same asset and operation.
- Then: The first call returns HTTP 200 with a `failed`, retryable delivery whose message is "Slack file byte upload failed (HTTP 403)" and Slack upload completion is not called. The second call returns a `delivered` receipt. The upload host receives the 42 bytes twice, Slack allocates an upload URL twice, and upload completion is called exactly once.

## integrations-slack-upload-complete-004

- Vitest: "POST /api/integrations/slack/upload-file/complete > waits for an uploaded shared file when the receipt is unshared"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. The Slack upload host accepts the bytes, but Slack file info first reports the file as unshared (size 42, no channels) and later as shared in `C123` with size 42.
- When: The agent calls `POST /api/integrations/slack/upload-file/deliver` twice while the file is unshared and once more after Slack reports it shared.
- Then: The first two calls return HTTP 200 with a `failed`, retryable delivery. The third returns a `delivered` receipt. The upload host receives the 42 bytes only once and Slack upload completion is called exactly once.

## integrations-slack-upload-complete-005

- Vitest: "POST /api/integrations/slack/upload-file/complete > waits for an uploaded shared file when the receipt is empty"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. The Slack upload host accepts the bytes, but Slack file info first reports the file in `C123` with size 0 (empty) and later as shared in `C123` with size 42.
- When: The agent calls `POST /api/integrations/slack/upload-file/deliver` twice while the receipt is empty and once more after Slack reports the full file.
- Then: The first two calls return HTTP 200 with a `failed`, retryable delivery. The third returns a `delivered` receipt. The upload host receives the 42 bytes only once and Slack upload completion is called exactly once.

## integrations-slack-upload-complete-006

- Vitest: "POST /api/integrations/slack/upload-file/complete > waits for an uploaded shared file when the receipt is unprocessed"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. The Slack upload host accepts the bytes, but Slack file info first reports the file in `C123` without a size (unprocessed) and later as shared in `C123` with size 42.
- When: The agent calls `POST /api/integrations/slack/upload-file/deliver` twice while the receipt is unprocessed and once more after Slack reports the processed file.
- Then: The first two calls return HTTP 200 with a `failed`, retryable delivery. The third returns a `delivered` receipt. The upload host receives the 42 bytes only once and Slack upload completion is called exactly once.

## integrations-slack-upload-complete-007

- Vitest: "POST /api/integrations/slack/upload-file/complete > rechecks destination access after server byte transfer and recovers after restoration"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. While Slack receives the bytes, the user and bot stop sharing any channel, and Slack file info reports the file without channels.
- When: The agent calls `POST /api/integrations/slack/upload-file/deliver`, the shared channel membership is restored, and the agent calls deliver again.
- Then: The first call returns HTTP 200 with a `failed` delivery and Slack upload completion is not called. The retry returns a `delivered` receipt. The upload host receives the bytes once, Slack allocates an upload URL once, and upload completion is called exactly once.

## integrations-slack-upload-complete-008

- Vitest: "POST /api/integrations/slack/upload-file/complete > rejects corrupted canonical bytes before contacting Slack's upload host"
- Mode: run
- Given: A run-scoped agent has initialized a canonical 42-byte `report.csv` upload for Slack channel `C123`, but the stored object contains different bytes than the declared SHA-256 checksum.
- When: The agent calls `POST /api/integrations/slack/upload-file/deliver` for the asset and operation.
- Then: The response is HTTP 200 with a `failed` delivery whose message is "Canonical Slack bytes do not match the declared size and checksum". Slack upload completion is not called.

## integrations-slack-upload-complete-009

- Vitest: "POST /api/integrations/slack/upload-file/complete > rejects an unexpected provider upload host without forwarding bytes"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. Slack returns an upload URL on `untrusted.example` instead of the Slack upload host.
- When: The agent calls `POST /api/integrations/slack/upload-file/deliver` for the asset and operation.
- Then: The response is HTTP 200 with a `failed` delivery whose message is "Slack returned an unsupported file upload destination". Slack upload completion is not called.

## integrations-slack-upload-complete-010

- Vitest: "POST /api/integrations/slack/upload-file/complete > keeps a concurrent request from completing an active byte upload"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. The Slack upload host holds the first byte upload open until released.
- When: The agent starts `POST /api/integrations/slack/upload-file/deliver`, sends a second concurrent deliver for the same asset and operation while the bytes are in flight, then the upload host finishes and Slack reports the file shared.
- Then: The concurrent call returns HTTP 200 with a `failed`, retryable delivery whose message is "Another Slack delivery attempt is already in progress", and no upload completion happens yet. The first call returns a `delivered` receipt. Slack allocates an upload URL once and upload completion is called exactly once.

## integrations-slack-upload-complete-011

- Vitest: "POST /api/integrations/slack/upload-file/complete > records a cancelled server transfer so the same operation can retry"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. The Slack upload host holds the byte transfer open.
- When: The caller aborts `POST /api/integrations/slack/upload-file/deliver` during the byte transfer, then Slack reports the file shared and the agent sends the same deliver request again.
- Then: The first request ends with an AbortError. The retry returns HTTP 200 with a `delivered` receipt, and Slack allocates an upload URL twice.

## integrations-slack-upload-complete-012

- Vitest: "POST /api/integrations/slack/upload-file/complete > reconciles a provider-accepted completion after caller cancellation"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. The Slack upload host accepts the bytes and Slack accepts the upload completion only after a delay.
- When: The caller aborts `POST /api/integrations/slack/upload-file/deliver` while Slack completion is in progress, Slack then accepts it and reports the file shared, and the agent sends the same deliver request again.
- Then: The first request ends with an AbortError. The retry returns HTTP 200 with a `delivered` receipt. Slack allocates an upload URL once and upload completion is called exactly once.

## integrations-slack-upload-complete-013

- Vitest: "POST /api/integrations/slack/upload-file/complete > returns an in-progress canonical Slack receipt for a mismatched file ID"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes, and Slack allocates file `F-MATERIALIZED`.
- When: The agent calls `POST /api/integrations/slack/upload-file/materialize`, then `POST /api/integrations/slack/upload-file/complete` with file ID `F-WRONG` and a different channel, then complete with `F-MATERIALIZED`, and finally replays that completion after the user and bot no longer share any channel.
- Then: Materialize returns exactly the asset ID, URL and a `pending` delivery with `F-MATERIALIZED` and its upload URL, without Slack completion or file info calls. The mismatched completion returns HTTP 200 with `F-WRONG`, empty permalink, channel `C123`, the asset ID, `failed` status and error "Another Slack delivery attempt is already in progress". The correct completion returns `F-MATERIALIZED`, its permalink, channel `C123`, the asset ID and `delivered`, and the replay returns the identical body. Slack completion is called exactly once for `C123` with no title or thread and a "Triggered by <@…>" comment; file info and upload URL allocation each happen once.

## integrations-slack-upload-complete-014

- Vitest: "POST /api/integrations/slack/upload-file/complete > rechecks membership before preparing a canonical Slack delivery"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123`, and the user and bot no longer share any Slack channel.
- When: The agent calls `POST /api/integrations/slack/upload-file/materialize` for the asset and operation.
- Then: The response is HTTP 200 with a `failed` delivery whose message contains "not shared". Slack upload completion is not called.

## integrations-slack-upload-complete-015

- Vitest: "POST /api/integrations/slack/upload-file/complete > denies completion when membership is revoked after Slack upload preparation"
- Mode: run
- Given: A run-scoped agent has a canonical 42-byte `report.csv` upload for Slack channel `C123` that has been materialized to a pending Slack file. Afterwards the user and bot no longer share any Slack channel.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` with the canonical asset ID, operation ID, the pending file ID and channel `C123`.
- Then: The response is HTTP 200 with `deliveryStatus` `failed` and a `deliveryError` containing "not shared". Slack upload completion is not called.

## integrations-slack-upload-complete-016

- Vitest: "POST /api/integrations/slack/upload-file/complete > revokes pending canonical delivery when the organization bot is uninstalled"
- Mode: run
- Given: A run-scoped agent has a canonical 42-byte `report.csv` upload for Slack channel `C123` that has been materialized to a pending Slack file. The organization's Slack workspace is then uninstalled.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` with the canonical asset ID, operation ID, the pending file ID and channel `C123`.
- Then: The response is HTTP 200 with channel `C123` and `deliveryStatus` `failed`. Slack upload completion is not called.

## integrations-slack-upload-complete-017

- Vitest: "POST /api/integrations/slack/upload-file/complete > records a canonical Slack reconciliation failure and retries materialization"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. Slack allocates a file; on the second attempt Slack file info reports the file with a permalink but Slack upload completion fails with `invalid_arguments`; later Slack file info reports the file shared in `C123`.
- When: The agent calls `POST /api/integrations/slack/upload-file/materialize` once to prepare, once while completion fails, and twice after Slack recovers.
- Then: The first call returns exactly a `pending` delivery with the file ID and upload URL, without completion or file info calls. The second returns HTTP 200 with a `failed`, retryable delivery "Slack delivery failed: invalid_arguments" after one completion attempt for `C123`. Both recovery calls return exactly a `delivered` receipt with the file ID and permalink; across the test Slack completion is called once, file info twice (last for the same file), and upload URL allocation once.

## integrations-slack-upload-complete-018

- Vitest: "POST /api/integrations/slack/upload-file/complete > records a canonical Slack preparation failure and retries materialization"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123` with stored bytes. Slack upload URL allocation first fails with `invalid_arguments`, then succeeds with `F-MATERIALIZED`, and Slack file info reports the file with a permalink.
- When: The agent calls `POST /api/integrations/slack/upload-file/materialize` twice, then calls `POST /api/integrations/slack/upload-file/complete` twice with a different channel in the body, the second time after the user and bot no longer share any channel.
- Then: The first materialize returns HTTP 200 with a `failed`, retryable delivery "Slack delivery failed: invalid_arguments" and no Slack completion or file info calls. The second returns exactly a `pending` delivery with `F-MATERIALIZED` and its upload URL. Both completions return exactly the file ID, permalink, channel `C123`, the asset ID and `delivered`; Slack completion and file info are each called once.

## integrations-slack-upload-complete-019

- Vitest: "POST /api/integrations/slack/upload-file/complete > returns canonical not found for missing Slack delivery identities"
- Mode: run
- Given: A run-scoped agent has a canonical 42-byte `report.csv` upload for Slack channel `C123` materialized to a pending Slack file.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` once with an unknown canonical asset ID and the real operation ID, and once with the real asset ID and an unknown operation ID.
- Then: Each call returns HTTP 404 with error code `NOT_FOUND` and message "Canonical Slack delivery was not found". Slack upload completion and file info are never called.

## integrations-slack-upload-complete-020

- Vitest: "POST /api/integrations/slack/upload-file/complete > rejects another run's canonical Slack delivery and preserves its owner's receipt"
- Mode: run
- Given: Two run-scoped agents from different Slack-installed organizations each have a canonical 42-byte `report.csv` upload for channel `C123` materialized to a pending Slack file.
- When: The first agent calls `POST /api/integrations/slack/upload-file/complete` with the second agent's canonical asset, operation and file IDs, then the second agent calls complete with the same body twice.
- Then: The first agent receives HTTP 404 `NOT_FOUND` "Canonical Slack delivery was not found" without any Slack completion or file info call. Both of the second agent's calls return exactly the file ID, permalink, channel `C123`, its asset ID and `delivered`; Slack completion and file info are each called once.

## integrations-slack-upload-complete-021

- Vitest: "POST /api/integrations/slack/upload-file/complete > records an authoritative Slack upload error before successful completion and replay"
- Mode: run
- Given: A run-scoped agent has a canonical 42-byte `report.csv` upload for Slack channel `C123` materialized to a pending Slack file.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` with `uploadError` "The prepared Slack upload failed" and a different channel, then calls complete twice without `uploadError` after Slack file info reports the file.
- Then: The first call returns HTTP 200 with exactly the file ID, empty permalink, channel `C123`, the asset ID, `failed` and that `deliveryError`, without Slack completion or file info calls. Both later calls return exactly the file ID, permalink, channel `C123`, asset ID and `delivered`; Slack completion and file info are each called once.

## integrations-slack-upload-complete-022

- Vitest: "POST /api/integrations/slack/upload-file/complete > selects each request's installation across members of one organization and returns to the first actor"
- Mode: run
- Given: Two members of one organization (an admin and a member) are both connected to the same installed Slack workspace. Each request uses a newly launched run's agent token: the admin, then the member, then the admin again.
- When: For each run the agent calls `POST /api/integrations/slack/upload-file/init` for a canonical 42-byte CSV to its own channel, stores the bytes, then calls `POST /api/integrations/slack/upload-file/materialize` and `POST /api/integrations/slack/upload-file/complete`.
- Then: For every request, materialize returns exactly a `pending` delivery with that request's Slack file ID and upload URL, and complete returns exactly the file ID, permalink, channel, asset ID and `delivered`. Each request creates three Slack clients with the shared installation's bot token, requests one upload URL with the filename and length 42, completes once to its channel with a "Triggered by <@…>" comment, and reads file info once. The run's thread artifacts include the asset, and the three runs are distinct.

## integrations-slack-upload-complete-023

- Vitest: "POST /api/integrations/slack/upload-file/complete > selects each request's installation across different organizations and returns to the first actor"
- Mode: run
- Given: Two admins of different organizations each have their own installed and connected Slack workspace. Each request uses a newly launched run's agent token: the first admin, then the second, then the first again.
- When: For each run the agent calls `POST /api/integrations/slack/upload-file/init` for a canonical 42-byte CSV to its own channel, stores the bytes, then calls `POST /api/integrations/slack/upload-file/materialize` and `POST /api/integrations/slack/upload-file/complete`.
- Then: For every request, materialize returns exactly a `pending` delivery with that request's Slack file ID and upload URL, and complete returns exactly the file ID, permalink, channel, asset ID and `delivered`. Each request creates three Slack clients with its own organization's bot token, requests one upload URL with the filename and length 42, completes once to its channel with a "Triggered by <@…>" comment, and reads file info once. The run's thread artifacts include the asset, and the three runs are distinct.

## integrations-slack-upload-complete-024

- Vitest: "POST /api/integrations/slack/upload-file/complete > selects each request's installation across an uninstalled organization and returns to the first actor"
- Mode: run
- Given: The first admin's organization has an installed and connected Slack workspace; a second admin belongs to a different organization without a Slack installation. Each request uses a newly launched run's agent token: the first admin, then the second, then the first again.
- When: The first admin's run initializes, stores, materializes and completes a canonical 42-byte CSV via `POST /api/integrations/slack/upload-file/init`, `/materialize` and `/complete`; the second admin's run calls materialize and complete for the previous upload's asset, operation and file IDs; then the first admin repeats a fresh upload.
- Then: Both of the first admin's uploads return a `pending` materialization and a `delivered` completion with three Slack clients using that organization's bot token and one upload URL, completion and file info call each. The second admin's materialize and complete both return HTTP 404 `NOT_FOUND` without creating any Slack client or calling Slack. The three runs are distinct.

## integrations-slack-upload-complete-025

- Vitest: "POST /api/integrations/slack/upload-file/complete > keeps a canonical upload unpublished after missing storage verification and recovers on replay"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123`, but object storage first reports the uploaded object as missing.
- When: The agent calls `POST /api/integrations/slack/upload-file/materialize`, storage then reports the real object, and the agent calls materialize again.
- Then: The first call returns HTTP 400 with code `storage-verification-failed` and message "Canonical upload was not found", and the member's artifact catalog is empty. The retry returns HTTP 200 with the asset ID, URL and a `pending` delivery; the catalog then has one artifact and the run's thread artifacts include the asset with materialization `ready`.

## integrations-slack-upload-complete-026

- Vitest: "POST /api/integrations/slack/upload-file/complete > keeps a canonical upload unpublished after undefined length storage verification and recovers on replay"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123`, but object storage first reports the uploaded object without a content length.
- When: The agent calls `POST /api/integrations/slack/upload-file/materialize`, storage then reports the real object, and the agent calls materialize again.
- Then: The first call returns HTTP 400 with code `storage-verification-failed` and message "Canonical upload size did not match", and the member's artifact catalog is empty. The retry returns HTTP 200 with the asset ID, URL and a `pending` delivery; the catalog then has one artifact and the run's thread artifacts include the asset with materialization `ready`.

## integrations-slack-upload-complete-027

- Vitest: "POST /api/integrations/slack/upload-file/complete > keeps a canonical upload unpublished after mismatched length storage verification and recovers on replay"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123`, but object storage first reports the uploaded object with a content length of 41.
- When: The agent calls `POST /api/integrations/slack/upload-file/materialize`, storage then reports the real object, and the agent calls materialize again.
- Then: The first call returns HTTP 400 with code `storage-verification-failed` and message "Canonical upload size did not match", and the member's artifact catalog is empty. The retry returns HTTP 200 with the asset ID, URL and a `pending` delivery; the catalog then has one artifact and the run's thread artifacts include the asset with materialization `ready`.

## integrations-slack-upload-complete-028

- Vitest: "POST /api/integrations/slack/upload-file/complete > cancels canonical publication during storage verification and permits a fresh replay"
- Mode: run
- Given: A run-scoped agent has a pending canonical 42-byte `report.csv` upload for Slack channel `C123`, and object storage verification of the upload is held open.
- When: The caller aborts `POST /api/integrations/slack/upload-file/materialize` during storage verification, then sends a fresh materialize request.
- Then: The aborted request ends with an AbortError and the member's artifact catalog stays empty. The fresh request returns HTTP 200 and the catalog then contains one artifact.

## integrations-slack-upload-complete-029

- Vitest: "POST /api/integrations/slack/upload-file/complete > returns 401 when no auth token is provided"
- Mode: run
- Given: The caller sends no authorization token.
- When: The caller calls `POST /api/integrations/slack/upload-file/complete` with file ID `F123` and channel `C123`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## integrations-slack-upload-complete-030

- Vitest: "POST /api/integrations/slack/upload-file/complete > returns 403 when sandbox token lacks slack:write"
- Mode: run
- Given: A run's sandbox token, which does not carry the `slack:write` capability, is used in an organization without a Slack installation.
- When: The caller calls `POST /api/integrations/slack/upload-file/complete` with file ID `F123` and channel `C123`.
- Then: The response is HTTP 403 with an error message mentioning `slack:write`.

## integrations-slack-upload-complete-031

- Vitest: "POST /api/integrations/slack/upload-file/complete > returns 404 when no Slack installation exists for org"
- Mode: run
- Given: A run-scoped agent token belongs to an organization admin whose organization has no Slack installation.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` with file ID `F123` and channel `C123`.
- Then: The response is HTTP 404 with an error message containing "No Slack installation".

## integrations-slack-upload-complete-032

- Vitest: "POST /api/integrations/slack/upload-file/complete > forwards Slack file info errors as 400 SLACK_ERROR"
- Mode: run
- Given: A run-scoped agent token belongs to an organization with the Slack bot installed, and Slack file info fails with `file_not_found`.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` with a file ID and channel `C123`.
- Then: The response is HTTP 400 with error code `SLACK_ERROR` and a message containing `file_not_found`. The run's thread artifacts list no uploaded files.

## integrations-slack-upload-complete-033

- Vitest: "POST /api/integrations/slack/upload-file/complete > records a Slack upload for a run-scoped agent token"
- Mode: run
- Given: A run-scoped agent token belongs to an organization with the Slack bot installed. Slack file info reports a 42-byte `text/csv` file with a permalink.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` with the file ID, channel `C123`, `threadTs` `123.456`, title "Quarterly report" and initial comment "Uploaded from a run".
- Then: The response is HTTP 200 with the file ID and Slack permalink. Slack completion is called for `C123` in thread `123.456` with title "Quarterly report" and the comment "Uploaded from a run" followed by a blank line and "Triggered by <@…>". The run's thread artifacts list exactly one file with that ID, filename "Quarterly report", content type `text/csv`, size 42 and the permalink as URL.

## integrations-slack-upload-complete-034

- Vitest: "POST /api/integrations/slack/upload-file/complete > opens a DM for direct completion addressed to me"
- Mode: run
- Given: A run-scoped agent token belongs to an organization admin connected to a Slack user in the installed workspace. The target is `me`, Slack opens DM `D-SELF` with the caller's Slack user, and Slack file info reports the file with a permalink.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` with the file ID, `user` `me` and title "Self report" and no channel.
- Then: The response is HTTP 200 with exactly the file ID, permalink and channel `D-SELF`. Slack opens a conversation with the caller's connected Slack user ID, and completion is sent to `D-SELF` with title "Self report", no thread and the comment "Triggered by <@caller>".

## integrations-slack-upload-complete-035

- Vitest: "POST /api/integrations/slack/upload-file/complete > opens a DM for direct completion addressed to U_OTHER_USER"
- Mode: run
- Given: A run-scoped agent token belongs to an organization admin connected to a Slack user in the installed workspace. The target is Slack user `U_OTHER_USER`, Slack opens DM `D-SELF` with that user, and Slack file info reports the file with a permalink.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` with the file ID, `user` `U_OTHER_USER` and title "Self report" and no channel.
- Then: The response is HTTP 200 with exactly the file ID, permalink and channel `D-SELF`. Slack opens a conversation with `U_OTHER_USER`, and completion is sent to `D-SELF` with title "Self report", no thread and the comment "Triggered by <@caller>".

## integrations-slack-upload-complete-036

- Vitest: "POST /api/integrations/slack/upload-file/complete > persists recipient me DM for a canonical upload"
- Mode: run
- Given: A run-scoped agent token belongs to an organization admin connected to a Slack user in the installed workspace. The recipient is `me`, Slack opens DM `D-SELF`, allocates file `F-SELF`, and reports it with a permalink.
- When: The agent calls `POST /api/integrations/slack/upload-file/init` with a canonical 42-byte `report.csv` addressed to `user` `me`, stores the bytes, calls `POST /api/integrations/slack/upload-file/materialize`, then calls `POST /api/integrations/slack/upload-file/complete` with `F-SELF`, `user` `me` and the canonical identities.
- Then: Init returns channel `D-SELF` after opening a conversation with the caller's Slack user ID. Completion returns HTTP 200 with `F-SELF`, channel `D-SELF`, the asset ID and `delivered`. Slack completion goes to `D-SELF` without title or thread with "Triggered by <@caller>", and Slack opens a DM only once in total.

## integrations-slack-upload-complete-037

- Vitest: "POST /api/integrations/slack/upload-file/complete > persists recipient U_OTHER_USER DM for a canonical upload"
- Mode: run
- Given: A run-scoped agent token belongs to an organization admin connected to a Slack user in the installed workspace. The recipient is `U_OTHER_USER`, Slack opens DM `D-SELF`, allocates file `F-SELF`, and reports it with a permalink.
- When: The agent calls `POST /api/integrations/slack/upload-file/init` with a canonical 42-byte `report.csv` addressed to `user` `U_OTHER_USER`, stores the bytes, calls `POST /api/integrations/slack/upload-file/materialize`, then calls `POST /api/integrations/slack/upload-file/complete` with `F-SELF`, the same user and the canonical identities.
- Then: Init returns channel `D-SELF` after opening a conversation with `U_OTHER_USER`. Completion returns HTTP 200 with `F-SELF`, channel `D-SELF`, the asset ID and `delivered`. Slack completion goes to `D-SELF` without title or thread with "Triggered by <@caller>", and Slack opens a DM only once in total.

## integrations-slack-upload-complete-038

- Vitest: "POST /api/integrations/slack/upload-file/complete > keeps one private canonical output across Slack and Drive (artifactUpload=false)"
- Mode: run
- Given: A run-scoped agent token belongs to an organization admin with the Slack bot installed; Slack allocates `F-CANONICAL` and reports it with a permalink. The member connects Google Drive, which creates folders and accepts resumable uploads. Row: `artifactUpload=false`.
- When: The agent initializes (and retries) a canonical 42-byte `report.csv` upload for `C123` thread `123.456`, stores the bytes, materializes and completes it via the Slack upload routes; the member attaches the file to a chat message; the file is uploaded to Drive via `POST /api/artifacts/:artifactId/google-drive/chat-uploads` twice with the member session and once with the run token; then the run completes with the assistant reply "The canonical report is ready.".
- Then: Init returns kind `canonical`, only an `x-amz-meta-artifact-id` upload header, an `/artifacts/<10 chars>.csv` URL and a private-bucket signed upload, without contacting Slack; the retry returns the same asset and URL. Materialize returns `pending` for `F-CANONICAL` after one upload-URL request, the artifact catalog holds a `report.csv` file entry for the asset, and completion is `delivered`. The run lists exactly one file with `published-output` classification, `published` access and `ready` materialization. Each Drive upload returns the Drive file; Drive gets two folders with root "Okou Artifacts" and three JSON-metadata uploads in the inner folder carrying thread, run and operation metadata. Thread events include the final reply and a `run.completed` marker with null content.

## integrations-slack-upload-complete-039

- Vitest: "POST /api/integrations/slack/upload-file/complete > keeps one private canonical output across Slack and Drive (artifactUpload=true)"
- Mode: run
- Given: A run-scoped agent token belongs to an organization admin with the Slack bot installed; Slack allocates `F-CANONICAL` and reports it with a permalink. The member connects Google Drive, which creates folders and accepts resumable uploads; another member of the organization connects a separate Drive account. Row: `artifactUpload=true`.
- When: The agent initializes (and retries), stores, materializes and completes a canonical 42-byte `report.csv` for `C123`; the member attaches it to a chat message and uploads it to Drive via `POST /api/artifacts/:artifactId/google-drive/chat-uploads`; then catalog artifacts, ordinary uploads, a hosted site and a deleted source thread are exercised through the same Drive upload route with various callers.
- Then: Canonical init, materialize, catalog and completion behave as in the shared flow, with three initial Drive uploads in an "Okou Artifacts" subfolder. Uploading the catalog entry from another conversation's run returns 200 with `okouArtifactId` metadata and the 42 `a` bytes. Unauthenticated requests get 401, an unknown artifact 404, an unknown thread or connection 400, a sandbox token 403, the run token with a foreign thread 400 and another member's Drive connection 400. An ordinary `ordinary.csv` upload and a later `companion-data.csv` appear as catalog file entries next to an unchanged hosted-site entry, and Drive receives the `b` bytes for the ordinary file. After the source thread is deleted, the canonical artifact still uploads with `okouArtifactId` and no thread metadata, while a foreign user or organization receives 404; Drive receives eight uploads in total.

## integrations-slack-upload-complete-040

- Vitest: "POST /api/integrations/slack/upload-file/complete > keeps an attachment-only output out of the event stream"
- Mode: run
- Given: A run-scoped agent in an organization with the Slack bot installed has initialized a canonical 128-byte `attachment-only.pdf` upload for channel `C123` that was never delivered.
- When: The run completes through the agent completion webhook without emitting any output events.
- Then: The thread's events contain a `run.completed` lifecycle marker for the run with null content and no `output.message` event for the run.

## integrations-slack-upload-complete-041

- Vitest: "POST /api/integrations/slack/upload-file/complete > keeps a canonical Slack delivery failed when file info has no permalink"
- Mode: run
- Given: A run-scoped agent has a canonical 42-byte `report.csv` upload for channel `C123` with stored bytes, Slack allocates `F-MISSING-PERMALINK`, and Slack file info reports the file without a permalink.
- When: The agent materializes the upload via `POST /api/integrations/slack/upload-file/materialize` and then calls `POST /api/integrations/slack/upload-file/complete` with the file ID, channel and canonical identities.
- Then: Materialize returns a `pending` delivery for `F-MISSING-PERMALINK`. Completion returns HTTP 200 with that file ID, the asset ID, an empty permalink, `deliveryStatus` `failed` and `deliveryError` "Slack file info did not include a permalink".

## integrations-slack-upload-complete-042

- Vitest: "POST /api/integrations/slack/upload-file/complete > keeps one Slack delivery authoritative across concurrent retries"
- Mode: run
- Given: A run-scoped agent has a canonical 42-byte `report.csv` upload for `C123` thread `123.456` with stored bytes. Slack allocates a distinct file ID for each upload URL request and answers two concurrent requests together.
- When: The agent sends two concurrent `POST /api/integrations/slack/upload-file/materialize` requests, completes the losing file ID, completes the winning file ID, completes the losing file ID again with `uploadError` "stale upload failed", and materializes once more.
- Then: One materialize returns `pending` and the other a retryable `failed` delivery mentioning "already in progress". The stale completion returns `failed` with an "already in progress" error, the authoritative completion returns `delivered`, and the later stale failure report still returns the authoritative file ID as `delivered`. The final materialize returns a `delivered` receipt with the authoritative file ID and its permalink.

## integrations-slack-upload-complete-043

- Vitest: "POST /api/integrations/slack/upload-file/complete > records an uploaded Slack video in its thread artifacts"
- Mode: run
- Given: A run-scoped agent token belongs to an organization with the Slack bot installed. Slack file info reports `demo.mp4` as a 1024-byte `video/mp4` file with a permalink.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` with the file ID, channel `C123` and title "Demo video".
- Then: The request succeeds with HTTP 200, and the run's thread artifacts list exactly one file with that ID, filename "Demo video", content type `video/mp4` and the permalink as URL.

## integrations-slack-upload-complete-044

- Vitest: "POST /api/integrations/slack/upload-file/complete > does not record a run association for ordinary clerk session auth"
- Mode: run
- Given: An organization admin with an active run in a Slack-installed organization calls with an ordinary signed-in session instead of a run token. Slack file info reports the file with a permalink.
- When: The member calls `POST /api/integrations/slack/upload-file/complete` with the file ID, channel `C123` and title "Session upload".
- Then: The response is HTTP 200 with the file ID and permalink, and the run's thread artifacts list no uploaded files.

## integrations-slack-upload-complete-045

- Vitest: "POST /api/integrations/slack/upload-file/complete > is idempotent for repeated completion calls for the same run file"
- Mode: run
- Given: A run-scoped agent token belongs to an organization with the Slack bot installed. Slack file info reports the file with a permalink.
- When: The agent calls `POST /api/integrations/slack/upload-file/complete` twice with the same file ID, channel `C123` and title "Retry upload".
- Then: Both calls return HTTP 200, and the run's thread artifacts list exactly one uploaded file.
