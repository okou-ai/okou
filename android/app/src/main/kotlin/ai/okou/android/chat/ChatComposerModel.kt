package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.connectors.ChatConnectorOverride
import ai.okou.android.connectors.ConnectorService
import ai.okou.android.settings.DefaultModelOptions
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
    connectors: ConnectorService? = null,
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
            connectors,
        )
    private val owner = store.attach(identity, connection)
    val uiState = owner.uiState

    init {
        if (history != null)
            viewModelScope.launch {
                history.uiState.collect { state ->
                    val threadId = state.thread?.id ?: return@collect
                    val transcript = state.transcript ?: return@collect
                    owner.reconcileMessages(connection, threadId, transcript)
                    if (recovery != null)
                        history.checkpoint(threadId)?.let {
                            owner.reconcileRecovery(connection, it)
                        }
                }
            }
    }

    fun recover(target: ComposerTarget, failureId: String, reset: Boolean = false) =
        owner.recover(connection, target, failureId, reset)

    internal fun confirmRecoveryReset(
        target: ComposerTarget,
        failureId: String,
        accountId: String,
    ) = owner.recover(connection, target, failureId, reset = true, confirmedAccount = accountId)

    internal fun checkRecoveryReset(target: ComposerTarget, failureId: String, key: String) =
        owner.recover(connection, target, failureId, reset = true, originalResetKey = key)

    fun open(target: ComposerTarget) {
        owner.open(connection, target)
    }

    internal suspend fun prefillNew(prefix: String): ComposerPrefillResult =
        owner.prefillNew(connection, prefix)

    fun edit(target: ComposerTarget, text: String) = owner.edit(connection, target, text)

    internal fun editConnectorOverride(target: ComposerTarget, choice: ChatConnectorOverride?) =
        owner.editConnectorOverride(connection, target, choice)

    fun send(target: ComposerTarget) = owner.send(connection, target)

    internal fun send(target: ComposerTarget, options: DefaultModelOptions?) =
        owner.send(connection, target, options)

    internal fun editDraftModel(target: ComposerTarget, selection: DraftModelSelection) =
        owner.editDraftModel(connection, target, selection)

    fun retry(target: ComposerTarget) = owner.retry(connection, target)

    fun observe(target: ComposerTarget) = owner.observe(connection, target)

    fun retryLocal() = owner.retryLocal(connection)

    fun restoreDraft(target: ComposerTarget, key: String) =
        owner.restoreDraft(connection, target, key)

    fun beginNew(projectId: String?) = owner.beginNew(connection, projectId)

    fun acknowledge(threadId: String) = owner.acknowledge(connection, threadId)

    override fun onCleared() {
        connection.retired = true
        store.detach(identity, connection, owner)
    }
}
