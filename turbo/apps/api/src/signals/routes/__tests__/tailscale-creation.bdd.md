# tailscale-creation

## tailscale-creation-001

- Vitest: "arbitrates concurrent explicit-ID creation without overwriting the winner or granting foreign reconciliation"
- Mode: run
- Given: An authenticated user in an organization supplies an explicit Tailscale configuration ID, synthetic credentials and a tag. Another member of that organization has a different user identity.
- When: The owner submits two concurrent creations for the same ID with different names, replays with a changed name and secret, and the other user tries that same ID. Both users list configurations.
- Then: Concurrent responses are one HTTP 201 and one HTTP 204. The owner list retains only the winning configuration after the replay returns HTTP 204. The other user gets HTTP 409 with no credential or configuration-name disclosure and sees an empty list. The owner still sees the winner and can delete it with its first revision.
