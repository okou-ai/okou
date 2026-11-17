package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Deferred
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
    val recovery: CancellationRecovery = CancellationRecovery(),
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

/**
 * Workspace-owned actions. A composition supplies IDs it displayed, never a replaceable "latest".
 */
class RunControlsModel(
    private val service: RunControlService,
    private val store: RunControlJournalStore,
    private val identity: WorkspaceIdentity,
    private val history: ConversationHistoryModel,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : ViewModel() {
    private class Operation(val intent: RunControlIntent)

    private class Read

    private val mutable = MutableStateFlow(RunControlsState())
    val uiState = mutable.asStateFlow()
    private val sync = ConversationHistorySync(service, dispatcher)
    private val writes = mutableMapOf<String, Operation>()
    private val reads = mutableMapOf<String, Read>()
    private var restoring: Job? = null
    private var metadata: Job? = null
    private var metadataTicket = 0L
    private var revision = 0L
    private var closed = false

    init {
        restore()
        viewModelScope.launch {
            var thread: String? = null
            var confirmedRevision: Long? = null
            history.uiState.collect { state ->
                state.thread?.id?.let { id -> history.checkpoint(id)?.let { reconcile(it) } }
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

    private fun current() = !closed && authorized()

    private fun contains(intent: RunControlIntent) =
        mutable.value.journal?.pending?.contains(intent) == true

    private fun current(op: Operation) =
        current() && writes[op.intent.id] === op && contains(op.intent)

    private suspend fun requireCurrent(op: Operation) {
        currentCoroutineContext().ensureActive()
        if (!current(op)) throw CancellationException("Control owner retired or target settled")
    }

    private fun restore() {
        if (!current() || restoring?.isActive == true || mutable.value.journal != null) return
        mutable.value = mutable.value.copy(persistence = RunControlPersistence.Loading)
        restoring =
            viewModelScope.launch {
                try {
                    val saved = store.load(identity)
                    currentCoroutineContext().ensureActive()
                    if (!current()) return@launch
                    mutable.value =
                        mutable.value.copy(
                            journal = saved.journal,
                            persistence =
                                if (saved.durable) RunControlPersistence.Durable
                                else RunControlPersistence.Failed,
                            phases =
                                saved.journal.pending.associate { it.id to RunControlPhase.Unknown },
                        )
                    // Restore publishes intent only. Even an interrupted preparation cannot POST.
                    history.uiState.value.thread?.id?.let {
                        history.checkpoint(it)?.let { checkpoint -> reconcile(checkpoint) }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (current())
                        mutable.value =
                            mutable.value.copy(persistence = RunControlPersistence.Failed)
                }
            }
    }

    private fun persist(
        journal: RunControlJournal,
        phases: Map<String, RunControlPhase> = mutable.value.phases,
        notice: RunControlNotice? = mutable.value.notice,
    ): Deferred<Unit> {
        val ticket = ++revision
        val write = store.persist(identity, journal)
        mutable.value =
            mutable.value.copy(
                journal = journal,
                phases = phases,
                notice = notice,
                persistence = RunControlPersistence.Pending,
            )
        viewModelScope.launch {
            val durable =
                try {
                    write.await()
                    true
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    false
                }
            if (current() && ticket == revision)
                mutable.value =
                    mutable.value.copy(
                        persistence =
                            if (durable) RunControlPersistence.Durable
                            else RunControlPersistence.Failed
                    )
        }
        return write
    }

    fun retryLocal() {
        if (!current()) return
        val journal = mutable.value.journal
        if (journal == null) restore() else persist(journal)
    }

    fun stop(threadId: String, displayedRunIds: List<String>) {
        if (!current()) return
        val state = history.uiState.value
        val thread = state.thread?.takeIf { it.id == threadId } ?: return
        val eligible = state.controlRunIds(history.output.state.value).toSet()
        append(
            displayedRunIds
                .distinct()
                .filter { it in eligible }
                .map {
                    RunControlIntent(
                        UUID.randomUUID().toString(),
                        threadId,
                        thread.agentId,
                        RunControlKind.Interrupt,
                        it,
                    )
                }
        )
    }

    fun skip(threadId: String, eventId: String) {
        if (!current()) return
        val state = history.uiState.value
        val thread = state.thread?.takeIf { it.id == threadId } ?: return
        if (eventId !in state.transcript?.queuedEventIds.orEmpty()) return
        append(
            listOf(
                RunControlIntent(
                    UUID.randomUUID().toString(),
                    threadId,
                    thread.agentId,
                    RunControlKind.Revoke,
                    eventId,
                )
            )
        )
    }

    private fun append(candidates: List<RunControlIntent>) {
        val state = mutable.value
        val journal = state.journal ?: return
        if (!current() || state.persistence == RunControlPersistence.Failed) return
        val fresh =
            candidates.filter { candidate ->
                journal.pending.none {
                    it.threadId == candidate.threadId &&
                        it.kind == candidate.kind &&
                        it.targetId == candidate.targetId
                }
            }
        if (fresh.isEmpty()) return
        persist(
            journal.copy(pending = journal.pending + fresh),
            state.phases + fresh.associate { it.id to RunControlPhase.Preparing },
        )
        fresh.forEach { launch(it, false) }
    }

    private fun phase(intent: RunControlIntent, value: RunControlPhase) {
        if (current() && contains(intent))
            mutable.value = mutable.value.copy(phases = mutable.value.phases + (intent.id to value))
    }

    fun retry(id: String) {
        if (!current() || mutable.value.phases[id] != RunControlPhase.Retryable) return
        val intent = mutable.value.journal?.pending?.singleOrNull { it.id == id } ?: return
        launch(intent, true)
    }

    private fun launch(intent: RunControlIntent, retry: Boolean) {
        if (!current() || intent.id in writes) return
        val op = Operation(intent)
        writes[intent.id] = op
        viewModelScope.launch {
            var outcomeTicket: Long? = null
            try {
                if (retry) {
                    phase(intent, RunControlPhase.Checking)
                    outcomeTicket = beginOutcomeRead(intent.threadId)
                    val read = sync.read(intent.threadId, history.checkpoint(intent.threadId))
                    requireCurrent(op)
                    val evidence = controlEvidence(intent, read.checkpoint)
                    outcomeTicket?.let {
                        publishRecovery(intent.threadId, read.cancellationRecoveryPending, it)
                    }
                    outcomeTicket = null
                    if (evidence != RunControlEvidence.Eligible) {
                        reconcile(read.checkpoint, setOf(intent.id))
                        return@launch
                    }
                }
                val saved = store.load(identity)
                requireCurrent(op)
                if (!saved.durable || intent !in saved.journal.pending)
                    throw IOException("Exact control intent is not durable")
                // A newer local canonical read can settle the original target while disk I/O
                // waits.
                history.checkpoint(intent.threadId)?.let { checkpoint ->
                    val evidence = controlEvidence(intent, checkpoint)
                    if (
                        evidence in
                            setOf(RunControlEvidence.Recorded, RunControlEvidence.TargetSettled)
                    ) {
                        reconcile(checkpoint)
                    }
                }
                requireCurrent(op)
                phase(intent, RunControlPhase.Sending)
                val accepted = service.sendControl(intent.request())
                requireCurrent(op)
                if (accepted.threadId != intent.threadId) throw ApiFailure.IncompatibleResponse()
                phase(intent, RunControlPhase.Accepted)
                history.invalidate(intent.threadId)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (current(op)) {
                    report(error)
                    outcomeTicket?.let { failRecovery(intent.threadId, it) }
                    phase(intent, RunControlPhase.Unknown)
                    history.invalidate(intent.threadId)
                }
            } finally {
                if (writes[intent.id] === op) writes.remove(intent.id)
            }
        }
    }

    /** Read-only reconciliation; foreground/navigation/reconnect never call sendControl. */
    fun check(threadId: String) {
        if (!current() || threadId in reads || writes.values.any { it.intent.threadId == threadId })
            return
        val pending = mutable.value.journal?.pending?.filter { it.threadId == threadId }.orEmpty()
        if (pending.isEmpty()) {
            refreshRecovery(threadId)
            return
        }
        val checkedIds = pending.mapTo(hashSetOf()) { it.id }
        mutable.value =
            mutable.value.copy(
                phases =
                    mutable.value.phases + pending.associate { it.id to RunControlPhase.Checking }
            )
        val reading = Read()
        reads[threadId] = reading
        val ticket = beginOutcomeRead(threadId)
        viewModelScope.launch {
            try {
                val read = sync.read(threadId, history.checkpoint(threadId))
                currentCoroutineContext().ensureActive()
                if (!current()) return@launch
                reconcile(read.checkpoint, checkedIds)
                ticket?.let { publishRecovery(threadId, read.cancellationRecoveryPending, it) }
                history.invalidate(threadId)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (current()) {
                    report(error)
                    if (!current()) return@launch
                    ticket?.let { failRecovery(threadId, it) }
                    val remaining =
                        mutable.value.journal?.pending.orEmpty().filter { it.id in checkedIds }
                    mutable.value =
                        mutable.value.copy(
                            phases =
                                mutable.value.phases +
                                    remaining.associate { it.id to RunControlPhase.Unknown },
                            notice = RunControlNotice(threadId, RunControlNoticeKind.ReadFailed),
                        )
                }
            } finally {
                if (reads[threadId] === reading) reads.remove(threadId)
            }
        }
    }

    private fun reconcile(checkpoint: HistoryCheckpoint, checkedIds: Set<String> = emptySet()) {
        if (!current()) return
        val journal = mutable.value.journal ?: return
        val intents = journal.pending.filter { it.threadId == checkpoint.threadId }
        if (intents.isEmpty()) return
        val observation = RunControlObservation(checkpoint)
        val results = intents.associateWith { observation.evidence(it) }
        val resolved =
            results.filterValues {
                it == RunControlEvidence.Recorded || it == RunControlEvidence.TargetSettled
            }
        val ids = resolved.keys.mapTo(hashSetOf()) { it.id }
        var phases = mutable.value.phases - ids
        // Canonical evidence may settle any target. Request phases belong only to commands
        // that existed when this read began; later writes keep their own sending/outcome state.
        for ((intent, evidence) in results) {
            if (intent.id in checkedIds && intent.id !in ids)
                phases =
                    phases +
                        (intent.id to
                            if (evidence == RunControlEvidence.Eligible) RunControlPhase.Retryable
                            else RunControlPhase.Unknown)
        }
        val notice =
            when {
                resolved.isNotEmpty() ->
                    RunControlNotice(
                        checkpoint.threadId,
                        if (resolved.values.any { it == RunControlEvidence.Recorded })
                            RunControlNoticeKind.Recorded
                        else RunControlNoticeKind.TargetSettled,
                    )
                results.values.any { it == RunControlEvidence.Invalid } ->
                    RunControlNotice(checkpoint.threadId, RunControlNoticeKind.ReadFailed)
                else -> mutable.value.notice
            }
        if (ids.isNotEmpty())
            persist(
                journal.copy(pending = journal.pending.filterNot { it.id in ids }),
                phases,
                notice,
            )
        else if (phases != mutable.value.phases || notice != mutable.value.notice)
            mutable.value = mutable.value.copy(phases = phases, notice = notice)
    }

    fun refreshRecovery(threadId: String?) {
        if (!current()) return
        val ticket = ++metadataTicket
        metadata?.cancel()
        if (threadId == null) {
            mutable.value = mutable.value.copy(recovery = CancellationRecovery())
            return
        }
        mutable.value =
            mutable.value.copy(
                recovery = CancellationRecovery(threadId, CancellationReadPhase.Loading)
            )
        metadata =
            viewModelScope.launch {
                try {
                    val detail = service.threadDetail(threadId)
                    currentCoroutineContext().ensureActive()
                    if (current() && ticket == metadataTicket)
                        publishRecovery(threadId, detail.cancellationRecoveryPending, ticket)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (current() && ticket == metadataTicket) {
                        report(error)
                        if (!current() || ticket != metadataTicket) return@launch
                        mutable.value =
                            mutable.value.copy(
                                recovery =
                                    CancellationRecovery(threadId, CancellationReadPhase.Failed)
                            )
                    }
                }
            }
    }

    private fun beginOutcomeRead(threadId: String): Long? {
        if (history.uiState.value.thread?.id != threadId) return null
        val ticket = ++metadataTicket
        metadata?.cancel()
        mutable.value =
            mutable.value.copy(
                recovery = CancellationRecovery(threadId, CancellationReadPhase.Loading)
            )
        return ticket
    }

    private fun publishRecovery(threadId: String, pending: Boolean, ticket: Long) {
        if (current() && ticket == metadataTicket && history.uiState.value.thread?.id == threadId)
            mutable.value =
                mutable.value.copy(
                    recovery = CancellationRecovery(threadId, CancellationReadPhase.Ready, pending)
                )
    }

    private fun failRecovery(threadId: String, ticket: Long) {
        if (current() && ticket == metadataTicket && history.uiState.value.thread?.id == threadId)
            mutable.value =
                mutable.value.copy(
                    recovery = CancellationRecovery(threadId, CancellationReadPhase.Failed)
                )
    }

    private fun report(error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            onFailure(error)
    }

    override fun onCleared() {
        closed = true
        metadataTicket++
    }
}
