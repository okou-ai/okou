# get-started-invitations

## get-started-invitations-001

- Vitest: "maps Clerk invitation conflict already_a_member_in_organization to a stable 409"
- Mode: run
- Given: Row `already_a_member_in_organization`: a signed-in admin of an onboarded workspace, and the identity provider rejects the invitation with that code and HTTP 400.
- When: The member invites an email address as `member` with `POST /api/org/invite`.
- Then: The API responds with HTTP 409 and exactly `{ error: { code: "INVITEE_ALREADY_MEMBER", message: "This person is already a member." } }`.

## get-started-invitations-002

- Vitest: "maps Clerk invitation conflict duplicate_record to a stable 409"
- Mode: run
- Given: Row `duplicate_record`: a signed-in admin of an onboarded workspace, and the identity provider rejects the invitation with that code and HTTP 422.
- When: The member invites an email address as `member` with `POST /api/org/invite`.
- Then: The API responds with HTTP 409 and exactly `{ error: { code: "INVITATION_ALREADY_EXISTS", message: "This person already has a pending invitation." } }`.

## get-started-invitations-003

- Vitest: "maps Clerk invitation conflict organization_invitation_not_unique to a stable 409"
- Mode: run
- Given: Row `organization_invitation_not_unique`: a signed-in admin of an onboarded workspace, and the identity provider rejects the invitation with that code and HTTP 409.
- When: The member invites an email address as `member` with `POST /api/org/invite`.
- Then: The API responds with HTTP 409 and exactly `{ error: { code: "INVITATION_ALREADY_EXISTS", message: "This person already has a pending invitation." } }`.

## get-started-invitations-004

- Vitest: "returns an address-level error when Clerk rejects the email format without recording invitation progress"
- Mode: run
- Given: A signed-in admin of an onboarded workspace, and the identity provider rejects the invitation with `form_param_format_invalid` (HTTP 422) and the detail "Email address must be a valid email address."
- When: The member invites an email address as `member` with `POST /api/org/invite`.
- Then: The API responds with HTTP 400 and exactly `{ error: { code: "BAD_REQUEST", message: "Enter a valid email address." } }`.

## get-started-invitations-005

- Vitest: "keeps unrelated Clerk invitation failure invalid_clerk_configuration as a server error"
- Mode: run
- Given: Row `invalid_clerk_configuration`: a signed-in admin of an onboarded workspace, and the identity provider rejects the invitation with that code and HTTP 400.
- When: The member invites an email address as `member` with `POST /api/org/invite`.
- Then: The API responds with HTTP 500 and exactly `{ error: "Internal server error" }`.

## get-started-invitations-006

- Vitest: "keeps unrelated Clerk invitation failure form_param_format_invalid as a server error"
- Mode: run
- Given: Row `form_param_format_invalid` with detail "Redirect URL must be a valid URL.": a signed-in admin of an onboarded workspace, and the identity provider rejects the invitation with that code and HTTP 422.
- When: The member invites an email address as `member` with `POST /api/org/invite`.
- Then: The API responds with HTTP 500 and exactly `{ error: "Internal server error" }`.
