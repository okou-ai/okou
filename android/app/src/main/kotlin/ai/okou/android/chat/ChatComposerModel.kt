package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope

class ChatComposerModel(
    service: ChatComposerService,
    private val store: ComposerJournalStore,
    private val identity: WorkspaceIdentity,
    authorized: () -> Boolean,
    onFailure: (Exception) -> Unit,
    accepted: (String) -> Unit,
) : ViewModel() {
    private val connection =
        ChatComposerOwner.Connection(service, viewModelScope, authorized, onFailure, accepted)
    private val owner = store.attach(identity, connection)
    val uiState = owner.uiState

    fun open(target: ComposerTarget) = owner.open(connection, target)

    fun edit(target: ComposerTarget, text: String) = owner.edit(connection, target, text)

    fun send(target: ComposerTarget) = owner.send(connection, target)

    fun retry(target: ComposerTarget) = owner.retry(connection, target)

    fun observe(target: ComposerTarget) = owner.observe(connection, target)

    fun retryLocal() = owner.retryLocal(connection)

    fun beginNew(projectId: String?) = owner.beginNew(connection, projectId)

    fun acknowledge(threadId: String) = owner.acknowledge(connection, threadId)

    override fun onCleared() {
        connection.retired = true
        store.detach(identity, connection, owner)
    }
}
