# host-preview

## host-preview-001

- Vitest: "sandbox hosted previews > preserves original image/png bytes and file identity"
- Mode: run
- Given: Row `image/png`. A signed-in member prepares a hosted site via `POST /api/host/deployments/prepare` declaring a PNG preview (size, SHA-256, content type) and uploads the exact bytes to the returned upload URL.
- When: The member completes the deployment with `POST /api/host/deployments/:deploymentId/complete`, resolves the preview reference with `GET /api/artifact-references/:reference`, and completes the deployment again.
- Then: The prepare response echoes the declared SHA-256 and the upload returns HTTP 200. The completed `previewImageUrl` ends in `.png`, storage holds exactly the original bytes, written with content type `image/png` and `IfNoneMatch: "*"`. The reference resolves with `contentType: "image/png"` and filename `preview-<sha256>.png`. The repeat completion returns the same preview URL and storage still holds only the original bytes.

## host-preview-002

- Vitest: "sandbox hosted previews > preserves original image/jpeg bytes and file identity"
- Mode: run
- Given: Row `image/jpeg`. A signed-in member prepares a hosted site via `POST /api/host/deployments/prepare` declaring a JPEG preview (size, SHA-256, content type) and uploads the exact bytes to the returned upload URL.
- When: The member completes the deployment with `POST /api/host/deployments/:deploymentId/complete`, resolves the preview reference with `GET /api/artifact-references/:reference`, and completes the deployment again.
- Then: The prepare response echoes the declared SHA-256 and the upload returns HTTP 200. The completed `previewImageUrl` ends in `.jpg`, storage holds exactly the original bytes, written with content type `image/jpeg` and `IfNoneMatch: "*"`. The reference resolves with `contentType: "image/jpeg"` and filename `preview-<sha256>.jpg`. The repeat completion returns the same preview URL and storage still holds only the original bytes.

## host-preview-003

- Vitest: "sandbox hosted previews > resolves published covers and authorizes them through the current Site policy"
- Mode: run
- Given: A signed-in member published a public hosted site with an uploaded PNG cover; a user from another workspace also exists.
- When: The owner requests `GET /api/host/sites/:publicSlug/preview?hostname=<slug>.okou.app` twice, the outsider requests it, the owner switches visibility to `private` with `PATCH /api/host/sites/:siteId/visibility` (using the current revision), and both request the preview again.
- Then: The owner's preview has an `https://pv-` session URL, a non-null `expiresAt`, and a cover URL pointing into private artifact storage; the repeat read is identical. The outsider gets the public `https://<slug>.okou.app/` URL, `expiresAt: null`, and the same cover URL. After the site becomes private, the owner still gets the same cover with a `pv-` URL, and the outsider gets HTTP 404.

## host-preview-004

- Vitest: "sandbox hosted previews > reads authored HTML metadata with the hosted-sites credentials even without an uploaded cover"
- Mode: run
- Given: A signed-in member published a public hosted site without a cover whose `index.html` has the title "Morning coffee", a description meta tag "Fresh coffee daily", and a relative `og:image`.
- When: An anonymous caller requests `GET /api/artifact-og/metadata?kind=host&id=<deploymentId>`.
- Then: The response has `available: true`, title "Morning coffee", and description "Fresh coffee daily". Storage is read with the hosted-sites credentials and never with the general storage credentials.

## host-preview-005

- Vitest: "sandbox hosted previews > redirects to the original published cover anonymously, retains older versions, and revokes OG on deletion"
- Mode: run
- Given: A signed-in member prepares a public hosted site whose HTML title is "Quarterly &amp; Annual" with description "Public summary", declaring a PNG cover.
- When: An anonymous caller reads `GET /api/artifact-og/metadata` before and after the owner uploads the cover and completes the deployment, requests `GET /api/artifact-og/image` with the advertised version (default and `variant=slack`), with a wrong version, and `GET /api/artifact-og/default.png`; the owner publishes a second version with a different cover and later deletes the site.
- Then: Before completion the metadata is exactly `{ available: false }`; afterwards it is available with title "Quarterly & Annual", the description, an image URL through `/cdn-cgi/image/`, and no private storage path. The image request redirects (HTTP 302) to the original stored cover bytes, the Slack variant to the same location, with `Cache-Control: private, no-store` and CDN `no-store`. The default image and wrong-version requests redirect to the brand image. After the second version the original version still redirects to the original cover. After deletion the metadata is exactly `{ available: false }` and the image redirects to the brand image.

## host-preview-006

- Vitest: "sandbox hosted previews > keeps the active HTML cover in the catalog across late completions and retries"
- Mode: run
- Given: An entitled member has a running chat Run, and the Run's token is used as the caller.
- When: The Run token reads `GET /api/feature-switches`, tries to update and delete switches, prepares two versions of a public hosted site with different PNG covers, uploads both, completes the second then the first, completes the second again; the member lists `GET /api/artifacts/catalog`, and the member and an outsider resolve the latest cover reference.
- Then: The switch read returns `Cache-Control: private, no-store` and the update and delete return HTTP 403. The late first completion is not active and has a different cover URL; the latest cover URL matches `/artifacts/<id>.png` and the repeat completion returns it. The catalog contains exactly one hosted-site artifact with that title and the latest cover as thumbnail. The member resolves the reference with HTTP 200 and the outsider gets HTTP 404.

## host-preview-007

- Vitest: "sandbox hosted previews > retries a sealed cover after staging cleanup fails without activating it early"
- Mode: run
- Given: An entitled member's running chat Run prepares a hosted site with a JPEG cover and uploads it, and the first cleanup of the staging upload fails.
- When: The Run token completes the deployment, reads the site's deployments, completes again twice, and the member lists `GET /api/artifacts/catalog`.
- Then: The first completion returns HTTP 500, the site has no active deployment, the deployment is still `uploading`, and storage holds two objects. The retry activates it with a `.jpg` cover URL, leaving exactly one stored object with the original bytes that is not the staging upload. The next completion returns the same cover URL, and the catalog holds exactly one hosted-site artifact with that cover as thumbnail.

## host-preview-008

- Vitest: "sandbox hosted previews > does not activate missing or integrity-mismatched previews and permits repair"
- Mode: run
- Given: A signed-in member prepares a hosted site declaring a PNG cover.
- When: The member completes before uploading, after uploading incomplete bytes, and after uploading bytes with a changed first byte; reads deployments; uploads the correct bytes and completes; then overwrites the upload URL with other bytes and completes again.
- Then: Each of the three early completions returns HTTP 400, the site has no active deployment, and the deployment is still `uploading`. After the correct upload the completion returns a cover URL and no staging upload object remains. After the staging overwrite, completion returns the same cover URL and the sealed stored bytes are unchanged.
