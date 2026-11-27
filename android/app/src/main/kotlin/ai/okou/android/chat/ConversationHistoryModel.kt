package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.continuousRetryDelays
import ai.okou.android.api.generated.ThreadDetail
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class HistoryPhase {
    Loading,
    Ready,
    Failed,
    Missing,
}

data class ConversationUiState(
    val thread: ConfirmedChat? = null,
    val transcript: HistoryTranscript? = null,
    val phase: HistoryPhase = HistoryPhase.Loading,
    val source: ChatListSource? = null,
    val cacheUnavailable: Boolean = false,
    val generation: Long = 0,
    val confirmation: HistoryConfirmation? = null,
    val detail: ThreadDetail? = null,
    val detailPhase: ChatReadPhase = ChatReadPhase.Idle,
    val detailFailure: Exception? = null,
    val initialReadFailed: Boolean = false,
    val syncProgressDelayMillis: Long? = null,
    val consecutiveReadFailures: Int = 0,
)

/** A completed network read, distinct from both selection identity and the event cursor. */
data class HistoryConfirmation(val generation: Long, val revision: Long, val cursor: HistoryCursor)

/** Workspace-retained confirmed data. A visible visit owns its separate read session. */
class ConversationHistoryModel(
    internal val service: ConversationHistoryService,
    private val cache: ChatCacheStore.Lease,
    private val scope: CoroutineScope,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val onRead: () -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val precedingReadWrite: (String) -> Job? = { null },
    private val wallMillis: () -> Long = System::currentTimeMillis,
    private val markRead: suspend (String) -> Unit = { service.markRead(it) },
) {
    private val mutable = MutableStateFlow(ConversationUiState())
    val uiState = mutable.asStateFlow()
    val output = RunOutputModel({ mutable.value }, authorized, ::invalidate)

    private fun publish(next: ConversationUiState) {
        mutable.value = next
        output.reconcile()
    }

    private val sync = ConversationHistorySync(service, dispatcher)
    private var generation = 0L
    private var retired = false
    private var revision = 0L
    private var job: Job? = null
    private var detailJob: Job? = null
    private var visit: ConversationReadSession? = null

    private data class ConfirmedTimeline(
        val history: CachedHistory,
        val transcript: HistoryTranscript,
    )

    private var confirmed: ConfirmedTimeline? = null
    // The active timeline is kept separately. Only inactive visits count toward this limit.
    private val recent = linkedMapOf<String, ConfirmedTimeline>()
    private val reading = linkedMapOf<String, ConversationAnchor?>()
    private var readingWrite: Job? = null

    internal suspend fun restoreReadingAnchor(threadId: String): ConversationAnchor? {
        if (reading.containsKey(threadId)) return reading[threadId]
        val stored = cache.loadReadingAnchor(threadId)
        if (reading.containsKey(threadId)) return reading[threadId]
        reading[threadId] = stored
        if (reading.size > 4) reading.remove(reading.keys.first())
        return stored
    }

    internal fun rememberReadingAnchor(threadId: String, anchor: ConversationAnchor?) {
        if (!current(generation) || mutable.value.thread?.id != threadId) return
        if (reading.containsKey(threadId) && reading[threadId] == anchor) return
        reading.remove(threadId)
        reading[threadId] = anchor
        if (reading.size > 4) reading.remove(reading.keys.first())
        val previousWrite = readingWrite
        readingWrite = scope.launch {
            // Preserve the order of the UI actions across the IO dispatcher.
            previousWrite?.join()
            cache.saveReadingAnchor(threadId, anchor)
        }
    }

    internal fun checkpoint(threadId: String): HistoryCheckpoint? =
        confirmed?.history?.checkpoint?.takeIf { current(generation) && it.threadId == threadId }

    private val dirty = mutableMapOf<String, CachedHistory>()
    // Confirmed access loss survives navigation until a successful history read. A new cache
    // commit waits for the workspace-owned eviction of the denied history.
    private val accessEvictions = mutableMapOf<String, Job>()
    private val invalidations = Channel<Long>(Channel.CONFLATED)
    private val invalidationJob = scope.launch { for (ticket in invalidations) catchUp(ticket) }
    private val detailInvalidations = Channel<Long>(Channel.CONFLATED)
    private val detailInvalidationJob = scope.launch {
        for (ticket in detailInvalidations) {
            if (!current(ticket)) continue
            detailJob?.join()
            if (current(ticket)) {
                refreshDetail()
                detailJob?.join()
            }
        }
    }

    private fun current(ticket: Long) = !retired && authorized() && ticket == generation

    private suspend fun requireCurrent(ticket: Long) {
        currentCoroutineContext().ensureActive()
        if (!current(ticket)) throw CancellationException("Conversation owner retired")
    }

    fun open(thread: ConfirmedChat) {
        if (retired || !authorized()) return
        if (mutable.value.thread?.id == thread.id) {
            publish(mutable.value.copy(thread = thread))
            return
        }
        generation++
        job?.cancel()
        detailJob?.cancel()
        visit?.close()
        visit = null
        output.visible(false)
        confirmed?.let { recent[it.history.checkpoint.threadId] = it }
        val restored = recent.remove(thread.id)
        if (recent.size > 3) recent.remove(recent.keys.first())
        confirmed = restored
        publish(
            ConversationUiState(
                thread = thread,
                transcript = restored?.transcript,
                phase =
                    if (thread.id in accessEvictions) HistoryPhase.Missing
                    else HistoryPhase.Loading,
                source = restored?.let { ChatListSource.Cache },
                cacheUnavailable = thread.id in dirty,
                generation = generation,
            ),
        )
        refresh()
    }

    fun beginVisit(threadId: String, generation: Long): ConversationReadSession? {
        if (mutable.value.thread?.id != threadId || !current(generation)) return null
        visit?.close()
        return ConversationReadSession(
                threadId,
                service,
                scope,
                { current(generation) },
                { mutable.value.confirmation },
                ::reportAuthorization,
                onRead,
                { precedingReadWrite(threadId) },
                markRead,
            )
            .also {
                visit = it
                output.visible(true)
                refresh()
            }
    }

    fun endVisit(value: ConversationReadSession) {
        value.close()
        if (visit === value) {
            visit = null
            output.visible(false)
            if (mutable.value.consecutiveReadFailures > 0) job?.cancel()
        }
    }

    internal fun readSessionFor(threadId: String): ConversationReadSession? = visit?.takeIf {
        mutable.value.thread?.id == threadId
    }

    fun refresh() {
        refreshHistory()
        refreshDetail()
    }

    private fun refreshHistory() {
        val state = mutable.value
        val thread = state.thread ?: return
        if (retired || !authorized() || job?.isActive == true) return
        val ticket = generation
        val eviction = accessEvictions[thread.id]
        publish(
            state.copy(
                phase = if (eviction == null) HistoryPhase.Loading else HistoryPhase.Missing,
                confirmation = null,
                syncProgressDelayMillis = confirmed?.history?.progressDelayMillis(),
                consecutiveReadFailures = 0,
                initialReadFailed = false,
            ),
        )
        job = scope.launch {
            var saved = if (eviction == null) dirty[thread.id] ?: confirmed?.history else null
            if (saved == null && eviction == null) {
                try {
                    saved = cache.loadHistory(thread.id)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    requireCurrent(ticket)
                    publish(mutable.value.copy(cacheUnavailable = true))
                }
            }
            if (saved != null && confirmed == null) {
                val transcript = withContext(dispatcher) { projectHistory(saved.checkpoint) }
                requireCurrent(ticket)
                confirmed = ConfirmedTimeline(saved, transcript)
                publish(
                    mutable.value.copy(
                        transcript = transcript,
                        source = ChatListSource.Cache,
                        initialReadFailed = false,
                        syncProgressDelayMillis = saved.progressDelayMillis(),
                    ),
                )
            }
            try {
                var next =
                    CachedHistory(
                        readWithRetry(thread.id, saved?.checkpoint, ticket),
                        wallMillis(),
                    )
                eviction?.join()
                requireCurrent(ticket)
                dirty[thread.id] = next
                var diskFailed = false
                try {
                    val committed = cache.saveHistory(next.checkpoint, next.confirmedAt, saved)
                    val disk = cache.loadHistory(thread.id, committed)
                    requireCurrent(ticket)
                    if (disk != null) next = disk
                    dirty.remove(thread.id)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    requireCurrent(ticket)
                    diskFailed = true
                }
                // Room may select a different prefix at the same cursor.
                val transcript =
                    confirmed?.takeIf { it.history.checkpoint === next.checkpoint }?.transcript
                        ?: withContext(dispatcher) { projectHistory(next.checkpoint) }
                requireCurrent(ticket)
                confirmed = ConfirmedTimeline(next, transcript)
                accessEvictions.remove(thread.id)
                publish(
                    mutable.value.copy(
                        transcript = transcript,
                        phase = HistoryPhase.Ready,
                        source = ChatListSource.Network,
                        cacheUnavailable = diskFailed,
                        initialReadFailed = false,
                        syncProgressDelayMillis = null,
                        consecutiveReadFailures = 0,
                        // Equal rows still complete a new read; StateFlow may conflate phases.
                        confirmation =
                            HistoryConfirmation(ticket, ++revision, next.checkpoint.cursor),
                    ),
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent(ticket)
                if (error is ApiFailure.Http && error.status in setOf(403, 404)) {
                    detailJob?.cancel()
                    missing(thread.id, ticket, error)
                } else {
                    reportAuthorization(error)
                    if (current(ticket) && eviction == null) {
                        val state = mutable.value
                        publish(
                            state.copy(
                                phase = HistoryPhase.Failed,
                                // A transient read can end before the visible visit starts its
                                // retries. Keep the same initial feedback across that handoff.
                                initialReadFailed =
                                    state.transcript == null &&
                                        chatReadRetryDelayMillis(error, 0) == null,
                                syncProgressDelayMillis = null,
                                consecutiveReadFailures = 0,
                            ),
                        )
                    }
                }
            }
        }
    }

    private fun CachedHistory.progressDelayMillis() =
        chatSyncNoticeDelayMillis(confirmedAt, wallMillis())

    private suspend fun readWithRetry(
        threadId: String,
        checkpoint: HistoryCheckpoint?,
        ticket: Long,
    ): HistoryCheckpoint {
        var failures = 0
        while (true) {
            try {
                return sync.synchronize(threadId, checkpoint)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent(ticket)
                val retryDelay = chatReadRetryDelayMillis(error, failures)
                if (visit == null || retryDelay == null) throw error
                failures = (failures + 1).coerceAtMost(continuousRetryDelays.size)
                publish(mutable.value.copy(consecutiveReadFailures = failures))
                delay(retryDelay)
                requireCurrent(ticket)
                if (visit == null) throw CancellationException("Conversation visit ended")
            }
        }
    }

    private fun refreshDetail() {
        val thread = mutable.value.thread ?: return
        if (retired || !authorized() || detailJob?.isActive == true) return
        val ticket = generation
        publish(mutable.value.copy(detailPhase = ChatReadPhase.Loading, detailFailure = null))
        detailJob = scope.launch {
            try {
                val detail = service.threadDetail(thread.id)
                requireCurrent(ticket)
                publish(mutable.value.copy(detail = detail, detailPhase = ChatReadPhase.Ready))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent(ticket)
                if (error is ApiFailure.Http && error.status in setOf(403, 404)) {
                    job?.cancel()
                    missing(thread.id, ticket, error)
                } else {
                    reportAuthorization(error)
                    if (current(ticket))
                        publish(
                            mutable.value.copy(
                                detailPhase = ChatReadPhase.Failed,
                                detailFailure = error,
                            ),
                        )
                }
            }
        }
    }

    private fun missing(threadId: String, ticket: Long, error: Exception) {
        confirmed = null
        recent.remove(threadId)
        dirty.remove(threadId)
        val eviction =
            accessEvictions[threadId]?.takeUnless { it.isCompleted }
                ?: scope
                    .launch(start = CoroutineStart.LAZY) {
                        try {
                            cache.deleteHistory(threadId)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            if (current(ticket))
                                publish(mutable.value.copy(cacheUnavailable = true))
                        }
                    }
                    .also { accessEvictions[threadId] = it }
        publish(
            mutable.value.copy(
                transcript = null,
                source = null,
                phase = HistoryPhase.Missing,
                confirmation = null,
                initialReadFailed = false,
                syncProgressDelayMillis = null,
                consecutiveReadFailures = 0,
                detail = null,
                detailPhase = ChatReadPhase.Failed,
                detailFailure = error,
            ),
        )
        eviction.start()
    }

    internal fun forgetWarmedHistory(threadId: String) {
        if (retired || !authorized() || mutable.value.thread?.id == threadId) return
        recent.remove(threadId)
        dirty.remove(threadId)
    }

    fun refreshAfterSend(threadId: String) {
        invalidate(threadId)
        invalidateDetail(threadId)
    }

    fun invalidate(threadId: String? = null) {
        val selected = mutable.value.thread ?: return
        if (!retired && authorized() && (threadId == null || threadId == selected.id))
            invalidations.trySend(generation)
    }

    fun invalidateDetail(threadId: String? = null) {
        val selected = mutable.value.thread ?: return
        if (!retired && authorized() && (threadId == null || threadId == selected.id))
            detailInvalidations.trySend(generation)
    }

    private suspend fun catchUp(ticket: Long) {
        if (!current(ticket)) return
        job?.join()
        if (current(ticket)) {
            refreshHistory()
            job?.join()
        }
    }

    internal suspend fun searchMessageIsMissing(threadId: String, sequence: Long): Boolean {
        val selected = mutable.value
        if (selected.thread?.id != threadId || selected.hasSearchMessage(sequence)) return false
        val ticket = generation
        job?.join()
        requireCurrent(ticket)
        val latest = mutable.value
        if (latest.hasSearchMessage(sequence)) return false
        // The search index can be ahead of this visit's last synchronized history.
        if (
            latest.phase != HistoryPhase.Missing &&
                (latest.confirmation?.cursor?.seqId ?: 0L) < sequence
        ) {
            refreshHistory()
        }
        val resolved = mutable.first {
            it.generation != ticket ||
                it.phase == HistoryPhase.Ready ||
                it.phase == HistoryPhase.Missing
        }
        requireCurrent(ticket)
        return !resolved.hasSearchMessage(sequence)
    }

    private fun ConversationUiState.hasSearchMessage(sequence: Long) =
        transcript?.searchMessage(sequence) != null

    private fun reportAuthorization(error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            onFailure(error)
    }

    fun close() {
        retired = true
        output.close()
        invalidationJob.cancel()
        invalidations.close()
        detailInvalidationJob.cancel()
        detailInvalidations.close()
        generation++
        job?.cancel()
        detailJob?.cancel()
        visit?.close()
        visit = null
        confirmed = null
        recent.clear()
        dirty.clear()
        accessEvictions.values.forEach { it.cancel() }
        accessEvictions.clear()
        mutable.value = ConversationUiState(generation = generation)
    }
}
