# integrations-github-files

## integrations-github-files-001

- Vitest: "GitHub file integration routes > returns GitHub attachment download metadata: report final.csv"
- Mode: run
- Given: A workspace user has installed the GitHub App for organization `bdd-files-org` and calls with a run's Okou token.
- When: The caller requests `GET /api/integrations/github/download-file/url` with `url` `https://raw.githubusercontent.com/okou-ai/okou/main/report%20final.csv`.
- Then: The response is HTTP 200 with exactly `{ downloadUrl: <the same URL>, filename: "report final.csv", contentType: "text/csv" }` and `cache-control: private, no-store`.

## integrations-github-files-002

- Vitest: "GitHub file integration routes > returns GitHub attachment download metadata: github-file"
- Mode: run
- Given: A workspace user has installed the GitHub App for organization `bdd-files-org` and calls with a run's Okou token.
- When: The caller requests `GET /api/integrations/github/download-file/url` with a `https://github.com/user-attachments/assets/<uuid>` URL.
- Then: The response is HTTP 200 with exactly `{ downloadUrl: <the same URL>, filename: "github-file", contentType: "application/octet-stream" }` and `cache-control: private, no-store`.

## integrations-github-files-003

- Vitest: "GitHub file integration routes > preserves signed GitHub URLs while sanitizing filename hints"
- Mode: run
- Given: A workspace user has installed the GitHub App and calls with a run's Okou token.
- When: The caller requests `GET /api/integrations/github/download-file/url` with the signed URL `https://private-user-images.githubusercontent.com/123/file?jwt=signed!` and filename hint `../report.pdf`.
- Then: The response is HTTP 200 with exactly `{ downloadUrl: <the unchanged signed URL>, filename: ".._report.pdf", contentType: "application/pdf" }`.

## integrations-github-files-004

- Vitest: "GitHub file integration routes > returns a presigned upload URL for GitHub file delivery"
- Mode: run
- Given: A workspace user has installed the GitHub App and calls with a run's Okou token; storage has a public endpoint configured.
- When: The caller sends `POST /api/integrations/github/upload-file/init` with filename "daily report.pdf", `application/pdf` and length 1234.
- Then: The response is HTTP 200 with the presigned `uploadUrl`, filename `daily_report.pdf`, content type, size 1234, upload headers carrying `x-amz-meta-artifact-id` equal to the UUID `uploadId`, and a `fileUrl` of the form `/artifacts/<10 chars>.pdf` that does not contain the user ID. The URL is signed for bucket `test-private-artifacts`, key `private-artifacts/<uploadId>/daily_report.pdf` and metadata `artifact-id` equal to the upload ID.

## integrations-github-files-005

- Vitest: "GitHub file integration routes > posts an uploaded file URL to GitHub and records the run artifact"
- Mode: run
- Given: A Pro-entitled workspace user has installed the GitHub App, and a thread run "deliver github file" is claimed by a Runner; GitHub issues installation token `ghs_test_token` and accepts issue comments with ID 98765.
- When: The run calls `POST /api/integrations/github/upload-file/init` for `report.pdf` (1234 bytes), uploads the bytes, then calls `POST /api/integrations/github/upload-file/complete` for repo `okou-ai/okou`, issue 42 and caption "Daily report".
- Then: The upload returns HTTP 200. GitHub receives a comment on `okou-ai/okou` issue 42 with the installation token and body `Daily report\n\n[report.pdf](<fileUrl>)`. The completion returns HTTP 200 with `commentId` "98765", the repo, issue number 42, filename `report.pdf`, `application/pdf`, size 1234 and the init's `fileUrl`.
