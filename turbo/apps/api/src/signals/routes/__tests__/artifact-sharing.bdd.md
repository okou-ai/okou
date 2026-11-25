# artifact-sharing

## artifact-sharing-001

- Vitest: "named viewers can open and download report.pdf from another active workspace"
- Mode: run
- Given: Hosted-site email sharing is enabled for the owner's workspace. The owner has uploaded `report.pdf` (`application/pdf`), and the viewer, "Taylor Viewer", is a verified member of the same workspace. The email service accepts sends.
- When: The owner calls `POST /api/artifact-sharing/file/:id/shares` with the viewer's email twice. The viewer, now active in another workspace with a Pro entitlement, calls `GET /api/artifact-references/:reference` and `GET /api/artifact-references/:reference/download`, and tries to share the file with another email. The owner then removes the grant with `DELETE /api/artifact-sharing/file/:id/shares/:shareId` and the viewer repeats the reads.
- Then: Both shares return HTTP 200 with the same `{ share: { id, email } }`, and exactly one email is sent from `Okou <noreply@okou.ai>` to the viewer with template `okou-artifact-invitation-v1`, inviter "Taylor Viewer", the recipient email and an `/artifacts/` URL. The viewer's preview and download return HTTP 200 with the filename, content type and file target (download kind `file`), and the viewer's share attempt returns HTTP 404. After removal returns HTTP 200, both reads return HTTP 404.

## artifact-sharing-002

- Vitest: "named viewers can open and download recording.mp4 from another active workspace"
- Mode: run
- Given: Hosted-site email sharing is enabled for the owner's workspace. The owner has uploaded `recording.mp4` (`video/mp4`), and the viewer, "Taylor Viewer", is a verified member of the same workspace. The email service accepts sends.
- When: The owner calls `POST /api/artifact-sharing/file/:id/shares` with the viewer's email twice. The viewer, now active in another workspace with a Pro entitlement, calls `GET /api/artifact-references/:reference` and `GET /api/artifact-references/:reference/download`, and tries to share the file with another email. The owner then removes the grant with `DELETE /api/artifact-sharing/file/:id/shares/:shareId` and the viewer repeats the reads.
- Then: Both shares return HTTP 200 with the same `{ share: { id, email } }`, and exactly one email is sent from `Okou <noreply@okou.ai>` to the viewer with template `okou-artifact-invitation-v1`, inviter "Taylor Viewer", the recipient email and an `/artifacts/` URL. The viewer's preview and download return HTTP 200 with the filename, content type and file target (download kind `file`), and the viewer's share attempt returns HTTP 404. After removal returns HTTP 200, both reads return HTTP 404.

## artifact-sharing-003

- Vitest: "external invitations use the Resend file template, deduplicate and require a verified email to claim"
- Mode: run
- Given: Hosted-site email sharing is enabled for the owner's workspace and the owner has uploaded `report.pdf`. The invited viewer is not a member of the owner's workspace. The email service accepts sends.
- When: The owner calls `POST /api/artifact-sharing/file/:id/shares` with the viewer's email twice; the viewer calls `GET /api/artifact-references/:reference` while their email is unverified and again once verified; the owner removes the grant and the viewer resolves again.
- Then: Both invitations return HTTP 200 with identical bodies, and exactly one email is sent from `Okou <noreply@okou.ai>` to the viewer with template `okou-artifact-invitation-v1`, inviter "Taylor Viewer", the recipient email and an `/artifacts/` URL. The unverified viewer gets HTTP 404 and the verified viewer gets HTTP 200. After `DELETE /api/artifact-sharing/file/:id/shares/:shareId` returns HTTP 200, the viewer gets HTTP 404.

## artifact-sharing-004

- Vitest: "nickname search stays in the owner's workspace and an unrelated account cannot claim an invitation"
- Mode: run
- Given: Hosted-site email sharing is enabled and the owner has uploaded a file. One user is in the owner's workspace; an external user and an unrelated stranger are outside it.
- When: The owner calls `GET /api/artifact-sharing/file/:id/share-accounts` with the local user's nickname and with the external user's email, then invites the external email via `POST /api/artifact-sharing/file/:id/shares`. The stranger resolves the file reference and searches share accounts for "Taylor".
- Then: The nickname search returns HTTP 200 with exactly the local user's ID, name "Taylor Viewer" and email; the external email search returns HTTP 200 with no accounts. The invitation returns HTTP 200. The stranger gets HTTP 404 for `GET /api/artifact-references/:reference` and for the share-account search.

## artifact-sharing-005

- Vitest: "file sharing honors the server switch and recipient quotas"
- Mode: run
- Given: The owner has uploaded a file, and hosted-site email sharing is first disabled and then enabled for the workspace.
- When: The owner calls `POST /api/artifact-sharing/file/:id/shares` for `viewer@example.com` while disabled, then four times while enabled; the same user in another enabled workspace calls `GET /api/artifact-sharing/file/:id/shares`.
- Then: The share while disabled returns HTTP 404. The first three enabled shares return HTTP 200 and the fourth returns HTTP 429 with error code `RATE_LIMITED`. The listing from the other workspace returns HTTP 404.

## artifact-sharing-006

- Vitest: "the common sharing API preserves existing website grants"
- Mode: run
- Given: Hosted-site email sharing is enabled, and the owner has deployed a private hosted site. A viewer is a member of the owner's workspace.
- When: The owner shares the site with `POST /api/artifact-sharing/site/:id/shares` for the viewer's email and lists shares; the viewer requests `GET /api/host/sites/:publicSlug/preview` with the site hostname before and after the owner removes the grant.
- Then: The share returns HTTP 200 and the listing returns exactly that grant. The viewer's preview returns HTTP 200 while the grant exists and HTTP 404 after `DELETE /api/artifact-sharing/site/:id/shares/:shareId` returns HTTP 200.
