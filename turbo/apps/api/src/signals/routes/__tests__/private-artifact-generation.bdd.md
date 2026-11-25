# private-artifact-generation

## private-artifact-generation-001

- Vitest: "managed artifact privacy > keeps generated images private through completion (guarded=false)"
- Mode: run
- Given: A signed-in member with ample credits has selected the `fal-ai/flux-pro/v1.1` image model. Fal accepts queued jobs and serves the generated JPEG at its source URL.
- When: The member queues an image with the ordinary `POST /api/image-io/generate` (not the private-only variant), Fal calls `POST /api/webhooks/built-in-generations/fal/:generationId` with a completed result, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/web/file-url?file_id=<id>`; then a different user in the same organization, the same user in another organization, and an unauthenticated caller request them.
- Then: The generation is `completed` with `privateArtifacts` true; the image is stored in the private artifacts bucket and the result URL is a stable `/artifacts/<10 chars>.jpg` link with no source or embed URL. Realtime events never include the Fal source URL, `cover_url`, private storage keys or signed URLs. The file URL returns HTTP 200 with a signed URL valid for 172,800 seconds and null `publicUrl` and `previewImageUrl`. The other user and other organization get HTTP 404 for both reads, and the unauthenticated file URL request returns 401.

## private-artifact-generation-002

- Vitest: "managed artifact privacy > keeps generated images private through completion (guarded=true)"
- Mode: run
- Given: A signed-in member with ample credits has selected the `fal-ai/flux-pro/v1.1` image model. Fal accepts queued jobs and serves the generated JPEG at its source URL.
- When: The member queues an image with `POST /api/image-io/generate/private` and `requirePrivateArtifact: true`, Fal calls `POST /api/webhooks/built-in-generations/fal/:generationId` with a completed result, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/web/file-url?file_id=<id>`; then a different user in the same organization, the same user in another organization, and an unauthenticated caller request them.
- Then: The generation is `completed` with `privateArtifacts` true; the image is stored in the private artifacts bucket and the result URL is a stable `/artifacts/<10 chars>.jpg` link with no source or embed URL. Realtime events never include the Fal source URL, `cover_url`, private storage keys or signed URLs. The file URL returns HTTP 200 with a signed URL valid for 172,800 seconds and null `publicUrl` and `previewImageUrl`. The other user and other organization get HTTP 404 for both reads, and the unauthenticated file URL request returns 401.

## private-artifact-generation-003

- Vitest: "managed artifact privacy > resolves an owned private input and keeps the stable reference in the next result"
- Mode: run
- Given: A signed-in member has completed a private image generation and holds its stable artifact URL.
- When: The member queues another image with `POST /api/image-io/generate` using that artifact URL in `imageUrls`, and Fal completes it.
- Then: The request sent to Fal contains a signed private URL (valid 172,800 seconds, for `private-artifacts/<id>/<filename>` in the private bucket) instead of the stable URL. The completed result lists the stable URL in `sourceImageUrls` and contains no signed URL.

## private-artifact-generation-004

- Vitest: "managed artifact privacy > does not forward another user's private reference or sign it for a provider"
- Mode: run
- Given: A member has completed a private image generation; a different user in the same organization knows its artifact URL and has selected an image model.
- When: The other user calls `POST /api/image-io/generate` with that artifact URL in `imageUrls`.
- Then: The request returns HTTP 400. No additional request reaches Fal and no new signed URL is created.

## private-artifact-generation-005

- Vitest: "managed artifact privacy > fails private completion without falling back to the public bucket when credentials are missing"
- Mode: run
- Given: A signed-in member with ample credits has selected the `fal-ai/flux-pro/v1.1` image model and queued an image with the ordinary `POST /api/image-io/generate` (HTTP 202); the private artifact storage access key is then unset.
- When: Fal posts a completed result to the generation's callback URL (`POST /api/webhooks/built-in-generations/fal/:generationId` with its token) and the member reads `GET /api/built-in-generations/:generationId`; later the key is configured again and Fal delivers the completion again.
- Then: The first callback returns HTTP 500; the generation read returns HTTP 200 still `running` with no result, and no JPEG object is stored in any bucket. After the key is restored, the retried callback returns HTTP 200 and the generation reads `completed` with a result URL containing `/artifacts/`.
