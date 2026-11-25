# member-settings-lifecycle

## member-settings-lifecycle-001

- Vitest: "Member settings across membership changes > preserves member settings after leave and reinitialization"
- Mode: run
- Given: A workspace member has initialized user preferences and saved a false Dummy setting. The original administrator and the same user in another workspace also have the setting false.
- When: The member leaves the workspace. The member subsequently initializes again under the original workspace.
- Then: The reinitialized member’s feature switch response remains exactly Dummy false. The administrator and the other-workspace identity still read the same value.

## member-settings-lifecycle-002

- Vitest: "Member settings across membership changes > preserves member settings after remove and reinitialization"
- Mode: run
- Given: A workspace member has initialized user preferences and saved a false Dummy setting. The original administrator and the same user in another workspace also have the setting false.
- When: The administrator removes the member by email. The member subsequently initializes again under the original workspace.
- Then: The reinitialized member’s feature switch response remains exactly Dummy false. The administrator and the other-workspace identity still read the same value.

## member-settings-lifecycle-003

- Vitest: "Member settings across membership changes > preserves member settings after webhook and reinitialization"
- Mode: run
- Given: A workspace member has initialized user preferences and saved a false Dummy setting. The original administrator and the same user in another workspace also have the setting false.
- When: Clerk reports the membership deleted and the webhook returns HTTP 200. The member subsequently initializes again under the original workspace.
- Then: The reinitialized member’s feature switch response remains exactly Dummy false. The administrator and the other-workspace identity still read the same value.
