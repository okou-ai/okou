package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
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

enum class CancellationReadPhase {
    Idle,
    Loading,
    Ready,
    Failed,
}

data class CancellationRecovery(
    val threadId: String? = null,
    val phase: CancellationReadPhase = CancellationReadPhase.Idle,
    val pending: Boolean? = null,
)

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

/** Presentation connection to shared commands, with its own selected-thread metadata query. */
class RunControlsModel(
    private val service: RunControlService,
    private val store: RunControlJournalStore,
    private val identity: WorkspaceIdentity,
    private val history: ConversationHistoryModel,
    authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
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
    private val mutableRecovery = MutableStateFlow(CancellationRecovery())
    val recovery = mutableRecovery.asStateFlow()
    private var metadata: Job? = null
    private var metadataTicket = 0L

    init {
        viewModelScope.launch {
            var thread: String? = null
            var confirmedRevision: Long? = null
            history.uiState.collect { state ->
                state.thread?.id?.let { id ->
                    history.checkpoint(id)?.let { owner.reconcile(connection, it) }
                }
                val next = state.thread?.id
                if (
                    next != thread ||
                        (state.confirmation != null &&
                            state.confirmation.revision != confirmedRevision)
                ) {
                    thread = next
                    confirmedRevision = state.confirmation?.revision
                    refreshRecovery(next)
                }
            }
        }
    }

    fun retryLocal() = owner.retryLocal(connection)

    fun stop(threadId: String, displayedRunIds: List<String>) =
        owner.stop(connection, threadId, displayedRunIds)

    fun skip(threadId: String, eventId: String) = owner.skip(connection, threadId, eventId)

    fun retry(id: String) = owner.retry(connection, id)

    /** Outcome readback never acquires or completes the independent metadata query. */
    fun check(threadId: String) {
        if (owner.hasPending(threadId)) owner.check(connection, threadId)
        else refreshRecovery(threadId)
    }

    fun refreshRecovery(threadId: String?) {
        if (!connection.current() || history.uiState.value.thread?.id != threadId) return
        val ticket = ++metadataTicket
        metadata?.cancel()
        if (threadId == null) {
            mutableRecovery.value = CancellationRecovery()
            return
        }
        mutableRecovery.value = CancellationRecovery(threadId, CancellationReadPhase.Loading)
        metadata =
            viewModelScope.launch {
                try {
                    val detail = service.threadDetail(threadId)
                    currentCoroutineContext().ensureActive()
                    if (currentMetadata(threadId, ticket))
                        mutableRecovery.value =
                            CancellationRecovery(
                                threadId,
                                CancellationReadPhase.Ready,
                                detail.cancellationRecoveryPending,
                            )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (currentMetadata(threadId, ticket)) {
                        if (
                            error is ApiFailure.Unauthenticated ||
                                error is ApiFailure.UpdateRequired ||
                                error is ApiFailure.Http && error.status == 401
                        )
                            onFailure(error)
                        if (currentMetadata(threadId, ticket))
                            mutableRecovery.value =
                                CancellationRecovery(threadId, CancellationReadPhase.Failed)
                    }
                }
            }
    }

    private fun currentMetadata(threadId: String, ticket: Long) =
        connection.current() &&
            ticket == metadataTicket &&
            history.uiState.value.thread?.id == threadId

    override fun onCleared() {
        connection.retired = true
        metadataTicket++
        store.detach(identity, connection, owner)
    }
}
