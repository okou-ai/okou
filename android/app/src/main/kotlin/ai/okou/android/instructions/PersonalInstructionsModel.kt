package ai.okou.android.instructions

import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.instructions.PersonalInstructionsOwner.Connection
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope

/** A workspace-authorized controller of the application's shared Instructions transaction. */
class PersonalInstructionsModel(
    service: PersonalInstructionsService,
    private val store: PersonalInstructionsDraftStore,
    private val identity: WorkspaceIdentity,
    authorized: () -> Boolean,
    onFailure: (Exception) -> Unit,
) : ViewModel() {
    private val connection = Connection(service, viewModelScope, authorized, onFailure)
    private val editor = store.attach(identity, connection)
    val uiState = editor.uiState

    fun open() = editor.refresh(connection)

    fun refreshFromForeground() = editor.refreshFromForeground(connection)

    fun edit(content: String) = editor.edit(connection, content)

    fun retryLocalDraft() = editor.retryLocalDraft(connection)

    fun discard() = editor.discard(connection)

    fun refresh() = editor.refresh(connection)

    fun save() = editor.save(connection)

    override fun onCleared() {
        connection.retire()
        store.detach(identity, connection, editor)
    }
}
