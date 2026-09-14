# Social download discovery

`okou social downloads --json` lists one page of saved download tasks for the
authenticated user in the current organization. `--status active` finds tasks
holding the user's active-download slot, including artifact recovery failures.
Other filters are `queued`, `processing`, `materializing`, `artifact_failed`,
`provider_failed`, and `completed`.

Each entry includes the task ID, saved state, original request URL and options,
available artifact, billing/error information, and a `resumeCommand`.
Inspect the request before choosing a task. Run the returned command to use the
existing known-ID polling and artifact recovery flow. Completed tasks return
their saved artifact; terminal provider failures have no resume command.
Listing itself does not poll, reconcile, submit, or charge for a download.
It does not cancel upstream processing or prevent billing.

## API and pagination

GET `/api/social/downloads` requires the same organization, owner and
`social:read` capability boundary as GET `/api/social/downloads/:downloadId`.
Discovery and accessible conflict recovery are available to all authorized
callers without a feature switch.

Query parameters:

- `limit`: integer from 1 through 100, default 20.
- `status`: optional public status above or `active`.
- `cursor`: optional UUID from the preceding response's `nextCursor`.

The response is `{ downloads, nextCursor }`. The CLI adds `nextCommand` to
continue with the same limit and status. Results are ordered by creation time
descending, then UUID descending. Cursor comparison uses the database's full
timestamp precision. Newly created tasks do not shift subsequent pages; start
over to see them. Status filters describe current saved state, not a frozen
snapshot across requests.

Both the page and its cursor anchor require the exact user and organization.
An unknown, deleted, or inaccessible anchor yields the same empty page with a
null cursor. Omit the cursor to restart. No provider job IDs, temporary media
URLs, credentials, or other owners' task details are returned.

## Create conflicts and deployment compatibility

POST `/api/social/downloads` still enforces one active task per user across
organizations. It retains HTTP 409, `DOWNLOAD_IN_PROGRESS`, and the existing
message. When an active task remains accessible in the current organization,
`error.recovery` adds `downloadId` and `resumeCommand`.
Otherwise the error has no recovery fields, including when the conflicting task
has already stopped being active. The server does not retry the submission.
CLI human and JSON errors preserve these hints without automatically selecting
or resuming another task.

Existing create/get response fields and known-ID resume remain unchanged.
Older CLI artifacts ignore the additional conflict fields and retain their
existing error behavior. New clients also accept generic conflicts, which remain
part of the authorization contract. A new list command against an older API
reports the normal HTTP failure; there is no alternate discovery protocol.
Existing request snapshots and indexes require no schema migration or backfill.
See [deployment compatibility](deployment-compatibility.md#commit-addressed-cli-artifacts).
