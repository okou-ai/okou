package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ThreadDetail
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
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

    internal fun checkpoint(threadId: String): HistoryCheckpoint? =
        confirmed?.history?.checkpoint?.takeIf { current(generation) && it.threadId == threadId }

    private val dirty = mutableMapOf<String, CachedHistory>()
    private val invalidations = Channel<Long>(Channel.CONFLATED)
    private val invalidationJob = scope.launch { for (ticket in invalidations) catchUp(ticket) }
    private val detailInvalidations = Channel<Long>(Channel.CONFLATED)
    private val detailInvalidationJob =
        scope.launch {
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
                source = restored?.let { ChatListSource.Cache },
                cacheUnavailable = thread.id in dirty,
                generation = generation,
            )
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
        }
    }

    internal fun stopAutomaticRead(threadId: String): Job? =
        if (mutable.value.thread?.id == threadId) visit?.stopAutomaticRead() else null

    fun refresh() {
        refreshHistory()
        refreshDetail()
    }

    private fun refreshHistory() {
        val thread = mutable.value.thread ?: return
        if (retired || !authorized() || job?.isActive == true) return
        val ticket = generation
        publish(mutable.value.copy(phase = HistoryPhase.Loading, confirmation = null))
        job =
            scope.launch {
                var saved = dirty[thread.id] ?: confirmed?.history
                if (saved == null) {
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
                        mutable.value.copy(transcript = transcript, source = ChatListSource.Cache)
                    )
                }
                try {
                    var next =
                        CachedHistory(
                            sync.synchronize(thread.id, saved?.checkpoint),
                            System.currentTimeMillis(),
                        )
                    requireCurrent(ticket)
                    dirty[thread.id] = next
                    var diskFailed = false
                    try {
                        cache.saveHistory(next.checkpoint, next.confirmedAt)
                        val disk = cache.loadHistory(thread.id)
                        requireCurrent(ticket)
                        if (disk != null) next = disk
                        dirty.remove(thread.id)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        requireCurrent(ticket)
                        diskFailed = true
                    }
                    val transcript = withContext(dispatcher) { projectHistory(next.checkpoint) }
                    requireCurrent(ticket)
                    confirmed = ConfirmedTimeline(next, transcript)
                    publish(
                        mutable.value.copy(
                            transcript = transcript,
                            phase = HistoryPhase.Ready,
                            source = ChatListSource.Network,
                            cacheUnavailable = diskFailed,
                            // Equal rows still complete a new read; StateFlow may conflate phases.
                            confirmation =
                                HistoryConfirmation(ticket, ++revision, next.checkpoint.cursor),
                        )
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
                        if (current(ticket))
                            publish(mutable.value.copy(phase = HistoryPhase.Failed))
                    }
                }
            }
    }

    private fun refreshDetail() {
        val thread = mutable.value.thread ?: return
        if (retired || !authorized() || detailJob?.isActive == true) return
        val ticket = generation
        publish(mutable.value.copy(detailPhase = ChatReadPhase.Loading, detailFailure = null))
        detailJob =
            scope.launch {
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
                                )
                            )
                    }
                }
            }
    }

    private suspend fun missing(threadId: String, ticket: Long, error: Exception) {
        confirmed = null
        recent.remove(threadId)
        dirty.remove(threadId)
        publish(
            mutable.value.copy(
                transcript = null,
                source = null,
                phase = HistoryPhase.Missing,
                confirmation = null,
                detail = null,
                detailPhase = ChatReadPhase.Failed,
                detailFailure = error,
            )
        )
        try {
            cache.deleteHistory(threadId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            requireCurrent(ticket)
            publish(mutable.value.copy(cacheUnavailable = true))
        }
    }

    internal fun forgetWarmedHistory(threadId: String) {
        if (retired || !authorized() || mutable.value.thread?.id == threadId) return
        recent.remove(threadId)
        dirty.remove(threadId)
    }

    fun refreshAfterSend(threadId: String) {
        val ticket = generation
        scope.launch {
            job?.join()
            if (current(ticket) && mutable.value.thread?.id == threadId) refresh()
        }
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
        mutable.value = ConversationUiState(generation = generation)
    }
}
