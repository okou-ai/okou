# vercel-build

## vercel-build-001

- Vitest: "Vercel build > preserves dispatch socket ownership through the native Runner transport"
- Mode: run
- Intent: review
- Given: The API package includes the native Runner dispatch transport conformance probe.
- When: The Vercel build test launches the probe through Node.
- Then: The child process exits with code 0. Its transport cases are registered in the standalone Node suite.

## vercel-build-002

- Vitest: "Vercel build > preserves request bodies, cookies and streaming through the generated Node listener"
- Mode: run
- Intent: review
- Given: The production Vercel build configuration builds an app with a binary echo, an output stream and an endpoint that releases the second stream chunk.
- When: A caller posts bytes `[0, 1, 127, 128, 255]` to `/echo?source=preview`. It then requests `GET /stream`, reads the first chunk and sends `POST /release`.
- Then: The echo responds with HTTP 201, path `/echo`, type `application/octet-stream`, both separate HttpOnly cookies with `Path=/`, and the exact original bytes. The stream returns HTTP 200 and yields `first` before the release. The release responds with HTTP 204 and the remaining stream is `second`.
