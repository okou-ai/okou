# marketing-handoffs

## marketing-handoffs-001

- Vitest: "Marketing content handoff > rejects the special filename \".\" before storing content"
- Mode: run
- Given: A signed-in user is on the trusted marketing origin `https://www.okou.ai`.
- When: The user calls `POST /api/marketing-handoffs/files` with a text file named `.`.
- Then: The API responds with HTTP 400.

## marketing-handoffs-002

- Vitest: "Marketing content handoff > rejects the special filename \"..\" before storing content"
- Mode: run
- Given: A signed-in user is on the trusted marketing origin `https://www.okou.ai`.
- When: The user calls `POST /api/marketing-handoffs/files` with a text file named `..`.
- Then: The API responds with HTTP 400.

## marketing-handoffs-003

- Vitest: "Marketing content handoff > keeps identical content stable, versions edits, and leaves the old manifest readable"
- Mode: run
- Given: A signed-in user is on the trusted marketing origin.
- When: The user submits the same version-1 manifest twice and an edited manifest with `POST /api/marketing-handoffs`, then resolves the first by full hash and by short hash with `POST /api/marketing-handoffs/:hash/resolve`.
- Then: The `shortHash` is the first 12 characters of the hash. The duplicate returns the same hash and the edit returns a different hash. Both resolves return HTTP 200 with exactly the original manifest.

## marketing-handoffs-004

- Vitest: "Marketing content handoff > rejects a colliding short address without overwriting or granting access to the first task"
- Mode: run
- Given: A signed-in user has submitted a handoff manifest. A second signed-in user has a different manifest whose hash shares the same 12-character short address.
- When: The second user submits the colliding manifest with `POST /api/marketing-handoffs` and then resolves the first user's short hash; the first user then resolves it.
- Then: The colliding submission returns HTTP 409 and the second user's resolve returns HTTP 404. The first user's resolve returns HTTP 200 with exactly the first manifest.

## marketing-handoffs-005

- Vitest: "Marketing content handoff > reserves a short address for only one of two concurrent colliding tasks"
- Mode: run
- Given: A signed-in user has two different manifests whose hashes share the short address `23aab54ca8ed`.
- When: The user submits both manifests concurrently with `POST /api/marketing-handoffs` and then resolves `23aab54ca8ed`.
- Then: One submission returns HTTP 200 and the other HTTP 409. The short address resolves with HTTP 200 to the manifest whose submission succeeded.

## marketing-handoffs-006

- Vitest: "Marketing content handoff > returns not found for an unknown short address"
- Mode: run
- Given: A signed-in user is on the trusted marketing origin.
- When: The user calls `POST /api/marketing-handoffs/000000000000/resolve` for an unknown short address.
- Then: The API responds with HTTP 404.

## marketing-handoffs-007

- Vitest: "Marketing content handoff > does not grant another user access merely because they know the hash"
- Mode: run
- Given: One signed-in user has submitted a handoff manifest; a different signed-in user knows its short hash.
- When: The second user calls `POST /api/marketing-handoffs/:hash/resolve` with that short hash.
- Then: The API responds with HTTP 404.

## marketing-handoffs-008

- Vitest: "Marketing content handoff > gives independent grants to two users who submit identical content"
- Mode: run
- Given: Two different signed-in users submit identical manifest content.
- When: Each user calls `POST /api/marketing-handoffs`, then the first user resolves the handoff with `POST /api/marketing-handoffs/:hash/resolve`.
- Then: Both submissions return the same hash, and the first user's resolve still returns HTTP 200.

## marketing-handoffs-009

- Vitest: "Marketing content handoff > reuses the handoff transport across independent requests"
- Mode: run
- Intent: review
- Given: A signed-in user on the trusted origin, with marketing handoff storage configured with access key `test-marketing-key`.
- When: The user submits three different manifests with `POST /api/marketing-handoffs`.
- Then: Every storage client created for these requests shares the same request transport and uses the configured marketing handoff access key and secret.

## marketing-handoffs-010

- Vitest: "Marketing content handoff > authorizes every account with the same cookie and retains their independent grants"
- Mode: run
- Given: A browser obtains a guest handoff cookie from `POST /api/marketing-handoffs/session` (HttpOnly, Secure, no Domain) and submits a manifest without signing in.
- When: Three different signed-in accounts each resolve the handoff with the cookie and then without it; a fourth account resolves without a cookie and with its own unrelated guest cookie; finally the first account resolves without a cookie.
- Then: Each of the three accounts gets HTTP 200 both with and without the cookie. The fourth account gets HTTP 404 in both cases. The first account still gets HTTP 200 without a cookie.

## marketing-handoffs-011

- Vitest: "Marketing content handoff > does not authorize a new account with an expired cookie"
- Mode: run
- Given: A browser has a guest handoff cookie and submitted a manifest without signing in. One account resolved it with the cookie. The clock then advances more than 7 days.
- When: The same account resolves without the cookie, and a new signed-in account resolves with the expired cookie via `POST /api/marketing-handoffs/:hash/resolve`.
- Then: The account that already received the handoff gets HTTP 200, and the new account gets HTTP 404.

## marketing-handoffs-012

- Vitest: "Marketing content handoff > shares authenticated submissions and their files with the submitting browser session"
- Mode: run
- Given: A signed-in user has a guest handoff cookie, uploads `shared.txt` with `POST /api/marketing-handoffs/files`, and submits a manifest with that file using the cookie.
- When: A second account resolves it with the cookie, submits an edited manifest with the same file and cookie, and imports it with `POST /api/marketing-handoffs/:hash/import`; a third account then submits another edit with the file and resolves the second account's edit with the cookie.
- Then: The second account's resolve returns HTTP 200 and its import returns the file with the uploaded filename and size. The third account's submission succeeds and its resolve returns HTTP 200.

## marketing-handoffs-013

- Vitest: "Marketing content handoff > rejects a tampered guest session"
- Mode: run
- Given: A browser has a guest handoff cookie and submitted a manifest without signing in.
- When: A signed-in user resolves the handoff with a tampered copy of the cookie.
- Then: The API responds with HTTP 404.

## marketing-handoffs-014

- Vitest: "Marketing content handoff > authorizes two accounts receiving from the same browser session concurrently"
- Mode: run
- Given: A browser has a guest handoff cookie and submitted a manifest without signing in. Two different signed-in accounts use that browser.
- When: Both accounts call `POST /api/marketing-handoffs/:hash/resolve` concurrently with the same cookie.
- Then: Both requests return HTTP 200.

## marketing-handoffs-015

- Vitest: "Marketing content handoff > keeps guest-uploaded files authorized after sign-in and prompt editing"
- Mode: run
- Given: A guest browser with a handoff cookie uploads `guest.txt` without signing in and submits a manifest that includes it.
- When: The user signs in and resolves the handoff with the cookie, submits an edited prompt with the same file, and imports the edit with `POST /api/marketing-handoffs/:hash/import`.
- Then: The resolve returns HTTP 200, the edit gets a new hash, and the import returns HTTP 200.

## marketing-handoffs-016

- Vitest: "Marketing content handoff > cannot attach another account's file by hash"
- Mode: run
- Given: One signed-in user uploads `notes.txt` with `POST /api/marketing-handoffs/files`.
- When: A different signed-in user submits a manifest with `POST /api/marketing-handoffs` that references the first user's uploaded file.
- Then: The API responds with HTTP 404.

## marketing-handoffs-017

- Vitest: "Marketing content handoff > imports files privately with stable identities on retry"
- Mode: run
- Given: A signed-in user uploads `notes.txt` and submits a manifest that includes it.
- When: The user imports it with `POST /api/marketing-handoffs/:hash/import` and an intent ID, retries with the short hash and the same intent ID, imports again with a new intent ID, and requests `GET /api/web/file-url` for the imported file as themselves and as another user.
- Then: The retry returns exactly the same result as the first import, which contains one file `notes.txt`. The new intent yields a different file ID. The owner's file URL request returns HTTP 200 and the other user's returns HTTP 404.

## marketing-handoffs-018

- Vitest: "Marketing content handoff > rejects a manifest whose declared size differs from uploaded bytes"
- Mode: run
- Given: A signed-in user uploaded `notes.txt` with `POST /api/marketing-handoffs/files`.
- When: The user submits a manifest with `POST /api/marketing-handoffs` that declares the file size as 1 byte.
- Then: The API responds with HTTP 400.

## marketing-handoffs-019

- Vitest: "Marketing content handoff > rejects requests from another origin even when the user is authenticated"
- Mode: run
- Given: A signed-in user sends a request from the origin `https://untrusted.example`.
- When: The user calls `POST /api/marketing-handoffs` with a valid manifest.
- Then: The API responds with HTTP 403.
