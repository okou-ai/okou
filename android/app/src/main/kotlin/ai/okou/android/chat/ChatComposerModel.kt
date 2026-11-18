package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch

class ChatComposerModel(
    service: ChatComposerService,
    private val store: ComposerJournalStore,
    private val identity: WorkspaceIdentity,
    authorized: () -> Boolean,
    onFailure: (Exception) -> Unit,
    accepted: (String) -> Unit,
    recovery: AssistantRecoveryModel? = null,
) : ViewModel() {
    private val connection =
        ChatComposerOwner.Connection(
            service,
            viewModelScope,
            authorized,
            onFailure,
            accepted,
            recovery,
        )
    private val owner = store.attach(identity, connection)
    val uiState = owner.uiState

    init {
        if (recovery != null)
            viewModelScope.launch {
                recovery.history.uiState.collect { state ->
                    state.thread
                        ?.id
                        ?.let { recovery.history.checkpoint(it) }
                        ?.let { owner.reconcileRecovery(connection, it) }
                }
            }
    }

    fun recover(target: ComposerTarget, failureId: String, reset: Boolean = false) =
        owner.recover(connection, target, failureId, reset)

    fun open(target: ComposerTarget) = owner.open(connection, target)

    fun edit(target: ComposerTarget, text: String) = owner.edit(connection, target, text)

    fun send(target: ComposerTarget) = owner.send(connection, target)

    fun retry(target: ComposerTarget) = owner.retry(connection, target)

    fun observe(target: ComposerTarget) = owner.observe(connection, target)

    fun retryLocal() = owner.retryLocal(connection)

    fun retrySync(target: ComposerTarget) = owner.retrySync(connection, target)

    fun restoreDraft(target: ComposerTarget, key: String) =
        owner.restoreDraft(connection, target, key)

    fun beginNew(projectId: String?) = owner.beginNew(connection, projectId)

    fun acknowledge(threadId: String) = owner.acknowledge(connection, threadId)

    override fun onCleared() {
        connection.retired = true
        store.detach(identity, connection, owner)
    }
}
