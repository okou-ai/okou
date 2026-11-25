# browser-body-policy

## browser-body-policy-001

- Vitest: "Browser input request body policy > rejects a declared body above the limit before JSON parsing"
- Mode: run
- Given: A signed-in workspace member.
- When: The member sends `POST /api/browser/user-actions/:id/apply` with a JSON content type, a `content-length` one byte above the Browser input body limit, and the body `{`.
- Then: The API responds with HTTP 400 and the error message "Browser input request is too large" (the body is not parsed as JSON).

## browser-body-policy-002

- Vitest: "Browser input request body policy > bounds actual streamed bytes and cancels the producer with content-length=undefined"
- Mode: run
- Given: A signed-in workspace member streams a request body whose character count fits the Browser input body limit but whose UTF-8 encoding (because of an `é`) is one byte over it, in 64 KiB chunks.
- When: The member sends `POST /api/browser/user-actions/:id/apply` with a JSON content type and no `content-length` header.
- Then: The API responds with HTTP 400 and the error message "Browser input request is too large". The request body stream is cancelled before it is fully read and is left unlocked.

## browser-body-policy-003

- Vitest: "Browser input request body policy > bounds actual streamed bytes and cancels the producer with content-length=1"
- Mode: run
- Given: A signed-in workspace member streams a request body whose character count fits the Browser input body limit but whose UTF-8 encoding (because of an `é`) is one byte over it, in 64 KiB chunks.
- When: The member sends `POST /api/browser/user-actions/:id/apply` with a JSON content type and a misleading `content-length: 1` header.
- Then: The API responds with HTTP 400 and the error message "Browser input request is too large". The request body stream is cancelled before it is fully read and is left unlocked.

## browser-body-policy-004

- Vitest: "Browser input request body policy > accepts the exact byte limit and decodes UTF-8 across stream chunks"
- Mode: run
- Given: A signed-in workspace member has a valid JSON input body (a `name` value of `é`) padded with spaces to exactly the Browser input body limit in bytes, streamed in two chunks split inside the `é` character.
- When: The member sends `POST /api/browser/user-actions/:id/apply` for an unknown user action with `content-length` equal to the limit.
- Then: The body is accepted and decoded, and the request reaches the normal lookup: the API responds with HTTP 404 and error code `BROWSER_USER_ACTION_NOT_FOUND`.

## browser-body-policy-005

- Vitest: "Browser input request body policy > preserves JSON and schema validation for {"
- Mode: run
- Given: A signed-in workspace member.
- When: The member sends `POST /api/browser/user-actions/:id/apply` with a JSON content type and the malformed body `{`.
- Then: The API responds with HTTP 400 and the error message "Invalid JSON in request body".

## browser-body-policy-006

- Vitest: "Browser input request body policy > preserves JSON and schema validation for {\"values\":\"invalid\"}"
- Mode: run
- Given: A signed-in workspace member.
- When: The member sends `POST /api/browser/user-actions/:id/apply` with the body `{"values":"invalid"}`.
- Then: The API responds with HTTP 400 and the error message "values: Invalid input: expected array, received string".
