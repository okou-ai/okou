# connector-permissions

## connector-permissions-001

- Vitest: "Member connector permissions > applies the same one-hour deadline to both permissions in a member patch"
- Mode: run
- Given: An authenticated member has a connected Slack account and the time is fixed at the grant start.
- When: The member uses GET and PUT /api/connector-permissions to patch chat:write and conversations:read to allow for one hour and reads one millisecond before and at the deadline.
- Then: The HTTP 200 write returns exactly two allow grants with the same deadline one hour later. Both remain visible just before that deadline. The HTTP 200 read at the deadline returns no grants.

## connector-permissions-002

- Vitest: "Member connector permissions > starts from connector defaults, shares rules across Chats/Agents and preserves deny, expiry and reset"
- Mode: run
- Given: An authenticated member with two Chats has a connected Slack account and starts with no member grants.
- When: The caller uses GET and PUT /api/connector-permissions to set a one-hour conversations:read allow plus indefinite chat:write and fallback denies. The caller disables the account only in the first Chat, patches chat:write to a later one-hour allow, reads just after the first expiration and replaces all grants with an empty list.
- Then: The first Chat loses availability and the second retains it. Both share unchanged member grants at the time of the override. The patch retains the first allow's original deadline. After the first deadline only the fallback deny and later timed chat:write allow remain. Clearing returns and reads back an empty grant list.

## connector-permissions-003

- Vitest: "Member connector permissions > shares custom rules across accounts and permits editing with all accounts disabled"
- Mode: run
- Given: An authenticated member has a custom HTTP connector with the Slack bundle, two connected accounts, a Chat and no current grants.
- When: The member saves a chat:write deny via GET and PUT /api/connector-permissions, selects the second account for the thread, disables that account's default availability, deletes the first account, and edits the grants again while the connector is unavailable.
- Then: The rules follow the connector definition and remain the same when selection changes and when no account is available. Deleting the first account returns HTTP 200 with no promoted default. Replacing rules with a conversations:read allow returns it with null expiry, and a patch for an undefined permission returns HTTP 400 and leaves that allow in place. The Chat connector remains unavailable.

## connector-permissions-004

- Vitest: "Member connector permissions > isolates member and organization grants for the same connector without requiring a Chat"
- Mode: run
- Given: Three authenticated contexts each have an OpenAI account. The original member, a second member in the same organization, and the same member in another organization use different fallback grants.
- When: With no Chat, each context replaces and then reads its own fallback permission through GET and PUT /api/connector-permissions. A fourth member with no account attempts both operations.
- Then: The original context retains deny, the other member retains the one-hour allow and the other organization retains the 24-hour allow. Both operations for the unconnected fourth member return HTTP 404.

## connector-permissions-005

- Vitest: "Member connector permissions > rejects a real Run credential before it can change shared rules"
- Mode: run
- Given: An authenticated member has a connected OpenAI account, no grants and a valid credential for a dispatched run.
- When: The run credential attempts PUT /api/connector-permissions to add an allow. The member reads the rules with a user session, then saves a fallback deny.
- Then: The Run request returns HTTP 403 and leaves no grants. The authenticated member's write succeeds and returns the deny with null expiry.
