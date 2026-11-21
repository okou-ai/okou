package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.WorkspaceIdentity
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Main-thread command transaction owner shared by every controller of one durable identity. */
internal class RunControlsOwner(
    private val store: RunControlJournalStore,
    private val identity: WorkspaceIdentity,
) {
    class Connection(
        val service: RunControlService,
        val history: ConversationHistoryModel,
        val scope: CoroutineScope,
        val authorized: () -> Boolean,
        val onFailure: (Exception) -> Unit,
        dispatcher: CoroutineDispatcher,
    ) {
        val sync = ConversationHistorySync(service, dispatcher)
        var retired = false

        fun current() = !retired && scope.isActive && authorized()
    }

    private class Operation(val connection: Connection, val intent: RunControlIntent) {
        var job: Job? = null
    }

    private class Read(val connection: Connection, val checkedIds: Set<String>) {
        var job: Job? = null
    }

    private val mutable = MutableStateFlow(RunControlsState())
    val uiState = mutable.asStateFlow()
    private val localScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val connections = mutableSetOf<Connection>()
    private val writes = mutableMapOf<String, Operation>()
    private val reads = mutableMapOf<String, Read>()
    private var restoring: Job? = null
    private var revision = 0L

    fun attach(connection: Connection) {
        connections += connection
        restore()
    }

    fun detach(connection: Connection): Boolean {
        val interrupted = hashSetOf<String>()
        writes.values
            .filter { it.connection === connection }
            .toList()
            .forEach { op ->
                writes.remove(op.intent.id)
                interrupted += op.intent.id
                op.job?.cancel()
            }
        reads.entries
            .filter { it.value.connection === connection }
            .toList()
            .forEach { (id, read) ->
                reads.remove(id)
                interrupted += read.checkedIds.filterNot { it in writes }
                read.job?.cancel()
            }
        markInterrupted(interrupted)
        connections -= connection
        if (connections.isNotEmpty()) return false
        localScope.cancel()
        return true
    }

    private fun markInterrupted(ids: Set<String>) {
        mutable.value =
            mutable.value.copy(
                phases =
                    mutable.value.phases.mapValues { (id, phase) ->
                        if (
                            id in ids &&
                                (phase == RunControlPhase.Preparing ||
                                    phase == RunControlPhase.Sending ||
                                    phase == RunControlPhase.Checking)
                        )
                            RunControlPhase.Unknown
                        else phase
                    }
            )
    }

    private fun current(connection: Connection) = connection in connections && connection.current()

    private fun contains(intent: RunControlIntent) =
        mutable.value.journal?.pending?.contains(intent) == true

    private fun current(op: Operation) =
        current(op.connection) && writes[op.intent.id] === op && contains(op.intent)

    private suspend fun requireCurrent(op: Operation) {
        currentCoroutineContext().ensureActive()
        if (!current(op))
            throw CancellationException("Control connection retired or target settled")
    }

    private fun restore() {
        if (
            connections.none { it.current() } ||
                restoring?.isActive == true ||
                mutable.value.journal != null
        )
            return
        mutable.value = mutable.value.copy(persistence = RunControlPersistence.Loading)
        restoring =
            localScope.launch {
                try {
                    val saved = store.load(identity)
                    currentCoroutineContext().ensureActive()
                    if (connections.none { current(it) }) return@launch
                    mutable.value =
                        mutable.value.copy(
                            journal = saved.journal,
                            persistence =
                                if (saved.durable) RunControlPersistence.Durable
                                else RunControlPersistence.Failed,
                            phases =
                                saved.journal.pending.associate { it.id to RunControlPhase.Unknown },
                        )
                    // Restore publishes intent only; never dispatch from a restored preparation.
                    for (connection in connections.toList()) connection.history.uiState.value.thread
                        ?.id
                        ?.let { id ->
                            connection.history.checkpoint(id)?.let { reconcile(connection, it) }
                        }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    mutable.value = mutable.value.copy(persistence = RunControlPersistence.Failed)
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
        localScope.launch {
            val durable =
                try {
                    write.await()
                    true
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    false
                }
            if (ticket == revision)
                mutable.value =
                    mutable.value.copy(
                        persistence =
                            if (durable) RunControlPersistence.Durable
                            else RunControlPersistence.Failed
                    )
        }
        return write
    }

    fun retryLocal(connection: Connection) {
        if (!current(connection)) return
        val journal = mutable.value.journal
        if (journal == null) restore() else persist(journal)
    }

    fun stop(connection: Connection, threadId: String, displayedRunIds: List<String>) {
        if (!current(connection)) return
        val state = connection.history.uiState.value
        val thread = state.thread?.takeIf { it.id == threadId } ?: return
        val eligible = state.controlRunIds(connection.history.output.state.value).toSet()
        append(
            connection,
            displayedRunIds
                .distinct()
                .filter { it in eligible }
                .map {
                    RunControlIntent(
                        UUID.randomUUID().toString(),
                        threadId,
                        null,
                        RunControlKind.Interrupt,
                        it,
                    )
                },
        )
    }

    fun skip(connection: Connection, threadId: String, eventId: String) {
        if (!current(connection)) return
        val state = connection.history.uiState.value
        val thread = state.thread?.takeIf { it.id == threadId } ?: return
        if (eventId !in state.transcript?.queuedEventIds.orEmpty()) return
        append(
            connection,
            listOf(
                RunControlIntent(
                    UUID.randomUUID().toString(),
                    threadId,
                    null,
                    RunControlKind.Revoke,
                    eventId,
                )
            ),
        )
    }

    private fun append(connection: Connection, candidates: List<RunControlIntent>) {
        val state = mutable.value
        val journal = state.journal ?: return
        if (!current(connection) || state.persistence == RunControlPersistence.Failed) return
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
        fresh.forEach { launch(connection, it, false) }
    }

    private fun phase(op: Operation, value: RunControlPhase) {
        if (current(op))
            mutable.value =
                mutable.value.copy(phases = mutable.value.phases + (op.intent.id to value))
    }

    fun retry(connection: Connection, id: String) {
        if (!current(connection) || mutable.value.phases[id] != RunControlPhase.Retryable) return
        val intent = mutable.value.journal?.pending?.singleOrNull { it.id == id } ?: return
        launch(connection, intent, true)
    }

    private fun launch(connection: Connection, intent: RunControlIntent, retry: Boolean) {
        if (!current(connection) || intent.id in writes) return
        val op = Operation(connection, intent)
        writes[intent.id] = op
        op.job =
            connection.scope.launch {
                try {
                    if (retry) {
                        phase(op, RunControlPhase.Checking)
                        val checkpoint =
                            connection.sync.synchronize(
                                intent.threadId,
                                connection.history.checkpoint(intent.threadId),
                            )
                        requireCurrent(op)
                        if (controlEvidence(intent, checkpoint) != RunControlEvidence.Eligible) {
                            reconcile(connection, checkpoint, setOf(intent.id))
                            return@launch
                        }
                    }
                    val saved = store.load(identity)
                    requireCurrent(op)
                    if (!saved.durable || intent !in saved.journal.pending)
                        throw IOException("Exact control intent is not durable")
                    // Any peer's current canonical checkpoint can settle the original target.
                    for (peer in connections.toList()) peer.history
                        .checkpoint(intent.threadId)
                        ?.let { reconcile(peer, it) }
                    requireCurrent(op)
                    phase(op, RunControlPhase.Sending)
                    val accepted = connection.service.sendControl(intent.request())
                    requireCurrent(op)
                    if (accepted.threadId != intent.threadId)
                        throw ApiFailure.IncompatibleResponse()
                    phase(op, RunControlPhase.Accepted)
                    invalidate(intent.threadId)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (current(op)) {
                        report(connection, error)
                        phase(op, RunControlPhase.Unknown)
                        if (current(op)) invalidate(intent.threadId)
                    }
                } finally {
                    if (writes[intent.id] === op) {
                        writes.remove(intent.id)
                        markInterrupted(setOf(intent.id))
                    }
                }
            }
    }

    fun hasPending(threadId: String) =
        mutable.value.journal?.pending?.any { it.threadId == threadId } == true

    /** Read-only reconciliation; foreground/navigation/reconnect never call sendControl. */
    fun check(connection: Connection, threadId: String) {
        if (
            !current(connection) ||
                threadId in reads ||
                writes.values.any { it.intent.threadId == threadId }
        )
            return
        val pending = mutable.value.journal?.pending?.filter { it.threadId == threadId }.orEmpty()
        if (pending.isEmpty()) return
        val checkedIds = pending.mapTo(hashSetOf()) { it.id }
        mutable.value =
            mutable.value.copy(
                phases =
                    mutable.value.phases + pending.associate { it.id to RunControlPhase.Checking }
            )
        val reading = Read(connection, checkedIds)
        reads[threadId] = reading
        reading.job =
            connection.scope.launch {
                try {
                    val checkpoint =
                        connection.sync.synchronize(
                            threadId,
                            connection.history.checkpoint(threadId),
                        )
                    currentCoroutineContext().ensureActive()
                    if (!current(connection) || reads[threadId] !== reading) return@launch
                    reconcile(connection, checkpoint, checkedIds)
                    invalidate(threadId)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (current(connection) && reads[threadId] === reading) {
                        report(connection, error)
                        if (!current(connection)) return@launch
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
                    if (reads[threadId] === reading) {
                        reads.remove(threadId)
                        markInterrupted(checkedIds.filterNot { it in writes }.toSet())
                    }
                }
            }
    }

    fun reconcile(
        connection: Connection,
        checkpoint: HistoryCheckpoint,
        checkedIds: Set<String> = emptySet(),
    ) {
        if (!current(connection)) return
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
        // Only commands captured by this read receive request phases; newer writes keep theirs.
        for ((intent, evidence) in results) if (intent.id in checkedIds && intent.id !in ids)
            phases =
                phases +
                    (intent.id to
                        if (evidence == RunControlEvidence.Eligible) RunControlPhase.Retryable
                        else RunControlPhase.Unknown)
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

    private fun invalidate(threadId: String) {
        connections
            .filter { current(it) }
            .forEach {
                it.history.invalidate(threadId)
                it.history.invalidateDetail(threadId)
            }
    }

    private fun report(connection: Connection, error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            connection.onFailure(error)
    }
}
