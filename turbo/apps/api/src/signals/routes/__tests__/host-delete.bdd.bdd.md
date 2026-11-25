# host-delete.bdd

## host-delete.bdd-001

- Vitest: "FILE-01: hosted-site deletion through host APIs > takes every version offline and restores the address as a new version on redeploy [HOST-A]"
- Mode: run
- Given: A Pro member published two versions of a hosted site through `POST /api/host/deployments/prepare` and `POST /api/host/deployments/:deploymentId/complete`, and has a third version prepared but not completed. Another Pro user exists.
- When: The owner deletes the site with `DELETE /api/host/sites/:publicSlug`, reads deployments and files, tries to complete the pending version, deletes again, then prepares and completes a new version.
- Then: The delete returns exactly the site ID, slug, alias URL, and `offlineUrls` [alias, second version URL, first version URL], and the hosted-sites storage the host Worker reads no longer has the site pointer, HTML delivery record, three deployment pointers, or two version delivery records. Deployment history has no active deployment and three `deleted` versions. Alias files return HTTP 409 "Hosted site has no active deployment", a version's files return HTTP 409 "Hosted deployment is deleted", the other user gets HTTP 404, and completing the pending version returns HTTP 409 "Hosted deployment is deleted". The repeat delete returns the same result. The redeploy completes on the same site and alias URL as active version 4, the site pointer names it, old version files still return HTTP 409, and history reads [4 ready, 3 deleted, 2 deleted, 1 deleted].

## host-delete.bdd-002

- Vitest: "FILE-01: hosted-site deletion through host APIs > lets only the site owner delete [HOST-D]"
- Mode: run
- Given: A Pro member published a hosted site; an admin of the same workspace and an unauthenticated caller also exist.
- When: The workspace admin and the unauthenticated caller each request `DELETE /api/host/sites/:publicSlug`, and the owner reads `GET /api/host/sites/:publicSlug/files`.
- Then: The admin gets HTTP 404 "Hosted site not found" and the unauthenticated caller gets HTTP 401. No hosted-site storage object is deleted, and the owner's files still come from the published deployment.

## host-delete.bdd-003

- Vitest: "FILE-01: hosted-site deletion through host APIs > rejects a delayed completion after deletion and preserves a new redeploy [HOST-A]"
- Mode: run
- Given: A Pro member prepared a first hosted-site version, and its completion stalls while writing the version's deployment pointer to storage.
- When: While that completion is stalled, the owner deletes the site, prepares and completes a replacement version, and then the stalled completion resumes.
- Then: The stalled completion returns HTTP 409 "Hosted deployment is deleted". The site's files come from the replacement at version 2, the stalled version's files return HTTP 409, its deployment pointer and version delivery record are absent from storage, and the site pointer names the replacement.

## host-delete.bdd-004

- Vitest: "FILE-01: hosted-site deletion through host APIs > keeps the site offline when deletion wins an overlapping publication [HOST-A]"
- Mode: run
- Given: A Pro member prepared a first hosted-site version, and its completion stalls while writing the site's active pointer to storage.
- When: The owner deletes the site while the completion is stalled, the completion then resumes, and the owner reads files and deployments and redeploys.
- Then: The completion returns HTTP 409 "Hosted deployment is deleted" and the version's deployment pointer is absent. Version and alias files return HTTP 409, history shows no active deployment and a `deleted` version. The redeploy completes on the same site and alias URL as active version 2.

## host-delete.bdd-005

- Vitest: "FILE-01: hosted-site deletion through host APIs > lets publication complete while deletion waits for storage, then takes it offline [HOST-A]"
- Mode: run
- Given: A Pro member published a first hosted-site version and prepared a second; the site deletion stalls at its first storage delete batch.
- When: While the deletion is stalled, the owner completes the second version and reads files; the deletion then resumes and the owner reads files and deployments.
- Then: The second version completes as active with `activeDeploymentVersion: 2` and its files are served during the stall. After the deletion finishes, alias and version files return HTTP 409, history shows no active deployment with both versions `deleted`, and the site's active pointer is absent from storage.

## host-delete.bdd-006

- Vitest: "FILE-01: hosted-site deletion through host APIs > retries a partial remote deletion without losing version history or the site address [HOST-A]"
- Mode: run
- Given: A Pro member published one hosted-site version, and the first storage delete batch removes one object but reports an internal error for another.
- When: The owner requests `DELETE /api/host/sites/:publicSlug`, reads deployments, deletes again, reads deployments, and then publishes a replacement version.
- Then: The first delete returns HTTP 500 and the version stays active and `ready`. The retry succeeds: no active deployment, the version is `deleted`, and the site and deployment pointers are absent from storage. The replacement completes on the same site and alias URL as active version 2, and the old version's files return HTTP 409.
