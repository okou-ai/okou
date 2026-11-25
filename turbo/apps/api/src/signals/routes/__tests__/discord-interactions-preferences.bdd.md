# discord-interactions-preferences

## discord-interactions-preferences-001

- Vitest: "Discord account preferences through private controls > disconnects only the invoked workspace and exposes that change through status"
- Mode: run
- Given: The same Discord and Okou user is linked to two workspaces and has selected the first through the private workspace control.
- When: The user invokes the signed `/disconnect` interaction from the first workspace, then reads connection status in both workspaces.
- Then: The private reply confirms disconnection from this workspace. Status shows the first workspace disconnected and the second still connected.

## discord-interactions-preferences-002

- Vitest: "Discord account preferences through private controls > shows the account connection status in a server with one workspace"
- Mode: run
- Given: A Discord identity is already linked to exactly one Okou workspace.
- When: The sender invokes the signed `/connect` interaction from a server.
- Then: The private reply says `You are already connected to Okou.` and has no interactive controls.

## discord-interactions-preferences-003

- Vitest: "Discord account preferences through private controls > shows the account connection status in a DM with one workspace"
- Mode: run
- Given: A Discord identity is already linked to exactly one Okou workspace.
- When: The sender invokes the signed `/connect` interaction from a DM.
- Then: The private reply says `You are already connected to Okou.` and has no interactive controls.

## discord-interactions-preferences-004

- Vitest: "Discord account preferences through private controls > requires and saves an explicit workspace choice in a DM"
- Mode: run
- Given: The same Discord identity has two linked workspaces and no selected DM connection.
- When: The user invokes signed `/connect` from a DM, chooses the second workspace from the returned menu, and invokes `/connect` again.
- Then: The initial private reply asks the user to choose a workspace, listing exactly the two eligible connections and leaving status selection null. Selection confirms the workspace, the second workspace's status returns its connection ID as the DM selection, and the new menu preselects only that connection.

## discord-interactions-preferences-005

- Vitest: "Discord account preferences through private controls > requires and saves an explicit workspace choice in a guild"
- Mode: run
- Given: The same Discord identity has two linked workspaces and no selected DM connection.
- When: The user invokes signed `/connect` from a guild, chooses the second workspace from the returned menu, and invokes `/connect` again.
- Then: The initial private reply asks the user to choose a workspace, listing exactly the two eligible connections and leaving status selection null. Selection confirms the workspace, the second workspace's status returns its connection ID as the DM selection, and the new menu preselects only that connection.

## discord-interactions-preferences-006

- Vitest: "Discord account preferences through private controls > keeps the selected DM workspace when an org control changes sender authority"
- Mode: run
- Given: The same connected Discord identity has two workspaces and has already saved the first as the selected DM workspace. The control is used by a different Discord sender.
- When: Discord submits the existing DM workspace control with the second workspace's connection ID.
- Then: The private reply says the control expired or access changed. The first workspace's public status still exposes its own connection ID as the DM selection.

## discord-interactions-preferences-007

- Vitest: "Discord account preferences through private controls > keeps the selected DM workspace when an org control changes channel authority"
- Mode: run
- Given: The same connected Discord identity has two workspaces and has already saved the first as the selected DM workspace. The control is used from a different Discord DM channel.
- When: Discord submits the existing DM workspace control with the second workspace's connection ID.
- Then: The private reply says the control expired or access changed. The first workspace's public status still exposes its own connection ID as the DM selection.

## discord-interactions-preferences-008

- Vitest: "Discord account preferences through private controls > keeps the selected DM workspace when an org control changes expired authority"
- Mode: run
- Given: The same connected Discord identity has two workspaces and has already saved the first as the selected DM workspace. Fifteen minutes elapse after issuing the control.
- When: Discord submits the existing DM workspace control with the second workspace's connection ID.
- Then: The private reply says the control expired or access changed. The first workspace's public status still exposes its own connection ID as the DM selection.

## discord-interactions-preferences-009

- Vitest: "Discord account preferences through private controls > keeps the selected DM workspace when an org control changes disconnect authority"
- Mode: run
- Given: The same connected Discord identity has two workspaces and has already saved the first as the selected DM workspace. The second workspace's connection was disconnected after the control was issued.
- When: Discord submits the existing DM workspace control with the second workspace's connection ID.
- Then: The private reply says the control expired or access changed. The first workspace's public status still exposes its own connection ID as the DM selection.

## discord-interactions-preferences-010

- Vitest: "Discord account preferences through private controls > keeps the selected DM workspace when an org control changes membership authority"
- Mode: run
- Given: The same connected Discord identity has two workspaces and has already saved the first as the selected DM workspace. The user no longer belongs to the second workspace after the control was issued.
- When: Discord submits the existing DM workspace control with the second workspace's connection ID.
- Then: The private reply says the control expired or access changed. The first workspace's public status still exposes its own connection ID as the DM selection.

## discord-interactions-preferences-011

- Vitest: "Discord account preferences through private controls > preselects the selected DM workspace"
- Mode: run
- Given: A Discord identity has two linked workspaces and opens a DM workspace chooser with no preselected option.
- When: The user selects the first workspace and opens the chooser again.
- Then: The subsequent chooser preselects only the first workspace's connection ID.
