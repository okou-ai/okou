# hosted-upload-immutability

## hosted-upload-immutability-001

- Vitest: "issues normal 48-hour hosted PUT credentials without checksum binding"
- Mode: run
- Given: A signed-in member with a Pro entitlement is publishing a new hosted site with `/index.html` and a hashed asset `/assets/manifest-3f8c2d91.json`; S3 accepts uploads.
- When: The member calls `POST /api/host/deployments/prepare`, completes it with `POST /api/host/deployments/:deploymentId/complete`, and lists `GET /api/host/sites/dpl-<deploymentId>/files`.
- Then: Each file receives a presigned S3 PUT whose key contains the file path, with no SHA-256 checksum binding and an expiry of 172,800 seconds (48 hours). Completion writes exactly one `manifest.json` containing the deployment ID and `immutableContent: true`, and the file listing includes `/assets/manifest-3f8c2d91.json`.

## hosted-upload-immutability-002

- Vitest: "rejects uploads that would overwrite the server delivery manifest"
- Mode: run
- Given: A signed-in member with a Pro entitlement is publishing a new hosted site.
- When: The member calls `POST /api/host/deployments/prepare` with `/index.html` and a root `/manifest.json`.
- Then: The response is HTTP 400 with error message `Hosted-site path is reserved: /manifest.json`.

## hosted-upload-immutability-003

- Vitest: "rejects an asset whose name does not carry its content hash"
- Mode: run
- Given: A signed-in member with a Pro entitlement is publishing a new hosted site.
- When: The member calls `POST /api/host/deployments/prepare` with `/index.html` and the unhashed asset `/assets/app.css`.
- Then: The response is HTTP 400 with an error message containing `Hosted-site asset must carry a content hash in its file name: /assets/app.css`.

## hosted-upload-immutability-004

- Vitest: "preserves asset hashes across retained deployments even when a later deployment omits the asset"
- Mode: run
- Given: A signed-in member with a Pro entitlement published a site with `/assets/app-4f3a9c12.css`, then a second deployment that replaces it with `/assets/app-8b6e1d42.css`.
- When: The member prepares a third deployment that reuses the name `/assets/app-4f3a9c12.css` with different content, then prepares another deployment with the original content of that asset plus the second deployment's asset and new HTML (`POST /api/host/deployments/prepare`).
- Then: The second deployment keeps the same site ID with deployment version 2. The changed-content upload returns HTTP 409 with a message containing `Hosted-site asset changed without a new file name: /assets/app-4f3a9c12.css`. The unchanged-assets redeployment is accepted with the same site ID and public slug and deployment version 3.
