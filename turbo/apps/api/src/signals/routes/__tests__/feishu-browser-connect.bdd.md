# feishu-browser-connect

## feishu-browser-connect-001

- Vitest: "Feishu browser connection > returns a finite invalid-link error for rejected connection and status requests"
- Mode: run
- Given: A workspace member has a valid signed-in session and a validly shaped Feishu installation and chat link with a current timestamp but an invalid signature.
- When: The member submits the link to `POST /api/feishu/connect` and requests its status with `GET /api/feishu/connect/status`.
- Then: Both endpoints return HTTP 400 with error code `FEISHU_CONNECT_LINK_INVALID` and message `Invalid or expired bot connect link`.
