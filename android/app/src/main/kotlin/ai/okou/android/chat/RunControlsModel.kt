package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

enum class RunControlPersistence {
    Loading,
    Pending,
    Durable,
    Failed,
}

enum class RunControlPhase {
    Preparing,
    Sending,
    Accepted,
    Unknown,
    Checking,
    Retryable,
}

enum class RunControlNoticeKind {
    Recorded,
    TargetSettled,
    ReadFailed,
}

data class RunControlNotice(val threadId: String, val kind: RunControlNoticeKind)

data class RunControlsState(
    val journal: RunControlJournal? = null,
    val persistence: RunControlPersistence = RunControlPersistence.Loading,
    val phases: Map<String, RunControlPhase> = emptyMap(),
    val notice: RunControlNotice? = null,
)

fun ConversationUiState.controlRunIds(output: RunOutputState): List<String> =
    transcript
        ?.liveRunsIncluding(
            output.messages
                .takeIf { output.threadId == thread?.id }
                .orEmpty()
                .mapNotNull { it.runId }
        )
        .orEmpty()

/** Presentation connection to shared commands and the existing independent conversation detail. */
class RunControlsModel(
    service: RunControlService,
    private val store: RunControlJournalStore,
    private val identity: WorkspaceIdentity,
    private val history: ConversationHistoryModel,
    authorized: () -> Boolean,
    onFailure: (Exception) -> Unit,
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : ViewModel() {
    private val connection =
        RunControlsOwner.Connection(
            service,
            history,
            viewModelScope,
            authorized,
            onFailure,
            dispatcher,
        )
    private val owner = store.attach(identity, connection)
    val uiState = owner.uiState

    init {
        viewModelScope.launch {
            history.uiState.collect { state ->
                state.thread?.id?.let { id ->
                    history.checkpoint(id)?.let { owner.reconcile(connection, it) }
                }
            }
        }
    }

    fun retryLocal() = owner.retryLocal(connection)

    fun stop(threadId: String, displayedRunIds: List<String>) =
        owner.stop(connection, threadId, displayedRunIds)

    fun skip(threadId: String, eventId: String) = owner.skip(connection, threadId, eventId)

    fun retry(id: String) = owner.retry(connection, id)

    /** Outcome readback never acquires or completes the history owner's detail request. */
    fun check(threadId: String) {
        if (owner.hasPending(threadId)) owner.check(connection, threadId)
        else refreshRecovery(threadId)
    }

    fun refreshRecovery(threadId: String) {
        if (connection.current() && history.uiState.value.thread?.id == threadId)
            history.invalidateDetail(threadId)
    }

    override fun onCleared() {
        connection.retired = true
        store.detach(identity, connection, owner)
    }
}
