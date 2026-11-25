# instructions

## instructions-001

- Vitest: "Personal Instructions > notifies the owner after publishing new personal Instructions"
- Mode: run
- Given: A signed-in workspace member.
- When: The member saves personal Instructions with `PUT /api/instructions` and reads them back with `GET /api/instructions`.
- Then: A realtime `personalInstructionsChanged` event (payload null) is published on the member's `user:<userId>` channel, and the read returns the member's user and workspace IDs with the new content.

## instructions-002

- Vitest: "Personal Instructions > reads the default until each member/workspace saves its own value"
- Mode: run
- Given: Alice and Bob are signed-in members of the same workspace, and Alice also belongs to another workspace; none has saved personal Instructions.
- When: Each member/workspace pair reads `GET /api/instructions`, then saves its own content with `PUT /api/instructions` (Alice saves text with a BOM, CRLF, Chinese characters and surrounding whitespace); Alice reads again, then saves an empty string and reads again.
- Then: Each pair first reads the seed default Instructions with its own user and workspace IDs, unaffected by the others' saves. Alice's original workspace then returns her raw content exactly as saved, and after saving an empty string the content is empty.

## instructions-003

- Vitest: "Personal Instructions > protects newer saves with a version while allowing an explicit unconditional replace"
- Mode: run
- Given: A signed-in member has read the current Instructions version.
- When: The member sends two concurrent `PUT /api/instructions` saves (`one`, `two`) with that version, a third save `stale` with the old version, and finally an unconditional save `unconditional` without a version.
- Then: The concurrent saves return one HTTP 200 and one HTTP 409, and the current content is one of the two with a new version. The stale save returns HTTP 409 and leaves the read unchanged. The unconditional save succeeds and the content becomes `unconditional`.

## instructions-004

- Vitest: "Personal Instructions > does not let a peer or admin choose another personal owner"
- Mode: run
- Given: Alice has saved personal Instructions `Alice private`, and a workspace admin in the same workspace is signed in.
- When: The admin sends `PUT /api/instructions` with Alice's version, then a raw `PUT /api/instructions` whose body includes Alice's `userId`; the admin and then Alice read `GET /api/instructions`.
- Then: The versioned save returns HTTP 409 and the request naming another user returns HTTP 400. The admin still reads the seed default under the admin's own identity, and Alice still reads `Alice private`.

## instructions-005

- Vitest: "Personal Instructions > keeps the saved value when publication fails at class HeadObjectCommand {\n\t\tinput;\n\t\tconstructor(input) {\n\t\t\tthis.input = input;\n\t\t}\n\t} and permits a later retry"
- Mode: run
- Given: A signed-in member has published Instructions `published`, and the storage existence check (S3 HEAD) used to publish Instructions fails (row: `HeadObjectCommand`).
- When: The member saves `not published` with `PUT /api/instructions`; after storage recovers, the member saves `retry` and reads `GET /api/instructions`.
- Then: The failing save returns HTTP 500 and the read is unchanged from before. After recovery the save succeeds and the content is `retry`.

## instructions-006

- Vitest: "Personal Instructions > keeps the saved value when publication fails at class PutObjectCommand {\n\t\tinput;\n\t\tconstructor(input) {\n\t\t\tthis.input = input;\n\t\t}\n\t} and permits a later retry"
- Mode: run
- Given: A signed-in member has published Instructions `published`, and the storage write (S3 PUT) used to publish Instructions fails (row: `PutObjectCommand`).
- When: The member saves `not published` with `PUT /api/instructions`; after storage recovers, the member saves `retry` and reads `GET /api/instructions`.
- Then: The failing save returns HTTP 500 and the read is unchanged from before. After recovery the save succeeds and the content is `retry`.

## instructions-007

- Vitest: "Personal Instructions > retains personal content across departure and rejoin"
- Mode: run
- Given: A signed-in member has saved personal Instructions in a workspace.
- When: A signed Clerk `organizationMembership.deleted` webhook for that member and workspace arrives at `POST /api/webhooks/clerk`, and the member later reads `GET /api/instructions` in the same workspace.
- Then: The webhook returns HTTP 200 and the read is identical to the one before departure.
