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
    history: ConversationHistoryModel? = recovery?.history,
    chatList: ChatListModel? = null,
) : ViewModel() {
    private val connection =
        ChatComposerOwner.Connection(
            service,
            viewModelScope,
            authorized,
            onFailure,
            accepted,
            recovery,
            history,
            chatList,
        )
    private val owner = store.attach(identity, connection)
    val uiState = owner.uiState

    init {
        if (history != null)
            viewModelScope.launch {
                history.uiState.collect { state ->
                    val threadId = state.thread?.id ?: return@collect
                    val transcript = state.transcript ?: return@collect
                    owner.reconcileMessages(connection, threadId, transcript.persistedIds)
                    if (recovery != null)
                        history.checkpoint(threadId)?.let {
                            owner.reconcileRecovery(connection, it)
                        }
                }
            }
    }

    fun recover(target: ComposerTarget, failureId: String, reset: Boolean = false) =
        owner.recover(connection, target, failureId, reset)

    fun open(target: ComposerTarget) {
        owner.open(connection, target)
    }

    internal suspend fun prefillNew(prefix: String): ComposerPrefillResult =
        owner.prefillNew(connection, prefix)

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
