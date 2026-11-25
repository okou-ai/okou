# web-url

## web-url-001

- Vitest: "web URL > rejects missing raw OKOU_WEB_URL input"
- Mode: run
- Intent: review
- Given: `OKOU_WEB_URL` is absent.
- When: The API initializes its environment configuration.
- Then: Initialization fails with an error containing `Invalid environment variables`.

## web-url-002

- Vitest: "web URL > rejects invalid raw OKOU_WEB_URL input"
- Mode: run
- Intent: review
- Given: `OKOU_WEB_URL` has the value `not-a-url`.
- When: The API initializes its environment configuration.
- Then: Initialization fails with an error containing `Invalid environment variables`.

## web-url-003

- Vitest: "web URL > accepts valid raw OKOU_WEB_URL input"
- Mode: run
- Intent: review
- Given: `OKOU_WEB_URL` is `https://configured.example.test/path`.
- When: The API initializes its environment configuration.
- Then: Initialization succeeds.

## web-url-004

- Vitest: "web URL > preserves Web URL bytes and OAuth origins"
- Mode: run
- Intent: review
- Given: The configured web URL is `https://www.vm6.ai/configured/path` and there is no explicitly configured backend URL.
- When: OAuth resolves the canonical redirect for `https://api.vm6.ai/api/connectors/github/callback?code=test`.
- Then: The configured web URL retains its path. The OAuth origins are `https://www.vm6.ai` for Web and `https://api.vm6.ai` for API. The canonical redirect is `https://www.vm6.ai/api/connectors/github/callback?code=test`.
