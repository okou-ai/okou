# chat-thread-pdf-filename

## chat-thread-pdf-filename-001

- Vitest: "PDF filename generation > names only selected canonical messages, sanitizes the base, and generates again without caching"
- Mode: run
- Given: An authenticated member owns a thread containing eligible canonical messages, plus private text outside the selected set. The text provider returns a quoted filename with a slash and a PDF suffix, then a different filename.
- When: The member requests a PDF filename for selected messages twice, then requests it again with a repeated selected ID.
- Then: All requests return HTTP 200. The first body is "Solar Payback" with `private, no-store`, and the second is "Solar costs". There are three provider calls using the selected content and no private unselected text, with Gemini 3.1 Flash Lite verified on the first call. Duplicate selected IDs are accepted.

## chat-thread-pdf-filename-002

- Vitest: "PDF filename generation > returns an empty filename when generation fails or is unusable"
- Mode: run
- Given: An authenticated thread owner selects valid messages, and the provider either rate-limits generation, returns only unusable filename characters, or is unconfigured.
- When: The member requests a filename under each condition.
- Then: Each request returns HTTP 200 with an empty filename.

## chat-thread-pdf-filename-003

- Vitest: "PDF filename generation > bounds generated filenames"
- Mode: run
- Given: An authenticated thread owner selects valid messages and the text provider returns a long string of Chinese characters.
- When: The member requests a filename for the selection.
- Then: HTTP 200 returns a filename of 48 Unicode code points.

## chat-thread-pdf-filename-004

- Vitest: "PDF filename generation > protects thread ownership, organization and the entire selected event set before generation"
- Mode: run
- Given: A workspace member owns a thread with valid canonical and revoked event IDs. The generation provider is available.
- When: The filename request is sent without authentication, by another user, with the owner in another workspace, for an unknown thread, with an unknown or revoked event mixed into the selection, and with an unsupported caller prompt field.
- Then: The unauthenticated request returns HTTP 401, inaccessible or missing threads return HTTP 404, and invalid selections or the extra prompt field return HTTP 400. No request reaches the generation provider.
