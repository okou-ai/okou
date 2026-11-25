# web-file-url

## web-file-url-001

- Vitest: "GET /api/web/file-url > returns 401 when no auth token is provided"
- Mode: run
- Given: The caller is unauthenticated.
- When: The caller sends `GET /api/web/file-url?file_id=abc` without an authorization header.
- Then: The API responds with HTTP 401 and error code `UNAUTHORIZED`.

## web-file-url-002

- Vitest: "GET /api/web/file-url > returns 403 for an agent token without file:read capability"
- Mode: run
- Given: An agent sandbox token for a user and organization carries only the `agent:read` capability.
- When: The agent sends `GET /api/web/file-url?file_id=abc`.
- Then: The API responds with HTTP 403 and error code `FORBIDDEN`.

## web-file-url-003

- Vitest: "GET /api/web/file-url > returns 404 without signing anything when the file does not exist"
- Mode: run
- Given: An organization member's agent token carries the `file:read` capability, and the artifact storage bucket has no object for the requested file.
- When: The agent sends `GET /api/web/file-url?file_id=missing`.
- Then: The API responds with HTTP 404 and error code `NOT_FOUND`, and no storage URL is signed.

## web-file-url-004

- Vitest: "GET /api/web/file-url > signs the resolved object key for the owning user"
- Mode: run
- Given: The clock is 2026-09-09 12:00:00.123 UTC. An organization member's agent token carries `file:read`, and the artifact bucket stores `artifacts/<userId>/<fileId>/photo.png` for that member.
- When: The agent sends `GET /api/web/file-url?file_id=<fileId>`.
- Then: The API responds with HTTP 200 whose `url` and `downloadUrl` are the presigned URL, `expiresAt` is 2026-09-11 12:00:00.000 UTC and `previewImageUrl` is null. Two URLs are signed for that bucket and key with a 172,800-second lifetime: a preview signed at the whole second, and a download signed at the exact time with `private, no-store` cache control and an `attachment; filename*=UTF-8''photo.png` disposition.

## web-file-url-005

- Vitest: "GET /api/web/file-url > reports the public artifacts url for the same object"
- Mode: run
- Given: Private artifact access keys are not configured. An organization member's agent token carries `file:read`, and the artifact bucket stores the member's `photo.png` file.
- When: The agent sends `GET /api/web/file-url?file_id=<fileId>`.
- Then: The API responds with HTTP 200 with `Cache-Control: private, no-store` and a `publicUrl` of `https://cdn.vm7.io/` followed by the object key.

## web-file-url-006

- Vitest: "GET /api/web/file-url > keeps preview inline and serves the separate download as an attachment"
- Mode: run
- Given: An organization member's agent token carries `file:read`, and the artifact bucket stores the member's `photo.png` file.
- When: The agent sends `GET /api/web/file-url?file_id=<fileId>`.
- Then: The API responds with HTTP 200. The preview URL is signed without a content disposition, and the download URL is signed with `attachment; filename*=UTF-8''photo.png`.

## web-file-url-007

- Vitest: "GET /api/web/file-url > does not sign a URL for a file owned by another user"
- Mode: run
- Given: Two organization members each have an agent token with `file:read`. The artifact bucket stores `private_notes.md` under the first member's user ID.
- When: The owner sends `GET /api/web/file-url?file_id=<fileId>`, then the other member requests the same file ID.
- Then: The owner's request returns HTTP 200. The other member's request returns HTTP 404 with `NOT_FOUND`, and only the owner's two URLs are signed.
