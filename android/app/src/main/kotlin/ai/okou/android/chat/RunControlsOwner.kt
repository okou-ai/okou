package ai.okou.android.chat

import ai.okou.android.FeedbackReceipt
import ai.okou.android.api.ApiFailure
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Main-thread transaction owner for the attached controllers of one authorized workspace. */
internal class RunControlsOwner {
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
        var feedbackThreadId: String? = null

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
    private val connections = mutableSetOf<Connection>()
    private val writes = mutableMapOf<String, Operation>()
    private val reads = mutableMapOf<String, Read>()

    fun attach(connection: Connection) {
        connections += connection
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
        discardHiddenActionFailures()
        return connections.isEmpty()
    }

    private fun markInterrupted(ids: Set<String>) {
        if (ids.isEmpty()) return
        mutable.value =
            mutable.value.copy(
                phases =
                    mutable.value.phases.mapValues { (id, phase) ->
                        if (
                            id in ids &&
                                (phase == RunControlPhase.Sending ||
                                    phase == RunControlPhase.Checking)
                        )
                            RunControlPhase.Unknown
                        else phase
                    },
            )
    }

    private fun current(connection: Connection) = connection in connections && connection.current()

    private fun contains(intent: RunControlIntent) = intent in mutable.value.pending

    private fun current(op: Operation) =
        current(op.connection) && writes[op.intent.id] === op && contains(op.intent)

    private suspend fun requireCurrent(op: Operation) {
        currentCoroutineContext().ensureActive()
        if (!current(op))
            throw CancellationException("Control connection retired or target settled")
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
        if (!current(connection)) return
        val state = mutable.value
        val fresh = candidates.filter { candidate ->
            state.pending.none {
                it.threadId == candidate.threadId &&
                    it.kind == candidate.kind &&
                    it.targetId == candidate.targetId
            }
        }
        if (fresh.isEmpty()) return
        mutable.value =
            state.copy(
                pending = state.pending + fresh,
                phases = state.phases + fresh.associate { it.id to RunControlPhase.Sending },
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
        val state = mutable.value
        val intent = state.pending.singleOrNull { it.id == id } ?: return
        if (id in writes) return
        mutable.value =
            state.copy(
                phases = state.phases + (id to RunControlPhase.Checking),
                actionFailures = state.actionFailures.filterNot { it.value.id == id },
            )
        launch(connection, intent, true)
    }

    fun showActionFeedbackFor(connection: Connection, threadId: String?) {
        if (!current(connection) || connection.feedbackThreadId == threadId) return
        connection.feedbackThreadId = threadId
        discardHiddenActionFailures()
    }

    private fun hasFeedbackPane(threadId: String): Boolean = connections.any {
        it.current() && it.feedbackThreadId == threadId
    }

    private fun discardHiddenActionFailures() {
        val state = mutable.value
        val remaining = state.actionFailures.filter { hasFeedbackPane(it.value.threadId) }
        if (remaining != state.actionFailures)
            mutable.value = state.copy(actionFailures = remaining)
    }

    fun consumeActionFailure(
        connection: Connection,
        receipt: FeedbackReceipt<RunControlIntent>,
    ): Boolean {
        val state = mutable.value
        if (!current(connection) || receipt !in state.actionFailures) return false
        mutable.value = state.copy(actionFailures = state.actionFailures - receipt)
        return true
    }

    private fun launch(connection: Connection, intent: RunControlIntent, retry: Boolean) {
        if (!current(connection) || intent.id in writes) return
        val op = Operation(connection, intent)
        writes[intent.id] = op
        op.job =
            connection.scope.launch {
                try {
                    if (retry && !verifyTarget(op, canResend = true)) return@launch
                    submitWithRetry(op)
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

    private suspend fun send(op: Operation) {
        val intent = op.intent
        requireCurrent(op)
        // Any peer's current canonical checkpoint can settle the original target.
        for (peer in connections.toList()) peer.history.checkpoint(intent.threadId)?.let {
            reconcile(peer, it)
        }
        requireCurrent(op)
        phase(op, RunControlPhase.Sending)
        val accepted = op.connection.service.sendControl(intent.request())
        requireCurrent(op)
        if (accepted.threadId != intent.threadId) throw ApiFailure.IncompatibleResponse()
        phase(op, RunControlPhase.Accepted)
        invalidate(intent.threadId)
    }

    private suspend fun verifyTarget(op: Operation, canResend: Boolean): Boolean {
        requireCurrent(op)
        phase(op, RunControlPhase.Checking)
        val connection = op.connection
        val intent = op.intent
        suspend fun read() =
            connection.sync.synchronize(
                intent.threadId,
                connection.history.checkpoint(intent.threadId),
            )
        val checkpoint = ChatDependencyRetry().read(isCurrent = { current(op) }, fetch = ::read)
        requireCurrent(op)
        if (canResend && controlEvidence(intent, checkpoint) == RunControlEvidence.Eligible)
            return true
        reconcile(connection, checkpoint, setOf(intent.id))
        invalidate(intent.threadId)
        return false
    }

    private suspend fun submitWithRetry(op: Operation) {
        var remaining = ChatDependencyRetryCount
        while (true) {
            try {
                send(op)
                return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent(op)
                report(op.connection, error)
                requireCurrent(op)
                phase(op, RunControlPhase.Unknown)
                invalidate(op.intent.threadId)
                val delayMillis =
                    dependencyRetryDelayMillis(error, ChatDependencyRetryCount - remaining).takeIf {
                        remaining > 0
                    }
                if (delayMillis != null) delay(delayMillis)
                // Only an authoritative observation of the exact original target permits a resend.
                if (!verifyTarget(op, canResend = delayMillis != null)) return
                remaining--
            }
        }
    }

    fun hasPending(threadId: String) = mutable.value.pending.any { it.threadId == threadId }

    /** Read-only reconciliation; foreground/navigation/reconnect never call sendControl. */
    fun check(connection: Connection, threadId: String, unknownOnly: Boolean = false) {
        if (!current(connection) || threadId in reads) return
        val state = mutable.value
        val pending =
            state.pending.filter { intent ->
                val phase = state.phases[intent.id]
                intent.threadId == threadId &&
                    intent.id !in writes &&
                    (phase == RunControlPhase.Unknown ||
                        !unknownOnly && phase == RunControlPhase.Accepted)
            }
        if (pending.isEmpty()) return
        val checkedIds = pending.mapTo(hashSetOf()) { it.id }
        val reading = Read(connection, checkedIds)
        reads[threadId] = reading
        mutable.value =
            state.copy(
                phases = state.phases + pending.associate { it.id to RunControlPhase.Checking },
            )
        reading.job =
            connection.scope.launch {
                try {
                    val before = connection.history.checkpoint(threadId)
                    val checkpoint = connection.sync.synchronize(threadId, before)
                    currentCoroutineContext().ensureActive()
                    if (!current(connection) || reads[threadId] !== reading) return@launch
                    reconcile(connection, checkpoint, checkedIds)
                    // After a history refresh, an unchanged checkpoint needs no new invalidation.
                    if (!unknownOnly || checkpoint !== before) invalidate(threadId)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (current(connection) && reads[threadId] === reading)
                        report(connection, error)
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
        val threadId = checkpoint.threadId
        val priorSettledQueue = state.settledQueueInputs[threadId].orEmpty()
        val priorSettledRuns = state.settledRuns[threadId].orEmpty()
        val intents = state.pending.filter { it.threadId == threadId }
        if (intents.isEmpty() && priorSettledQueue.isEmpty() && priorSettledRuns.isEmpty()) return
        val results =
            if (intents.isEmpty()) emptyMap()
            else intents.associateWith(RunControlObservation(checkpoint)::evidence)
        val resolved = results.filterValues {
            it == RunControlEvidence.Recorded || it == RunControlEvidence.TargetSettled
        }
        val ids = resolved.keys.mapTo(hashSetOf()) { it.id }
        var phases = state.phases - ids
        var actionFailures = state.actionFailures.filterNot { it.value.id in ids }
        // Only commands captured by this read receive request phases; newer writes keep theirs.
        for ((intent, evidence) in results) {
            if (intent.id !in checkedIds || intent.id in ids) continue
            if (evidence == RunControlEvidence.Eligible) {
                phases = phases + (intent.id to RunControlPhase.Retryable)
                if (
                    hasFeedbackPane(threadId) &&
                        state.phases[intent.id] != RunControlPhase.Retryable &&
                        actionFailures.none { it.value.id == intent.id }
                ) {
                    actionFailures = actionFailures + FeedbackReceipt(intent)
                }
            } else {
                phases = phases + (intent.id to RunControlPhase.Unknown)
            }
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
                pending = state.pending.filterNot { it.id in ids },
                phases = phases,
                actionFailures = actionFailures,
                settledQueueInputs =
                    if (settledQueue.isEmpty()) state.settledQueueInputs - threadId
                    else state.settledQueueInputs + (threadId to settledQueue),
                settledRuns =
                    if (settledRuns.isEmpty()) state.settledRuns - threadId
                    else state.settledRuns + (threadId to settledRuns),
            )
        if (next != state) mutable.value = next
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
