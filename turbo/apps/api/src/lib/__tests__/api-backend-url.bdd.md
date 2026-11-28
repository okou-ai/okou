# api-backend-url

## api-backend-url-001

- Vitest: "API backend URL > returns the canonical URL byte-for-byte"
- Mode: run
- Intent: review
- Given: `OKOU_API_BACKEND_URL` is set to a URL containing a path, query and fragment.
- When: The API reads its configured backend URL.
- Then: It obtains the exact configured string, including the path, query and fragment.

## api-backend-url-002

- Vitest: "API backend URL > returns undefined when the canonical input is absent"
- Mode: run
- Intent: review
- Given: `OKOU_API_BACKEND_URL` is unset.
- When: The API reads its configured backend URL.
- Then: It obtains no value.

## api-backend-url-003

- Vitest: "OAuth API origin > keeps OAuth configured-origin normalization and sibling/web fallbacks"
- Mode: run
- Intent: review
- Given: An OAuth request targets `https://request.example.test/oauth`. The deployment can have an explicit backend URL, a known sibling web host, or an external web host.
- When: OAuth resolves its API origin for each of those three configurations.
- Then: With backend URL `https://api.okou.ai/configured/path` and web URL `https://www.okou.ai`, the origin is `https://api.okou.ai`. With no backend URL and web URL `https://www.vm6.ai`, it is `https://api.vm6.ai`. With no backend URL and web URL `https://external.example.test/path`, it is `https://external.example.test`.
