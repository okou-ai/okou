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
    internal val settledQueueInputs: Map<String, Set<String>> = emptyMap(),
)

fun ConversationUiState.controlRunIds(output: RunOutputState): List<String> =
    transcript
        ?.liveRunsIncluding(
            output.messages
                .takeIf { output.threadId == thread?.id }
                .orEmpty()
                .mapNotNull { it.runId },
        )
        .orEmpty()

/** An observed queue entry is actionable until history has evidence about that input. */
internal fun ConversationUiState?.canWithdrawInput(
    threadId: String,
    eventId: String,
    preview: ComposerMessagePreview?,
): Boolean {
    val confirmed = this?.takeIf { it.thread?.id == threadId }
    if (confirmed?.phase == HistoryPhase.Missing) return false
    val transcript = confirmed?.transcript
    if (eventId in transcript?.revocableInputIds.orEmpty()) return true
    return eventId !in transcript?.persistedIds.orEmpty() &&
        preview?.disposition == TextDisposition.Queued &&
        preview.threadId == threadId &&
        preview.eventId == eventId
}

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

    fun skip(threadId: String, eventId: String, preview: ComposerMessagePreview? = null) =
        owner.skip(connection, threadId, eventId, preview)

    fun retry(id: String) = owner.retry(connection, id)

    /** Outcome readback never acquires or completes the history owner's detail request. */
    fun check(threadId: String) {
        if (owner.hasPending(threadId)) owner.check(connection, threadId)
        else refreshRecovery(threadId)
    }

    internal fun checkWithdrawal(threadId: String, eventId: String) =
        owner.check(connection, threadId, withdrawalId = eventId)

    fun refreshRecovery(threadId: String) {
        if (connection.current() && history.uiState.value.thread?.id == threadId)
            history.invalidateDetail(threadId)
    }

    override fun onCleared() {
        connection.retired = true
        store.detach(identity, connection, owner)
    }
}
