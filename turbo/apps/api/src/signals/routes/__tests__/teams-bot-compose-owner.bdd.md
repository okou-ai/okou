# teams-bot-compose-owner

## teams-bot-compose-owner-001

- Vitest: "dispatches a Teams personal message as the connected member"
- Mode: run
- Given: An onboarded Teams member has connected their personal identity. Microsoft token exchange succeeds and Graph reports no installed apps for the user.
- When: The connected member sends a signed personal message through the Teams bot webhook, then asks Okou to cancel the run from their account.
- Then: The member's run log returns one running Teams run with their prompt and a start timestamp. Cancellation returns HTTP 200, and reading the run returns the same ID, prompt and start timestamp with status `cancelled`.

## teams-bot-compose-owner-002

- Vitest: "refreshes a connected Teams sender ID without changing its Aad identity"
- Mode: run
- Given: An onboarded Teams member's status shows one account with its tenant, Teams user ID, Microsoft Entra object ID, display name and user principal name. Teams' member directory attests a new Teams user ID for the same Entra identity and tenant.
- When: The member sends a signed personal bot message using that new Teams user ID and later cancels the resulting run.
- Then: The linked account list retains exactly the original account with only its Teams user ID updated. The member's run log initially contains one running Teams run with their prompt and start timestamp, and after HTTP 200 cancellation the run reads back as cancelled with the same ID, prompt and start timestamp.

## teams-bot-compose-owner-003

- Vitest: "returns a connection notice without starting a Run when Teams sender identity is absent"
- Mode: run
- Given: A Teams workspace has one existing linked member. A signed personal message has a conversation and activity ID, but its sender has neither a usable Teams user ID nor an Entra identity.
- When: The Teams bot webhook receives the activity from the unidentified sender.
- Then: The API returns HTTP 200 and the normalized personal message includes the original prompt with empty or null sender identity and no connect URL. Teams receives only `Please connect your account to use Okou in this Teams workspace.` for this request. No run appears for the linked member and their status is unchanged.
