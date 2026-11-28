# internal-api-url

## internal-api-url-001

- Vitest: "internalApiBaseUrl > uses OKOU_API_BACKEND_URL when set so internal API calls skip www"
- Mode: run
- Intent: review
- Given: The backend URL is `https://api.okou.ai` and the web URL is `https://www.okou.ai`.
- When: The API resolves the internal destination for processing usage events.
- Then: The base is `https://api.okou.ai` and the resolved destination is `https://api.okou.ai/api/cron/process-usage-events`.

## internal-api-url-002

- Vitest: "internalApiBaseUrl > defaults to the API backend origin in production when the backend URL is unset"
- Mode: run
- Intent: review
- Given: The deployment is in production, the backend URL is unset, and the web URL is `https://www.okou.ai`.
- When: The API resolves its base URL for internal calls.
- Then: The base is `https://vm0-api.vm6.ai`.

## internal-api-url-003

- Vitest: "internalApiBaseUrl > falls back to OKOU_WEB_URL outside production when the backend URL is unset"
- Mode: run
- Intent: review
- Given: The deployment is in development, the backend URL is unset, and the web URL is `https://tunnel-abc.vm0.dev`.
- When: The API resolves its base URL for internal calls.
- Then: The base is `https://tunnel-abc.vm0.dev`.
