# discord-oauth-export

## discord-oauth-export-001

- Vitest: "downloads only the requesting owner's OAuth export content without capabilities through the normal export request"
- Mode: run
- Given: A signed-in Discord installer has a personal install consent and a pending connect attempt. A workspace peer has a separate pending attempt and binding, and another workspace has its own installation. The export service can write a downloadable archive.
- When: The installer starts `POST /api/user/export`, checks `GET /api/user/export` after completion, and downloads the ZIP.
- Then: The request returns HTTP 202 and the read returns HTTP 200 with the same job ID, `completed`, no error, and a working ZIP URL. The archive contains exactly the owner's pending connect attempt and personal install consent in their defined public schemas, with the requesting user, organization, and guild identities. It contains no installation-consent records, peer or other workspace identifiers, OAuth completion tokens, authorization state, or their SHA-256 hashes.
