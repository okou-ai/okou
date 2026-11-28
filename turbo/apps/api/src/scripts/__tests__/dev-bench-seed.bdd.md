# dev-bench-seed

## dev-bench-seed-001

- Vitest: "dev bench seed profile rows > preserves the production-shaped profile invariants"
- Mode: run
- Intent: review
- Given: The development benchmark defines the feature-switch-digest and release-pr-auto-merge thread profiles with a fixed user, organization and thread identity.
- When: The fixture builder constructs Run and chat event rows for each profile.
- Then: The profiles produce respectively 134 and 142 Runs and 1,429 and 2,821 events. The pinned counts include 139 and 142 user events, 1,290 and 2,679 assistant events, nine and zero events without a Run, 133 and 142 completions, one and zero failures, 72 and 142 follow-up events, 32 and zero usage events, 46 and 135 scheduled Runs with trigger briefs, and six revocations each. Every Run has a string trigger source, autonomy budget 128 and no selected image model. Numeric per-Run event sequences are positive, unique and within the profile maximum.
