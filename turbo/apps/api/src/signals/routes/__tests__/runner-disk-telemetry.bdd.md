# runner-disk-telemetry

## runner-disk-telemetry-001

- Vitest: "Runner disk telemetry HTTP > accepts independent, missing and malformed filesystem observations on an authenticated assigned Run"
- Mode: run
- Given: A Pro user has an assigned Run. An authenticated sandbox holds the token issued for that Run and telemetry ingestion is available.
- When: The sandbox posts telemetry with root and home disk observations both present, one missing, one malformed and both missing. It then submits telemetry for a different Run ID and reports a home-filesystem-full terminal failure for its own Run.
- Then: Each matching telemetry request returns HTTP 200 with success and the Run ID, and the mismatched request returns HTTP 401. Completion returns HTTP 200 and the owner reads the Run as failed.
