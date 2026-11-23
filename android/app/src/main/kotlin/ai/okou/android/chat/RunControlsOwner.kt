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
import kotlinx.coroutines.delay
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
                    },
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
        restoring = localScope.launch {
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
        state: RunControlsState = mutable.value,
    ): Deferred<Unit> {
        val ticket = ++revision
        val write = store.persist(identity, journal)
        mutable.value = state.copy(journal = journal, persistence = RunControlPersistence.Pending)
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
                            else RunControlPersistence.Failed,
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
        if (state.thread?.id != threadId) return
        val eligible = state.controlRunIds(connection.history.output.state.value).toSet()
        val settled = mutable.value.settledRuns[threadId].orEmpty()
        append(
            connection,
            displayedRunIds
                .distinct()
                .filter { it in eligible && it !in settled }
                .map {
                    RunControlIntent(
                        UUID.randomUUID().toString(),
                        threadId,
                        RunControlKind.Interrupt,
                        it,
                    )
                },
        )
    }

    fun skip(
        connection: Connection,
        threadId: String,
        eventId: String,
        preview: ComposerMessagePreview?,
    ) {
        if (!current(connection)) return
        if (eventId in mutable.value.settledQueueInputs[threadId].orEmpty()) return
        if (!connection.history.uiState.value.canWithdrawInput(threadId, eventId, preview)) return
        append(
            connection,
            listOf(
                RunControlIntent(
                    UUID.randomUUID().toString(),
                    threadId,
                    RunControlKind.Revoke,
                    eventId,
                ),
            ),
        )
    }

    private fun append(connection: Connection, candidates: List<RunControlIntent>) {
        val state = mutable.value
        val journal = state.journal ?: return
        if (!current(connection) || state.persistence == RunControlPersistence.Failed) return
        val fresh = candidates.filter { candidate ->
            journal.pending.none {
                it.threadId == candidate.threadId &&
                    it.kind == candidate.kind &&
                    it.targetId == candidate.targetId
            }
        }
        if (fresh.isEmpty()) return
        persist(
            journal.copy(pending = journal.pending + fresh),
            state.copy(
                phases = state.phases + fresh.associate { it.id to RunControlPhase.Preparing },
            ),
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
    fun check(connection: Connection, threadId: String, intentId: String? = null) {
        if (!current(connection) || threadId in reads) return
        val pending =
            mutable.value.journal?.pending.orEmpty().filter {
                it.threadId == threadId &&
                    (intentId == null ||
                        it.id == intentId && mutable.value.phases[it.id] == RunControlPhase.Unknown)
            }
        if (pending.isEmpty() || pending.any { it.id in writes }) return
        val checkedIds = pending.mapTo(hashSetOf()) { it.id }
        mutable.value =
            mutable.value.copy(
                phases =
                    mutable.value.phases + pending.associate { it.id to RunControlPhase.Checking },
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
                        if (remaining.isNotEmpty()) {
                            val state = mutable.value
                            mutable.value =
                                state.copy(
                                    phases =
                                        state.phases +
                                            remaining.associate {
                                                it.id to RunControlPhase.Unknown
                                            },
                                    notice =
                                        if (remaining.any { it.kind == RunControlKind.Interrupt })
                                            RunControlNotice(
                                                threadId,
                                                RunControlNoticeKind.ReadFailed,
                                                RunControlKind.Interrupt,
                                            )
                                        else state.notice,
                                )
                        }
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
        val state = mutable.value
        val journal = state.journal ?: return
        val threadId = checkpoint.threadId
        val priorSettledQueue = state.settledQueueInputs[threadId].orEmpty()
        val priorSettledRuns = state.settledRuns[threadId].orEmpty()
        val intents = journal.pending.filter { it.threadId == threadId }
        if (intents.isEmpty() && priorSettledQueue.isEmpty() && priorSettledRuns.isEmpty()) return
        val results =
            if (intents.isEmpty()) emptyMap()
            else intents.associateWith(RunControlObservation(checkpoint)::evidence)
        val resolved = results.filterValues {
            it == RunControlEvidence.Recorded || it == RunControlEvidence.TargetSettled
        }
        val ids = resolved.keys.mapTo(hashSetOf()) { it.id }
        var phases = state.phases - ids
        // Only commands captured by this read receive request phases; newer writes keep theirs.
        for ((intent, evidence) in results) if (intent.id in checkedIds && intent.id !in ids)
            phases =
                phases +
                    (intent.id to
                        if (evidence == RunControlEvidence.Eligible) RunControlPhase.Retryable
                        else RunControlPhase.Unknown)
        val settledElsewhere =
            resolved.entries.lastOrNull {
                it.value == RunControlEvidence.TargetSettled
            }
        val notice =
            when {
                settledElsewhere != null ->
                    RunControlNotice(
                        threadId,
                        RunControlNoticeKind.TargetSettled,
                        settledElsewhere.key.kind,
                    )
                results.any { (intent, evidence) ->
                    intent.kind == RunControlKind.Interrupt &&
                        evidence == RunControlEvidence.Invalid
                } ->
                    RunControlNotice(
                        threadId,
                        RunControlNoticeKind.ReadFailed,
                        RunControlKind.Interrupt,
                    )
                else -> null
            }
        val settledQueue =
            targetsAwaitingHistory(
                threadId,
                resolved.keys
                    .filter { it.kind == RunControlKind.Revoke }
                    .mapTo(priorSettledQueue.toMutableSet()) { it.targetId },
            ) { transcript, id ->
                transcript.hasSettledInput(id)
            }
        val settledRuns =
            targetsAwaitingHistory(
                threadId,
                resolved.keys
                    .filter { it.kind == RunControlKind.Interrupt }
                    .mapTo(priorSettledRuns.toMutableSet()) { it.targetId },
            ) { transcript, id ->
                id in transcript.terminatedRunIds
            }
        val next =
            state.copy(
                phases = phases,
                notice = notice ?: state.notice,
                settledQueueInputs =
                    if (settledQueue.isEmpty()) state.settledQueueInputs - threadId
                    else state.settledQueueInputs + (threadId to settledQueue),
                settledRuns =
                    if (settledRuns.isEmpty()) state.settledRuns - threadId
                    else state.settledRuns + (threadId to settledRuns),
            )
        if (ids.isNotEmpty())
            persist(journal.copy(pending = journal.pending.filterNot { it.id in ids }), next)
        else if (next != state) mutable.value = next
        if (notice?.kind == RunControlNoticeKind.TargetSettled) {
            localScope.launch {
                delay(4_000)
                if (mutable.value.notice === notice)
                    mutable.value = mutable.value.copy(notice = null)
            }
        }
    }

    /** A validated control read can settle targets before the selected histories catch up. */
    private fun targetsAwaitingHistory(
        threadId: String,
        targets: Set<String>,
        isSettled: (HistoryTranscript, String) -> Boolean,
    ): Set<String> {
        if (targets.isEmpty()) return targets
        val selected = connections.mapNotNull { connection ->
            connection.history.uiState.value.takeIf {
                current(connection) && it.thread?.id == threadId
            }
        }
        if (selected.isEmpty()) return targets
        return targets.filterTo(hashSetOf()) { id ->
            selected.any { state ->
                state.phase != HistoryPhase.Missing &&
                    state.transcript?.let { isSettled(it, id) } != true
            }
        }
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
