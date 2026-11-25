# presigned-url-redaction

## presigned-url-redaction-001

- Vitest: "redactPresignedUrls > redacts an AWS-compatible presigned URL embedded in provider text"
- Mode: run
- Intent: review
- Given: The service returns error text in a JSON string. The text contains an AWS-compatible presigned object URL with signing parameters.
- When: The API sanitizes the serialized provider error.
- Then: The error remains `download failed: [redacted presigned URL]` inside the JSON string.

## presigned-url-redaction-002

- Vitest: "redactPresignedUrls > preserves ordinary public URLs"
- Mode: run
- Intent: review
- Given: The provider error text contains a public URL with a regular `version=latest` query parameter.
- When: The API sanitizes the provider error text.
- Then: The complete input text is preserved.
