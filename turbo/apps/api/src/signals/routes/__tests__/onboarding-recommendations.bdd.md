# onboarding-recommendations

## onboarding-recommendations-001

- Vitest: "onboarding recommendations > starts an owned durable job and exposes only its bounded status"
- Mode: run
- Given: An authenticated user requests an operations recommendation in en-US. A second user belongs to the same workspace.
- When: The first user starts the job and reads its status. The second user attempts to read the same job ID.
- Then: Start returns HTTP 202 with only the job ID and pending status. The owner gets HTTP 200 for that ID with pending, running or failed status and no error field. The peer gets HTTP 404 with `NOT_FOUND`. All responses use `private, no-store`.

## onboarding-recommendations-002

- Vitest: "onboarding recommendations > preserves authorized context when another source fails (Gmail revoked during read: false)"
- Mode: run
- Given: An administrator has connected Gmail and GitHub, the GitHub repository endpoint returns 503, and the Gmail provider can return inbox counts and recent-message metadata. Gmail remains authorized.
- When: The administrator starts an operations recommendation. The job reads available connector context, calls the model and the administrator reads the result.
- Then: Start is HTTP 202. Read returns HTTP 200 with the completed task recommendation for preparing important replies, including the supplied title, outcome, prompt and profile. The model gets Business & operations context, GitHub capabilities with no facts, and the unavailable-source list reflects the provider failure. Gmail context includes redacted email and link placeholders, and only GitHub is unavailable. The outbound model request uses Gemini 3.1 Flash Lite, minimal thinking and JSON output, with neither credential nor the original sender email or URL.

## onboarding-recommendations-003

- Vitest: "onboarding recommendations > preserves authorized context when another source fails (Gmail revoked during read: true)"
- Mode: run
- Given: An administrator has connected Gmail and GitHub, the GitHub repository endpoint returns 503, and the Gmail provider can return inbox counts and recent-message metadata. The Gmail account is disconnected while its label request is in flight.
- When: The administrator starts an operations recommendation. The job reads available connector context, calls the model and the administrator reads the result.
- Then: Start is HTTP 202. Read returns HTTP 200 with the completed task recommendation for preparing important replies, including the supplied title, outcome, prompt and profile. The model gets Business & operations context, GitHub capabilities with no facts, and the unavailable-source list reflects the provider failure. Gmail is unavailable alongside GitHub and the Gmail context retains capabilities but no facts. The outbound model request uses Gemini 3.1 Flash Lite, minimal thinking and JSON output, with neither credential nor the original sender email or URL.
