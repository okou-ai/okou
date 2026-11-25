# host.bdd

## host.bdd-001

- Vitest: "FILE-01: hosted-site deployments through host APIs > preserves history and aliases across out-of-order completion [HOST-A]"
- Mode: run
- Given: A Pro member prepares two versions of the same hosted site with `POST /api/host/deployments/prepare`.
- When: The member completes the second version and then the first with `POST /api/host/deployments/:deploymentId/complete`, reads files for each version by site alias plus version and by `dpl-<deploymentId>` alias, and reads `GET /api/host/sites/:site/deployments`.
- Then: Both prepares share one site ID with versions 1 and 2. The late first completion reports `isActive: false` and `activeDeploymentVersion: 2`, and the site alias serves the second version. Each version's files, by either target, return that version's deployment ID, artifact URL, and files, and each version's manifest was written to hosted-sites storage. History lists two deployments with the second active.

## host.bdd-002

- Vitest: "FILE-01: hosted-site deployments through host APIs > refuses completion by another member of the owner's organization"
- Mode: run
- Given: A member prepared a hosted site, and another member of the same workspace is signed in.
- When: The other member completes the deployment with `POST /api/host/deployments/:deploymentId/complete`, then the owner completes it.
- Then: The other member gets HTTP 404 and the owner's completion succeeds with `isActive: true`.

## host.bdd-003

- Vitest: "FILE-01: hosted-site deployments through host APIs > gives concurrent publications distinct versions after resubmitting allocation conflicts [HOST-A]"
- Mode: run
- Given: A member publishes a new hosted site name with no prior versions.
- When: The member sends three concurrent `POST /api/host/deployments/prepare` requests for the same site, resubmits any that returned HTTP 409, and reads the site's deployments.
- Then: Each conflict returns the message "Hosted site allocation changed. Retry publishing the same site." After resubmission all results share one site ID and the requested slug, are `private`, and have versions exactly {1, 2, 3}. History lists three deployments, each `uploading` with its version.

## host.bdd-004

- Vitest: "FILE-01: hosted-site deployments through host APIs > redeploys one site while keeping previous publication URLs and completion retries stable [HOST-A]"
- Mode: run
- Given: The public host domain is `okou-public-sites.test` over `http`, and a Pro member publishes a hosted site.
- When: The member prepares and completes the first version (twice), prepares and completes an updated version, completes the first version again, and reads files by the old `dpl-` alias, by site alias with version 1, and by site alias and new `dpl-` alias, and reads deployments.
- Then: The first prepare returns URL and alias URL `http://<site>.okou-public-sites.test`, version 1, and artifact URL `http://dpl-<deploymentId>.okou-public-sites.test`; the repeat completion is identical. The replacement keeps the same site, slug, and alias URL with a new artifact URL and version 2, and re-completing the first returns `isActive: false` with active version 2. The old alias and version 1 serve the original files; the site alias and new alias serve the updated `index.html`. History is exactly [version 2 active, version 1 inactive].

## host.bdd-005

- Vitest: "FILE-01: hosted-site deployments through host APIs > redeploys the same preferred slug more times than the collision retry limit [HOST-A]"
- Mode: run
- Given: A member publishes a hosted site name.
- When: The member prepares eight versions of the same site in sequence and reads its deployments.
- Then: All eight share one site ID and the requested slug, have eight distinct deployment IDs and versions 1 through 8, and history lists eight deployments.

## host.bdd-006

- Vitest: "FILE-01: hosted-site deployments through host APIs > publishes browser and dispatched Runner sites in the current layout [HOST-A]"
- Mode: run
- Given: The public host domain is `okou.app` over `https`, and an entitled member has a running chat Run whose execution provides an Okou token.
- When: The member prepares a site from the browser session; the Run token prepares and completes another site.
- Then: The browser site URL is `https://<site>.okou.app`. The Run-token site URL is `https://<site>.okou.app` with artifact URL `https://dpl-<deploymentId>.okou.app`. Completion writes the site's active pointer, deployment pointer, and manifest to hosted-sites storage with `publicBrand: "okou"`, the slug, and the deployment ID.

## host.bdd-007

- Vitest: "FILE-01: hosted-site deployments through host APIs > adds a four-character hash only when the simple alias is already occupied [HOST-A]"
- Mode: run
- Given: Another user already occupies a public slug, and an onboarded member requests a site with that same name.
- When: The member prepares and completes the hosted site.
- Then: The member's slug is the occupied slug plus `-` and four lowercase alphanumerics, version 1, with an artifact URL containing `dpl-<deploymentId>.`, and completion writes its manifest to hosted-sites storage.

## host.bdd-008

- Vitest: "FILE-01: hosted-site deployments through host APIs > serves owner file metadata after retrying incomplete uploads and gates suspended orgs [HOST-A]"
- Mode: run
- Given: A member whose workspace has an active but unfunded Pro subscription publishes a public SPA site with `/index.html` and `/assets/app-4f3a9c12.js`, and the script is initially missing from storage; a Pro outsider exists; the workspace's billing later becomes suspended.
- When: The member prepares, completes before and after the script upload, lists files with `GET /api/host/sites/:publicSlug/files`; the outsider lists them; the member prepares a second site, the workspace is suspended, and the member completes it and prepares again.
- Then: The prepare returns the slug, version 1, upload paths in order, and uses the hosted-sites credentials. The first completion returns HTTP 400 "Hosted deployment file was not uploaded: /assets/app-4f3a9c12.js"; the retry is `ready`, active version 1. The owner's listing shows two files with total size and sorted paths, sizes, and content types. The outsider sees the same listing plus download URLs on `dpl-<deploymentId>.okou.app` under `/.okou/download/` with the file path. While suspended, completion and prepare return HTTP 402 `INSUFFICIENT_CREDITS`.

## host.bdd-009

- Vitest: "FILE-01: hosted-site deployments through host APIs > rejects unauthenticated prepares [HOST-D]"
- Mode: run
- Given: An unauthenticated caller.
- When: The caller requests `POST /api/host/deployments/prepare` for a new site.
- Then: The API responds with HTTP 401 and error code `UNAUTHORIZED`.

## host.bdd-010

- Vitest: "CHAIN-BILLING-MEDIA/FILE-01: run-scoped agent-token attribution > attributes hosted-site artifacts through a run-scoped token [HOST-B]"
- Mode: run
- Given: A member who prefers `claude-fable-5-1` has a running chat Run whose execution token starts with `vm0_sandbox_`.
- When: The Run token prepares a hosted site with slug suffix `run-01` and completes it twice.
- Then: The prepare returns the requested slug and version 1, the completion is `ready`, and the repeat completion returns exactly the same result.
