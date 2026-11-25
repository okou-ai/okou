# uploads-prepare

## uploads-prepare-001

- Vitest: "POST /api/uploads/prepare > registers the legacy public URL before issuing upload credentials"
- Mode: run
- Given: A signed-in user without an organization uploading from `https://app.okou.ai`.
- When: The user calls `POST /api/uploads/prepare` for `hello.txt` (`text/plain`, 13 bytes).
- Then: The API responds with HTTP 200. Before the upload URL is signed, exactly one create-only public registration is written to the hosted-sites bucket: version 1, `legacy-file`, public audience, `okou` brand, key `artifacts/<10 chars>.txt`, filename `hello.txt` and content type `text/plain`.

## uploads-prepare-002

- Vitest: "POST /api/uploads/prepare > does not issue upload credentials when public registration fails"
- Mode: run
- Given: A signed-in user without an organization; writing the public URL registration fails ("Registry unavailable").
- When: The user calls `POST /api/uploads/prepare` for `hello.txt`.
- Then: The API responds with HTTP 500 and no upload URL is signed.

## uploads-prepare-003

- Vitest: "POST /api/uploads/prepare > returns 401 when unauthenticated"
- Mode: run
- Given: No authentication.
- When: The caller calls `POST /api/uploads/prepare` for `hello.txt`.
- Then: The API responds with HTTP 401 with error code `UNAUTHORIZED`.

## uploads-prepare-004

- Vitest: "POST /api/uploads/prepare > accepts an Okou run token with file:write and returns a presigned URL"
- Mode: run
- Given: A workspace member with an Okou Run token that has the `file:write` capability.
- When: The agent calls `POST /api/uploads/prepare` for `hello.txt`.
- Then: The API responds with HTTP 200 with an HTTP(S) upload URL, a file URL matching `http://localhost:3002/artifacts/<10 chars>.txt`, and a UUID ID.

## uploads-prepare-005

- Vitest: "POST /api/uploads/prepare > returns a private artifact reference for run uploads"
- Mode: run
- Given: A workspace member with an Okou Run token that has `file:write`, uploading from `https://app.okou.ai`.
- When: The agent calls `POST /api/uploads/prepare` for `hello.txt`.
- Then: The API responds with HTTP 200 with a URL matching `http://localhost:3002/artifacts/<10 chars>.txt` and upload headers whose `x-amz-meta-artifact-id` equals the returned ID.

## uploads-prepare-006

- Vitest: "POST /api/uploads/prepare > returns public artifact metadata for organization-less browser uploads"
- Mode: run
- Given: A signed-in user without an organization uploading from `https://app.okou.ai`.
- When: The user calls `POST /api/uploads/prepare` for `hello.txt`.
- Then: The API responds with HTTP 200 with a short `https://a.okou.io/<10 chars>.txt` URL and upload headers with `x-amz-meta-public-brand: okou`.

## uploads-prepare-007

- Vitest: "POST /api/uploads/prepare > rejects files larger than 5 GB with 400"
- Mode: run
- Given: A signed-in workspace member.
- When: The member calls `POST /api/uploads/prepare` for `big.bin` declared as 5 GiB plus 1 byte.
- Then: The API responds with HTTP 400 and an error message containing "File too large".

## uploads-prepare-008

- Vitest: "POST /api/uploads/prepare > falls back to a generic content type for unrecognized MIME values"
- Mode: run
- Given: A signed-in workspace member.
- When: The member calls `POST /api/uploads/prepare` for `capture.custom` with content type `Application/X-Custom; Version=1` and size 10.
- Then: The API responds with HTTP 200 with filename `capture.custom`, content type `application/octet-stream` and size 10.

## uploads-prepare-009

- Vitest: "POST /api/uploads/prepare > prepares Text/Markdown; Charset=\"UTF-8\" with compatible upload metadata"
- Mode: run
- Given: Row `Text/Markdown; Charset="UTF-8"`. A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `artifact.bin` (32 bytes) with that content type.
- Then: The API responds with HTTP 200 with content type `text/markdown; charset=utf-8`, and both the `legacy-file` registration and the signed upload use that content type.

## uploads-prepare-010

- Vitest: "POST /api/uploads/prepare > prepares Text/Plain; Charset=UTF-8 with compatible upload metadata"
- Mode: run
- Given: Row `Text/Plain; Charset=UTF-8`. A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `artifact.bin` (32 bytes) with that content type.
- Then: The API responds with HTTP 200 with content type `text/plain; charset=utf-8`, and both the `legacy-file` registration and the signed upload use that content type.

## uploads-prepare-011

- Vitest: "POST /api/uploads/prepare > prepares text/plain; charset=GB18030 with compatible upload metadata"
- Mode: run
- Given: Row `text/plain; charset=GB18030`. A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `artifact.bin` (32 bytes) with that content type.
- Then: The API responds with HTTP 200 with content type `text/plain; charset=gb18030`, and both the `legacy-file` registration and the signed upload use that content type.

## uploads-prepare-012

- Vitest: "POST /api/uploads/prepare > prepares text/markdown with compatible upload metadata"
- Mode: run
- Given: Row `text/markdown`. A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `artifact.bin` (32 bytes) with that content type.
- Then: The API responds with HTTP 200 with content type `text/markdown`, and both the `legacy-file` registration and the signed upload use that content type.

## uploads-prepare-013

- Vitest: "POST /api/uploads/prepare > prepares text/markdown; charset=unsupported-label with compatible upload metadata"
- Mode: run
- Given: Row `text/markdown; charset=unsupported-label`. A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `artifact.bin` (32 bytes) with that content type.
- Then: The API responds with HTTP 200 with the charset dropped (`text/markdown`), and both the `legacy-file` registration and the signed upload use `text/markdown`.

## uploads-prepare-014

- Vitest: "POST /api/uploads/prepare > prepares image/png; charset=utf-8 with compatible upload metadata"
- Mode: run
- Given: Row `image/png; charset=utf-8`. A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `artifact.bin` (32 bytes) with that content type.
- Then: The API responds with HTTP 200 with content type `image/png`, and both the `legacy-file` registration and the signed upload use `image/png`.

## uploads-prepare-015

- Vitest: "POST /api/uploads/prepare > returns presigned upload URL and final CDN URL with full body shape"
- Mode: run
- Given: A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `hello.txt` (`text/plain`, 13 bytes).
- Then: The API responds with HTTP 200 with filename, content type and size echoed, an HTTP(S) `uploadUrl`, a short `https://a.okou.io/<10 chars>.txt` URL, a UUID ID, and upload headers with the artifact ID, filename `hello.txt`, `okou` brand and the encoded user ID.

## uploads-prepare-016

- Vitest: "POST /api/uploads/prepare > uses flat 10-character keys and signed filename metadata"
- Mode: run
- Given: A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `财务 报告.PDF` (`application/pdf`).
- Then: The API responds with HTTP 200 with a short `https://a.okou.io/<10 chars>.pdf` URL that does not contain the user ID, and upload headers with the artifact ID, URL-encoded filename, `okou` brand and encoded user ID. The upload is signed for key `artifacts/<10 chars>.pdf` with the same metadata, and those four metadata headers are kept unhoisted (signed as headers).

## uploads-prepare-017

- Vitest: "POST /api/uploads/prepare > retries with a new artifact id when a flat hash is occupied"
- Mode: run
- Given: A signed-in user without an organization; the first candidate flat key prefix is already occupied in storage.
- When: The user calls `POST /api/uploads/prepare` for `hello.txt`.
- Then: The API responds with HTTP 200 with a short `https://a.okou.io/<10 chars>.txt` URL after checking two different key prefixes.

## uploads-prepare-018

- Vitest: "POST /api/uploads/prepare > rejects suspended orgs with insufficient credits"
- Mode: run
- Given: A signed-in workspace member whose unfunded Pro organization is suspended.
- When: The member calls `POST /api/uploads/prepare` for `hello.txt`.
- Then: The API responds with HTTP 402 with error code `INSUFFICIENT_CREDITS`.

## uploads-prepare-019

- Vitest: "POST /api/uploads/prepare > normalizes Stripe subscription lifecycle statuses for suspension checks"
- Mode: run
- Given: An onboarded workspace member whose plan subscription moves through Stripe statuses `trialing`, `past_due` and then `canceled`.
- When: The member calls `POST /api/uploads/prepare` for `hello.txt` after each status change.
- Then: The requests return HTTP 200 while `trialing` and `past_due`, and HTTP 402 with `INSUFFICIENT_CREDITS` once `canceled`.

## uploads-prepare-020

- Vitest: "POST /api/uploads/prepare > uses the public S3 endpoint for externally consumed upload URLs"
- Mode: run
- Given: A signed-in user without an organization; the internal S3 endpoint is `http://internal-s3.example.com` and the public S3 endpoint is `http://public-s3.example.com`.
- When: The user calls `POST /api/uploads/prepare` for `hello.txt`.
- Then: The API responds with HTTP 200, and an artifacts storage client is configured with the public endpoint, the artifacts credentials, region `auto`, virtual-host style and `WHEN_REQUIRED` checksums.

## uploads-prepare-021

- Vitest: "POST /api/uploads/prepare > preserves original filenames in metadata while using flat keys"
- Mode: run
- Given: A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `my file (1).txt` (`text/plain`, 10 bytes).
- Then: The upload is signed for the user-artifacts bucket with key `artifacts/<10 chars>.txt` that does not contain the user ID, and metadata with the URL-encoded original filename, `okou` brand and encoded user ID.

## uploads-prepare-022

- Vitest: "POST /api/uploads/prepare > accepts representative MIME types from the allowlist"
- Mode: run
- Given: A signed-in workspace member.
- When: The member calls `POST /api/uploads/prepare` (4096 bytes) for each of 26 representative files, including AVIF, HTML, MP3, ZIP, 7z, tar, gzip, PSD, AI, HEIC, TIFF, DOCX, XLSX, PPTX, Pages, Numbers, Keynote, XLSM, POTX, PDF, XML, YAML, TSV, Parquet, SQLite and EPUB.
- Then: Every request returns HTTP 200 echoing the filename and the declared content type.

## uploads-prepare-023

- Vitest: "POST /api/uploads/prepare > returns 403 for sandbox token without file:write capability"
- Mode: run
- Given: A sandbox-scoped token without the `file:write` capability.
- When: The caller calls `POST /api/uploads/prepare` for `hello.txt`.
- Then: The API responds with HTTP 403 `FORBIDDEN` with a message mentioning `file:write`.
