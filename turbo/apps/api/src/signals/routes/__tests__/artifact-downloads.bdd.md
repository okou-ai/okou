# artifact-downloads

## artifact-downloads-001

- Vitest: "keeps report.pdf uploads as single-file downloads"
- Mode: run
- Given: A Pro-entitled signed-in member has uploaded "report.pdf" (`application/pdf`) as an artifact through `POST /api/uploads/prepare` and `POST /api/uploads/complete`; a user without an organization exists.
- When: The member calls `GET /api/artifact-references/:reference/download` and `/read`, a run token with `host:read` calls `/files`; the member shares the file publicly through `PUT /api/artifact-shares`, the outsider downloads it, the member makes it private, and the outsider downloads again.
- Then: The owner's download is `kind: file` with the filename and content type and equals the legacy read body plus `kind: file`; the files request returns HTTP 404. After public sharing the outsider's download returns the file with a storage key under `private-artifacts/<fileId>/shares/<shareId>/` ending in the filename. After the file is made private the outsider gets HTTP 404 without `site` or `url`.

## artifact-downloads-002

- Vitest: "keeps standalone.html uploads as single-file downloads"
- Mode: run
- Given: A Pro-entitled signed-in member has uploaded "standalone.html" (`text/html`) as an artifact through `POST /api/uploads/prepare` and `POST /api/uploads/complete`; a user without an organization exists.
- When: The member calls `GET /api/artifact-references/:reference/download` and `/read`, a run token with `host:read` calls `/files`; the member shares the file publicly through `PUT /api/artifact-shares`, the outsider downloads it, the member makes it private, and the outsider downloads again.
- Then: The owner's download is a single `kind: file` download (not a site) equal to the legacy read body; the files request returns HTTP 404. After public sharing the outsider's download returns the file with a storage key under `private-artifacts/<fileId>/shares/<shareId>/` ending in the filename. After the file is made private the outsider gets HTTP 404 without `site` or `url`.

## artifact-downloads-003

- Vitest: "report.html previews do not reuse attachment-bearing download credentials"
- Mode: run
- Given: A Pro-entitled member uploads "report.html" (`text/html`) as an artifact; storage signs download disposition and cache-control into URLs.
- When: The member resolves `GET /api/artifact-references/:reference`; shares the file with the organization through `PUT /api/artifact-shares`; an organization member downloads it through `/download`; both resolve the shared reference; the file is shared publicly and read through `/public`, then made private and read again.
- Then: Every `downloadUrl` (owner, recipient and public) carries `attachment; filename*=UTF-8''report.html` with `private, no-store`, while each preview `url` has no content disposition; the recipient's download uses that disposition and the same object as their preview. The public download uses a share copy, and after the file is made private `/public` returns HTTP 404.

## artifact-downloads-004

- Vitest: "chart.svg previews do not reuse attachment-bearing download credentials"
- Mode: run
- Given: A Pro-entitled member uploads "chart.svg" (`image/svg+xml`) as an artifact; storage signs download disposition and cache-control into URLs.
- When: The member resolves `GET /api/artifact-references/:reference`; shares the file with the organization through `PUT /api/artifact-shares`; an organization member downloads it through `/download`; both resolve the shared reference; the file is shared publicly and read through `/public`, then made private and read again.
- Then: Every `downloadUrl` (owner, recipient and public) carries `attachment; filename*=UTF-8''chart.svg` with `private, no-store`, while each preview `url` has no content disposition; the recipient's download uses that disposition and the same object as their preview. The public download uses a share copy, and after the file is made private `/public` returns HTTP 404.

## artifact-downloads-005

- Vitest: "report.xml previews do not reuse attachment-bearing download credentials"
- Mode: run
- Given: A Pro-entitled member uploads "report.xml" (`application/xml`) as an artifact; storage signs download disposition and cache-control into URLs.
- When: The member resolves `GET /api/artifact-references/:reference`; shares the file with the organization through `PUT /api/artifact-shares`; an organization member downloads it through `/download`; both resolve the shared reference; the file is shared publicly and read through `/public`, then made private and read again.
- Then: Every `downloadUrl` (owner, recipient and public) carries `attachment; filename*=UTF-8''report.xml` with `private, no-store`, while each preview `url` has no content disposition; the recipient's download uses that disposition and the same object as their preview. The public download uses a share copy, and after the file is made private `/public` returns HTTP 404.

## artifact-downloads-006

- Vitest: "小猫 (draft)'*.png previews do not reuse attachment-bearing download credentials"
- Mode: run
- Given: A Pro-entitled member uploads "小猫 (draft)'*.png" (`image/png`) as an artifact; storage signs download disposition and cache-control into URLs.
- When: The member resolves `GET /api/artifact-references/:reference`; shares the file with the organization through `PUT /api/artifact-shares`; an organization member downloads it through `/download`; both resolve the shared reference; the file is shared publicly and read through `/public`, then made private and read again.
- Then: Every `downloadUrl` (owner, recipient and public) carries the percent-encoded `attachment; filename*=UTF-8''%E5%B0%8F%E7%8C%AB%20%28draft%29%27%2A.png` with `private, no-store`, while each preview `url` has no content disposition; the recipient's download uses that disposition and the same object as their preview. The public download uses a share copy, and after the file is made private `/public` returns HTTP 404.

## artifact-downloads-007

- Vitest: "public sites are cloneable outside their originating organization"
- Mode: run
- Given: A Pro-entitled member has deployed a public five-file hosted site; a user without an organization exists.
- When: The outsider reads the site's files through `GET /api/host/sites/:publicSlug/files` by public slug and by `dpl-<deploymentId>` slug.
- Then: Both reads return the deployment with all five files, the total size and file count, and each file's download URL is on `dpl-<deploymentId>.okou.app` under `/.okou/download/` with the file path as `path`.

## artifact-downloads-008

- Vitest: "free App previews respect the download paywall without blocking agent inputs"
- Mode: run
- Given: A free-plan signed-in member has uploaded "report.pdf" as an artifact.
- When: The member resolves `GET /api/artifact-references/:reference`, downloads through `/download`, a run token with `file:read` resolves it with `kind=file`, and after public sharing `/public` is read.
- Then: The App preview returns the filename, content type and URL with `downloadAllowed: false` and a `downloadUrl` pointing to `https://api.okou.ai/api/artifact-references/<reference>/download`. The download returns HTTP 402. The agent input resolution and the public preview both return a download URL.

## artifact-downloads-009

- Vitest: "pro App previews respect the download paywall without blocking agent inputs"
- Mode: run
- Given: A Pro-entitled signed-in member has uploaded "report.pdf" as an artifact.
- When: The member resolves `GET /api/artifact-references/:reference`, downloads through `/download`, a run token with `file:read` resolves it with `kind=file`, and after public sharing `/public` is read.
- Then: The App preview returns the filename, content type, URL and a download URL without a `downloadAllowed` flag. The download returns HTTP 200. The agent input resolution and the public preview both return a download URL.
