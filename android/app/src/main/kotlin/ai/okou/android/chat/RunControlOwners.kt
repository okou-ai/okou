package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity

/** Controllers with the same current authorization share in-memory command and readback state. */
class RunControlOwners {
    private val workspaces = mutableMapOf<WorkspaceIdentity, RunControlsOwner>()

    internal fun attach(identity: WorkspaceIdentity, connection: RunControlsOwner.Connection) =
        workspaces.getOrPut(identity, ::RunControlsOwner).also { it.attach(connection) }

    internal fun detach(
        identity: WorkspaceIdentity,
        connection: RunControlsOwner.Connection,
        owner: RunControlsOwner,
    ) {
        if (owner.detach(connection)) workspaces.remove(identity, owner)
    }
}
